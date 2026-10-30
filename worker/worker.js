/* Fly with Friends — SerpApi proxy.
 *
 * Exists because SerpApi refuses cross-origin browser requests by design: the
 * key would be visible to anyone who opened devtools. This Worker holds the key
 * and is the only thing that talks to SerpApi.
 *
 * On the free tier the real scarcity is searches, not compute: 250/month total,
 * and a 4-person round trip costs 8 of them. So three things matter more than
 * speed here --
 *   1. cache at the level of ONE search (origin-set, destination, date), so two
 *      different groups sharing a leg only pay for it once;
 *   2. a hard monthly cap, checked before spending, so the quota cannot be
 *      drained in an afternoon;
 *   3. serving cached results even after the cap is hit, so a shared link keeps
 *      working when the budget is gone.
 */

const SERPAPI_ENDPOINT = 'https://serpapi.com/search.json';
const DUFFEL_ENDPOINT = 'https://api.duffel.com/air/offer_requests?return_offers=true';

const LIMITS = {
  /* The owner's position, and it is the right one: upgrade rather than ration.
   * So there is no per-person search cap. A real group searching hard is a
   * customer, not a threat, and telling them "you have used your searches" is
   * the worst possible first impression.
   *
   * What remains is only what cannot be wished away:
   *   - monthly is the provider's actual allowance. SerpApi simply stops at it.
   *   - globalHourly is a runaway brake, set far above any human session, so a
   *     script cannot convert the whole month into one minute before anyone
   *     notices. It is deliberately generous: a burst it blocks is a burst no
   *     group of friends would ever produce.
   * Separating humans from scripts is Turnstile's job, not a quota's. */
  monthly: 230,      // of SerpApi's 250, leaving headroom for manual scans
  daily: 120,
  globalHourly: 60,
  perIpRequestsHourly: 240,   // anti-script only; ~40 group searches an hour
  perIpTripWrites: 40,
  cacheTtlSeconds: 60 * 60 * 24,   // a day; fares do not move enough to matter
  maxTravelers: 8,
  optionsPerLeg: 25,
  tripTtlSeconds: 60 * 60 * 24 * 30,   // a shared trip stays openable for a month
  tripBytesMax: 256 * 1024,            // a real 8-person round trip is ~150KB
  maxDaysAhead: 330,                   // past Google's horizon a search buys nothing
};

const CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'MXN']);

/* Requests from a browser always carry Origin, so it can be required rather
 * than failed open. This stops a hostile page and the copy-paste attacker; it
 * is no defence at all against curl, which types whatever it likes. */
function originOk(request, env) {
  const o = request.headers.get('Origin') || '';
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) return true;
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  return allowed.length ? allowed.includes(o) : true;   // unset: permissive until deployed
}

/* An exact IP is free to an attacker -- a phone gets a new one by toggling
 * airplane mode, and a single IPv6 allocation holds 18 quintillion addresses.
 * The /64 is the smallest block an ISP hands one customer, so rotating inside
 * it buys nothing. */
function ipBucket(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!ip.includes(':')) return ip;
  const [lead, tail] = ip.split('::');
  const left = lead ? lead.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const full = tail === undefined
    ? left
    : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return full.slice(0, 4).map(h => h.replace(/^0+(?=.)/, '').toLowerCase()).join(':') + '::/64';
}

/* Every field that reaches a cache key is attacker-controllable, and an
 * unbounded key space means an unbounded supply of guaranteed cache misses.
 * Sorting origins also fixes a bug aimed at real users: ["SFO","OAK"] and
 * ["OAK","SFO"] are one search that was being paid for twice. */
function normalize(body) {
  const clean = a => [...new Set((a || []).map(x => String(x).toUpperCase().slice(0, 3)))].sort().slice(0, 4);
  body.dest = clean(body.dest);
  for (const t of (body.travelers || [])) {
    if (!t) continue;
    t.origins = clean(t.origins);
    const seats = Number((t.bags && t.bags.carry_on) || 0);
    if (t.bags) t.bags.carry_on = isFinite(seats) ? Math.min(9, Math.max(0, Math.floor(seats))) : 0;
  }
  body.currency = CURRENCIES.has(body.currency) ? body.currency : 'USD';
  return body;
}

