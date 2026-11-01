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

/* The timeline's scale lives here rather than in a UI suite because what it
 * gets wrong is arithmetic: which day the card is drawn on, which marks are
 * too close together to draw apart, where a mark lands as a percentage of the
 * card, and what a time past midnight is called.
 *
 * Sliced by the two landmark comments wrapped round it in app.js rather than
 * by the name of the first statement in it -- the last suite that sliced on
 * something a refactor could rewrite exited 1 for a day with nobody noticing.
 * cut() exits non-zero when it cannot find either end. */
ctx.SET = { time24: false };
ctx.clock = function (m) {
    var d = new Date(m * 60000), h = d.getUTCHours(), mm = d.getUTCMinutes();
    var pad = (mm < 10 ? '0' : '') + mm;
    if (ctx.SET.time24) return (h < 10 ? '0' + h : h) + ':' + pad;
    return (h % 12 === 0 ? 12 : h % 12) + ':' + pad + (h < 12 ? 'am' : 'pm');
};
vm.runInContext(cut('/* --- BEGIN timeline scale', '/* --- END timeline scale',
                    'the timeline scale'), ctx);

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


/* === BEGIN adaptive timeline tests ==================================
 *
 * The timeline's scale lives here rather than in a UI suite because what it
 * gets wrong is arithmetic: how far in the card is zoomed, where a mark lands
 * as a percentage of it, which faces had to be pushed off their own time to
 * stay legible, and what the scale under them is allowed to say.
 *
 * Sliced by the two landmark comments wrapped round it in app.js rather than
 * by the name of the first statement in it -- the last suite that sliced on
 * something a refactor could rewrite exited 1 for a day with nobody noticing.
 * cut() exits non-zero when it cannot find either end.
 *
 * Three cards have been built and rejected here, and the first two are what
 * most of this file is guarding against coming back:
 *
 *   1. cluster plus 45% padding, no labels -- 55 minutes and 5h38m drawn
 *      identically;
 *   2. hour ticks under that, which at cluster zoom printed the arrival times
 *      back at the reader as a second row of times;
 *   3. the whole day, which is honest and 7px wide for a 37-minute group.
 *
 * So: an adaptive window, and a scale whose labels are durations, which no
 * clock time can collide with. Both halves are asserted below.
 *
 * Minutes are minutes since the epoch throughout, so a midnight is a multiple
 * of 1440 and every rung of the ladder divides one. */
var DAY0 = 20799 * 1440;
function mins(h, m) { return DAY0 + h * 60 + (m || 0); }
function win(list) { return ctx.fitWindow(list); }
function width(w) { return w.to - w.from; }

