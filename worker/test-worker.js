/* Worker unit tests: bag-text parsing (checked against the Python parser in
 * .github/scripts/scan.py) and request validation. Run: node test-worker.js */
import { _internals } from './worker.js';
const { parseBags, validate } = _internals;

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
};

console.log('\n1. Bag parsing');
const cases = [
  [['Checked baggage for a fee'], 'fee_unknown', null, null],
  [['1st checked bag: 35'], 'parsed', 35, null],
  [['First checked bag: $40', 'Free carry-on'], 'parsed', 40, true],
  [['1 free checked bag'], 'parsed', 0, null],
  [['Carry-on bag not included', 'Checked bag: 30'], 'parsed', 30, false],
  [['Bag and fare conditions depend on the return flight'], 'fee_unknown', null, null],
  [['Below average legroom (29 in)'], 'absent', null, null],
  [[], 'absent', null, null],
];
for (const [ext, conf, price, carry] of cases) {
  const got = parseBags(ext);
  check(JSON.stringify(ext).slice(0, 52),
    got.confidence === conf && got.checked_first_price === price && got.carry_on_included === carry,
    'got ' + JSON.stringify(got));
}

console.log('\n2. Validation rejects bad input');
const base = { travelers: [{ id: 'a', origins: ['SFO'] }, { id: 'b', origins: ['ORD'] }],
               dest: ['PIT'], depart: '2027-02-12', ret: '2027-02-15' };
const bad = [
  ['one person', { ...base, travelers: [base.travelers[0]] }],
  ['nine people', { ...base, travelers: Array.from({ length: 9 }, (_, i) => ({ id: 'p' + i, origins: ['SFO'] })) }],
  ['lowercase dest', { ...base, dest: ['pit'] }],
  ['no dest', { ...base, dest: [] }],
  ['bad date', { ...base, depart: '12/02/2027' }],
  ['return before depart', { ...base, ret: '2027-02-01' }],
  ['origin not a code', { ...base, travelers: [{ id: 'a', origins: ['San Francisco'] }, base.travelers[1]] }],
  ['empty origins', { ...base, travelers: [{ id: 'a', origins: [] }, base.travelers[1]] }],
];
for (const [name, body] of bad) check('rejects ' + name, validate(body) !== null, 'got null');
check('accepts a valid round trip', validate(base) === null, validate(base));
check('accepts a valid one-way', validate({ ...base, ret: null }) === null);
check('accepts multi-airport origins', validate({ ...base,
  travelers: [{ id: 'a', origins: ['SFO', 'OAK', 'SJC'] }, base.travelers[1]] }) === null);

console.log('\n3. Duffel: ISO durations');
const { parseIsoDuration, duffelBags, extractDuffelOptions, localStamp } = _internals;
check('PT5H30M -> 330', parseIsoDuration('PT5H30M') === 330);
check('PT11H -> 660', parseIsoDuration('PT11H') === 660);
check('PT45M -> 45', parseIsoDuration('PT45M') === 45);
check('P1DT2H30M -> 1590', parseIsoDuration('P1DT2H30M') === 1590, 'got ' + parseIsoDuration('P1DT2H30M'));
check('junk -> null', parseIsoDuration('banana') === null);
check('localStamp trims ISO to wall clock',
  localStamp('2027-03-10T14:30:00') === '2027-03-10 14:30', localStamp('2027-03-10T14:30:00'));

console.log('\n4. Duffel: baggage is "what is included", not "what it costs"');
check('checked bag included -> known free',
  JSON.stringify(duffelBags({ baggages: [{ type: 'checked', quantity: 1 }, { type: 'carry_on', quantity: 1 }] }))
  === JSON.stringify({ carry_on_included: true, checked_first_price: 0, confidence: 'parsed' }));
check('no checked bag -> chargeable, amount unknown, carry-on still known',
  JSON.stringify(duffelBags({ baggages: [{ type: 'carry_on', quantity: 1 }] }))
  === JSON.stringify({ carry_on_included: true, checked_first_price: null, confidence: 'fee_unknown' }));
