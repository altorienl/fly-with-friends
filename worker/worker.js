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
   *
   * There is no daily cap. There was one, and it was the wrong shape: the
   * provider does not bill for overage, it refuses, so spending a month's
   * allowance quickly costs nothing except having spent it. The only thing a
   * daily cap bought was telling a real group "come back tomorrow" on the one
   * day they were actually planning a trip, which is the worst day to say it.
   * "any use is good use" -- so the month is the month, and it is the owner's
   * to spend however fast it goes.
   *   - globalHourly is a runaway brake, set far above any human session, so a
   *     script cannot convert the whole month into one minute before anyone
   *     notices. It is deliberately generous: a burst it blocks is a burst no
   *     group of friends would ever produce.
   * Separating humans from scripts is Turnstile's job, not a quota's. */
  /* The FREE tier's numbers, and now only a floor. The real ceiling is read
   * from the provider -- see planCaps -- so moving to a bigger plan takes
   * effect on its own rather than waiting for somebody to remember to edit this
   * line and redeploy. These apply when the account call fails, which is the
   * safe direction to be wrong in. */
  monthly: 230,      // of the free tier's 250, leaving headroom for manual scans
  globalHourly: 60,
  planHeadroom: 0.95,   // of the plan's monthly allowance
  hourHeadroom: 0.9,    // of the plan's hourly throughput
  perIpRequestsHourly: 240,   // anti-script only; ~40 group searches an hour
  perIpTripWrites: 40,

  /* One TTL was answering two different questions. A fare nine months out barely
   * moves and a week-old quote is still right; a fare next week moves hourly and
   * a day-old quote is wrong. Grading it by how far out the flight is buys the
   * thing that actually costs money and buys it where staleness is cheapest.
   *
   * Then somebody tapped Book on a three-day-old quote and got Google's "the
   * itinerary you selected is no longer available". Three days was chosen when
   * the whole month was 250 searches and every one of them had to be hoarded;
   * on the $25 plan it is 1,000, so the trade reverses -- 12 hours, 3 days and
   * a week become 2 hours, 6 hours and a day.
   *
   * What makes that affordable is that a shared ?t= link reads a stored
   * snapshot and never searches. The TTL is only ever paid when somebody
   * presses the search button, which a group does a handful of times while
   * planning -- not once per person per visit. */
  cacheTtlSeconds: 60 * 60 * 6,             // fallback when the date is unreadable
  legTtlNearSeconds: 60 * 60 * 2,           // departing inside 14 days
  legTtlMidSeconds: 60 * 60 * 6,            // 15-60 days out
  legTtlFarSeconds: 60 * 60 * 24,           // 60+ days out
  legTtlNearDays: 14,
  legTtlMidDays: 60,

  maxTravelers: 8,
  optionsPerLeg: 25,
  tripTtlSeconds: 60 * 60 * 24 * 30,   // a shared trip stays openable for a month
  tripBytesMax: 256 * 1024,            // a real 8-person round trip is ~150KB
  /* The entire rate limit on roster updates, and it costs nothing, because it
   * rides the write it bounds: the counter lives inside the trip, so the KV
   * put that records a status change is also the put that increments it. A
   * real group needs at most one per person -- eight -- so 200 is twenty-five
   * times the honest ceiling and still bounds a hostile loop to 200 writes
   * against the 1,000-a-day account allowance. */
  tripMarksMax: 200,
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
  /* Five, because London genuinely has five and a traveller picking "London"
   * should not silently lose two of them. Still one search either way. */
  const clean = a => [...new Set((a || []).map(x => String(x).toUpperCase().slice(0, 3)))].sort().slice(0, 5);
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
  /* Accept is on the list because the search endpoint negotiates its
   * progress stream with it. Content-Type already forces a preflight on every
   * POST, so this costs nothing extra on the wire. */
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
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

    /* Carrier + number per segment, which is what lets the app hand somebody a
     * link to THIS itinerary's booking screen instead of a search they have to
     * redo by hand. Google accepts a bogus flight number silently and shows an
     * empty screen, so these must come from the live search -- never guessed --
     * and the app falls back to a plain search link if any segment lacks one. */
    const segs = [];
    for (const leg of legs) {
      const fn = String(leg.flight_number || '').trim();
      const m = fn.match(/^([A-Z0-9]{1,3})\s*([0-9]{1,4}[A-Z]?)$/i);
      const dep = leg.departure_airport || {}, arr = leg.arrival_airport || {};
      segs.push({
        from: dep.id || null,
        to: arr.id || null,
        date: typeof dep.time === 'string' ? dep.time.slice(0, 10) : null,
        carrier: m ? m[1].toUpperCase() : null,
        number: m ? m[2] : null,
      });
    }

    out.push({
      price: it.price,
      depart, arrive,
      duration_minutes: it.total_duration,
      stops: Math.max(legs.length - 1, 0),
      airlines,
      from: first.departure_airport && first.departure_airport.id,
      to: last.arrival_airport && last.arrival_airport.id,
      airline_logo: it.airline_logo || first.airline_logo,
      segs,
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
                   params.currency].join('|');
}

