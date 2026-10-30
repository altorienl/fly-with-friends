/* Tests for "Is another day cheaper?".
 *
 * This is the only control in the app that spends money when you touch it. Each
 * tap sends real searches against a 250-a-month allowance with no overage --
 * the provider refuses rather than billing over -- so two things have to be
 * right before anything else: the set of dates it asks about, and the number it
 * promises to spend asking.
 *
 * The number is the one a person reads and consents to. It must never come in
 * UNDER the quote, because that is a button that lied, and it must not be wildly
 * over, because then nobody taps it. The cache makes the real figure lower, so
 * the quote is an upper bound by design -- asserted here as exactly that.
 *
 * No network: the date and cost logic is sliced into a vm with no fetch
 * defined, so a candidate that reached for the provider would throw rather than
 * spend a search.
 */
var fs = require('fs'), vm = require('vm');
var src = fs.readFileSync(__dirname + '/app.js', 'utf8');

var pass = 0, fail = 0;
function check(n, c, extra) {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (extra ? '\n          ' + extra : '')); }
}
function eq(n, got, want) { check(n, got === want, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want)); }

function cut(a, b, label) {
    var i = src.indexOf(a), j = src.indexOf(b);
    if (i < 0 || j < 0 || j < i) {
        console.error('FAIL: could not locate ' + label + ' in app.js');
        process.exit(1);
    }
    return src.slice(i, j);
}

var ctx = {
    console: console,
    AIRPORTS: require(__dirname + '/airports.js'),
    state: { q: null },
    SHIFTS: {},
    BUDGET: null,
    /* The clock is frozen, because "a departure in the past cannot be searched"
     * is one of the rules under test and a suite that depends on the real date
     * passes until the fixture dates go by. */
    TODAY: '2027-02-01',
};
ctx.todayISO = function () { return ctx.TODAY; };
ctx.hasReturn = function () { return !!(ctx.state.q && ctx.state.q.ret); };
ctx.travelers = function () { return ctx.TRAVELERS; };
vm.createContext(ctx);
vm.runInContext(cut('function shiftDays(iso, n) {',
                    '/* Prices one alternative trip from an already-fetched payload. */',
                    'date shift'), ctx);

function trip(dep, ret, origins) {
    ctx.state.q = { dest: 'PIT', dep: dep, ret: ret };
    ctx.TRAVELERS = (origins || [['SFO'], ['ORD'], ['ATL']]).map(function (o, i) {
        return { id: 'p' + i, name: 'P' + i, origins: o, bags: {} };
    });
    ctx.SHIFTS = {};
}

console.log('\n-- which dates it asks about --');
(function () {
    trip('2027-03-10', '2027-03-14');
    var c = ctx.shiftCandidates();
    eq('four candidates on a round trip', c.length, 4);
    var by = {};
    c.forEach(function (x) { by[x.k] = x; });
    eq('the whole trip a day earlier', by['all-'].dep + '|' + by['all-'].ret, '2027-03-09|2027-03-13');
    eq('the whole trip a day later', by['all+'].dep + '|' + by['all+'].ret, '2027-03-11|2027-03-15');
    /* The two the owner named, and the two the old pair could not express: both
     * of these keep one end of the trip exactly where it is. */
    eq('leave a day later keeps the return', by['dep+'].dep + '|' + by['dep+'].ret, '2027-03-11|2027-03-14');
    eq('stay an extra day keeps the departure', by['ret+'].dep + '|' + by['ret+'].ret, '2027-03-10|2027-03-15');
    check('every candidate is a different pair of dates',
          Object.keys(c.reduce(function (m, x) { m[ctx.shiftKey(x)] = 1; return m; }, {})).length === 4);
    check('and none of them is the trip the reader is already looking at',
          c.every(function (x) { return ctx.shiftKey(x) !== '2027-03-10|2027-03-14'; }));
})();

console.log('\n-- dates it must refuse to ask about --');
(function () {
    /* A one-way trip has no return to move, so two of the four do not exist. */
    trip('2027-03-10', null);
    var one = ctx.shiftCandidates();
    eq('a one-way trip has two candidates, not four', one.length, 2);
    check('neither of them invents a return date',
          one.every(function (c) { return c.ret === null; }),
          JSON.stringify(one.map(function (c) { return c.ret; })));

    /* Today minus one is in the past and cannot be searched at all. */
    trip(ctx.TODAY, '2027-02-05');
    var todayTrip = ctx.shiftCandidates();
    check('a trip leaving today does not offer yesterday',
          todayTrip.every(function (c) { return c.dep >= ctx.TODAY; }),
          JSON.stringify(todayTrip.map(function (c) { return c.k + ':' + c.dep; })));

    /* "Leave a day later" on a one-night trip would land on the return date. */
    trip('2027-03-10', '2027-03-11');
    var tight = ctx.shiftCandidates();
    check('leave a day later is dropped when it would meet the return',
          !tight.some(function (c) { return c.k === 'dep+'; }),
          JSON.stringify(tight.map(function (c) { return c.k; })));
    check('staying an extra day is still offered on a one-night trip',
          tight.some(function (c) { return c.k === 'ret+'; }));
    check('every surviving candidate returns after it departs',
          tight.every(function (c) { return !c.ret || c.ret > c.dep; }));
})();