console.log('\n-- the window is the smallest one that holds the group --');
(function () {
    /* The five cases in the brief, as the owner stated them. */
    eq('a minute apart gets a four-minute line',
       width(win([mins(16, 28), mins(16, 29)])), 4);
    eq('fifteen minutes apart gets twenty',
       width(win([mins(16, 28), mins(16, 43)])), 20);
    eq('forty minutes apart gets an hour',
       width(win([mins(16, 28), mins(17, 8)])), 60);
    eq('three hours apart gets four',
       width(win([mins(14, 28), mins(17, 28)])), 240);
    eq('seven hours apart gets eight',
       width(win([mins(14, 9), mins(14, 26), mins(21, 26)])), 480);

    /* The live trip, both legs, at the positions they actually render at. */
    var arr = win([mins(16, 28), mins(16, 40), mins(17, 5)]);
    eq('the real arrival cluster is drawn on an hour', width(arr), 60);
    eq('...from a quarter past', arr.from, mins(16, 15));
    eq('...at a fifteen-minute step', arr.step, 15);
    var ret = win([mins(14, 9), mins(14, 26), mins(21, 26)]);
    eq('the real return is drawn on eight hours, at a two-hour step', ret.step, 120);
    eq('...starting on the hour', ret.from, mins(14, 0));

    eq('everyone on one flight still gets a window',
       width(win([mins(16, 28), mins(16, 28)])), 4);
    check('...centered on the moment they share',
          win([mins(9, 0), mins(9, 0)]).from === mins(8, 58));
    eq('nothing to draw is not a window', ctx.fitWindow([]), null);

    /* The properties, swept rather than sampled: every start minute of a day
     * against every spread from a minute to three days. */
    var bad = [], shrunk = [], offCenter = [], unaligned = [], loose = [];
    var prev = 0;
    [0, 1, 2, 3, 5, 8, 13, 21, 37, 40, 55, 89, 120, 144, 233, 377, 610, 987,
     1439, 1440, 1600, 2500, 4320, 7000].forEach(function (spread) {
        for (var s = 0; s < 1440; s += 7) {
            var lo = DAY0 + s, hi = lo + spread;
            var w = win([lo, hi, (lo + hi) / 2 | 0]);
            if (!(w.from <= lo && w.to >= hi)) bad.push(spread + '@' + s);
            if (width(w) !== 4 * w.step) loose.push(spread + '@' + s);
            if (w.from % w.step !== 0) unaligned.push(spread + '@' + s);
            /* Alignment is the only thing allowed to push off center a card, and it
             * can only ever be worth half a step. */
            if (Math.abs((w.from + w.to) / 2 - (lo + hi) / 2) > w.step / 2 + 1e-9) {
                offCenter.push(spread + '@' + s);
            }
            /* The smallest rung that holds it: no rung below the one chosen
             * may also hold it. */
            for (var i = 0; i < ctx.SCALE_STEPS.length; i++) {
                if (ctx.SCALE_STEPS[i] >= w.step) break;
                if (ctx.stepHolds(lo, hi, ctx.SCALE_STEPS[i])) shrunk.push(spread + '@' + s + '/' + ctx.SCALE_STEPS[i]);
            }
        }
        /* A wider group can never be given a narrower window. */
        var here = width(win([DAY0, DAY0 + spread]));
        if (here < prev) bad.push('shrank at ' + spread);
        prev = here;
    });
    check('every window holds every mark on it', !bad.length, bad.slice(0, 4).join(' '));
    check('every window is exactly four steps wide', !loose.length, loose.slice(0, 4).join(' '));
    check('every window starts on a step boundary', !unaligned.length, unaligned.slice(0, 4).join(' '));
    check('no window is off center by more than half a step',
          !offCenter.length, offCenter.slice(0, 4).join(' '));
    check('and no smaller step would have held the group',
          !shrunk.length, shrunk.slice(0, 4).join(' '));

    /* The rungs, which are how the card decides whether reaching a traveler
     * who cannot make the window is worth the zoom it costs. */
    check('every step on the ladder is its own rung',
          ctx.SCALE_STEPS.every(function (st, i) { return ctx.rung(st) === i; }),
          ctx.SCALE_STEPS.map(function (st) { return ctx.rung(st); }).join(' '));
    eq('a two-day step is one rung past a one-day step',
       ctx.rung(2880) - ctx.rung(1440), 1);
    eq('and a four-day step is three past it', ctx.rung(5760) - ctx.rung(1440), 3);
    check('rungs only ever go up as the step does',
          ctx.SCALE_STEPS.concat([2880, 4320, 5760]).every(function (st, i, a) {
              return i === 0 || ctx.rung(st) > ctx.rung(a[i - 1]);
          }));
    /* The policy that uses them: a straggler a quarter of an hour past the
     * group costs one rung and is drawn; one six hours past costs three and
     * is not. */
    eq('reaching a straggler fifteen minutes out costs one rung',
       ctx.rung(win([mins(16, 28), mins(17, 8), mins(17, 23)]).step)
       - ctx.rung(win([mins(16, 28), mins(17, 8)]).step), ctx.ZOOM_GIVE);
    check('reaching one six hours out costs more than the card will give',
          ctx.rung(win([mins(16, 28), mins(17, 8), mins(23, 8)]).step)
          - ctx.rung(win([mins(16, 28), mins(17, 8)]).step) > ctx.ZOOM_GIVE);

    /* Past the top of the ladder the step is whole days. A leg spanning most
     * of a week is not a card anyone wants, but it must not be a crash. */
    var wk = win([DAY0, DAY0 + 9 * 1440]);
    check('a nine-day spread still gets a window that holds it',
          wk.from <= DAY0 && wk.to >= DAY0 + 9 * 1440 && width(wk) === 4 * wk.step,
          JSON.stringify({ step: wk.step, days: width(wk) / 1440 }));
    eq('...and its step is a whole number of days', wk.step % 1440, 0);
})();

console.log('\n-- the scale says how far in the card is zoomed --');
(function () {
    var labels = function (list) {
        var w = win(list);
        return ctx.scaleTicks(w.from, w.step).map(function (t) { return t.label; }).join(' ');
    };
    eq('a minute apart is labeled in minutes', labels([mins(16, 28), mins(16, 29)]), '1m 2m 3m');
    eq('the real arrival cluster reads as an hour across the card',
       labels([mins(16, 28), mins(16, 40), mins(17, 5)]), '15m 30m 45m');
    eq('the real return reads as eight',
       labels([mins(14, 9), mins(14, 26), mins(21, 26)]), '2h 4h 6h');
    eq('a day across the card says so', labels([mins(1, 0), mins(23, 0)]), '6h 12h 18h');

    /* THE RULE THAT RETIRES THE SECOND ATTEMPT. Above the rule everything is
     * a clock time; below it everything is a duration. A duration has no
     * colon and no am/pm, so no reader can take a scale label for somebody's
     * arrival time, at any zoom, on any data. It is a property of the format
     * and not of the numbers, which is why it can be asserted exhaustively. */
    var every = [];
    ctx.SCALE_STEPS.concat([2880, 4320, 10080]).forEach(function (s) {
        ctx.scaleTicks(DAY0, s).forEach(function (t) { every.push(t.label); });
    });
    check('no scale label anywhere contains a colon',
          every.every(function (l) { return l.indexOf(':') < 0; }), every.join(' '));
    check('nor am or pm',
          every.every(function (l) { return !/am|pm/.test(l); }), every.join(' '));
    check('every one of them is digits and one unit letter',
          every.every(function (l) { return /^\d+[mhd]$/.test(l); }), every.join(' '));
    check('...a whole number of them, never a fraction',
          every.every(function (l) { return String(parseInt(l, 10)) === l.slice(0, -1); }),
          every.join(' '));
    /* 24-hour mode changes how a time is written and must not reach the
     * scale, which has nothing to write a time with. */
    ctx.SET.time24 = true;
    eq('24-hour mode does not change the scale',
       labels([mins(16, 28), mins(16, 40), mins(17, 5)]), '15m 30m 45m');
    ctx.SET.time24 = false;

    /* One unit a card, so the row reads as one quantity growing. */
    var mixed = ctx.SCALE_STEPS.filter(function (s) {
        var u = ctx.scaleTicks(DAY0, s).map(function (t) { return t.label.slice(-1); });
        return u[0] !== u[1] || u[1] !== u[2];
    });
    check('one unit for all three labels on a card', !mixed.length, mixed.join(' '));
    var backwards = ctx.SCALE_STEPS.filter(function (s) {
        var v = ctx.scaleTicks(DAY0, s).map(function (t) { return parseInt(t.label, 10); });
        return !(v[0] < v[1] && v[1] < v[2]);
    });
    check('and the three of them grow left to right', !backwards.length, backwards.join(' '));

    /* HOW THE TWO CARDS STAY COMPARABLE. Adaptive zoom costs the shared axis.
     * What is bought back is that the ticks are at the same three pixels on
     * every card in the app, so the arrival card's scale and the departure
     * card's scale form a column and differ only in what they say. */
    var places = function (list) {
        var w = win(list);
        return ctx.scaleTicks(w.from, w.step).map(function (t) {
            return +ctx.plotPct(t.m, w.from, w.to).toFixed(6);
        }).join(' ');
    };
    var tight = places([mins(16, 28), mins(16, 29)]);
    var wide = places([mins(14, 9), mins(21, 26)]);
    eq('a four-minute card and an eight-hour one tick at the same three places',
       tight, wide);
    eq('...which are the quarter points of the plot', tight, '28 50 72');
    check('so the only thing that differs is what the scale says',
          labels([mins(16, 28), mins(16, 29)]) !== labels([mins(14, 9), mins(21, 26)]));
    /* The guard on that claim: two different windows must never produce the
     * same three labels, or the column would read as one scale. */
    var seen = {}, dupes = [];
    ctx.SCALE_STEPS.forEach(function (s) {
        var key = ctx.scaleTicks(DAY0, s).map(function (t) { return t.label; }).join(' ');
        if (seen[key]) dupes.push(key);
        seen[key] = 1;
    });
    check('no two zoom levels are labeled the same', !dupes.length, dupes.join(' / '));

    eq('a window with no step has no scale', ctx.scaleTicks(DAY0, 0).length, 0);
    eq('and three ticks is all there ever are', ctx.scaleTicks(DAY0, 60).length, 3);
})();