/* A regex is not a date: 9999-99-99 passes one. */
function realDateInWindow(sIso) {
  const t = Date.parse(sIso + 'T00:00:00Z');
  if (!isFinite(t)) return false;
  if (new Date(t).toISOString().slice(0, 10) !== sIso) return false;
  const days = (t - Date.now()) / 86400000;
  return days > -2 && days < LIMITS.maxDaysAhead;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

/* ------------------------------------------------------------- baggage */

/* Google publishes bag info only as free text in `extensions`. Mirrors the
 * parser in .github/scripts/scan.py -- keep the two in step. A fee we could not
 * read is reported as unknown, never as zero. */
function parseBags(extensions) {
  const text = (extensions || []).join(' | ');
  let carryOn = null;
  if (/(free\s+carry[- ]on|carry[- ]on\s+(bag\s+)?included)/i.test(text)) carryOn = true;
  else if (/carry[- ]on\s+(bag\s+)?(not\s+included|for\s+a\s+fee)/i.test(text)) carryOn = false;

  const free = /(\d+)\s+free\s+checked\s+bag/i.exec(text);
  if (free && +free[1] > 0) {
    return { carry_on_included: carryOn, checked_first_price: 0, confidence: 'parsed' };
  }
  const priced = /(?:1st|first)?\s*checked\s+bag[:\s]+\$?(\d+)/i.exec(text);
  if (priced) {
    return { carry_on_included: carryOn, checked_first_price: +priced[1], confidence: 'parsed' };
  }
  if (/checked\s+baggage\s+for\s+a\s+fee|bag\s+and\s+fare\s+conditions/i.test(text)) {
    return { carry_on_included: carryOn, checked_first_price: null, confidence: 'fee_unknown' };
  }
  return { carry_on_included: carryOn, checked_first_price: null, confidence: 'absent' };
}

function extractOptions(payload, limit) {
  const out = [];
  const itineraries = [...(payload.best_flights || []), ...(payload.other_flights || [])];

  for (const it of itineraries) {
    const legs = it.flights || [];
    if (!legs.length) continue;
    const first = legs[0], last = legs[legs.length - 1];
    const depart = first.departure_airport && first.departure_airport.time;
    const arrive = last.arrival_airport && last.arrival_airport.time;
    if (!depart || !arrive || it.price == null) continue;

    const extensions = [...(it.extensions || [])];
    for (const leg of legs) extensions.push(...(leg.extensions || []));

    const airlines = [];
    for (const leg of legs) if (leg.airline && !airlines.includes(leg.airline)) airlines.push(leg.airline);

    out.push({
      price: it.price,
      depart, arrive,
      duration_minutes: it.total_duration,
      stops: Math.max(legs.length - 1, 0),
      airlines,
      from: first.departure_airport && first.departure_airport.id,
      to: last.arrival_airport && last.arrival_airport.id,
      airline_logo: it.airline_logo || first.airline_logo,
      extensions,
      bags: parseBags(extensions),
    });
  }

  out.sort((a, b) => a.price - b.price);
  return out.slice(0, limit);
}

/* -------------------------------------------------------------- duffel */

/* Duffel reports what a fare INCLUDES, not what extras cost. That is a different
 * shape of knowledge from Google's free text, and a more useful one here:
 *
 *   - checked quantity >= 1  -> a bag is included, genuinely free. Known.
 *   - checked quantity == 0  -> no bag included. We still do not know the fee,
 *                               but we now know WHICH fares need one -- so the
 *                               assumption lands only on those, and therefore
 *                               actually moves the ranking instead of adding a
 *                               constant to everything.
 *   - carry_on quantity      -> resolves carry_on_included to a real true/false,
 *                               which Google never gave us at all.
 */
function duffelBags(passenger) {
  const bags = (passenger && passenger.baggages) || [];
  let checked = 0, carryOn = 0;
  for (const b of bags) {
    if (b.type === 'checked') checked += b.quantity || 0;
    if (b.type === 'carry_on') carryOn += b.quantity || 0;
  }
  if (checked > 0) {
    return { carry_on_included: carryOn > 0, checked_first_price: 0, confidence: 'parsed' };
  }
  // No checked bag in the fare: known to be chargeable, amount still unknown.
  return { carry_on_included: carryOn > 0, checked_first_price: null, confidence: 'fee_unknown' };
}

/* Durations must come from Duffel's own field. Subtracting local wall-clock
 * times would be wrong across timezones -- which is exactly the London case. */
function parseIsoDuration(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(iso || '');
  if (!m) return null;
  return (+(m[1] || 0)) * 1440 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
}

const localStamp = (iso) => String(iso || '').replace('T', ' ').slice(0, 16);

function extractDuffelOptions(payload, limit) {
  const offers = (payload.data && payload.data.offers) || [];
  const out = [];

  for (const offer of offers) {
    const slice = (offer.slices || [])[0];
    if (!slice) continue;
    const segs = slice.segments || [];
    if (!segs.length) continue;

    const first = segs[0], last = segs[segs.length - 1];
    const price = parseFloat(offer.total_amount);
    if (!isFinite(price)) continue;

    const airlines = [];
    for (const seg of segs) {
      const n = seg.marketing_carrier && seg.marketing_carrier.name;
      if (n && !airlines.includes(n)) airlines.push(n);
    }

    let duration = parseIsoDuration(slice.duration);
    if (duration == null) {
      duration = segs.reduce((sum, seg) => sum + (parseIsoDuration(seg.duration) || 0), 0) || null;
    }

    const bags = duffelBags((offer.passengers || [])[0]);
    const brand = slice.fare_brand_name || offer.fare_brand_name || null;

    out.push({
      price,
      depart: localStamp(first.departing_at),
      arrive: localStamp(last.arriving_at),
      duration_minutes: duration,
      stops: Math.max(segs.length - 1, 0),
      airlines,
      from: (first.origin && first.origin.iata_code) || null,
      to: (last.destination && last.destination.iata_code) || null,
      airline_logo: (first.marketing_carrier && first.marketing_carrier.logo_symbol_url) || null,
      fare_brand: brand,
      extensions: brand ? ['Fare brand: ' + brand] : [],
      bags,
    });
  }

  out.sort((a, b) => a.price - b.price);
  return out.slice(0, limit);
}

async function duffelSearch(env, params) {
  const res = await fetch(DUFFEL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.DUFFEL_TOKEN,
      'Duffel-Version': 'v2',
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      data: {
        slices: [{
          origin: params.departure_id.split(',')[0],
          destination: params.arrival_id.split(',')[0],
          departure_date: params.outbound_date,
        }],
        passengers: [{ type: 'adult' }],
        cabin_class: 'economy',
      },
    }),
  });

  const payload = await res.json();
  if (payload.errors && payload.errors.length) {
    throw new Error(payload.errors[0].message || payload.errors[0].title || 'Duffel error');
  }
  return { options: extractDuffelOptions(payload, LIMITS.optionsPerLeg), insights: null };
}

