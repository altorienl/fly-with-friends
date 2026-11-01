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


/* ------------------------------------------------------- the timeline
 *
 * The axis used to be the cluster plus 45% padding, so a 55-minute landing
 * window and a 5h38m one were drawn at exactly the same width and the line
 * meant nothing. It is the whole day now, midnight to midnight, which is the
 * only way two cards can be compared -- and which brings three problems of
 * its own: the ends of a day are where a 34px face gets clipped, a day is
 * long enough that two landings five minutes apart are one pixel apart, and a
 * leg can cross midnight. One section each.
 *
 * Minutes are minutes since the epoch throughout, so a midnight is a multiple
 * of 1440 and "which day" is integer division. */
var DAY0 = 20799 * 1440;
function mins(h, m) { return DAY0 + h * 60 + (m || 0); }

console.log('\n-- the day the card is drawn on --');
(function () {
    var w = ctx.dayWindow([mins(16, 28), mins(16, 40), mins(17, 5)]);
    eq('a cluster inside one day is drawn on the whole of that day', w.to - w.from, 1440);
    eq('...which starts at a midnight', w.from % 1440, 0);
    check('...before the earliest mark', w.from <= mins(16, 28) && w.to >= mins(17, 5));

    /* The reason for all of this. Two cards on the same day are the same
     * picture at the same scale, whatever times they happen to hold, so the
     * landing card and the leaving card can be read against each other. */
    var tight = ctx.dayWindow([mins(11, 10), mins(11, 15)]);
    var wide = ctx.dayWindow([mins(0, 5), mins(23, 50)]);
    eq('a five-minute window and a twenty-four-hour one share one scale',
       tight.from + '|' + tight.to, wide.from + '|' + wide.to);

    var over = ctx.dayWindow([mins(21, 26), mins(24, 54)]);
    eq('a leg that lands after midnight gets a second day', over.days, 2);
    eq('...still starting on a midnight', over.from % 1440, 0);
    eq('...and still ending on one', over.to % 1440, 0);
    check('...with both marks inside it',
          mins(21, 26) >= over.from && mins(24, 54) <= over.to);

    /* Midnight on the nose is the right hand end of the day it closes. A
     * second day for it would draw twenty-four hours of nothing to say the
     * same thing. */
    eq('midnight exactly does not buy a second day', ctx.dayWindow([mins(9), mins(24)]).days, 1);
    eq('one minute past it does', ctx.dayWindow([mins(9), mins(24, 1)]).days, 2);

    eq('a window only ever stretches by whole days', ctx.dayWindow([mins(1), mins(72, 30)]).days, 4);
    eq('nothing to draw is not a window', ctx.dayWindow([]), null);
})();

console.log('\n-- the plot is inset so that nothing is clipped --');
(function () {
    var from = DAY0, to = DAY0 + 1440;
    /* The card is 254px wide on a 320px phone, 324px on a 390px one, 356px on
     * a 430px one and 566px once main hits its 640px cap. Measured off the
     * rendered page, not guessed. */
    var BOXES = [254, 309, 324, 356, 566];

    eq('midnight sits on the left inset', ctx.plotPct(from, from, to), 6);
    eq('the next midnight sits on the right one', ctx.plotPct(to, from, to), 94);
    eq('noon is the middle of the card', ctx.plotPct(from + 720, from, to), 50);
    check('and the morning is in the left half',
          ctx.plotPct(from + 9 * 60, from, to) < 50 && ctx.plotPct(from + 15 * 60, from, to) > 50);

    /* What the inset is for: a lone 34px face and its own time label, at
     * either end of the day, inside a box that clips its overflow. 6% of the
     * 390px card is 19.4px against a 17px half-avatar, so the inset carries
     * this case on its own and the clamp never fires. */
    var box = 324, half = 34 / 2;
    [0, 1, 719, 720, 1438, 1439, 1440].forEach(function (mm) {
        var c = ctx.plotPct(from + mm, from, to) / 100 * box;
        check('a lone face at minute ' + mm + ' of the day needs no clamp at all',
              c - half >= 0 && c + half <= box && ctx.edgeShift(c, half, box) === 0,
              'centre ' + c.toFixed(1) + 'px of ' + box);
    });

    /* Everything wider than a lone face -- a stack of eight, a range label --
     * is pulled back in, at every width this renders at and at every minute
     * of the day. This is the check that the clamp is a guarantee rather than
     * a nudge that happens to work on the card in front of me. */
    var widest = ctx.pileWidth(8) / 2;
    var longest = '11:50am-12:10pm'.length * ctx.LABEL_CH / 2;
    var bad = [];
    BOXES.forEach(function (bw) {
        for (var mm = 0; mm <= 1440; mm++) {
            var c = ctx.plotPct(from + mm, from, to) / 100 * bw;
            [half, widest, longest].forEach(function (h) {
                var s = ctx.edgeShift(c, h, bw);
                if (c + s - h < 0 || c + s + h > bw) bad.push(bw + 'px@' + mm + '/' + h);
            });
        }
    });
    check('nothing is ever left hanging outside the box', !bad.length, bad.slice(0, 4).join(' '));

    /* Clamped by a whole pixel in the safe direction, not to the nearest one.
     * Rounding to nearest left a stack of eight faces with half a pixel of
     * clearance on a 320px card, measured. */
    var tightest = Infinity;
    BOXES.forEach(function (bw) {
        for (var mm = 0; mm <= 1440; mm++) {
            var c = ctx.plotPct(from + mm, from, to) / 100 * bw;
            [half, widest, longest].forEach(function (h) {
                var s = ctx.edgeShift(c, h, bw);
                tightest = Math.min(tightest, c + s - h, bw - (c + s + h));
            });
        }
    });
    check('and the tightest clearance anywhere is a whole pixel or better',
          tightest >= 1, tightest.toFixed(3) + 'px');

    check('and nothing away from the ends is moved at all',
          ctx.edgeShift(162, longest, 324) === 0 && ctx.edgeShift(162, widest, 324) === 0);
    check('a stack of eight faces still fits the narrowest card',
          ctx.pileWidth(8) < 254, ctx.pileWidth(8) + 'px');
})();