function legTtl(departIso) {
  const days = (Date.parse(departIso + 'T00:00:00Z') - Date.now()) / 86400000;
  if (!isFinite(days)) return LIMITS.cacheTtlSeconds;
  if (days <= LIMITS.legTtlNearDays) return LIMITS.legTtlNearSeconds;
  if (days <= LIMITS.legTtlMidDays) return LIMITS.legTtlMidSeconds;
  return LIMITS.legTtlFarSeconds;
}

/* What a request costs, as a pure function, so the economics can be measured
 * without spending anything.
 *
 * `jobs` is one entry per (traveller, leg) -- what the app asked for. `unique`
 * is what the provider is actually asked, after collapsing travellers who share
 * an origin set. The gap between those two numbers is the whole cost story:
 * eight people from eight cities round trip is 16 jobs and 16 searches, but
 * eight people from one city is 16 jobs and 2 searches.
 *
 * Note what is NOT in the key: `bags`, `adults`, `hl`, `gl`. Two groups with
 * different carry-on counts share one cached result. That is cheaper and it is
 * also wrong -- see test-worker.js, which pins it as a number so a future change
 * to either side shows up in a diff rather than in next month's bill. */
function planSearches(body, provider) {
  const currency = body.currency || 'USD';
  const carryOn = Math.max(0, ...body.travelers.map(t => (t.bags && t.bags.carry_on) || 0));

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

  /* Two people flying from the same city are the same search. Because jobs run in
   * parallel they would both miss the cache and both be billed, so collapse them
   * to one request per distinct (route, date) and fan the result back out. */
  const unique = new Map();
  for (const job of jobs) {
    const key = cacheKey(job.params, provider);
    if (!unique.has(key)) unique.set(key, { params: job.params, key, jobs: [] });
    unique.get(key).jobs.push(job);
  }

  return { currency, jobs, unique: [...unique.values()] };
}

/* ---------------------------------------------------- the provider's own meter
 *
 * SerpApi publishes its own usage at /account.json, free, and explicitly not
 * counted as a search (serpapi.com/account-api). That is worth more than it
 * sounds, because our KV counter cannot be made correct:
 *
 *   - it is a read-modify-write on ONE key, and Workers KV is last-write-wins;
 *   - KV caches reads for 60s by DEFAULT, with a 30s floor, even at the location
 *     that did the write -- so the value a request reads is routinely stale no
 *     matter how tight the code around it is;
 *   - writes to a single key are capped at 1/second on every plan, free or paid.
 *
 * So the counter does not merely race, it runs quietly LOW, and GET /budget
 * reports a comfortable number while the provider's meter keeps going. The
 * provider's own number cannot undercount. It is fetched only on the search
 * path, which is already making a provider round trip, and snapshotted once per
 * spending request -- so GET /budget can tell the truth without adding a KV
 * write per page load. */
const PROVIDER_SNAPSHOT = 'budget:provider';

async function fetchAccount(env) {
  if (!env.SERPAPI_KEY) return null;
  const res = await fetch('https://serpapi.com/account.json?api_key='
    + encodeURIComponent(env.SERPAPI_KEY));
  const a = await res.json();
  if (!a || typeof a !== 'object' || a.error) return null;
  return {
    used: Number(a.this_month_usage),
    left: Number(a.total_searches_left),
    perMonth: Number(a.searches_per_month),
    hourLimit: Number(a.account_rate_limit_per_hour),
    thisHour: Number(a.this_hour_searches),
    at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  };
}

/* What the plan actually allows, rather than what was true when this was
 * written. SerpApi reports searches_per_month and account_rate_limit_per_hour,
 * so the free tier's 250/50 and the $25 tier's 1,000/200 are the same code
 * path and an upgrade needs no deploy. Headroom is kept under each because our
 * counter and theirs can disagree by a search or two and theirs is the one
 * that refuses.
 *
 * Falls back to the free-tier floor whenever the account call failed, which is
 * the safe direction: spending less than allowed costs a search, spending more
 * than allowed costs a group their trip mid-search. */
function planCaps(acct) {
  const perMonth = acct && isFinite(acct.perMonth) && acct.perMonth > 0 ? acct.perMonth : null;
  const perHour = acct && isFinite(acct.hourLimit) && acct.hourLimit > 0 ? acct.hourLimit : null;
  const monthly = perMonth ? Math.floor(perMonth * LIMITS.planHeadroom) : LIMITS.monthly;
  return {
    monthly: monthly,
    hourly: perHour ? Math.floor(perHour * LIMITS.hourHeadroom) : LIMITS.globalHourly,
  };
}