console.log('\n-- the plot is inset so that nothing is clipped --');
(function () {
    var from = DAY0, to = DAY0 + 1440;
    /* The card is 254px wide on a 320px phone, 309px on a 360px one, 324px on
     * a 390px one, 356px on a 430px one and 566px once main hits its 640px
     * cap. Measured off the rendered page, not guessed. */
    var BOXES = [254, 309, 324, 356, 566];

    eq('the start of the window sits on the left inset', ctx.plotPct(from, from, to), 6);
    eq('the end of it sits on the right one', ctx.plotPct(to, from, to), 94);
    eq('the middle of the window is the middle of the card', ctx.plotPct(from + 720, from, to), 50);
    check('and the first half of it is in the left half of the card',
          ctx.plotPct(from + 9 * 60, from, to) < 50 && ctx.plotPct(from + 15 * 60, from, to) > 50);

    /* What the inset is for: a lone 34px face and its own time label, at
     * either end of the window, inside a box that clips its overflow. */
    var box = 324, half = 34 / 2;
    [0, 1, 719, 720, 1438, 1439, 1440].forEach(function (mm) {
        var c = ctx.plotPct(from + mm, from, to) / 100 * box;
        check('a lone face at minute ' + mm + ' of the window needs no clamp at all',
              c - half >= 0 && c + half <= box && ctx.edgeShift(c, half, box) === 0,
              'center ' + c.toFixed(1) + 'px of ' + box);
    });

    /* Everything wider than a lone face -- a row of eight, a range label --
     * is pulled back in, at every width this renders at and at every minute
     * of the window. This is the check that the clamp is a guarantee rather
     * than a nudge that happens to work on the card in front of me. */
    var widest = (34 + 7 * 24) / 2;
    var longest = '11:50am-12:10pm'.length * ctx.LABEL_CH / 2;
    var bad = [], tightest = Infinity;
    BOXES.forEach(function (bw) {
        for (var mm = 0; mm <= 1440; mm++) {
            var c = ctx.plotPct(from + mm, from, to) / 100 * bw;
            [half, widest, longest].forEach(function (h) {
                var s = ctx.edgeShift(c, h, bw);
                if (c + s - h < 0 || c + s + h > bw) bad.push(bw + 'px@' + mm + '/' + h);
                tightest = Math.min(tightest, c + s - h, bw - (c + s + h));
            });
        }
    });
    check('nothing is ever left hanging outside the box', !bad.length, bad.slice(0, 4).join(' '));
    /* EDGE_PAD exactly, not EDGE_PAD less a rounding error. The clamp rounds
     * the way that moves a drawing further in for this reason: rounding to
     * nearest leaves half a pixel of the pad behind, which is a guarantee
     * only until the next sub-pixel layout change. */
    check('and the clamp never spends any of the edge pad',
          tightest >= ctx.EDGE_PAD - 1e-9,
          tightest.toFixed(3) + 'px against a pad of ' + ctx.EDGE_PAD);
    check('and nothing away from the ends is moved at all',
          ctx.edgeShift(162, longest, 324) === 0 && ctx.edgeShift(162, widest, 324) === 0);
})();