check('basic economy with nothing -> carry_on_included false (Google never gave us this)',
  JSON.stringify(duffelBags({ baggages: [] }))
  === JSON.stringify({ carry_on_included: false, checked_first_price: null, confidence: 'fee_unknown' }));
check('missing passenger object does not throw',
  duffelBags(undefined).confidence === 'fee_unknown');

console.log('\n5. Duffel: transatlantic normalisation');
(function () {
  // SFO 14:30 -> LHR 08:45 next day. Subtracting local wall clock gives 18h 15m;
  // the real duration is 10h 15m. This is the London case that makes using
  // Duffel's own duration field mandatory rather than tidy.
  const payload = { data: { offers: [
    { total_amount: '612.40', total_currency: 'USD',
      passengers: [{ baggages: [{ type: 'checked', quantity: 1 }, { type: 'carry_on', quantity: 1 }] }],
      slices: [{ duration: 'PT10H15M', fare_brand_name: 'Economy Standard',
        segments: [{
          departing_at: '2027-03-10T14:30:00', arriving_at: '2027-03-11T08:45:00',
          origin: { iata_code: 'SFO' }, destination: { iata_code: 'LHR' },
          marketing_carrier: { name: 'British Airways', iata_code: 'BA',
                               logo_symbol_url: 'https://assets.duffel.com/img/airlines/BA.svg' },
        }] }] },
    { total_amount: '438.00', total_currency: 'USD',
      passengers: [{ baggages: [] }],
      slices: [{ duration: 'PT13H05M', fare_brand_name: 'Basic',
        segments: [
          { departing_at: '2027-03-10T07:10:00', arriving_at: '2027-03-10T15:40:00',
            origin: { iata_code: 'SFO' }, destination: { iata_code: 'JFK' },
            marketing_carrier: { name: 'American Airlines', iata_code: 'AA' } },
          { departing_at: '2027-03-10T18:00:00', arriving_at: '2027-03-11T06:15:00',
            origin: { iata_code: 'JFK' }, destination: { iata_code: 'LHR' },
            marketing_carrier: { name: 'British Airways', iata_code: 'BA' } },
        ] }] },
  ] } };

  const opts = extractDuffelOptions(payload, 25);
  check('two offers normalised', opts.length === 2);
  check('sorted cheapest first', opts[0].price === 438 && opts[1].price === 612.4,
    JSON.stringify(opts.map(o => o.price)));

  const cheap = opts[0], standard = opts[1];
  check('duration comes from the ISO field, not local subtraction',
    cheap.duration_minutes === 785 && standard.duration_minutes === 615,
    JSON.stringify([cheap.duration_minutes, standard.duration_minutes]));
  check('local subtraction would have been wrong',
    (Date.parse(standard.arrive.replace(' ', 'T')) - Date.parse(standard.depart.replace(' ', 'T'))) / 60000 === 1095);
  check('stops counted from segments', cheap.stops === 1 && standard.stops === 0,
    JSON.stringify([cheap.stops, standard.stops]));
  check('route taken from first origin and last destination',
    cheap.from === 'SFO' && cheap.to === 'LHR');
  check('both carriers listed on the connection',
    JSON.stringify(cheap.airlines) === JSON.stringify(['American Airlines', 'British Airways']),
    JSON.stringify(cheap.airlines));
  check('logo url carried through', standard.airline_logo.indexOf('duffel.com') > -1);
  check('fare brand captured', cheap.fare_brand === 'Basic' && standard.fare_brand === 'Economy Standard');

  // The whole point of the switch: the bag assumption now lands on one option
  // and not the other, so it can actually change which plan wins.
  check('basic fare known to need a bag', cheap.bags.confidence === 'fee_unknown'
    && cheap.bags.carry_on_included === false);
  check('standard fare known to include one', standard.bags.confidence === 'parsed'
    && standard.bags.checked_first_price === 0);
  check('the two differ, unlike under SerpApi',
    cheap.bags.confidence !== standard.bags.confidence);
})();