/* Gates on total_searches_left, not this_month_usage: a plan renews on its own
 * anniversary rather than the first of the calendar month, so the two can
 * disagree about which month a search belongs to. "How many will they still
 * serve me" has no such ambiguity.
 *
 * Returns null -- allow -- whenever the snapshot is missing or unreadable. A
 * telemetry call must never be the thing that stops a real group searching. */
function accountGate(acct, toSpend) {
  if (!acct || !isFinite(acct.left)) return null;
  if (acct.left <= 0) return 'exhausted';
  if (toSpend > acct.left) return 'exhausted';
  /* The free plan serves 50 searches an hour and paid plans serve more, so the
   * hourly brake is read off the account rather than hard-coded: it rises by
   * itself on upgrade instead of becoming the new bottleneck. Without this the
   * 51st search in an hour is not refused, it is accepted and then rejected
   * upstream, which the user sees as "could not be searched right now". */
  if (isFinite(acct.hourLimit) && acct.hourLimit > 0 && isFinite(acct.thisHour)
      && acct.thisHour + toSpend > acct.hourLimit) return 'hour';
  return null;
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
  /* Yes, handleSearch already probed this key to count toSpend, and no, the
   * result should not be threaded through to save the read. Reads are not the
   * scarce thing -- 100,000 a day against 250 searches a month -- and between
   * the two reads a sibling request may have populated the cache, in which case
   * this one gets the answer free and the reservation is refunded. Passing the
   * first read's value down would spend a search a sibling had just bought. */
  const hit = await env.FWF.get(key, 'json');
  if (hit) {
    /* Entries cached before insights existed are a bare array, and entries
     * cached before `at` existed carry no fetch time at all -- both age out
     * within the week, and until they do the caller reports the age it can
     * actually stand behind, which is none. */
    const cached = Array.isArray(hit)
      ? { options: hit, insights: null, at: null }
      : { options: hit.options || [], insights: hit.insights || null, at: hit.at || null };
    return { ...cached, spent: 0, empty: !cached.options.length };
  }

  /* Throws only on transport failure or an explicit provider error, neither of
   * which SerpApi bills for. */
  const got = provider === 'duffel'
    ? await duffelSearch(env, params)
    : await serpapiSearch(env, params);

  /* Stamped with the moment it was actually fetched. Without it a cached leg
   * is indistinguishable from a fresh one, and the app reported every response
   * as "fares just now" -- including a three-day-old quote for a flight that
   * had since sold out. Somebody tapped Book, landed on "the itinerary you
   * selected is no longer available", and could only conclude the app was
   * broken: "I just searched for this flight and its already gone??" They had
   * not just searched it. The app said they had. */
  const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  await env.FWF.put(key, JSON.stringify({ ...got, at }),
                    { expirationTtl: legTtl(params.outbound_date) });
  return { options: got.options, insights: got.insights, at, spent: 1,
           empty: !got.options.length };
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

/* `onLegs` is optional and is the whole of the streaming seam. Called with an
 * array of { id, leg, found, error } the moment a provider search resolves,
 * and never called at all when the caller did not ask for progress -- in which
 * case this function behaves exactly as it did before it existed. Everything
 * that guards money (the request guard, the account gate, the monthly and
 * hourly caps, the reserve-before-spend and the refund) runs in the same order
 * either way, because none of it moved. */
async function handleSearch(request, env, onLegs) {
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

  /* Build the full job list up front so the budget is checked against the real
   * cost, not discovered halfway through. */
  const { currency, unique: uniqueSearches } = planSearches(body, provider);

  /* The counters and the cache probe in one hop rather than two. The last of
   * these is the real question: how many of these legs are NOT already cached.
   * That, not the number of travellers, is what the month is charged. */
  const [used, usedToday, usedHour, ...cachedFlags] = await Promise.all([
    counter(env, monthKey()), counter(env, dayKey()), counter(env, hourKey()),
    ...uniqueSearches.map(u => env.FWF.get(u.key)),
  ]);
  const toSpend = cachedFlags.filter(v => !v).length;

  /* Only asked for on requests that are about to cost money. It is free and
   * unbilled, but a fully-cached shared link opened by a hundred people should
   * not turn into a hundred calls to the account API either. */
  const acct = (toSpend > 0 && provider === 'serpapi')
    ? await fetchAccount(env).catch(() => null) : null;

  /* A fully-cached request asks the provider nothing, so `acct` is null and
   * planCaps would fall back to the free-tier floor -- reporting a 950-search
   * plan as 230. Harmless while the counter is small, and not harmless at all
   * past 230, where a cached response would start telling the app the month
   * was spent and grey out the search button with two thirds of the plan
   * unused. The snapshot the spending path already writes is the right answer
   * here; only the gate below needs a figure fresh enough to refuse on, and
   * the gate only runs when toSpend > 0, which is when `acct` is real. */
  const known = acct
    || (provider === 'serpapi'
        ? await env.FWF.get(PROVIDER_SNAPSHOT, { type: 'json', cacheTtl: 60 }).catch(() => null)
        : null);
  const caps = planCaps(known);
  const budget = {
    /* usedToday is reported, not enforced: it is the number that tells you
     * whether something is running away, and nothing refuses on it. */
    used, limit: caps.monthly, usedToday,
    resetsAt: monthResetsAt(), wouldSpend: toSpend,
    /* The provider's own figure, next to ours. When these disagree, ours is the
     * one that is wrong -- see the note on PROVIDER_SNAPSHOT. */
    providerLeft: acct && isFinite(acct.left) ? acct.left : null,
    providerUsed: acct && isFinite(acct.used) ? acct.used : null,
  };

  /* Checked before our own counters, because it is the only number here that
   * cannot be quietly low. */
  const gate = toSpend > 0 ? accountGate(acct, toSpend) : null;
  if (gate === 'exhausted') {
    return json({ error: 'Fly with Friends has used this month\'s flight-data allowance. '
      + 'Shared links and recent searches still work, and it resets on ' + budget.resetsAt + '.',
      budget, exhausted: 'month' }, 429);
  }
  if (gate === 'hour') {
    return json({ error: 'Unusually heavy traffic in the last hour, so searching is '
      + 'briefly paused to protect the allowance. Shared links still work.',
      budget, exhausted: 'hour' }, 429);
  }

  /* planCaps(acct), not caps: refusing on a snapshot that could be a month old
   * is the one direction that costs a group their trip. When the account call
   * failed this is the free-tier floor again, deliberately. */
  if (toSpend > 0 && used + toSpend > planCaps(acct).monthly) {
    return json({ error: 'Fly with Friends has used this month\'s flight-data allowance. '
      + 'Shared links and recent searches still work, and it resets on ' + budget.resetsAt + '.',
      budget, exhausted: 'month' }, 429);
  }
  /* The hourly brake stays, and it is not a quota. It is set far above any
   * human session so that a script cannot convert a whole month into one
   * minute before anybody notices -- a burst it blocks is a burst no group of
   * friends could produce. Removing it would not give a real group anything,
   * and would hand a runaway loop the entire allowance. */
  if (toSpend > 0 && usedHour + toSpend > caps.hourly) {
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
      /* The anti-script counter is bumped here rather than on every request.
       * Writing it up front made this endpoint a KV-write amplifier: 240 an
       * hour per IP against a 1000-a-day account ceiling, with no provider
       * spend at all -- and running the account out of writes stops saved trip
       * links working for everyone. Charging only requests that actually
       * reserve a search is strictly more permissive than before. */
      bump(env, ipReqKey(bucket), 1, 60 * 60 * 2),
      bump(env, monthKey(), toSpend, 60 * 60 * 24 * 40),
      bump(env, dayKey(), toSpend, 60 * 60 * 36),
      bump(env, hourKey(), toSpend, 60 * 60 * 2),
      /* One write, on the only requests that cost money, so GET /budget can
       * report the provider's figure without a provider call -- and therefore
       * without a KV write -- on every page load. */
      acct ? env.FWF.put(PROVIDER_SNAPSHOT, JSON.stringify(acct),
                         { expirationTtl: 60 * 60 * 24 * 2 }) : Promise.resolve(),
    ]);
  }

  /* One unique search can serve several travelers -- two people flying from
   * the same city are one request -- so a resolved search is announced to
   * every job it covers, by exactly the same fan-out the results use below.
   * Announcing per unique search instead would leave the second of two people
   * from Chicago waiting forever for an event that was never going to come. */
  const announce = u => {
    if (!onLegs) return;
    try {
      onLegs(u.jobs.map(job => ({
        id: job.id, leg: job.leg,
        /* How many itineraries came back, not a percentage of anything. Zero
         * is a real answer and says so; it is not the same as a failure. */
        found: u.options.length,
        /* A closed three-word vocabulary, not the provider's prose. null is
         * "flights came back"; "none" is a route with no service on that
         * date, which is an answer; "failed" is "we could not ask", which is
         * not. The screen says different things for the last two and must
         * not have to tell them apart by matching on an English sentence. */
        error: u.code || null,
      })));
    } catch (e) { /* a broken listener must not fail the search */ }
  };

  const searched = await Promise.all(uniqueSearches.map(async u => {
    try {
      const { options, insights, at, spent, empty } = await oneSearch(env, u.params, provider);
      const done = { ...u, options, insights, at, spent,
                     error: empty ? 'no results for this route and date' : null,
                     code: empty ? 'none' : null };
      announce(done);
      return done;
    } catch (err) {
      /* The provider's own text names the account and the plan. The top-level
       * catch already withholds it; this path did not. */
      console.log('leg failed:', u.key, err && err.message);
      const done = { ...u, options: [], insights: null, at: null, spent: 0,
                     error: 'could not be searched right now', code: 'failed' };
      announce(done);
      return done;
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

  /* The OLDEST leg on the screen, not the moment the response was built. A
   * trip is as current as its stalest fare: quoting the freshest one, or the
   * clock, is how a three-day-old price gets a green dot. A leg whose age is
   * unknown makes the whole thing unknown rather than optimistic -- the app
   * already says "age unknown" for that, and it is the honest answer. */
  const ages = searched.filter(u => !u.error).map(u => u.at);
  const asOf = ages.length && ages.every(Boolean)
    ? ages.reduce((a, b) => (a < b ? a : b))
    : null;

  return json({
    generated_at: asOf,
    currency, provider, sample: false, trips, insights, errors,
    budget: { ...budget, used: used + spent, usedToday: usedToday + spent },
    provider_errors: errors.length,
    searches_made: spent,
    distinct_routes: uniqueSearches.length,
    cached: spent === 0,
  });
}

/* ----------------------------------------------------------- streaming
 *
 * Why this exists, and why it is opt-in.
 *
 * One POST fans out to every traveler and both legs, and until now the
 * browser could see exactly two things: sent, and arrived. Measured against
 * the live deployment, the gap between those two is 0.25s when every leg is
 * cached and 2.6-7.6s when they are not, so the app was either flashing a
 * screen nobody saw or holding a still frame for eight seconds. Cloudflare
 * allows six connections per invocation to be waiting for response headers at
 * once, so an eight-person round trip -- sixteen legs -- genuinely resolves in
 * waves rather than all at once. That is real progress, and it was invisible.
 *
 * It is opt-in on Accept because the alternative is a breaking change to a
 * shipped endpoint. Every existing caller, every old installed PWA, and every
 * proxy that would rather buffer than stream keeps getting the single JSON
 * body it already understands, byte for byte.
 *
 * The one property the race below buys, and the reason it is worth the
 * awkwardness: a request that is going to be REFUSED never becomes a stream.
 * An exhausted month has to arrive as a 429 with a JSON body, not as a 200
 * carrying bad news, and a malformed body has to stay a 400. The response is
 * only switched to a stream once a leg has actually resolved, and a leg can
 * only resolve on a request that already passed the request guard, the
 * account gate, the monthly cap, the hourly cap and the reservation.
 *
 * A fully cached search does still stream -- its legs resolve from KV on the
 * next microtask, so the first event beats the final payload. That is
 * harmless: the whole exchange measured 4ms locally, the client reads the
 * same events in the same order, and the only thing it costs is that a
 * failure in the refund path arrives as `event: fail` instead of a 500.
 */

function sseFrame(event, data) {
  /* data must be one line: a raw newline inside it would terminate the frame
   * early and the rest would be read as a new, nameless event. JSON.stringify
   * escapes newlines inside strings, and nothing else here can contain one. */
  return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
}

function wantsStream(request) {
  return /text\/event-stream/i.test(request.headers.get('Accept') || '');
}

async function streamSearch(request, env, ctx) {
  const enc = new TextEncoder();
  let ctrl = null, live = true;
  const readable = new ReadableStream({
    start(c) { ctrl = c; },
    /* The reader went away -- the tab was closed, or the app's own 45s abort
     * fired. Stop writing, but do NOT stop working: the searches are already
     * paid for, and the refund inside handleSearch is what hands back the
     * ones the provider never billed for. */
    cancel() { live = false; },
  });
  const push = (event, data) => {
    /* On a refusal this stream is built, written to, and then dropped on the
     * floor unread, because the race below hands back handleSearch's own
     * JSON Response instead. A flag to skip those writes was tried and
     * removed: it changed nothing a test could see, and the writes it saved
     * were a few hundred bytes on a path that had already done a KV read and
     * an account call. */
    if (!live) return;
    /* enqueue is synchronous and unbounded here, so a slow or absent reader
     * can never park the search mid-flight holding a reservation. */
    try { ctrl.enqueue(enc.encode(sseFrame(event, data))); }
    catch (e) { live = false; }
  };

  let opened = null;
  const firstLeg = new Promise(r => { opened = r; });
  const run = handleSearch(request, env, legs => {
    opened(true);
    for (const leg of legs) push('leg', leg);
  }).then(
    async res => {
      /* The final payload is whatever the unchanged function returned, read
       * back out of its own Response. Not rebuilt, not reshaped: there is one
       * place in this file that decides what a search result looks like.
       *
       * clone() is load-bearing, not tidiness. On a refusal this branch still
       * runs, and the Response it is reading is the same 429 the race below
       * is about to return to the caller -- reading the original would hand
       * back a 429 whose body had already been consumed. */
      push('done', await res.clone().json());
      return res;
    },
    err => {
      console.log('search failed:', err && err.message);
      /* Headers are long gone by here, so there is no status code left to
       * set. The event name is the status. */
      push('fail', { error: 'Search failed. Try again shortly.' });
      return null;
    },
  ).then(res => {
    if (live) { try { ctrl.close(); } catch (e) { /* already closed */ } }
    return res;
  });

  /* The race is the whole trick. If handleSearch settles first -- a refusal, a
   * malformed body, or a search whose every leg was cached -- there is nothing
   * to stream and its own Response goes back untouched, with its own status.
   * Only once a leg has actually resolved is the answer a stream. */
  const first = await Promise.race([firstLeg, run]);
  if (first !== true) {
    return first || json({ error: 'Search failed. Try again shortly.' }, 500);
  }

  /* From here the body outlives the handler, so the rest of the work -- the
   * remaining legs, and above all the refund of whatever was reserved and
   * never billed -- is kept alive explicitly. Without this a reader that
   * disconnects mid-stream would leave the month counted for searches the
   * provider never charged for. */
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(run);

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      /* Nginx and a few CDNs buffer a response until it completes unless told
       * not to, which would turn this back into one slow JSON body. */
      'X-Accel-Buffering': 'no',
      ...CORS,
    },
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

  /* The roster state is owned by this endpoint's siblings, never by the poster.
   * Stripped rather than rejected, because the app re-saves a trip it has been
   * looking at and the honest answer for a NEW id is a clean roster: the fares
   * behind it were re-searched, so carrying somebody's "booked" across would be
   * the app asserting a purchase against a plan that person has never seen.
   * Dropping `keys` here also closes the obvious land-grab -- posting a trip
   * with a claim key already set for every party, so the real group can never
   * mark themselves on their own trip. */
  delete trip.marks; delete trip.keys; delete trip.n;
  body = JSON.stringify(trip);

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

/* ------------------------------------------------------- the roster state
 *
 * A shared trip was a screenshot with working Book buttons: it could say what
 * the group should do and never what the group had done. The one fact that
 * actually blocks a group trip -- has Ray bought his ticket yet -- lived in a
 * chat window this app cannot see.
 *
 * Marks are that fact, and they are deliberately the smallest thing that can
 * carry it. One string per person. No comments, no votes, no threads: those
 * invite a conversation, and a conversation is what the group already has
 * somewhere better. This is the ledger the conversation keeps asking about.
 *
 * WRITES. One KV put per actual status change, so at most one per person per
 * trip in the normal case -- eight for the largest possible group, on top of
 * the two that sharing already costs (the trip, and the per-IP trip-write
 * counter). Ten writes for the biggest trip this app can produce. Nothing here
 * writes on a read: GET /trip/:id/marks is a pure read, which is what makes
 * refresh-on-return affordable, and re-posting a state somebody is already in
 * returns 200 without touching KV. The provider search allowance (230 a month,
 * eight per four-person round trip) caps the system at roughly 28 shareable
 * trips a MONTH, so ~280 roster writes a month against a 1,000-a-DAY ceiling.
 * Writes are two orders of magnitude from being the constraint; searches still
 * are. test-worker.js counts this rather than asserting it.
 *
 * TRUST. There are no accounts and there is not going to be one. The link is
 * the credential and first claim wins: the first device to mark a person mints
 * a random key, which is stored beside the mark and NEVER returned by any read.
 * Afterwards only that device can change that person's state. So a stranger who
 * later finds the link cannot un-book Ray, cannot flip the roster back and
 * forth, and cannot make the document lie about money. What they can do is
 * claim a person nobody has claimed yet -- which is the honest cost of having
 * no login, and is why `keys` must never reach a response body. */

const MARK_STATES = new Set(['booked', 'looking']);

/* Equal-length compare that does not return early on the first differing byte.
 * A 16-character key over the public internet is not realistically attacked
 * this way; it costs four lines not to have to argue about it. */
function sameKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* The roster is the only set of ids a mark may name. Without this a trip is
 * free unbounded key-value storage for anybody holding the link: post a mark
 * for a party id that does not exist and the object grows by a row. */
function partyIdsOf(trip) {
  const parties = (((trip || {}).payload || {}).q || {}).parties;
  return Array.isArray(parties)
    ? parties.map(p => String((p && p.id) == null ? '' : p.id)).filter(Boolean)
    : [];
}

/* Everything a reader is allowed to know. `keys` is absent by construction
 * rather than by deletion, so a field added to the stored shape later cannot
 * leak by being forgotten here. */
function publicMarks(trip) {
  const src = (trip && trip.marks && typeof trip.marks === 'object') ? trip.marks : {};
  const out = {};
  for (const id of partyIdsOf(trip)) {
    const m = src[id];
    if (m && MARK_STATES.has(m.s) && m.s !== 'looking') out[id] = { s: m.s, t: +m.t || 0 };
  }
  return out;
}

async function markTrip(id, request, env) {
  if (!/^[a-z2-9]{6,12}$/.test(id || '')) return json({ error: 'Not a trip id.' }, 400);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Malformed request.' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'Malformed request.' }, 400);

  const party = String(body.party == null ? '' : body.party).slice(0, 24);
  const state = String(body.state == null ? '' : body.state);
  const key = String(body.key == null ? '' : body.key);
  if (!MARK_STATES.has(state)) return json({ error: 'Unknown state.' }, 400);
  if (!/^[a-z0-9]{16,40}$/.test(key)) return json({ error: 'Missing claim key.' }, 400);

  /* Read-modify-write on KV is last-write-wins, and KV reads cannot be told to
   * skip their local cache -- 60 seconds is the floor the platform allows. So
   * two people marking within a minute THROUGH THE SAME COLO can lose one of
   * the two marks. This is the same hazard the budget counters above carry, it
   * has the same real fix (a Durable Object, one binding, which both should get
   * together), and it is deliberately being lived with here rather than
   * half-solved, because the blast radius is a single flag:
   *
   *   - nothing silently corrupts. The loser's own response showed the merged
   *     state this worker saw, and the next /marks read shows the truth.
   *   - the UI re-reads the roster whenever somebody returns to the tab, so the
   *     lost flag reappears as un-booked and is one tap from being right again.
   *   - no money moves on this flag, and it cannot un-book somebody who holds
   *     the claim key -- the write that matters is still gated.
   *
   * Splitting marks into one KV key per party would remove the race outright,
   * and was rejected for a worse cost: reading the roster back would then need
   * a list() per open, and list operations are capped at 1,000 a day on the
   * free tier -- exactly as scarce as the writes this design is protecting. */
  const raw = await env.FWF.get('trip:' + id);
  if (!raw) return json({ error: 'That trip has expired or never existed.' }, 404);
  let trip;
  try { trip = JSON.parse(raw); } catch (e) { return json({ error: 'Not a trip.' }, 500); }

  if (!partyIdsOf(trip).includes(party)) {
    return json({ error: 'Nobody by that id is on this trip.' }, 400);
  }

  if (!trip.marks || typeof trip.marks !== 'object') trip.marks = {};
  if (!trip.keys || typeof trip.keys !== 'object') trip.keys = {};

  const held = trip.keys[party];
  if (held && !sameKey(held, key)) {
    return json({ error: 'Somebody else already marks that person on this trip.' }, 403);
  }

  /* Re-posting the state a person is already in writes nothing. This is what
   * makes a double tap, a retry after a dropped connection and a stale tab all
   * free rather than each costing a write. */
  const current = (trip.marks[party] && trip.marks[party].s) || 'looking';
  if (current === state) {
    return json({ ok: true, marks: publicMarks(trip), n: +trip.n || 0, wrote: false });
  }

  const n = +trip.n || 0;
  if (n >= LIMITS.tripMarksMax) {
    return json({ error: 'This trip has been updated too many times.', marks: publicMarks(trip) }, 429);
  }

  /* 'looking' is the absence of a mark, not a third row to store -- but the
   * claim key stays, so the person who un-books can book again and nobody else
   * can take their place in the meantime. */
  if (state === 'looking') delete trip.marks[party];
  else trip.marks[party] = { s: state, t: Math.floor(Date.now() / 1000) };
  trip.keys[party] = key;
  trip.n = n + 1;

  const next = JSON.stringify(trip);
  if (next.length > LIMITS.tripBytesMax) return json({ error: 'Trip too large to update.' }, 413);

  /* The TTL is reset, not preserved: a trip people are actively booking is the
   * last thing that should expire out from under them. Bounded by tripMarksMax,
   * so this cannot be used to keep an object alive indefinitely for free. */
  await env.FWF.put('trip:' + id, next, { expirationTtl: LIMITS.tripTtlSeconds });
  return json({ ok: true, marks: publicMarks(trip), n: trip.n, wrote: true });
}

/* Split from the trip body on purpose. The document is large and immutable, so
 * it is cached hard at the edge; the roster is tiny and changes, so it is never
 * cached at all. Serving them together would force one of those two to be
 * wrong -- either a 150KB re-download every time somebody checks whether Ray
 * booked, or a five-minute lie about whether he did. */
async function readMarks(id, env) {
  if (!/^[a-z2-9]{6,12}$/.test(id || '')) return json({ error: 'Not a trip id.' }, 400);
  const raw = await env.FWF.get('trip:' + id);
  if (!raw) return json({ error: 'That trip has expired or never existed.' }, 404);
  let trip;
  try { trip = JSON.parse(raw); } catch (e) { return json({ error: 'Not a trip.' }, 500); }
  return new Response(JSON.stringify({ marks: publicMarks(trip), n: +trip.n || 0 }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  });
}

async function readTrip(id, env) {
  if (!/^[a-z2-9]{6,12}$/.test(id || '')) return json({ error: 'Not a trip id.' }, 400);
  const raw = await env.FWF.get('trip:' + id, { cacheTtl: 300 });
  if (!raw) return json({ error: 'That trip has expired or never existed.' }, 404);

  /* This response is cached publicly for five minutes, at the edge, keyed only
   * on the URL -- so anything in it is effectively published. The claim keys
   * must not be in it, and neither must the marks, which would be served up to
   * five minutes stale next to a /marks route that is always current. Parsed
   * and re-serialised rather than passed through for exactly that reason; a
   * body this route cannot parse is a body written before any of this existed
   * and had none of these fields, so it is passed through unchanged. */
  let trip;
  try { trip = JSON.parse(raw); } catch (e) { trip = null; }
  let out = raw;
  if (trip && typeof trip === 'object') {
    delete trip.keys; delete trip.marks; delete trip.n;
    out = JSON.stringify(trip);
  }
  return new Response(out, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', ...CORS },
  });
}

export const _internals = { parseBags, validate, extractOptions, extractInsights, cacheKey, LIMITS, tripId,
                            duffelBags, parseIsoDuration, extractDuffelOptions, localStamp,
                            planSearches, legTtl, accountGate, normalize, planCaps,
                            sameKey, partyIdsOf, publicMarks, MARK_STATES,
                            /* Exported so the trust model can be tested rather than
                             * reasoned about: that a claim key never reaches a
                             * response body is not a property a unit test of pure
                             * functions can see. */
                            saveTrip, readTrip, readMarks, markTrip,
                            /* The streaming seam. sseFrame and wantsStream are
                             * pure and are tested as such; handleSearch is
                             * exported so a test can assert that the progress
                             * callback sees exactly one event per traveler
                             * per leg. */
                            sseFrame, wantsStream, handleSearch };

export default {
  /* ctx is new, and optional on purpose: the unit tests call fetch(req, env)
   * with two arguments and must keep working. It is only read through a
   * typeof guard, by the streaming path, to keep the refund alive past a
   * reader that hangs up. */
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const path = new URL(request.url).pathname;

    if (path === '/budget' && request.method === 'GET') {
      const [used, usedToday, snap] = await Promise.all([
        env.FWF.get(monthKey(), { cacheTtl: 60 }).then(v => (v ? +v : 0)),
        env.FWF.get(dayKey(), { cacheTtl: 60 }).then(v => (v ? +v : 0)),
        /* Written by the search path, never fetched here: a page load must not
         * cost a KV write, and 1,000 a day is the real free-tier ceiling. */
        env.FWF.get(PROVIDER_SNAPSHOT, { type: 'json', cacheTtl: 60 }).catch(() => null),
      ]);
      /* `used` is ours and can be low; `providerLeft` is SerpApi's and cannot.
       * Reporting both is the honest version -- and `exhausted` believes
       * whichever of the two says the allowance is gone. */
      const providerLeft = snap && isFinite(snap.left) ? snap.left : null;
      /* From the same snapshot the search path writes, so this page and the
       * gate that actually refuses a search quote the same ceiling. Before an
       * upgrade's first search there is no snapshot, and the floor is reported
       * -- understating the allowance, which is the harmless direction. */
      const caps = planCaps(snap);
      return new Response(JSON.stringify({ used, limit: caps.monthly, usedToday,
          resetsAt: monthResetsAt(),
          providerUsed: snap && isFinite(snap.used) ? snap.used : null,
          providerLeft, providerAt: (snap && snap.at) || null,
          low: used > caps.monthly * 0.8
               || (providerLeft != null && providerLeft < caps.monthly * 0.2),
          exhausted: used >= caps.monthly || providerLeft === 0 }), {
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
      catch (err) { console.log('trip save failed:', err && err.message);
                    return json({ error: 'Could not save trip right now.' }, 500); }
    }

    /* Behind the Origin gate above, like every other write: a roster update is
     * an assertion about somebody's money, and it should come from the app. */
    if (path.startsWith('/trip/') && request.method === 'POST') {
      const m = /^([^/]+)\/mark$/.exec(path.slice(6));
      if (m) {
        try { return await markTrip(m[1], request, env); }
        catch (err) { console.log('trip mark failed:', err && err.message);
                      return json({ error: 'Could not update the trip right now.' }, 500); }
      }
    }

    if (path.startsWith('/trip/') && request.method === 'GET') {
      const rest = path.slice(6);
      const m = /^([^/]+)\/marks$/.exec(rest);
      try { return m ? await readMarks(m[1], env) : await readTrip(rest, env); }
      catch (err) { console.log('trip load failed:', err && err.message);
                    return json({ error: 'Could not load trip right now.' }, 500); }
    }

    if (path === '/search' && request.method === 'POST') {
      /* A plain variable so searching can be switched off from the dashboard in
       * seconds, without a redeploy, while cached results and shared links keep
       * working. */
      if (env.SEARCH_ENABLED === 'off') {
        return json({ error: 'New searches are paused right now. Shared links and '
          + 'recent searches still work.' }, 503);
      }
      try {
        return wantsStream(request)
          ? await streamSearch(request, env, ctx)
          : await handleSearch(request, env);
      }
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