console.log('\n-- one face per traveler, and the push to keep them legible --');
(function () {
    var BOX = 324, NARROW = 254;

    /* The open separation is two circles and the air between their rings,
     * except on a card too narrow to hold a row of them. */
    eq('two faces stand 36px apart where there is room', ctx.openSep(2, BOX), 36);
    eq('so do eight, on a 390px phone', ctx.openSep(8, BOX), 36);
    check('eight on a 320px phone close up instead of hanging off the card',
          ctx.openSep(8, NARROW) < 36 && ctx.openSep(8, NARROW) > 30,
          String(ctx.openSep(8, NARROW)));
    check('...and a row of them still fits inside the edge pad',
          7 * ctx.openSep(8, NARROW) + ctx.AVATAR_PX <= NARROW - 2 * ctx.EDGE_PAD,
          (7 * ctx.openSep(8, NARROW) + ctx.AVATAR_PX).toFixed(2) + 'px of ' + NARROW);
    eq('a single face has nothing to be separated from', ctx.openSep(1, BOX), 36);

    /* faceSep is the bound on the lie. A run that is genuinely simultaneous
     * closes all the way to the old facepile lap rather than fanning out and
     * claiming a spread it has not got; a run with real spread in it opens
     * out until every initial is readable. */
    eq('eight people on one flight stay the pile they always were',
       ctx.faceSep(8, 0, 36), ctx.AVATAR_PX - ctx.DOT_LAP);
    eq('...which is the same 202px of card it has always been',
       7 * ctx.faceSep(8, 0, 36) + ctx.AVATAR_PX, 202);
    eq('two people on one flight lap by the same amount', ctx.faceSep(2, 0, 36), 24);
    eq('two faces far enough apart to open fully do', ctx.faceSep(2, 40, 36), 36);
    check('and in between, no face is pushed further than MAX_SHIFT',
          [2, 3, 4, 5, 6, 7, 8].every(function (k) {
              for (var sp = 0; sp <= 300; sp += 3) {
                  var s = ctx.faceSep(k, sp, 36);
                  var drawnSpread = (k - 1) * s;
                  if (drawnSpread > sp && s > ctx.AVATAR_PX - ctx.DOT_LAP
                      && (drawnSpread - sp) / 2 > ctx.MAX_SHIFT + 1e-9) return false;
              }
              return true;
          }));

    /* spreadFaces itself. */
    var sp = function (xs, sep, box) { return ctx.spreadFaces(xs, sep === undefined ? 36 : sep, box || BOX); };
    eq('nobody to place is nothing to place', JSON.stringify(sp([])), '[]');
    eq('faces that are already clear of each other are not moved at all',
       JSON.stringify(sp([60, 120, 200])), '[60,120,200]');
    check('a face on its own stays exactly on its own time',
          sp([162])[0] === 162);

    /* The real arrival card at 390px: 4:28, 4:40 and 5:05pm on an hour. This
     * is the whole point of the redesign -- on the day axis these three were
     * one pile with one range label under it. */
    var arr = win([mins(16, 28), mins(16, 40), mins(17, 5)]);
    var arrX = [mins(16, 28), mins(16, 40), mins(17, 5)].map(function (m) {
        return ctx.plotPct(m, arr.from, arr.to) / 100 * BOX;
    });
    check('the real arrival cluster needs no pushing at all',
          JSON.stringify(sp(arrX)) === JSON.stringify(arrX),
          JSON.stringify(arrX.map(function (x) { return +x.toFixed(1); })));
    check('...because its three faces are 57px and 119px apart',
          Math.round(arrX[1] - arrX[0]) === 57 && Math.round(arrX[2] - arrX[1]) === 119,
          JSON.stringify(arrX.map(function (x) { return +x.toFixed(1); })));

    /* Order, separation, containment and balance, swept over shapes that have
     * each broken a version of this: a pile, a straggle, a pair jammed
     * against one end, everybody on one flight, and eight faces strung from
     * one end of the plot to the other -- which on a 320px phone is wider
     * than the card can carry and is the one case that has to be squeezed.
     *
     * Written as fractions of the plot, because that is what the renderer
     * hands in: plotPct never leaves [6%, 94%] of the box. */
    var SHAPES = [
        [], [0.5], [0.3, 0.31], [0.3, 0.45], [0.5, 0.5, 0.5],
        [0.5, 0.5, 0.5, 0.5], [0.06, 0.07, 0.08, 0.09, 0.1, 0.11, 0.12, 0.13],
        [0.06, 0.19, 0.31, 0.44, 0.56, 0.69, 0.81, 0.94],
        [0.06, 0.07, 0.08, 0.92, 0.93, 0.94], [0.92, 0.93, 0.94],
        [0.06, 0.07, 0.08], [0.06, 0.4, 0.41, 0.42, 0.43, 0.7, 0.71, 0.94]
    ];
    var orderBad = [], sepBad = [], outBad = [], movedBad = [], idemBad = [], leanBad = [];
    [254, 324, 566].forEach(function (bw) {
        SHAPES.forEach(function (frac, si) {
            var xs = frac.map(function (f) { return f * bw; });
            var sep = ctx.openSep(xs.length, bw);
            var out = ctx.spreadFaces(xs, sep, bw);
            var tag = bw + '#' + si;
            var squeezed = (frac.length > 1 ? frac[frac.length - 1] - frac[0] : 0) * bw
                > bw - 2 * ctx.EDGE_PAD - ctx.AVATAR_PX;
            for (var i = 1; i < out.length; i++) {
                if (out[i] < out[i - 1] - 1e-9) orderBad.push(tag);
                /* Either clear of the neighbor, or closed up no tighter than
                 * the lap -- which is the only way a group that is genuinely
                 * simultaneous is allowed to be drawn. */
                if (!squeezed && out[i] - out[i - 1] < ctx.AVATAR_PX - ctx.DOT_LAP - 1e-9) sepBad.push(tag + '/' + i);
            }
            out.forEach(function (x) {
                if (x - ctx.AVATAR_PX / 2 < ctx.EDGE_PAD - 1e-9
                    || x + ctx.AVATAR_PX / 2 > bw - ctx.EDGE_PAD + 1e-9) outBad.push(tag);
            });
            if (xs.length > 1) {
                /* Nothing moves that did not have to. */
                var clear = true;
                for (var j = 1; j < xs.length; j++) if (xs[j] - xs[j - 1] < sep) clear = false;
                var inside = xs[0] - ctx.AVATAR_PX / 2 >= ctx.EDGE_PAD
                    && xs[xs.length - 1] + ctx.AVATAR_PX / 2 <= bw - ctx.EDGE_PAD;
                if (clear && inside && JSON.stringify(out) !== JSON.stringify(xs)) movedBad.push(tag);
                /* And the row is not leaned one way: pooling a run places it
                 * on the run's own mean, so unless an end of the card had to
                 * be respected the group's center of gravity does not move.
                 * That is the least-squares property in the form a reader
                 * would notice it going wrong. */
                var mean = function (v) { return v.reduce(function (a, b) { return a + b; }, 0) / v.length; };
                var slid = out[0] - ctx.AVATAR_PX / 2 <= ctx.EDGE_PAD + 1e-6
                    || out[out.length - 1] + ctx.AVATAR_PX / 2 >= bw - ctx.EDGE_PAD - 1e-6;
                if (!slid && Math.abs(mean(out) - mean(xs)) > 1e-9) leanBad.push(tag);
            }
            /* No cliff edges. A flight time that moves by a minute may not
             * reshuffle the card, so the layout has to be continuous in its
             * input and not merely correct at it. */
            for (var q = 0; q < xs.length; q++) {
                var ys = xs.slice();
                ys[q] += 0.5;
                ys.sort(function (u, v) { return u - v; });
                var moved = ctx.spreadFaces(ys, sep, bw);
                for (var r = 0; r < moved.length; r++) {
                    if (Math.abs(moved[r] - out[r]) > 2 + 1e-9) idemBad.push(tag + '/' + q + '/' + r);
                }
            }
        });
    });
    check('order is never changed', !orderBad.length, orderBad.slice(0, 4).join(' '));
    check('no two faces are drawn closer than the lap',
          !sepBad.length, sepBad.slice(0, 4).join(' '));
    check('no face is drawn outside the box', !outBad.length, outBad.slice(0, 4).join(' '));
    check('and none is moved that did not have to be', !movedBad.length, movedBad.slice(0, 4).join(' '));
    check('the group is never leaned to one side of its own center',
          !leanBad.length, leanBad.slice(0, 4).join(' '));
    check('and half a pixel of input never moves a face more than two',
          !idemBad.length, idemBad.slice(0, 4).join(' '));

    /* Eight people on one flight: the face row is the old 202px pile and the
     * single dot under it is the correction. */
    var all = ctx.spreadFaces([162, 162, 162, 162, 162, 162, 162, 162], 36, 324);
    eq('eight on one flight are drawn as one 202px pile, not fanned over the card',
       Math.round(all[7] - all[0]) + ctx.AVATAR_PX, 202);
    check('...centered where they actually are',
          Math.abs((all[0] + all[7]) / 2 - 162) < 1e-9);
})();