/* -------------------------------------------------------------- budget */

const monthKey = () => 'budget:' + new Date().toISOString().slice(0, 7);
const dayKey = () => 'budget:' + new Date().toISOString().slice(0, 10);
const hourKey = () => 'budget:h:' + new Date().toISOString().slice(0, 13);
const ipHourKey = b => 'rl:h:' + b + ':' + new Date().toISOString().slice(0, 13);
const ipDayKey = b => 'rl:d:' + b + ':' + new Date().toISOString().slice(0, 10);
const ipReqKey = b => 'rq:' + b + ':' + new Date().toISOString().slice(0, 13);
const tripWriteKey = b => 'tw:' + b + ':' + new Date().toISOString().slice(0, 10);

async function counter(env, key) {
  const v = await env.FWF.get(key);
  return v ? +v : 0;
}

async function bump(env, key, by, ttl) {
  const next = Math.max(0, (await counter(env, key)) + by);
  await env.FWF.put(key, String(next), { expirationTtl: ttl });
  return next;
}

function monthResetsAt() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

/* --------------------------------------------------------------- search */

/* Provider is part of the cache key: the two return different option sets for
 * the same route, and mixing them would silently compare unlike things. */
function cacheKey(params, provider) {
  return 'leg:' + [provider, params.departure_id, params.arrival_id, params.outbound_date,
                   params.currency, params.bags].join('|');
}