/* ------------------------------------------------------------- economics
 *
 * These are the only tests here that are about money rather than correctness.
 * Every number below is a billed SerpApi search against a 250-a-month allowance,
 * so a change that makes any of them larger is a change to what the product can
 * be, and should have to argue for itself in a diff rather than turn up in a
 * bill. Where a number is wrong-but-cheap it is pinned as it is, with a comment
 * saying so, rather than quietly left untested. */
console.log('\n6. Economics: what a trip costs');
const { planSearches, legTtl, accountGate, normalize, LIMITS } = _internals;

const CITIES = ['SFO', 'ORD', 'ATL', 'DEN', 'BOS', 'AUS', 'SEA', 'PHL'];
const party = (n, origins) => ({ dest: ['PIT'], depart: '2027-02-12',
  travelers: Array.from({ length: n }, (_, i) => ({ id: 'p' + i,
    origins: origins ? origins(i) : [CITIES[i]], bags: { carry_on: 1 } })) });
/* normalize() then planSearches(), in that order, because that is what
 * handleSearch does and because the sort that makes ["SFO","OAK"] and
 * ["OAK","SFO"] one search rather than two lives in normalize. Testing
 * planSearches alone would pass while the real pipeline paid twice. */
const plan = (b, p) => planSearches(normalize(b), p || 'serpapi');
const cost = (b) => plan(b).unique.length;
const rt = (b) => ({ ...b, ret: '2027-02-15' });

/* One billed search per distinct origin set per leg. This is the table the
 * whole product sits on: eight people round trip is 16 of 250. */
for (const [n, ow, trip] of [[2, 2, 4], [3, 3, 6], [4, 4, 8], [6, 6, 12], [8, 8, 16]]) {
  check(n + ' parties: ' + ow + ' one-way, ' + trip + ' round trip',
    cost(party(n)) === ow && cost(rt(party(n))) === trip,
    'got ' + cost(party(n)) + ' and ' + cost(rt(party(n))));
}
check('8 parties round trip is 16 jobs, not 16 searches by accident',
  plan(rt(party(8))).jobs.length === 16);

/* Travellers who share an origin set are one search. This is the single
 * cheapest thing in the worker and the easiest to break by touching the key. */
check('two of four share a city: 8 jobs collapse to 6 searches',
  cost(rt(party(4, i => [['SFO', 'SFO', 'ORD', 'ATL'][i]]))) === 6);
check('a whole group from one city: 16 jobs collapse to 2 searches',
  cost(rt(party(8, () => ['SFO']))) === 2,
  'got ' + cost(rt(party(8, () => ['SFO']))));
check('origin order does not create a second search',
  cost(rt(party(2, i => (i ? ['SJC', 'OAK', 'SFO'] : ['SFO', 'OAK', 'SJC'])))) === 2);

/* The cost of letting one person pick "all Bay Area airports" and another pick
 * SFO: two billed searches for results that largely overlap. Pinned because it
 * is the most plausible remaining win and should be visible if anyone claims to
 * have taken it. */
check('COST: SFO vs SFO+OAK+SJC is two searches per leg, not one',
  cost(rt(party(2, i => (i ? ['SFO', 'OAK', 'SJC'] : ['SFO'])))) === 4,
  'got ' + cost(rt(party(2, i => (i ? ['SFO', 'OAK', 'SJC'] : ['SFO'])))));

/* WRONG BUT CHEAP, pinned deliberately: carry-on count is sent upstream but is
 * not in the cache key, so a group carrying bags is served the result computed
 * for a group carrying none. Fixing it by adding `bags` to the key costs real
 * searches; fixing it by not sending `bags` costs none. Either way this check
 * is the thing that has to change first. */