console.log('\n-- one row of times, because labels merge rather than stack --');
(function () {
    var BOX = 324;
    var packed = function (list) {
        var w = win(list);
        var marks = list.map(function (m) {
            return { m: m, x: ctx.plotPct(m, w.from, w.to) / 100 * BOX };
        });
        return ctx.packLabels(marks, BOX);
    };
    var texts = function (list) {
        return packed(list).map(function (p) { return p.label; }).join(' ');
    };

    /* The redesign's headline result. On the day axis this card printed one
     * label, "4:28-5:05pm", because the three faces were one pile. */
    eq('the real arrival card now prints all three times',
       texts([mins(16, 28), mins(16, 40), mins(17, 5)]), '4:28pm 4:40pm 5:05pm');
    eq('the real return card prints the pair as a range and the straggler alone',
       texts([mins(14, 9), mins(14, 26), mins(21, 26)]), '2:09-2:26pm 9:26pm');
    eq('a minute apart, zoomed in to a four-minute window, prints both',
       texts([mins(16, 28), mins(16, 29)]), '4:28pm 4:29pm');
    eq('everyone on one flight prints it once',
       texts([mins(16, 28), mins(16, 28)]), '4:28pm');

    /* Merging, not stacking: a label is never dropped and never printed on a
     * second row, so the card has one height. The guarantee is that whatever
     * comes out does not overlap. */
    var overlapFree = function (ps) {
        for (var i = 1; i < ps.length; i++) {
            if (ps[i - 1].center + ps[i - 1].half + ctx.LABEL_GAP_PX > ps[i].center - ps[i].half + 1e-9) return false;
        }
        return true;
    };
    var covers = function (list, ps) {
        /* Every time on the card is inside some label's range. */
        return list.every(function (m) {
            return ps.some(function (p) { return m >= p.lo && m <= p.hi; });
        });
    };
    var over = [], lost = [], unordered = [];
    var CASES = [
        [mins(16, 28), mins(16, 40), mins(17, 5)],
        [mins(14, 9), mins(14, 26), mins(21, 26)],
        [mins(16, 28), mins(16, 29)],
        [mins(0, 0), mins(0, 1), mins(0, 2), mins(0, 3)],
        [mins(11, 50), mins(12, 10)],
        [mins(23, 50), mins(24, 10)],
        [mins(9, 0), mins(9, 0), mins(9, 0)]
    ];
    for (var k = 2; k <= 8; k++) {
        var even = [];
        for (var j = 0; j < k; j++) even.push(mins(8, 0) + j * 17);
        CASES.push(even);
        var piled = [];
        for (var j2 = 0; j2 < k; j2++) piled.push(mins(8, 0) + (j2 < k - 1 ? 0 : 95));
        CASES.push(piled);
    }
    [254, 324, 566].forEach(function (bw) {
        CASES.forEach(function (list, ci) {
            var w = win(list);
            var marks = list.map(function (m) {
                return { m: m, x: ctx.plotPct(m, w.from, w.to) / 100 * bw };
            });
            var ps = ctx.packLabels(marks, bw);
            if (!overlapFree(ps)) over.push(bw + '#' + ci);
            if (!covers(list, ps)) lost.push(bw + '#' + ci);
            for (var i = 1; i < ps.length; i++) if (ps[i].lo < ps[i - 1].hi) unordered.push(bw + '#' + ci);
        });
    });
    check('no two labels ever overlap, at any card width', !over.length, over.slice(0, 4).join(' '));
    check('and no time is ever dropped off the card', !lost.length, lost.slice(0, 4).join(' '));
    check('and the ranges stay in order and do not interleave',
          !unordered.length, unordered.slice(0, 4).join(' '));

    /* Two label boxes that merely miss each other still read as one run of
     * digits, so merging insists on air on top of the budget. These two
     * centers are 45px apart and the boxes are 42px wide, so they clear each
     * other by three pixels and are merged anyway. */
    var squeak = ctx.packLabels([{ m: mins(16, 28), x: 120 }, { m: mins(17, 5), x: 165 }], 324);
    eq('two labels that only just miss each other are merged, not printed',
       squeak.length, 1);
    var clear = ctx.packLabels([{ m: mins(16, 28), x: 120 }, { m: mins(17, 5), x: 175 }], 324);
    eq('...and two with real air between them are left alone', clear.length, 2);

    /* The clamp has to be inside the merge test. A label at the end of the
     * line is pulled back in, and where it lands can touch a neighbor it
     * cleared perfectly well where it wanted to sit. Packing the unclamped
     * boxes would print one time through another. */
    var pulled = ctx.packLabels([{ m: mins(16, 28), x: 189 }, { m: mins(17, 5), x: 238 }], 254);
    eq('a label pulled in off the end is merged with what it lands on',
       pulled.length, 1);

    /* Merging rather than stacking is only worth it if it actually fires. */
    var jammed = packed([mins(8, 0), mins(8, 1), mins(8, 2), mins(8, 3), mins(8, 4),
                         mins(8, 5), mins(8, 6), mins(8, 7)]);
    check('eight times a minute apart come out as a handful of ranges, not eight labels',
          jammed.length < 8 && jammed.length > 0, JSON.stringify(jammed.map(function (p) { return p.label; })));
    check('...and a merged label is the range that covers what it swallowed',
          jammed.every(function (p) { return p.label === ctx.rangeLabel(p.lo, p.hi); }));
})();