function extractInsights(payload) {
  const p = payload.price_insights;
  if (!p) return null;
  return {
    level: p.price_level || null,
    lowest: p.lowest_price == null ? null : p.lowest_price,
    typical: Array.isArray(p.typical_price_range) ? p.typical_price_range : null,
  };
}

async function serpapiSearch(env, params) {
  const url = new URL(SERPAPI_ENDPOINT);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('engine', 'google_flights');
  url.searchParams.set('api_key', env.SERPAPI_KEY);

  const res = await fetch(url.toString());
  const payload = await res.json();
  if (payload.error) throw new Error(payload.error);
  return { options: extractOptions(payload, LIMITS.optionsPerLeg), insights: extractInsights(payload) };
}

/* Returns { options, insights, spent, empty }.
 *
 * spent is 1 whenever the provider was actually called, INCLUDING when it comes
 * back with no itineraries. A route with no service is still a billed search --
 * this previously threw before counting, so the guard undercounted against
 * SerpApi's own meter, which is the dangerous direction for something whose job
 * is protecting a quota.
 *
 * Empty results are cached too: there is no reason to pay a second time to learn
 * that Kyiv still has no flights. */
async function oneSearch(env, params, provider) {
  const key = cacheKey(params, provider);
  const hit = await env.FWF.get(key, 'json');
  if (hit) {
    /* Entries cached before insights existed are a bare array. */
    const cached = Array.isArray(hit)
      ? { options: hit, insights: null }
      : { options: hit.options || [], insights: hit.insights || null };
    return { ...cached, spent: 0, empty: !cached.options.length };
  }

  /* Throws only on transport failure or an explicit provider error, neither of
   * which SerpApi bills for. */
  const got = provider === 'duffel'
    ? await duffelSearch(env, params)
    : await serpapiSearch(env, params);

  await env.FWF.put(key, JSON.stringify(got), { expirationTtl: LIMITS.cacheTtlSeconds });
  return { options: got.options, insights: got.insights, spent: 1, empty: !got.options.length };
}

function validate(body) {
  const code = /^[A-Z]{3}$/;
  const date = /^\d{4}-\d{2}-\d{2}$/;

  if (!Array.isArray(body.travelers) || body.travelers.length < 2) {
    return 'Add at least two people.';
  }
  if (body.travelers.length > LIMITS.maxTravelers) {
    return 'Maximum ' + LIMITS.maxTravelers + ' people.';
  }
  if (!Array.isArray(body.dest) || !body.dest.length || !body.dest.every(a => code.test(a))) {
    return 'Destination must be a 3-letter airport code.';
  }
  if (!date.test(body.depart || '')) return 'Departure date must be YYYY-MM-DD.';
  if (!realDateInWindow(body.depart)) {
    return 'That departure date is in the past or further out than airlines have published.';
  }
  if (body.ret && !date.test(body.ret)) return 'Return date must be YYYY-MM-DD.';
  if (body.ret && !realDateInWindow(body.ret)) {
    return 'That return date is further out than airlines have published.';
  }
  if (body.ret && body.ret < body.depart) return 'Return date is before the departure date.';

  for (const t of body.travelers) {
    if (!Array.isArray(t.origins) || !t.origins.length || !t.origins.every(a => code.test(a))) {
      return 'Every person needs at least one 3-letter origin airport.';
    }
  }
  return null;
}