const withBags = party(2, () => ['SFO']);
const noBags = party(2, () => ['SFO']);
noBags.travelers.forEach(t => { t.bags.carry_on = 0; });
check('KNOWN: carry-on count is NOT in the cache key (two groups collide)',
  plan(withBags).unique[0].key === plan(noBags).unique[0].key);
check('...and the carry-on count IS sent upstream, so the collision is real',
  plan(withBags).unique[0].params.bags === 1
  && plan(noBags).unique[0].params.bags === 0);

/* KNOWN DEFECT on the Duffel path: duffelSearch sends only the first airport of
 * a comma list, but the cache key keeps the whole list. So two different origin
 * sets that share a first airport are two billed searches returning identical
 * results. Must be closed before PROVIDER=duffel goes live. */
check('KNOWN: Duffel keys the full origin list but only searches the first airport',
  plan(rt(party(2, i => (i ? ['SFO', 'OAK'] : ['SFO', 'SJC']))), 'duffel').unique.length === 4);

console.log('\n7. Economics: cache lifetime by how far out the flight is');
const inDays = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
check('a flight next week caches for 12h, not a day', legTtl(inDays(7)) === 60 * 60 * 12);
check('a month out caches for 3 days', legTtl(inDays(30)) === 60 * 60 * 24 * 3);
check('six months out caches for 7 days', legTtl(inDays(180)) === 60 * 60 * 24 * 7);
check('an unreadable date falls back to a day', legTtl('banana') === LIMITS.cacheTtlSeconds);
check('the far bucket is 7x the old flat day', legTtl(inDays(180)) / LIMITS.cacheTtlSeconds === 7);

console.log('\n8. Economics: the provider\'s meter overrules ours');
check('no snapshot means allow -- telemetry never blocks a real group',
  accountGate(null, 16) === null && accountGate({}, 16) === null);
check('allows a search that fits', accountGate({ left: 40, hourLimit: 50, thisHour: 0 }, 16) === null);
check('refuses a search that does not fit, even if our counter is happy',
  accountGate({ left: 10, hourLimit: 50, thisHour: 0 }, 16) === 'exhausted');
check('refuses at zero left', accountGate({ left: 0, hourLimit: 50, thisHour: 0 }, 1) === 'exhausted');
check('the hourly brake is the provider\'s own 50/hr, not our 60',
  accountGate({ left: 200, hourLimit: 50, thisHour: 40 }, 16) === 'hour'
  && accountGate({ left: 200, hourLimit: 200, thisHour: 40 }, 16) === null);
check('a missing hour figure does not block',
  accountGate({ left: 200 }, 16) === null);

/* ------------------------------------- what a request costs, end to end
 *
 * The checks above count searches from a pure function. These run the real
 * handler against a fake KV and a fake provider, which is the only way to see
 * the two numbers that actually decide what this product can be: KV writes per
 * request, and how far the budget counter drifts from what the provider billed.
 *
 * Nothing here touches the network. The provider stub counts calls instead. */
console.log('\n9. Economics: the request, measured end to end');
const worker = (await import('./worker.js')).default;

let kvReads = 0, kvWrites = 0, billed = 0;
const store = new Map();
const fakeKv = {
  async get(k, opt) {
    kvReads++;
    const v = store.get(k);
    if (v === undefined) return null;
    const wantsJson = opt === 'json' || (opt && opt.type === 'json');
    return wantsJson ? JSON.parse(v) : v;
  },
  async put(k, v) { kvWrites++; store.set(k, v); },
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  /* Free and not billed as a search -- that is the entire reason it is used. */
  if (u.includes('/account.json')) {
    return { json: async () => ({ this_month_usage: billed, total_searches_left: 250 - billed,
                                  searches_per_month: 250, account_rate_limit_per_hour: 50,
                                  this_hour_searches: billed }) };
  }
  if (u.includes('serpapi.com/search.json')) {
    billed++;
    return { json: async () => ({ best_flights: [{ price: 400, total_duration: 300,
      flights: [{ airline: 'United', flight_number: 'UA 500',
        departure_airport: { id: 'SFO', time: '2027-02-12 08:00' },
        arrival_airport: { id: 'PIT', time: '2027-02-12 16:00' }, extensions: [] }],
      extensions: ['1 free checked bag'] }], other_flights: [] }) };
  }
  throw new Error('unexpected fetch: ' + u);
};