console.log('\n-- what a label is called --');
(function () {
    eq('a single time keeps its plain label', ctx.rangeLabel(mins(16, 28), mins(16, 28)), '4:28pm');
    eq('a range inside one half of the day shares its suffix',
       ctx.rangeLabel(mins(11, 10), mins(11, 15)), '11:10-11:15am');
    eq('the old day-axis landing cluster still reads as one span',
       ctx.rangeLabel(mins(16, 28), mins(17, 5)), '4:28-5:05pm');
    eq('a range across noon has to say both',
       ctx.rangeLabel(mins(11, 50), mins(12, 10)), '11:50am-12:10pm');
    /* The window can cross a midnight and there is no day break drawn on the
     * scale any more, so the label is what says so. */
    eq('and a range across midnight says so in the label',
       ctx.rangeLabel(mins(23, 50), mins(24, 10)), '11:50pm-12:10am');

    ctx.SET.time24 = true;
    eq('24-hour mode has no suffix to share', ctx.rangeLabel(mins(11, 10), mins(11, 15)), '11:10-11:15');
    eq('...and a single 24-hour time is still plain', ctx.rangeLabel(mins(9, 5), mins(9, 5)), '09:05');
    ctx.SET.time24 = false;

    /* packLabels budgets 7px a character against a 15-character worst case. A
     * label that could come out longer would be packed and clamped against a
     * box narrower than the one it prints in. */
    var widest = '', s;
    for (var a = 0; a < 1440; a++) {
        for (var b = a; b < 1440; b += 37) {
            s = ctx.rangeLabel(DAY0 + a, DAY0 + b);
            if (s.length > widest.length) widest = s;
        }
    }
    eq('no label is wider than the 15 characters the packing budgets for', widest.length, 15);
    ctx.SET.time24 = true;
    var widest24 = '';
    for (var c = 0; c < 1440; c++) {
        for (var d = c; d < 1440; d += 37) {
            s = ctx.rangeLabel(DAY0 + c, DAY0 + d);
            if (s.length > widest24.length) widest24 = s;
        }
    }
    eq('nor in 24-hour mode', widest24.length, 11);
    ctx.SET.time24 = false;

    /* Measured off the rendered card with a hidden probe, because this is the
     * one number here that cannot be derived: the UI face is not monospaced,
     * so "4:28pm" is 6.79px a character at 11px and "11:10-11:15am" is 6.43px.
     * The budget has to be an over-estimate at every length -- over-estimating
     * costs a merge, under-estimating prints one time on top of another. */
    var MEASURED_11 = { '4:28pm': 40.73, '9:26pm': 40.73, '11:02am': 47.08,
        '2:09-2:26pm': 70.3, '4:28-5:05pm': 70.3, '11:10-11:15am': 83.64,
        '11:50am-12:10pm': 100.05, '23:59': 31.31, '11:10-11:15': 67.86 };
    var thin = Object.keys(MEASURED_11).filter(function (t) {
        return t.length * ctx.LABEL_CH < MEASURED_11[t];
    });
    check('the label budget is never under what a label measures on the card',
          !thin.length, thin.join(' '));

    /* And the same for the scale, whose labels are now durations, set in
     * tabular figures so every digit is the same width. Measured the same
     * way: "1m" is 15.23px, which is what 7.5 a character failed to cover. */
    var MEASURED_10 = { '1m': 15.23, '2m': 15.23, '3m': 15.23, '4m': 15.23,
        '5m': 15.23, '6m': 15.23, '10m': 21.66, '15m': 21.66, '20m': 21.66,
        '30m': 21.66, '45m': 21.66, '60m': 21.66, '90m': 21.66,
        '1h': 12.42, '2h': 12.42, '3h': 12.42, '4h': 12.42, '6h': 12.42,
        '9h': 12.42, '12h': 18.84, '18h': 18.84, '24h': 18.84, '36h': 18.84,
        '1d': 12.69, '2d': 12.69, '3d': 12.69 };
    var thinTicks = Object.keys(MEASURED_10).filter(function (t) {
        return t.length * ctx.TICK_CH < MEASURED_10[t];
    });
    check('and nor is the scale budget', !thinTicks.length, thinTicks.join(' '));
    var unmeasured = [];
    ctx.SCALE_STEPS.forEach(function (st) {
        ctx.scaleTicks(DAY0, st).forEach(function (t) {
            if (!(t.label in MEASURED_10)) unmeasured.push(t.label);
        });
    });
    check('every scale label the ladder can print has been measured',
          !unmeasured.length, unmeasured.join(' '));
})();