async function handleSearch(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Malformed request.' }, 400); }

  normalize(body);
  const invalid = validate(body);
  if (invalid) return json({ error: invalid }, 400);

  const bucket = ipBucket(request);

  /* A loose request guard so the endpoint is not a free KV-read amplifier,
   * separate from the search caps below which count the scarce thing. */
  if ((await counter(env, ipReqKey(bucket))) >= LIMITS.perIpRequestsHourly) {
    return json({ error: 'That looks automated. If you are a person, wait a minute and try again.' }, 429);
  }
  await bump(env, ipReqKey(bucket), 1, 60 * 60 * 2);

  /* Provider resolution: an explicit request wins, then the PROVIDER var in
   * wrangler.toml, then SerpApi. Per-request selection is what lets the same
   * route be run through both and compared. */
  /* Not client-selectable: provider is part of the cache key, so letting a
   * caller choose doubles the cost of every route by requesting both. */
  const provider = (env.ALLOW_PROVIDER_OVERRIDE === 'on' && body.provider)
    || env.PROVIDER || 'serpapi';
  if (provider !== 'serpapi' && provider !== 'duffel') {
    return json({ error: 'Unknown provider "' + provider + '".' }, 400);
  }
  if (provider === 'serpapi' && !env.SERPAPI_KEY) {
    return json({ error: 'SerpApi is not configured on this deployment.' }, 503);
  }
  if (provider === 'duffel' && !env.DUFFEL_TOKEN) {
    return json({ error: 'Duffel is not configured on this deployment. Set the DUFFEL_TOKEN secret.' }, 503);
  }

  const currency = body.currency || 'USD';
  const carryOn = Math.max(0, ...body.travelers.map(t => (t.bags && t.bags.carry_on) || 0));

  /* Build the full job list up front so the budget is checked against the real
   * cost, not discovered halfway through. */
  const jobs = [];
  for (const t of body.travelers) {
    jobs.push({ id: t.id, leg: 'outbound', params: {
      type: 2, departure_id: t.origins.join(','), arrival_id: body.dest.join(','),
      outbound_date: body.depart, currency, adults: 1, bags: carryOn, hl: 'en', gl: 'us' } });
    if (body.ret) {
      jobs.push({ id: t.id, leg: 'return', params: {
        type: 2, departure_id: body.dest.join(','), arrival_id: t.origins.join(','),
        outbound_date: body.ret, currency, adults: 1, bags: carryOn, hl: 'en', gl: 'us' } });
    }
  }

  const [used, usedToday, usedHour] = await Promise.all([
    counter(env, monthKey()), counter(env, dayKey()), counter(env, hourKey()),
  ]);

  /* Two people flying from the same city are the same search. Because jobs run in
   * parallel they would both miss the cache and both be billed, so collapse them
   * to one request per distinct (route, date) and fan the result back out. */
  const unique = new Map();
  for (const job of jobs) {
    const key = cacheKey(job.params, provider);
    if (!unique.has(key)) unique.set(key, { params: job.params, key, jobs: [] });
    unique.get(key).jobs.push(job);
  }
  const uniqueSearches = [...unique.values()];

  /* How many of these are not already cached -- that is the real spend. */
  const cachedFlags = await Promise.all(uniqueSearches.map(u => env.FWF.get(u.key)));
  const toSpend = cachedFlags.filter(v => !v).length;

  const budget = {
    used, limit: LIMITS.monthly, usedToday, dailyLimit: LIMITS.daily,
    resetsAt: monthResetsAt(), wouldSpend: toSpend,
  };

  if (toSpend > 0 && used + toSpend > LIMITS.monthly) {
    return json({ error: 'Fly with Friends has used this month\'s flight-data allowance. '
      + 'Shared links and recent searches still work, and it resets on ' + budget.resetsAt + '.',
      budget, exhausted: 'month' }, 429);
  }
  if (toSpend > 0 && usedToday + toSpend > LIMITS.daily) {
    return json({ error: 'Fly with Friends has used today\'s flight-data allowance. '
      + 'Shared links and recent searches still work, and more is available tomorrow.',
      budget, exhausted: 'day' }, 429);
  }
  if (toSpend > 0 && usedHour + toSpend > LIMITS.globalHourly) {
    return json({ error: 'Unusually heavy traffic in the last hour, so searching is '
      + 'briefly paused to protect the allowance. Shared links still work.',
      budget, exhausted: 'hour' }, 429);
  }

  /* Reserve before calling the provider. Read-modify-write on KV is
   * last-write-wins, so checking and then spending across a multi-second
   * provider round trip let parallel requests all pass the same check. This
   * shrinks that window to a single KV hop; it does not close it. A Durable
   * Object is the real fix and is the next thing to build. */
  if (toSpend > 0) {
    await Promise.all([
      bump(env, monthKey(), toSpend, 60 * 60 * 24 * 40),
      bump(env, dayKey(), toSpend, 60 * 60 * 36),
      bump(env, hourKey(), toSpend, 60 * 60 * 2),
    ]);
  }

  const searched = await Promise.all(uniqueSearches.map(async u => {
    try {
      const { options, insights, spent, empty } = await oneSearch(env, u.params, provider);
      return { ...u, options, insights, spent,
               error: empty ? 'no results for this route and date' : null };
    } catch (err) {
      return { ...u, options: [], insights: null, spent: 0, error: err.message };
    }
  }));

  /* Fan one result back out to everyone who shares that route and date. */
  const results = [];
  for (const u of searched) {
    for (const job of u.jobs) {
      results.push({ ...job, options: u.options, insights: u.insights, spent: 0, error: u.error });
    }
  }
  const spentTotal = searched.reduce((n, u) => n + u.spent, 0);

  /* Refund whatever was reserved but never actually billed -- transport
   * failures and provider errors are not charged by SerpApi. */
  const spent = spentTotal;
  const refund = toSpend - spent;
  if (refund > 0) {
    await Promise.all([
      bump(env, monthKey(), -refund, 60 * 60 * 24 * 40),
      bump(env, dayKey(), -refund, 60 * 60 * 36),
      bump(env, hourKey(), -refund, 60 * 60 * 2),
    ]);
  }

  const trips = { query: { outbound: {}, return: {} } };
  const insights = { outbound: {}, return: {} };
  const errors = [];
  for (const r of results) {
    trips.query[r.leg][r.id] = r.options;
    if (r.insights) insights[r.leg][r.id] = r.insights;
    if (r.error) errors.push({ traveler_id: r.id, leg: r.leg, reason: r.error });
  }

  return json({
    generated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    currency, provider, sample: false, trips, insights, errors,
    budget: { ...budget, used: used + spent, usedToday: usedToday + spent },
    provider_errors: errors.length,
    searches_made: spent,
    distinct_routes: uniqueSearches.length,
    cached: spent === 0,
  });
}