console.log('\n-- marks too close together become one mark --');
(function () {
    var from = DAY0, to = DAY0 + 1440, BOX = 324;
    var mk = function (list) {
        return ctx.mergeMarks(list.map(function (x) { return from + x; }), from, to, BOX);
    };
    var shape = function (list) {
        return mk(list).map(function (g) { return g.keys.length; }).join('+');
    };

    /* The case in the brief: five minutes is about one pixel of a day, and two
     * faces one pixel apart are one illegible face. */
    eq('11:10am and 11:15am are one mark', shape([670, 675]), '2');
    /* The real landing card: 4:28, 4:40 and 5:05pm. */
    eq('a 37-minute landing cluster is one mark', shape([988, 1000, 1025]), '3');
    /* The real return: two together at 2pm, one at 9:26pm. */
    eq('an evening return stays two marks', shape([849, 866, 1286]), '2+1');

    /* The chain guard. Each of these is under the avatar threshold from its
     * neighbour but not from the first of its group, so they must not roll up
     * into one pile covering half the day. */
    eq('a long straggle does not chain into one pile', shape([0, 150, 300, 450, 600]), '2+2+1');
    var spread = [0, 150, 300, 450, 600, 700, 701, 702];
    var px = function (g) { return (g.hi - g.lo) / 1440 * 0.88 * BOX; };
    check('no merged mark covers more of the clock than one avatar covers of the card',
          mk(spread).every(function (g) { return px(g) < 34; }),
          JSON.stringify(mk(spread).map(function (g) { return +px(g).toFixed(1); })));

    /* Merging may regroup. It may not lose anybody or reorder them. */
    var input = [0, 3, 7, 200, 205, 900, 1439];
    var flat = [];
    mk(input).forEach(function (g) { flat = flat.concat(g.keys); });
    eq('every mark survives the merge exactly once, in order',
       JSON.stringify(flat), JSON.stringify(input.map(function (x) { return from + x; })));
    check('and a group is drawn in the middle of what it covers',
          mk(input).every(function (g) { return g.m === (g.lo + g.hi) / 2; }));
    check('a group never claims a time nobody has',
          mk(input).every(function (g) { return g.lo === g.keys[0] && g.hi === g.keys[g.keys.length - 1]; }));

    eq('one mark is one mark', shape([600]), '1');
    eq('no marks is no marks', mk([]).length, 0);
})();