const env = { FWF: fakeKv, SERPAPI_KEY: 'test', ALLOWED_ORIGINS: 'https://app.test' };
const post = (body, ip) => new Request('https://api.test/search', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://app.test',
             'CF-Connecting-IP': ip || '203.0.113.9' },
  body: JSON.stringify(body) });
const fresh = () => { store.clear(); kvReads = 0; kvWrites = 0; billed = 0; };

/* One cold eight-person round trip. */
fresh();
const cold = await (await worker.fetch(post(rt(party(8))), env)).json();
const coldWrites = kvWrites;
check('cold 8-party round trip bills 16 searches', cold.searches_made === 16,
  'got ' + cold.searches_made);
check('...and reports the 16 distinct routes it paid for', cold.distinct_routes === 16);
check('...and costs 21 KV writes (16 cache + 4 counters + 1 provider snapshot)',
  coldWrites === 21, 'got ' + coldWrites);
check('...so the 1,000-a-day write ceiling allows 47 of them, and the '
  + '230-search cap allows 14 -- searches bind first, by two orders of magnitude',
  Math.floor(1000 / coldWrites) === 47 && Math.floor(230 / 16) === 14);

/* The same request again: the cache is the product. */
const warm = await (await worker.fetch(post(rt(party(8))), env)).json();
check('the same trip again bills nothing and writes nothing',
  warm.searches_made === 0 && warm.cached === true, JSON.stringify(warm.budget));
check('...and does not even call the free account API when nothing will be spent',
  billed === 16);

/* A dozen people opening the same saved link, one after another. */
fresh();
for (let i = 0; i < 12; i++) await worker.fetch(post(rt(party(8)), '198.51.100.' + i), env);
check('12 sequential openers of the same trip bill 16 between them, not 192',
  billed === 16, 'got ' + billed);

/* THE DEFECT, pinned as a number. Twelve people open the same link in the same
 * minute -- a group chat, which is the only way this app is ever used. The leg
 * cache has not been written yet, so every one of them misses it and pays; the
 * budget counter is a read-modify-write on one KV key, so eleven of the twelve
 * writes are lost and GET /budget reports a twelfth of what was spent.
 *
 * In production it is worse than this, not better: Workers KV caches reads for
 * 60s by default and writes to a single key are capped at 1/second on every
 * plan, so the window these numbers assume to be microseconds is really up to a
 * minute wide. A Durable Object is the fix. The accountGate above is the
 * stopgap: it asks the provider, which cannot undercount.
 *
 * When the fix lands, these two checks fail. That is their purpose. */
for (const [n, expectBilled] of [[2, 32], [5, 80], [12, 192]]) {
  fresh();
  await Promise.all(Array.from({ length: n }, (_, i) =>
    worker.fetch(post(rt(party(8)), '198.51.100.' + i), env)));
  const counted = +(store.get('budget:' + new Date().toISOString().slice(0, 7)) || 0);
  check('DEFECT: ' + n + ' simultaneous openers bill ' + expectBilled
    + ' but the counter records 16',
    billed === expectBilled && counted === 16,
    'billed ' + billed + ', counter ' + counted);
}

/* And the cap itself does not hold. Thirty searches left; six groups arrive at
 * once; each one individually fits, so all six are allowed through. */
fresh();
store.set('budget:' + new Date().toISOString().slice(0, 7), '200');
await Promise.all(Array.from({ length: 6 }, (_, i) =>
  worker.fetch(post({ ...rt(party(8)), depart: '2027-03-0' + (1 + i), ret: '2027-03-1' + (1 + i) },
                    '198.51.100.' + i), env)));