console.log('\n-- what it promises to spend --');
(function () {
    trip('2027-03-10', '2027-03-14');
    /* Three parties, three distinct origins, so three routes. The two whole-trip
     * candidates move both ends and pay for two legs each; the two single-ended
     * ones move one end, and the unchanged leg is the same route on the same
     * date, which the worker serves from its per-leg cache for nothing. */
    eq('three distinct origins are three routes', ctx.shiftRoutes(), 3);
    eq('a whole-trip shift pays for two legs', ctx.shiftLegs(ctx.shiftCandidates()[0]), 2);
    var byK = {};
    ctx.shiftCandidates().forEach(function (c) { byK[c.k] = c; });
    eq('leaving a day later pays for one', ctx.shiftLegs(byK['dep+']), 1);
    eq('staying an extra day pays for one', ctx.shiftLegs(byK['ret+']), 1);
    eq('so the whole scan quotes 18, not 24', ctx.shiftCost(), 18);

    /* Travellers sharing an origin set collapse to one search upstream, so
     * quoting parties x legs over-charges by exactly what the dedupe saves. */
    trip('2027-03-10', '2027-03-14', [['SFO'], ['SFO'], ['SFO'], ['ORD']]);
    eq('four friends from two cities are two routes', ctx.shiftRoutes(), 2);
    eq('and the quote follows the routes, not the heads', ctx.shiftCost(), 12);

    /* Multi-airport origins are still one search -- the provider takes them
     * comma-separated -- and the order they were typed in must not matter. */
    trip('2027-03-10', '2027-03-14', [['SFO', 'OAK'], ['OAK', 'SFO']]);
    eq('the same airports in a different order are one route', ctx.shiftRoutes(), 1);

    /* Closed airports are never searched, so they are never quoted either. */
    trip('2027-03-10', '2027-03-14', [['KBP'], ['ORD']]);
    eq('a closed airport is not a route', ctx.shiftRoutes(), 1);

    /* Somebody whose only airport is closed is not searched, so they are not
     * quoted -- and they must not silently make the whole scan free either.
     * Migrated from test-share-safety.js, which owned this arithmetic against
     * the two-candidate model. */
    trip('2027-03-10', '2027-03-14', [['SFO'], ['KBP']]);
    eq('somebody with no usable airport is not charged for', ctx.shiftRoutes(), 1);
    eq('and the scan still costs something', ctx.shiftCost(), 6);
    /* Zero is not a price, it is the absence of a scan: renderShifts hides the
     * whole section rather than offering a free check that checks nothing. */
    trip('2027-03-10', '2027-03-14', [['KBP'], ['IEV']]);
    eq('a group with no usable airport at all quotes nothing', ctx.shiftCost(), 0);
    check('...and renderShifts refuses to draw a button for it',
          /if \(!shiftRoutes\(\)\) \{ host\.className = 'shifts hidden'; return; \}/
            .test(src));

    /* A one-way trip pays for one leg on each of its two candidates. */
    trip('2027-03-10', null, [['SFO'], ['ORD'], ['ATL'], ['DEN']]);
    eq('4 cities, one way: 8', ctx.shiftCost(), 8);
    trip('2027-03-10', '2027-03-14', [['SFO'], ['ORD'], ['ATL'], ['DEN']]);
    eq('4 cities, round trip: 24', ctx.shiftCost(), 24);

    /* A date already priced is not paid for twice. */
    trip('2027-03-10', '2027-03-14');
    var full = ctx.shiftCost();
    ctx.SHIFTS[ctx.shiftKey(ctx.shiftCandidates()[0])] = { priced: { total: 1 } };
    check('a date already checked drops out of the quote',
          ctx.shiftCost() === full - 6, 'was ' + full + ', now ' + ctx.shiftCost());
})();

console.log('\n-- the quote is an upper bound --');
(function () {
    /* The guarantee a person is consenting to. Summed per candidate from the
     * legs that candidate actually changes, which is the same list
     * runShiftScan sends -- so the quote cannot come in under the spend. */
    trip('2027-03-10', '2027-03-14');
    var cands = ctx.shiftCandidates();
    var worst = cands.reduce(function (n, c) { return n + ctx.shiftLegs(c) * ctx.shiftRoutes(); }, 0);
    check('the quote equals the most the scan can bill',
          ctx.shiftCost() === worst, ctx.shiftCost() + ' vs ' + worst);
    check('no candidate pays for a leg it does not move',
          cands.every(function (c) {
              var moved = (c.dep !== ctx.state.q.dep) + (c.ret !== ctx.state.q.ret);
              return ctx.shiftLegs(c) === moved;
          }));
    check('and nothing is quoted at zero, which would be a free search',
          cands.every(function (c) { return ctx.shiftLegs(c) > 0; }));
})();

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail)
                         : 'ALL ' + pass + ' CHECKS PASSED'));
process.exitCode = fail ? 1 : 0;