/* Exported so the parsers and validator can be tested directly -- the bag parser
 * here must stay in step with the Python one in .github/scripts/scan.py, and
 * test-worker.js checks exactly that. */
/* ------------------------------------------------------------ shared trips */

/* Sharing used to mean re-running the whole search on the recipient's device:
 * free for 24 hours from cache, then billed again, and billed once more for
 * every person in the group chat who opened it late. Saving the finished trip
 * instead makes a shared link cost exactly one KV read, forever -- which is
 * both the efficiency and the only honest way to hand this to a group. */
function tripId() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return Array.from(a, b => 'abcdefghijkmnopqrstuvwxyz23456789'[b % 33]).join('');
}

async function saveTrip(request, env) {
  let body;
  try { body = await request.text(); } catch (e) { return json({ error: 'Malformed request.' }, 400); }
  if (!body || body.length > LIMITS.tripBytesMax) {
    return json({ error: 'Trip too large to share.' }, 413);
  }

  /* Shape, not just syntax. This namespace holds trips; without a shape check
   * it is free storage for whatever anyone cares to post, and the free tier
   * allows only 1,000 KV writes a day -- shared with the budget counters and
   * the search cache, so filling it stops the accounting working. */
  let trip;
  try { trip = JSON.parse(body); } catch (e) { return json({ error: 'Malformed trip.' }, 400); }
  if (!trip || trip.v !== 1 || !trip.data || typeof trip.data.trips !== 'object') {
    return json({ error: 'Not a trip.' }, 400);
  }

  const bucket = ipBucket(request);
  const wkey = tripWriteKey(bucket);
  if ((await counter(env, wkey)) >= LIMITS.perIpTripWrites) {
    return json({ error: 'Too many shared trips from this network today.' }, 429);
  }

  const id = tripId();
  /* tripId is ~30 bits, and put() overwrites silently. */
  if (await env.FWF.get('trip:' + id)) return json({ error: 'Please try sharing again.' }, 503);

  await env.FWF.put('trip:' + id, body, { expirationTtl: LIMITS.tripTtlSeconds });
  await bump(env, wkey, 1, 60 * 60 * 26);
  return json({ id, expires_in_days: Math.round(LIMITS.tripTtlSeconds / 86400) });
}

