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

/* The timeline's ruler lives here rather than in a UI suite because what it
 * gets wrong is arithmetic: which step divides the window, where a tick lands
 * as a percentage, and what a time past midnight is called. */
ctx.SET = { time24: false };
ctx.clock = function (m) {
    var d = new Date(m * 60000), h = d.getUTCHours(), mm = d.getUTCMinutes();
    return (h % 12 === 0 ? 12 : h % 12) + ':' + (mm < 10 ? '0' + mm : mm) + (h < 12 ? 'am' : 'pm');
};
vm.runInContext(cut('var RULER_STEPS = [', 'function timeline(picks', 'ruler and label rows'), ctx);

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


console.log('\n-- the timeline ruler --');
(function () {
    var labels = function (from, to) {
        return ctx.rulerTicks(from, to).map(function (t) { return t.label; }).join(' ');
    };

    /* The two real cards that prompted this. The axis is scaled to the cluster
     * with 45% padding, so these two windows are drawn the same width while
     * covering 55 minutes and 5h38m. That is the whole reason for a ruler, and
     * it is why the step has to come from the span rather than be fixed. */
    var lo1 = 11 * 60 + 10, hi1 = 11 * 60 + 15, pad1 = Math.max(Math.round((hi1 - lo1) * 0.45), 25);
    eq('a five-minute landing window is ruled in quarter hours',
       labels(lo1 - pad1, hi1 + pad1), '11am 11:15am 11:30am');

    var lo2 = 21 * 60, hi2 = 23 * 60 + 58, pad2 = Math.max(Math.round((hi2 - lo2) * 0.45), 25);
    eq('a three-hour one is ruled in two-hour steps',
       labels(lo2 - pad2, hi2 + pad2), '8pm 10pm 12am');

    /* Midnight is the label most likely to be wrong, and the one that matters
     * most: a reader needs to see that the window crossed into the next day. */
    check('a window crossing midnight says so',
          labels(23 * 60, 25 * 60).indexOf('12am') !== -1, labels(23 * 60, 25 * 60));

    /* Four is the ceiling. Past that this stops being a caption. */
    var manySpans = [30, 55, 90, 140, 200, 338, 600, 900, 1440, 2880];
    check('no window gets more than four ticks',
          manySpans.every(function (sp) { return ctx.rulerTicks(600, 600 + sp).length <= 4; }),
          manySpans.map(function (sp) { return sp + 'm:' + ctx.rulerTicks(600, 600 + sp).length; }).join(' '));

    /* .timeline clips its overflow, so a tick at 1% is a label sliced in half. */
    /* Each label needs half its own width of room, so the bound is per tick.
     * Checked as pixels on the narrowest axis this renders into, which is what
     * the rule actually protects -- a percentage alone would pass for a short
     * label and still clip a long one. */
    check('no label would be clipped on the narrowest axis',
          manySpans.every(function (sp) {
              return ctx.rulerTicks(600, 600 + sp).every(function (t) {
                  var halfPx = t.label.length * 6 / 2;
                  var centrePx = t.pct / 100 * 300;
                  return centrePx - halfPx >= 0 && centrePx + halfPx <= 300;
              });
          }));

    /* Ticks are snapped to the step, not to wherever the window began. */
    check('ticks land on round times, not on the window edge',
          ctx.rulerTicks(647, 702).every(function (t) { return t.m % 15 === 0; }),
          JSON.stringify(ctx.rulerTicks(647, 702).map(function (t) { return t.m; })));

    /* A degenerate window must not loop forever or divide by zero. */
    eq('a zero-width window has no ruler', ctx.rulerTicks(600, 600).length, 0);
    eq('a backwards window has no ruler', ctx.rulerTicks(700, 600).length, 0);

    ctx.SET.time24 = true;
    eq('24-hour mode keeps the minutes', labels(lo2 - pad2, hi2 + pad2), '20:00 22:00 00:00');
    ctx.SET.time24 = false;
})();

console.log('\n-- timeline labels do not collide --');
(function () {
    var at = function (pcts, label) {
        return ctx.labelRows(pcts.map(function (p) { return { pct: p, label: label || '11:02am' }; }));
    };
    /* The reported case, measured off the device: three landings 13 minutes
     * apart put two labels 40px apart on a 324px axis, and a label is 41px
     * wide. They printed over each other. */
    var reported = [39.7, 52.4, 60.3];
    check('three close landings do not share a row',
          JSON.stringify(at(reported)) !== JSON.stringify([0, 0, 0]), JSON.stringify(at(reported)));

    /* The real property, stated as geometry rather than as a row pattern:
     * nothing printed on the same row may overlap anything else on it. */
    var overlapFree = function (pcts, label) {
        var rows = at(pcts, label), seen = {};
        for (var i = 0; i < pcts.length; i++) {
            if (rows[i] < 0) continue;
            var half = (label || '11:02am').length * 7 / 2, c = pcts[i] / 100 * 300;
            var box = [c - half, c + half];
            var list = seen[rows[i]] = seen[rows[i]] || [];
            for (var j = 0; j < list.length; j++) {
                if (box[0] < list[j][1] && box[1] > list[j][0]) return false;
            }
            list.push(box);
        }
        return true;
    };
    check('no two labels on one row overlap, on the reported case',
          overlapFree(reported));
    /* Eight travelers inside one tight window is the worst this can face. */
    var dense = [30, 34, 38, 42, 46, 50, 54, 58];
    check('...nor when eight people land within minutes of each other',
          overlapFree(dense), JSON.stringify(at(dense)));
    check('...nor on a long label in 24-hour-plus-seconds width',
          overlapFree(dense, '11:02am'));

    /* Dropping beats overlapping, but only as a last resort. */
    check('labels are only dropped once three rows are full',
          at(dense).filter(function (r) { return r < 0; }).length < dense.length - 2,
          JSON.stringify(at(dense)));
    check('a well-spaced timeline keeps every label on the first row',
          JSON.stringify(at([10, 40, 70])) === '[0,0,0]', JSON.stringify(at([10, 40, 70])));
    eq('a single mark is never pushed down', JSON.stringify(at([50])), '[0]');
})();

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail)
                         : 'ALL ' + pass + ' CHECKS PASSED'));
process.exitCode = fail ? 1 : 0;