console.log('\n-- what a merged mark is called --');
(function () {
    eq('a single time keeps its plain label', ctx.rangeLabel(mins(16, 28), mins(16, 28)), '4:28pm');
    eq('a range inside one half of the day shares its suffix',
       ctx.rangeLabel(mins(11, 10), mins(11, 15)), '11:10-11:15am');
    eq('the real landing cluster reads as one span',
       ctx.rangeLabel(mins(16, 28), mins(17, 5)), '4:28-5:05pm');
    eq('a range across noon has to say both',
       ctx.rangeLabel(mins(11, 50), mins(12, 10)), '11:50am-12:10pm');
    eq('and so does one across midnight',
       ctx.rangeLabel(mins(23, 50), mins(24, 10)), '11:50pm-12:10am');

    ctx.SET.time24 = true;
    eq('24-hour mode has no suffix to share', ctx.rangeLabel(mins(11, 10), mins(11, 15)), '11:10-11:15');
    eq('...and a single 24-hour time is still plain', ctx.rangeLabel(mins(9, 5), mins(9, 5)), '09:05');
    ctx.SET.time24 = false;

    /* labelRows budgets 7px a character and the clamp is checked against 15 of
     * them. A label that could come out longer would be packed and clamped
     * against a box narrower than the one it prints in. */
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
     * costs a row, under-estimating prints one time on top of another, which
     * is the bug the row packing was written for in the first place. */
    var MEASURED_11 = { '4:28pm': 40.73, '9:26pm': 40.73, '11:02am': 47.08,
        '2:09-2:26pm': 70.3, '4:28-5:05pm': 70.3, '11:10-11:15am': 83.64,
        '11:50am-12:10pm': 100.05, '23:59': 31.31, '11:10-11:15': 67.86 };
    var thin = Object.keys(MEASURED_11).filter(function (t) {
        return t.length * ctx.LABEL_CH < MEASURED_11[t];
    });
    check('the label budget is never under what a label measures on the card',
          !thin.length, thin.join(' '));

    var MEASURED_10 = { '6am': 20.88, '12pm': 27.88, '6pm': 21.47, '12am': 27.3,
        'Wed': 21.41, 'Mon': 20.84, '06:00': 28.75, '12:00': 28.75, '18:00': 28.75 };
    var thinTicks = Object.keys(MEASURED_10).filter(function (t) {
        return t.length * ctx.TICK_CH < MEASURED_10[t];
    });
    check('and nor is the tick budget', !thinTicks.length, thinTicks.join(' '));
})();

console.log('\n-- the scale hung under the rule --');
(function () {
    var from = DAY0;
    var labels = function (days) {
        return ctx.dayTicks(from, from + days * 1440).map(function (t) { return t.label; }).join(' ');
    };

    eq('one day is ruled at six, noon and six', labels(1), '6am 12pm 6pm');
    /* The rejected ruler took its step from the cluster, so on a tight card it
     * printed the landing times back at the reader as a second row of times.
     * These three come from the clock and from nothing else. */
    eq('the scale does not depend on the data on the card',
       JSON.stringify(ctx.dayTicks(from, from + 1440)),
       JSON.stringify(ctx.dayTicks(from + 1440, from + 2880).map(function (t) {
           return { m: t.m - 1440, day: t.day, label: t.label };
       })));
    check('no tick is drawn on an end stop',
          ctx.dayTicks(from, from + 1440).every(function (t) { return t.m > from && t.m < from + 1440; }));
    check('and none of them is a midnight, which is what the end stops are',
          ctx.dayTicks(from, from + 1440).every(function (t) { return !t.day; }));

    /* Two days break at the midnight between them, and the weekday is the
     * only word the timeline is allowed -- earned because which side of the
     * break a mark sits on is the whole question. */
    var brk = new Date((from + 1440) * 60000).toUTCString().slice(0, 3);
    eq('two days break at the midnight between them', labels(2), '12pm ' + brk + ' 12pm');
    var breaks = ctx.dayTicks(from, from + 2880).filter(function (t) { return t.day; });
    eq('...and exactly one tick is marked as a break', breaks.length, 1);
    eq('...on the midnight itself', breaks[0].m % 1440, 0);
    /* Every day of the week, because the first day this was written on was a
     * Sunday and an index bug that always returns Sunday passes on one. */
    check('...named after the day it opens, whichever day that is',
          [0, 1, 2, 3, 4, 5, 6].every(function (k) {
              var f = DAY0 + k * 1440;
              var t = ctx.dayTicks(f, f + 2880).filter(function (x) { return x.day; })[0];
              return t.label === new Date(t.m * 60000).toUTCString().slice(0, 3);
          }),
          [0, 1, 2, 3, 4, 5, 6].map(function (k) {
              var f = DAY0 + k * 1440;
              return ctx.dayTicks(f, f + 2880).filter(function (x) { return x.day; })[0].label;
          }).join(' '));

    eq('past three days only the breaks are left',
       ctx.dayTicks(from, from + 5760).map(function (t) { return t.day ? 'break' : 'hour'; }).join(' '),
       'break break break');

    eq('a zero-width window has no scale', ctx.dayTicks(from, from).length, 0);
    eq('a backwards one has none either', ctx.dayTicks(from + 100, from).length, 0);

    ctx.SET.time24 = true;
    eq('24-hour mode rules the same three hours', labels(1), '06:00 12:00 18:00');
    ctx.SET.time24 = false;
})();

