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
  monthly: 230,      // of SerpApi's 250, leaving headroom for manual scans
  daily: 24,         // spreads the month out instead of burning it in one day
  perIpHourly: 12,
  cacheTtlSeconds: 60 * 60 * 24,   // a day; fares do not move enough to matter
  maxTravelers: 8,
  optionsPerLeg: 25,
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

async function counter(env, key) {
  const v = await env.FWF.get(key);
  return v ? +v : 0;
}

async function bump(env, key, by, ttl) {
  const next = (await counter(env, key)) + by;
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
  if (body.ret && !date.test(body.ret)) return 'Return date must be YYYY-MM-DD.';
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

  const invalid = validate(body);
  if (invalid) return json({ error: invalid }, 400);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipKey = 'rl:' + ip + ':' + new Date().toISOString().slice(0, 13);
  if ((await counter(env, ipKey)) >= LIMITS.perIpHourly) {
    return json({ error: 'Too many searches from this address. Try again in an hour.' }, 429);
  }

  /* Provider resolution: an explicit request wins, then the PROVIDER var in
   * wrangler.toml, then SerpApi. Per-request selection is what lets the same
   * route be run through both and compared. */
  const provider = body.provider || env.PROVIDER || 'serpapi';
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

  const [used, usedToday] = await Promise.all([counter(env, monthKey()), counter(env, dayKey())]);

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
    return json({ error: 'This month\'s search budget is used up. Cached searches still work, '
      + 'and the budget resets on ' + budget.resetsAt + '.', budget, exhausted: 'month' }, 429);
  }
  if (toSpend > 0 && usedToday + toSpend > LIMITS.daily) {
    return json({ error: 'Today\'s search budget is used up. Cached searches still work, '
      + 'and more become available tomorrow.', budget, exhausted: 'day' }, 429);
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

  const spent = spentTotal;
  if (spent > 0) {
    await Promise.all([
      bump(env, monthKey(), spent, 60 * 60 * 24 * 40),
      bump(env, dayKey(), spent, 60 * 60 * 36),
    ]);
  }
  await bump(env, ipKey, 1, 60 * 60 * 2);

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
    searches_made: spent,
    distinct_routes: uniqueSearches.length,
    cached: spent === 0,
  });
}

/* Exported so the parsers and validator can be tested directly -- the bag parser
 * here must stay in step with the Python one in .github/scripts/scan.py, and
 * test-worker.js checks exactly that. */
export const _internals = { parseBags, validate, extractOptions, extractInsights, cacheKey, LIMITS,
                            duffelBags, parseIsoDuration, extractDuffelOptions, localStamp };

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const path = new URL(request.url).pathname;

    if (path === '/budget') {
      const [used, usedToday] = await Promise.all([counter(env, monthKey()), counter(env, dayKey())]);
      return json({ used, limit: LIMITS.monthly, usedToday, dailyLimit: LIMITS.daily,
                    resetsAt: monthResetsAt() });
    }

    if (path === '/search' && request.method === 'POST') {
      try { return await handleSearch(request, env); }
      catch (err) { return json({ error: 'Search failed: ' + err.message }, 500); }
    }

    return json({ error: 'Not found' }, 404);
  },
};