console.log('\n-- the window never draws as a smear --');
(function () {
    var axis = 285;
    var floorPct = ctx.DOT_PX / axis * 100;

    /* The old floor was the bar's own 6px height, because on a day axis a
     * five-minute window was a one-pixel smear. On an adaptive window that
     * case is gone: five minutes fills the card. The only window still
     * narrower than its own ink is a group that is genuinely simultaneous,
     * and the right drawing for that is one dot -- so the floor is the dot's
     * diameter and the bar hides underneath it. */
    eq('everyone on one flight draws exactly one dot and no bar sticking out',
       ctx.spanWidthPct(42, 42, axis), floorPct);
    eq('...and the floor is the dot, not the bar',
       Math.round(floorPct * axis / 100), ctx.DOT_PX);
    check('the bar is thinner than the dots that sit on it',
          ctx.SPAN_H_PX < ctx.DOT_PX);

    /* The correction must not reach anything a reader could mistake for real.
     * On an hour-wide window the live arrival cluster is 62% of the plot. */
    var arr = win([mins(16, 28), mins(16, 40), mins(17, 5)]);
    var l = ctx.plotPct(mins(16, 28), arr.from, arr.to), r = ctx.plotPct(mins(17, 5), arr.from, arr.to);
    check('the real arrival cluster keeps its true width',
          Math.abs(ctx.spanWidthPct(l, r, axis) - (r - l)) < 1e-9,
          'drew ' + ctx.spanWidthPct(l, r, axis).toFixed(3) + '% against ' + (r - l).toFixed(3));
    check('and it is most of the line, which is the point of the whole change',
          (r - l) / (ctx.PLOT_HI - ctx.PLOT_LO) > 0.6,
          ((r - l) / (ctx.PLOT_HI - ctx.PLOT_LO) * 100).toFixed(1) + '% of the plot');
    check('the floor only bites below one dot',
          ctx.spanWidthPct(50, 50 + floorPct * 1.01, axis) > floorPct);

    /* Degenerate inputs must not produce NaN in a style attribute, which
     * silently drops the bar rather than failing anywhere visible. */
    eq('a zero-width axis cannot emit NaN', ctx.spanWidthPct(10, 20, 0), 0);
})();