console.log('\n-- the box is the size of what is in it --');
(function () {
    var one = ctx.timelineBox(1), two = ctx.timelineBox(2), three = ctx.timelineBox(3);
    eq('the ordinary card is one row of times and 88px tall', one.height, 88);
    check('every extra row costs exactly one row pitch',
          two.axis - one.axis === ctx.ROW_PITCH && three.axis - two.axis === ctx.ROW_PITCH,
          [one.axis, two.axis, three.axis].join(' '));
    check('the rule always clears the faces above it',
          one.axis > ctx.MARK_TOP + ctx.AVATAR_PX);
    check('the deepest label row never reaches the rule',
          ctx.MARK_TOP + ctx.AVATAR_PX + ctx.LABEL_LEAD + 2 * ctx.ROW_PITCH + ctx.LABEL_LINE < three.axis);
    check('and the box always clears the scale hung below it',
          [one, two, three].every(function (b) { return b.height >= b.axis + 1 + ctx.RULER_H; }));
})();

console.log('\n-- the stylesheet and the layout arithmetic agree --');
(function () {
    /* Two copies of a number is one copy too many and the one that rots is the
     * one nothing reads. timeline() writes --axis and --inset; the rest of the
     * vertical rhythm lives in index.html and has to match the constants the
     * row packing and the clamp are measured against. */
    var css = fs.readFileSync(__dirname + '/index.html', 'utf8');
    var num = function (re, label) {
        var m = re.exec(css);
        if (!m) { check('index.html still has ' + label, false); return NaN; }
        return parseFloat(m[1]);
    };
    eq('.tl-mark sits at MARK_TOP', num(/\.tl-mark \{[^}]*top: ([\d.]+)px/, '.tl-mark top'), ctx.MARK_TOP);
    eq('.tl-dot is AVATAR_PX square', num(/\.tl-dot \{[^}]*width: ([\d.]+)px/, '.tl-dot width'), ctx.AVATAR_PX);
    eq('the facepile laps by DOT_LAP',
       num(/\.tl-dots \.tl-dot \+ \.tl-dot \{ margin-right: -([\d.]+)px/, 'the facepile lap'), ctx.DOT_LAP);
    eq('row 0 sits LABEL_LEAD under the faces',
       num(/\.tl-t \{[^}]*margin-top: ([\d.]+)px/, '.tl-t margin-top'), ctx.LABEL_LEAD);
    eq('row 1 is one pitch further down',
       num(/\.tl-t\.r1 \{ margin-top: ([\d.]+)px/, '.tl-t.r1'), ctx.LABEL_LEAD + ctx.ROW_PITCH);
    eq('row 2 is two',
       num(/\.tl-t\.r2 \{ margin-top: ([\d.]+)px/, '.tl-t.r2'), ctx.LABEL_LEAD + 2 * ctx.ROW_PITCH);
    eq('the scale is RULER_H tall',
       num(/\.tl-ruler \{[^}]*height: ([\d.]+)px/, '.tl-ruler height'), ctx.RULER_H);
    eq('the rule is inset by PLOT_LO at both ends',
       num(/\.tl-axis \{ position: absolute; left: var\(--inset, ([\d.]+)%\); right: var\(--inset, ([\d.]+)%\)/,
           '.tl-axis inset'), ctx.PLOT_LO);
    check('the rule is placed off --axis rather than off a hard-coded top',
          /\.tl-axis \{[^}]*top: var\(--axis/.test(css));
    check('...as is the scale hung under it',
          /\.tl-ruler \{[^}]*top: calc\(var\(--axis/.test(css));
    check('...and the span rule that states the window',
          /\.tl-span \{[^}]*top: calc\(var\(--axis/.test(css));
    check('the day has end stops drawn on it, not two midnights spelled out',
          /\.tl-axis::before, \.tl-axis::after \{ content: ''/.test(css));

    /* The literals behind the two custom properties are the one-row card, so a
     * stylesheet loaded without the markup still draws the ordinary case. */
    eq('the stylesheet default height is the one-row card',
       num(/\.timeline \{[^}]*height: ([\d.]+)px/, '.timeline height'), ctx.timelineBox(1).height);
    var axisDefaults = css.match(/var\(--axis, ([\d.]+)px\)/g) || [];
    eq('--axis has a default everywhere it is read', axisDefaults.length, 3);
    check('...and all three are the one-row rule position',
          axisDefaults.every(function (d) {
              return parseFloat(/([\d.]+)px/.exec(d)[1]) === ctx.timelineBox(1).axis;
          }), axisDefaults.join(' '));
})();

console.log('\n-- time labels do not print over each other --');
(function () {
    var BOX = 324;
    var rows = function (specs) {
        return ctx.labelRows(specs.map(function (s) {
            return { pct: s[0], label: s[1] || '4:28pm' };
        }), BOX);
    };
    /* The property, as geometry rather than as a row pattern: nothing printed
     * on one row may touch anything else on it, measured where the label is
     * actually drawn -- which is after the clamp, because two labels pulled in
     * off the same end would otherwise be packed as though they were both
     * still outside. */
    var overlapFree = function (specs) {
        var r = rows(specs), seen = {};
        for (var i = 0; i < specs.length; i++) {
            if (r[i] < 0) continue;
            var half = (specs[i][1] || '4:28pm').length * ctx.LABEL_CH / 2;
            var c = specs[i][0] / 100 * BOX;
            c += ctx.edgeShift(c, half, BOX);
            var list = seen[r[i]] = seen[r[i]] || [];
            for (var j = 0; j < list.length; j++) {
                if (c - half < list[j][1] && c + half > list[j][0]) return false;
            }
            list.push([c - half, c + half]);
        }
        return true;
    };

    eq('a lone mark sits on the first row', JSON.stringify(rows([[50]])), '[0]');
    eq('well-spaced marks all stay on it', JSON.stringify(rows([[10], [45], [80]])), '[0,0,0]');

    /* The two real cards, at the positions they actually render at. */
    eq('the landing card keeps its one label on one row',
       JSON.stringify(rows([[67.51, '4:28-5:05pm']])), '[0]');
    eq('the return card keeps both of its labels on one row',
       JSON.stringify(rows([[58.4, '2:09-2:26pm'], [84.59, '9:26pm']])), '[0,0]');

    check('two long labels a label-width apart do not share a row',
          JSON.stringify(rows([[40, '11:50am-12:10pm'], [52, '11:50am-12:10pm']])) !== '[0,0]',
          JSON.stringify(rows([[40, '11:50am-12:10pm'], [52, '11:50am-12:10pm']])));

    check('no two labels on a row overlap, on the return card',
          overlapFree([[58.4, '2:09-2:26pm'], [84.59, '9:26pm']]));
    /* 10.5% of a 324px card is 34px, which is as close as two marks can be and
     * survive the merge -- the worst packing the renderer can be handed. */
    check('...nor on eight marks packed as tightly as the merge allows',
          overlapFree([[6], [16.5], [27], [37.5], [48], [58.5], [69], [79.5]]),
          JSON.stringify(rows([[6], [16.5], [27], [37.5], [48], [58.5], [69], [79.5]])));
    check('...nor when all of them are ranges jammed against the right end',
          overlapFree([[73, '11:10-11:15am'], [83.5, '11:10-11:15am'], [94, '11:10-11:15am']]),
          JSON.stringify(rows([[73, '11:10-11:15am'], [83.5, '11:10-11:15am'], [94, '11:10-11:15am']])));

    /* Two boxes that merely miss each other still read as one run of digits,
     * so the packer insists on LABEL_GAP_PX of air on top of the budget.
     * These two centres are 45px apart and the boxes are 42px wide. */
    eq('labels that only just miss each other still get their own rows',
       JSON.stringify(rows([[40], [53.889]])), '[0,1]');

    /* Dropping beats overlapping, and only once there is nowhere left. */
    eq('a label is dropped only when all three rows are full',
       rows([[40], [41], [42], [43]]).filter(function (r) { return r < 0; }).length, 1);
})();

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail)
                         : 'ALL ' + pass + ' CHECKS PASSED'));
process.exitCode = fail ? 1 : 0;