async function readTrip(id, env) {
  if (!/^[a-z2-9]{6,12}$/.test(id || '')) return json({ error: 'Not a trip id.' }, 400);
  const raw = await env.FWF.get('trip:' + id, { cacheTtl: 300 });
  if (!raw) return json({ error: 'That trip has expired or never existed.' }, 404);
  return new Response(raw, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', ...CORS },
  });
}

export const _internals = { parseBags, validate, extractOptions, extractInsights, cacheKey, LIMITS, tripId,
                            duffelBags, parseIsoDuration, extractDuffelOptions, localStamp };

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const path = new URL(request.url).pathname;

    if (path === '/budget' && request.method === 'GET') {
      const [used, usedToday] = await Promise.all([
        env.FWF.get(monthKey(), { cacheTtl: 60 }).then(v => (v ? +v : 0)),
        env.FWF.get(dayKey(), { cacheTtl: 60 }).then(v => (v ? +v : 0)),
      ]);
      return new Response(JSON.stringify({ used, limit: LIMITS.monthly, usedToday,
          dailyLimit: LIMITS.daily, resetsAt: monthResetsAt(),
          low: used > LIMITS.monthly * 0.8, exhausted: used >= LIMITS.monthly }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...CORS },
      });
    }

    /* Writes are gated on Origin; reads are not, so a shared link keeps working
     * from anywhere -- including a messaging app's in-page browser. */
    if (request.method === 'POST' && !originOk(request, env)) {
      return json({ error: 'This endpoint only serves the Fly with Friends app.' }, 403);
    }

    if (path === '/trip' && request.method === 'POST') {
      try { return await saveTrip(request, env); }
      catch (err) { return json({ error: 'Could not save trip: ' + err.message }, 500); }
    }

    if (path.startsWith('/trip/') && request.method === 'GET') {
      try { return await readTrip(path.slice(6), env); }
      catch (err) { return json({ error: 'Could not load trip: ' + err.message }, 500); }
    }

    if (path === '/search' && request.method === 'POST') {
      /* A plain variable so searching can be switched off from the dashboard in
       * seconds, without a redeploy, while cached results and shared links keep
       * working. */
      if (env.SEARCH_ENABLED === 'off') {
        return json({ error: 'New searches are paused right now. Shared links and '
          + 'recent searches still work.' }, 503);
      }
      try { return await handleSearch(request, env); }
      catch (err) {
        /* Provider errors name account and plan state, so they are logged and
         * not returned. */
        console.log('search failed:', err && err.message);
        return json({ error: 'Search failed. Try again shortly.' }, 500);
      }
    }

    return json({ error: 'Not found' }, 404);
  },
};