console.log('\n-- the box is one height, and the stylesheet agrees --');
(function () {
    var box = ctx.timelineBox();
    eq('the card is 94px tall, every time', box.height, 94);
    check('the rule clears the faces and their times above it',
          box.axis > ctx.MARK_TOP + ctx.AVATAR_PX + ctx.LABEL_LEAD + ctx.LABEL_LINE);
    check('and the box clears the dots on the rule and the scale hung below it',
          box.height >= box.axis + ctx.DOT_PX / 2 + ctx.RULER_H);

    /* Two copies of a number is one copy too many and the one that rots is the
     * one nothing reads. timeline() writes --axis, the height and --inset; the
     * rest of the vertical rhythm lives in index.html and has to match the
     * constants the packing and the clamps are measured against. */
    var css = fs.readFileSync(__dirname + '/index.html', 'utf8');
    var num = function (re, label) {
        var m = re.exec(css);
        if (!m) { check('index.html still has ' + label, false); return NaN; }
        return parseFloat(m[1]);
    };
    eq('.tl-mark sits at MARK_TOP', num(/\.tl-mark \{[^}]*top: ([\d.]+)px/, '.tl-mark top'), ctx.MARK_TOP);
    eq('.tl-dot is AVATAR_PX square', num(/\.tl-dot \{[^}]*width: ([\d.]+)px/, '.tl-dot width'), ctx.AVATAR_PX);
    eq('the times sit LABEL_LEAD under the faces',
       num(/\.tl-t \{[^}]*top: ([\d.]+)px/, '.tl-t top'),
       ctx.MARK_TOP + ctx.AVATAR_PX + ctx.LABEL_LEAD);
    eq('the scale is RULER_H tall',
       num(/\.tl-ruler \{[^}]*height: ([\d.]+)px/, '.tl-ruler height'), ctx.RULER_H);
    eq('...and hangs RULER_LEAD below the rule, clear of the dots on it',
       num(/\.tl-ruler \{[^}]*top: calc\(var\(--axis, [\d.]+px\) \+ ([\d.]+)px\)/, '.tl-ruler top'),
       ctx.RULER_LEAD);
    eq('the rule is inset by PLOT_LO at both ends',
       num(/\.tl-axis \{ position: absolute; left: var\(--inset, ([\d.]+)%\); right: var\(--inset, ([\d.]+)%\)/,
           '.tl-axis inset'), ctx.PLOT_LO);
    eq('.tl-span is SPAN_H_PX tall',
       num(/\.tl-span \{[^}]*height: ([\d.]+)px/, '.tl-span height'), ctx.SPAN_H_PX);
    /* The dot's diameter is also spanWidthPct's floor. If the CSS drifts off
     * DOT_PX the bar starts poking out from under a simultaneous group. */
    eq('.tl-pt is DOT_PX across', num(/\.tl-pt \{[^}]*width: ([\d.]+)px/, '.tl-pt width'), ctx.DOT_PX);
    eq('...and DOT_PX tall', num(/\.tl-pt \{[^}]*height: ([\d.]+)px/, '.tl-pt height'), ctx.DOT_PX);
    eq('...and is centered on the rule',
       num(/\.tl-pt \{[^}]*top: calc\(var\(--axis, [\d.]+px\) - ([\d.]+)px\)/, '.tl-pt top'),
       ctx.DOT_PX / 2);
    eq('...by its own half-width, not by a transform that would fight the clamp',
       num(/\.tl-pt \{[^}]*margin-left: -([\d.]+)px/, '.tl-pt margin-left'), ctx.DOT_PX / 2);
    check('the rule is placed off --axis rather than off a hard-coded top',
          /\.tl-axis \{[^}]*top: var\(--axis/.test(css));
    check('...as is the scale hung under it',
          /\.tl-ruler \{[^}]*top: calc\(var\(--axis/.test(css));
    check('...and the span rule that states the window',
          /\.tl-span \{[^}]*top: calc\(var\(--axis/.test(css));
    check('...and the dots that state where each person is',
          /\.tl-pt \{[^}]*top: calc\(var\(--axis/.test(css));
    check('the window has end stops drawn on it, not two times spelled out',
          /\.tl-axis::before, \.tl-axis::after \{ content: ''/.test(css));
    /* The second attempt put the scale above the rule, mixed in with the
     * times. Nothing below the rule may be a clock time and nothing above it
     * may be a duration; the markup split is what enforces it. */
    check('the stylesheet still has no second row of times to stack into',
          !/\.tl-t\.r[12]/.test(css));

    /* The literals behind the custom properties are the card itself, so a
     * stylesheet loaded without the markup still draws it. */
    eq('the stylesheet default height is the card',
       num(/\.timeline \{[^}]*height: ([\d.]+)px/, '.timeline height'), box.height);
    var axisDefaults = css.match(/var\(--axis, ([\d.]+)px\)/g) || [];
    eq('--axis has a default everywhere it is read', axisDefaults.length, 4);
    check('...and all of them are the rule position',
          axisDefaults.every(function (d) {
              return parseFloat(/([\d.]+)px/.exec(d)[1]) === box.axis;
          }), axisDefaults.join(' '));
})();
console.log('\n-- the card does not quietly redefine something else --');
(function () {
    /* The ladder was called STEPS for about an hour. app.js is one long IIFE
     * and there was already a STEPS in it -- the four words on the step rail
     * -- so the ladder silently replaced them and the rail started labeling
     * itself "1". Nothing failed: every suite slices this block into a vm of
     * its own, and the rail is not on the screen the card is on.
     *
     * So every name the block declares is counted against the whole file. */
    var block = cut('/* --- BEGIN timeline scale', '/* --- END timeline scale', 'the block');
    var names = [];
    block.split('\n').forEach(function (line) {
        var f = /^function\s+([\w$]+)/.exec(line);
        if (f) { names.push(f[1]); return; }
        var v = /^var\s+(.*)$/.exec(line);
        if (!v) return;
        v[1].split(',').forEach(function (part) {
            var id = /^\s*([\w$]+)\s*=/.exec(part);
            if (id) names.push(id[1]);
        });
    });
    check('the block declares the names this check is about', names.length > 25, names.length + ' names');
    var clash = names.filter(function (n) {
        var re = new RegExp('(?:^var\\s+|^\\s*|,\\s*)' + n + '\\s*=|^function\\s+' + n + '\\s*\\(', 'gm');
        return (src.match(re) || []).length > 1;
    });
    check('and not one of them is declared twice in app.js', !clash.length, clash.join(' '));
})();
/* === END adaptive timeline tests ==================================== */

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail)
                         : 'ALL ' + pass + ' CHECKS PASSED'));
process.exitCode = fail ? 1 : 0;