check('DEFECT: with 30 of 230 left, six simultaneous groups spend 96',
  billed === 96, 'got ' + billed);

globalThis.fetch = realFetch;
/* ------------------------------------------------------- the roster state
 *
 * Driven against a fake KV rather than against pure helpers, because the two
 * properties that matter are not visible from a helper: that a claim key never
 * appears in any response body, and that a status change costs exactly one
 * write. Both are counted here. */
await (async () => {
  console.log('\n5. Roster marks');
  const { saveTrip, readTrip, readMarks, markTrip, LIMITS } = _internals;

  const kv = {
    store: new Map(), writes: 0, reads: 0,
    async get(k) { this.reads++; const v = this.store.get(k); return v === undefined ? null : v; },
    async put(k, v) { this.writes++; this.store.set(k, v); },
  };
  const env = { FWF: kv };
  const post = (url, body) => new Request(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  const trip = {
    v: 1,
    data: { trips: { query: { outbound: {}, return: {} } }, currency: 'USD', generated_at: '2026-10-29T00:00:00Z' },
    payload: { q: { dest: 'PIT', dep: '2027-02-12', parties: [
      { id: 'alex', name: 'Alex', seats: 1, airports: ['SFO'] },
      { id: 'ray', name: 'Ray', seats: 1, airports: ['DEN'] },
    ] }, v: {} },
  };

  // A poster cannot pre-seed the roster or the keys on a trip they create.
  const saved = await (await saveTrip(post('https://x/trip',
    { ...trip, marks: { ray: { s: 'booked' } }, keys: { ray: 'aaaaaaaaaaaaaaaa' }, n: 99 }), env)).json();
  const id = saved.id;
  check('save returns an id', /^[a-z2-9]{6}$/.test(id || ''), JSON.stringify(saved));
  const stored0 = JSON.parse(kv.store.get('trip:' + id));
  check('a posted roster is stripped on save',
    stored0.marks === undefined && stored0.keys === undefined && stored0.n === undefined);

  const RAY = 'r4yk3yr4yk3yr4yk3y';
  const ALEX = 'al3xal3xal3xal3xal3x';

  // Input shapes.
  const bad = async (name, body, status) => {
    const r = await markTrip(id, post('https://x/trip/' + id + '/mark', body), env);
    check(name, r.status === status, 'got ' + r.status);
  };
  await bad('an unknown state is refused', { party: 'ray', state: 'vibing', key: RAY }, 400);
  await bad('a short key is refused', { party: 'ray', state: 'booked', key: 'abc' }, 400);
  await bad('a key with markup in it is refused',
    { party: 'ray', state: 'booked', key: '<img src=x onerror=1>' }, 400);
  await bad('a party id not on the trip is refused',
    { party: 'nobody', state: 'booked', key: RAY }, 400);
  const nowhere = await markTrip('zzzzzz', post('https://x/', { party: 'ray', state: 'booked', key: RAY }), env);
  check('marking a trip that does not exist is a 404', nowhere.status === 404);

  /* Two, both from the save: the trip itself and the per-IP trip-write counter.
   * None of the refusals above added to it, which is the property under test --
   * a rejected mark must not be a way to spend a write. */
  check('none of those refusals wrote anything', kv.writes === 2, 'writes ' + kv.writes);

  // The claim.
  const w0 = kv.writes;
  const m1 = await (await markTrip(id, post('https://x/', { party: 'ray', state: 'booked', key: RAY }), env)).json();
  check('Ray books', m1.ok && m1.marks.ray && m1.marks.ray.s === 'booked', JSON.stringify(m1));
  check('booking costs exactly one write', kv.writes === w0 + 1, 'writes ' + (kv.writes - w0));

  const m2 = await (await markTrip(id, post('https://x/', { party: 'ray', state: 'booked', key: RAY }), env)).json();
  check('re-posting the same state writes nothing', m2.wrote === false && kv.writes === w0 + 1);

  // The trust boundary.
  const steal = await markTrip(id, post('https://x/', { party: 'ray', state: 'looking', key: ALEX }), env);
  check('a stranger cannot un-book Ray', steal.status === 403, 'got ' + steal.status);
  check('and that refusal wrote nothing', kv.writes === w0 + 1);

  const alexOk = await (await markTrip(id, post('https://x/', { party: 'alex', state: 'booked', key: ALEX }), env)).json();
  check('but an unclaimed person is still claimable', alexOk.ok && alexOk.marks.alex.s === 'booked');

  // Reads.
  const marksBody = await (await readMarks(id, env)).json();
  check('/marks reports both', marksBody.marks.ray.s === 'booked' && marksBody.marks.alex.s === 'booked');
  check('/marks leaks no keys', JSON.stringify(marksBody).indexOf('r4yk3y') === -1
    && marksBody.keys === undefined, JSON.stringify(marksBody));
  const marksRes = await readMarks(id, env);
  check('/marks is never cached', marksRes.headers.get('Cache-Control') === 'no-store');

  const tripRes = await readTrip(id, env);
  const tripBody = await tripRes.json();
  const tripText = JSON.stringify(tripBody);
  check('the trip document leaks no keys', tripText.indexOf('r4yk3y') === -1 && tripText.indexOf('al3x') === -1);
  check('and carries no roster at all, so it can stay cached',
    tripBody.marks === undefined && tripBody.n === undefined);
  check('the trip document is still the trip',
    tripBody.v === 1 && tripBody.payload.q.dest === 'PIT' && !!tripBody.data.trips);
  check('the trip document is still cached hard',
    (tripRes.headers.get('Cache-Control') || '').indexOf('max-age=300') > -1);

  // Un-booking keeps the claim.
  await markTrip(id, post('https://x/', { party: 'ray', state: 'looking', key: RAY }), env);
  const after = await (await readMarks(id, env)).json();
  check('un-booking removes the mark', after.marks.ray === undefined, JSON.stringify(after.marks));
  const stillRays = await markTrip(id, post('https://x/', { party: 'ray', state: 'booked', key: ALEX }), env);
  check('but not the claim', stillRays.status === 403, 'got ' + stillRays.status);

  // The write ceiling, which is the whole rate limit.
  const stored = JSON.parse(kv.store.get('trip:' + id));
  stored.n = LIMITS.tripMarksMax;
  kv.store.set('trip:' + id, JSON.stringify(stored));
  const w1 = kv.writes;
  const capped = await markTrip(id, post('https://x/', { party: 'ray', state: 'booked', key: RAY }), env);
  check('the per-trip write ceiling stops further updates', capped.status === 429, 'got ' + capped.status);
  check('and the refusal itself writes nothing', kv.writes === w1);

  /* The whole lifecycle, counted: 2 to share it (trip + the per-IP counter),
   * then 1 each for Ray booking, Alex booking and Ray un-booking. Everything
   * else above -- five refusals, a repeat post, a 403, two reads of the roster
   * and a read of the document -- was free. */
  check('a two-person trip shared, booked and un-booked cost 5 writes end to end',
    kv.writes === 5, 'writes ' + kv.writes);
})();

/* ---------------------------------------------------------- the origin gate
 *
 * workers.dev means WAF and rate-limiting rules do not apply, so every
 * protection this worker has is code -- and this is the one that stops a
 * hostile page spending the month's searches using its visitors' IPs, each of
 * which looks like a single polite caller.
 *
 * Untested until now, and about to matter: moving the app to a custom domain
 * means adding a second origin to a comma-separated list. Get that wrong and
 * GET still works, so shared links open and the app looks alive, while every
 * POST -- searching, saving a trip, marking a seat booked -- returns 403. The
 * failure is silent in exactly the place nobody checks first. */
await (async () => {
  /* The provider stub is torn down above, for the roster tests that must not
   * have one. These POSTs reach the search path, so it goes back on: without it
   * they leave the machine and hit the real SerpApi with a junk key, which is
   * a test suite making network calls to a metered API. */
  const stub = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/account.json')) {
      return { json: async () => ({ this_month_usage: billed, total_searches_left: 250 - billed,
                                    searches_per_month: 250, account_rate_limit_per_hour: 50,
                                    this_hour_searches: billed }) };
    }
    if (u.includes('serpapi.com/search.json')) {
      billed++;
      return { json: async () => ({ best_flights: [{ price: 400, total_duration: 300,
        flights: [{ airline: 'United', flight_number: 'UA 500',
          departure_airport: { id: 'SFO', time: '2027-02-12 08:00' },
          arrival_airport: { id: 'PIT', time: '2027-02-12 16:00' }, extensions: [] }],
        extensions: ['1 free checked bag'] }], other_flights: [] }) };
    }
    throw new Error('unexpected fetch: ' + u);
  };

  const twoOrigins = { ...env, ALLOWED_ORIGINS: 'https://flywith.test,https://app.test' };
  const from = (origin, envv) => new Request('https://api.test/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin,
               'CF-Connecting-IP': '203.0.113.77' },
    body: JSON.stringify(rt(party(2))) });

  fresh();
  const old1 = await worker.fetch(from('https://app.test'), twoOrigins);
  check('a second origin does not displace the first', old1.status === 200,
    'got ' + old1.status);
  fresh();
  const new1 = await worker.fetch(from('https://flywith.test'), twoOrigins);
  check('and the new domain is served too', new1.status === 200, 'got ' + new1.status);

  /* Whitespace around the comma is the mistake a human makes editing a toml
   * line, and it must not cost an afternoon of "why is search broken". */
  fresh();
  const spaced = await worker.fetch(from('https://flywith.test'),
    { ...env, ALLOWED_ORIGINS: 'https://app.test , https://flywith.test' });
  check('spaces around the comma are tolerated', spaced.status === 200,
    'got ' + spaced.status);

  fresh();
  const stranger = await worker.fetch(from('https://evil.test'), twoOrigins);
  check('an origin not on the list is refused', stranger.status === 403,
    'got ' + stranger.status);
  check('...and the refusal spends no search', billed === 0, 'billed ' + billed);
  check('...and writes nothing, so it cannot be used to burn the KV ceiling',
    kvWrites === 0, 'writes ' + kvWrites);

  /* A scheme or a trailing slash is a different origin to a browser, and the
   * list is matched exactly. Pinned so the asymmetry is a decision on record
   * rather than a surprise during the move. */
  fresh();
  const scheme = await worker.fetch(from('http://flywith.test'), twoOrigins);
  check('http is not https -- the list is matched exactly', scheme.status === 403,
    'got ' + scheme.status);

  /* Localhost always passes, so the app can be developed against the real
   * worker without editing deployed config. */
  fresh();
  const local = await worker.fetch(from('http://localhost:8000'), twoOrigins);
  check('localhost is always allowed', local.status === 200, 'got ' + local.status);

  /* Unset is permissive, which is only safe because wrangler.toml sets it.
   * Asserted so that the comment claiming it stays true. */
  fresh();
  const unset = await worker.fetch(from('https://anything.test'), { ...env, ALLOWED_ORIGINS: '' });
  check('an unset list is permissive, as documented', unset.status === 200,
    'got ' + unset.status);

  /* Reads are deliberately ungated: a shared link has to open inside WhatsApp
   * and iMessage, whose in-page browsers send no Origin this worker chose. */
  const anyGet = await worker.fetch(new Request('https://api.test/trip/abc123', {
    headers: { Origin: 'https://evil.test' } }), twoOrigins);
  check('reads stay open, so shared links work from any app', anyGet.status !== 403,
    'got ' + anyGet.status);
  globalThis.fetch = stub;
})();

console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASSED' : pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
