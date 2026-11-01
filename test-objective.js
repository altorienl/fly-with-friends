/* The objective, measured on a real schedule.
 *
 * Every other suite here runs on fixtures.js, whose generated schedules are
 * far more scattered than anything an airline actually files. That is fine for
 * the window algorithms -- scatter is the hard case for them -- and it is
 * actively misleading for the question of what a good match COSTS, because the
 * money-versus-closeness tradeoff on a scattered day looks nothing like the
 * tradeoff on a real one.
 *
 * Proof that it matters: the rule this file guards replaced one that paid $387
 * to buy 45 minutes on the group below. The same overpay is not reachable on
 * generated groups at all -- a units gate over fixtures.js passes under BOTH
 * the old rule and the new one, so it would have shipped the bug twice.
 *
 * fixtures-live.json is one captured SerpApi response: BZN, seven origins,
 * 2026-12-11. 99 three-or-more-party subsets come out of it for free.
 */
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = __dirname;
var FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures-live.json'), 'utf8'));
var LIVE = FIX.scenarios.bzn, DEN = FIX.scenarios.den;

var harness = fs.readFileSync(path.join(ROOT, 'test-return.js'), 'utf8');
var cut = harness.indexOf('function text(html)');
if (cut < 0) throw new Error('test-return.js no longer exposes the harness this reuses');
var head = harness.slice(0, cut)
    .replace("'recommendedIn', 'blankQuery', 'migrateQuery'];",
             "'recommendedIn', 'blankQuery', 'migrateQuery', 'tripScore', 'latenessOf',\n"
             + "               'matchOf', 'tripMatches', 'coherentReturn', 'returnThOf', 'shadowOf'];")
    .replace("+ ',clearMemo:function(){returnTh={};}'",
             "+ ',clearMemo:function(){returnTh={};MATCHES=null;PICKED_PLAN=null;OUT_PICKS=null;}'"
             + "+ ',set C(v){C=v;},get C(){return C;}'"
             + "+ ',set PICKED_PLAN(v){PICKED_PLAN=v;},get PICKED_PLAN(){return PICKED_PLAN;}'");
var ctxBox = {};
(new Function('module', 'exports', 'require', '__dirname', '__filename',
              head + '\nmodule.exports = { FWF: FWF, T: T };'))
    (ctxBox, ctxBox.exports = {}, require, ROOT, __filename);
var FWF = ctxBox.exports.FWF, T = ctxBox.exports.T;

var pass = 0, fail = 0;
function check(n, c, extra) {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (extra ? '\n          ' + extra : '')); }
}

function setup(parties, sc) {
    sc = sc || LIVE;
    var q = T.blankQuery();
    q.dest = sc.dest; q.dep = sc.dep; q.ret = sc.ret; q.parties = parties;
    T.state.step = 4; T.state.leg = 'outbound'; T.state.recommend = 'value';
    T.state.th = { outbound: null, 'return': null };
    T.state.q = q; T.state.busy = false; T.state.error = null;
    T.DATA = { generated_at: sc.generated_at, currency: 'USD',
               trips: { query: sc.trips.query }, errors: [] };
    T.clearMemo();
}

/* Every 3+ subset of the seven parties. */
var SUBSETS = [];
for (var mask = 1; mask < (1 << LIVE.parties.length); mask++) {
    var ps = [], bits = 0;
    for (var i = 0; i < LIVE.parties.length; i++) {
        if (mask & (1 << i)) { ps.push(LIVE.parties[i]); bits++; }
    }
    if (bits >= 3) SUBSETS.push(ps);
}

console.log('\n-- the price of closeness, over ' + SUBSETS.length + ' real subsets --');

var perMin = [], rows = 0, anyLate = 0, worst = null, dominated = [];
SUBSETS.forEach(function (ps) {
    setup(ps);
    var l = T.tripLadder();
    if (!l || l.length < 2) return;
    rows++;
    var tb = T.tripBest(l);
    if (l.some(function (r) { return (r.late || 0) > 0; })) anyLate++;

    /* The price of closeness ALONE. Measured only against rows that ask no
     * more of anybody -- no extra connection, no more air time, no later
     * landing -- because otherwise the figure blames the whole premium on
     * spread. One real group here pays $214 over a cheaper row, and $184 of
     * that buys somebody out of a connection and 174 extra minutes in the
     * air; calling it "$7.13 a minute of closeness" is the statistic lying,
     * not the objective. */
    l.forEach(function (r) {
        if (r === tb) return;
        if (r.total >= tb.total) return;
        var rg = r.regret || { stops: 0, mins: 0 }, tg = tb.regret || { stops: 0, mins: 0 };
        if (rg.stops > tg.stops || rg.mins > tg.mins + 15) return;
        if ((r.late || 0) > (tb.late || 0)) return;
        var gained = r.worst - tb.worst, paid = tb.total - r.total;
        /* Cheaper, no worse on every axis the reader can see, and no looser:
         * nothing justifies passing it over. */
        if (gained <= 0) {
            dominated.push(ps.map(function (p) { return p.id; }).join('')
                + ': passed over $' + r.total + '/' + r.worst + 'm for $'
                + tb.total + '/' + tb.worst + 'm');
            return;
        }
        var rate = paid / gained;
        perMin.push(rate);
        if (!worst || rate > worst.rate) {
            worst = { rate: rate, paid: paid, gained: gained,
                      ids: ps.map(function (p) { return p.id; }).join(''),
                      from: r.total, to: tb.total };
        }
    });
});

perMin.sort(function (a, b) { return a - b; });
var mx = perMin.length ? perMin[perMin.length - 1] : 0;

check('never passes over a row that is cheaper and no worse on anything',
      dominated.length === 0, dominated.slice(0, 3).join('\n          '));
/* SPREAD_PER_MIN is $1.50 a minute for the group, and with the other axes held
 * equal that is the whole of what closeness may cost. The ceiling is set at
 * twice it to leave room for rounding across legs, not as a tolerance. */
check('and never pays more than the stated rate for closeness alone',
      mx <= 3, 'worst $' + mx.toFixed(2) + '/min'
      + (worst ? '  (' + worst.ids + ': $' + worst.from + ' -> $' + worst.to
                 + ' for ' + worst.gained + 'm)' : '')
      + '  over ' + perMin.length + ' comparisons in ' + rows + ' groups');

console.log('\n-- the case that produced the rule --');
/* Ana/LGA, Ben/ORD, Eli/SFO, Gus/DTW. The shipped-at-the-time app recommended
 * $1,086 six minutes apart while a $699 plan 51 minutes apart sat in its own
 * ladder, vetoed by worthIt() for a connection the same file prices at $120.
 * $387 to buy 45 minutes, on a product whose users check it against Google. */
setup(['a', 'b', 'e', 'g'].map(function (id) {
    return LIVE.parties.filter(function (p) { return p.id === id; })[0];
}));
var l4 = T.tripLadder(), tb4 = T.tripBest(l4);
/* $654 at 15 minutes, not the $699 at 51 this file first pinned. The pruning
 * fix that followed -- a connection cheaper than the best nonstop is no
 * longer cut for being slower -- put flights back in the option set that
 * this group's plan was built from, and the answer improved on both axes at
 * once. The old number is kept in the comment because a REGRESSION here
 * would most likely show up as a return to it. */
check('the cheap tight plan is on the ladder', !!l4.filter(function (r) {
    return r.total === 654; }).length, l4.map(function (r) { return '$' + r.total; }).join(' '));
check('and it is the one recommended', tb4.total === 654 && tb4.worst <= 15,
      'recommended $' + tb4.total + ' at ' + tb4.worst + 'm apart');
check('...which beats what the vetoing rule used to give', tb4.total < 699,
      '$' + tb4.total + ' vs $699');
check('nobody is sent into the night to achieve it', (tb4.late || 0) === 0,
      'late shadow $' + Math.round(tb4.late || 0));

console.log('\n-- the case that forced the two-slope ramp --');
/* Ana/LGA, Cara/ATL, Fay/MSY, Gus/DTW. With a single flat late rate the score
 * paid $5 to move this group from 114 minutes apart landing 12:24, to landing
 * together at 22:50 -- a perfect window, at ten to eleven at night. A perfect
 * window is not worth the day it is bought with. */
setup(['a', 'c', 'f', 'g'].map(function (id) {
    return LIVE.parties.filter(function (p) { return p.id === id; })[0];
}));
var lN = T.tripLadder(), tbN = T.tripBest(lN);
var dayEnd = Date.UTC(2026, 11, 11, 21, 0) / 60000;
var cN = T.compute('outbound');
var planN = FWF.minCostAtWindow(cN.prep, tbN.th, cN.costFn);
var lastIn = Math.max.apply(null, cN.ids.map(function (id) {
    return planN.picks[id].option.arriveMin; }));
check('nobody lands after 21:00 to buy a perfect window',
      lastIn <= dayEnd, 'last arrival ' + FWF.fmtClock(lastIn % 1440, true)
      + ' at $' + tbN.total + ' / ' + tbN.worst + 'm apart');
/* And the trade it declined is genuinely on the table, or the check is vacuous. */
check('...although the late plan really is on the ladder and really is tighter',
      lN.some(function (r) { return (r.late || 0) > 0 && r.worst < tbN.worst; }),
      lN.map(function (r) { return '$' + r.total + '/' + r.worst + 'm/late$'
          + Math.round(r.late || 0); }).join('  '));

console.log('\n-- a seat is a seat, in every shadow --');
/* Both shadows multiply by seats, and until now neither multiplication was
 * tested. Deleting the factor from the ease shadow survived a full suite
 * run: a party of three would have had their connection priced like one
 * person's, so the optimizer would cheerfully route the biggest party
 * through a change of planes to save money it was not really saving.
 *
 * The lateness shadow was already covered by "it counts seats" below; this
 * is the same property for the other one. */
var easeCtx = function (seats) {
    return { ids: ['x'], travelers: [{ id: 'x', name: 'X', seats: seats }],
             costFn: function () { return 100; },
             ownBest: { x: { stops: 0, mins: 120 } } };
};
var slower = { stops: 1, duration_minutes: 240 };
var one = T.shadowOf(easeCtx(1), 'ease')(slower, 'x');
var two = T.shadowOf(easeCtx(2), 'ease')(slower, 'x');
var three = T.shadowOf(easeCtx(3), 'ease')(slower, 'x');
check('one seat pays the base shadow', one > 100, '$' + one);
check('two seats pay twice the penalty', (two - 100) === (one - 100) * 2,
      '1 seat +$' + (one - 100) + ', 2 seats +$' + (two - 100));
check('three seats pay three times', (three - 100) === (one - 100) * 3,
      '3 seats +$' + (three - 100));

console.log('\n-- lateness is priced, and only when it should be --');
/* A term that fires on everything is a constant and changes no argmin; one
 * that fires on nothing is dead code. Counted over every ladder row rather
 * than the chosen one, because the term doing its job means the row it fires
 * on is the row that LOSES. */
check('lateness is reachable on real schedules', anyLate > 0,
      anyLate + ' of ' + rows + ' groups have a late row on the ladder');
check('...but does not fire on everything', anyLate < rows,
      anyLate + ' of ' + rows);

/* Direct unit check: same group, arrivals shifted into the night. */
var c = T.compute('outbound');
var mid = { ids: ['x'], travelers: [{ id: 'x', name: 'X', seats: 2 }] };
function at(hhmm) {
    return { x: { option: { arriveMin: Date.UTC(2026, 11, 11, hhmm[0], hhmm[1]) / 60000 } } };
}
var noon = T.latenessOf(mid, at([12, 0]), 'outbound');
var six = T.latenessOf(mid, at([18, 30]), 'outbound');
var elevenPm = T.latenessOf(mid, at([23, 0]), 'outbound');
var oneAm = T.latenessOf(mid, { x: { option: {
    arriveMin: Date.UTC(2026, 11, 12, 1, 0) / 60000 } } }, 'outbound');
check('landing at noon costs nothing', noon === 0, '$' + noon);
check('landing at 18:30 is a mild cost', six > 0 && six < 30, '$' + six.toFixed(2));
check('landing at 23:00 costs much more than 18:30', elevenPm > six * 4,
      '$' + elevenPm.toFixed(2) + ' vs $' + six.toFixed(2));
check('landing at 01:00 costs more again', oneAm > elevenPm,
      '$' + oneAm.toFixed(2) + ' vs $' + elevenPm.toFixed(2));
check('it counts seats', T.latenessOf(mid, at([23, 0]), 'outbound')
      > T.latenessOf({ ids: ['x'], travelers: [{ id: 'x', seats: 1 }] }, at([23, 0]), 'outbound'));
check('the way home is cheaper than the way out',
      T.latenessOf(mid, at([23, 0]), 'return') < elevenPm,
      'home $' + T.latenessOf(mid, at([23, 0]), 'return').toFixed(2));

console.log('\n-- the way home closes the loop when closing it is free --');
/* The owner's complaint, in his words: "matching is what we are selling, why
 * can't it find the matching leg to that round trip flight". He was right, and
 * the one-way-vs-round-trip answer I gave first was wrong -- both legs of the
 * Southwest round trip Google quoted at $317 were already in this response, at
 * $159 each. The app passed over the matching leg for a reason that had
 * nothing to do with how it searches.
 *
 * Carbone offers LGA, JFK and EWR. The app sent him out of LaGuardia and home
 * into JFK -- a different airport, a different airline, the same $159 -- while
 * a Delta DEN->LGA sat in the same option set. The window the return is solved
 * at comes from returnWays, built on a ladder that drops rows which are not
 * strictly cheaper, so when money is flat every wider rung is deleted before
 * coherence gets a vote. */
setup(DEN.parties, DEN);
T.C = T.compute();
var selD = T.matchOf(T.tripMatches());
T.PICKED_PLAN = selD ? selD.plan : null;
var outD = T.legBreakdown('outbound'), backD = T.legBreakdown('return');
var cOut = outD.rows.carbone.option, cBack = backD.rows.carbone.option;

check('he flies home to the airport he left from',
      cBack.to === cOut.from, cOut.from + ' out, home into ' + cBack.to);
check('...on the airline he flew out on',
      String(cBack.airlines) === String(cOut.airlines),
      cOut.airlines + ' out, ' + cBack.airlines + ' home');
check('...and it costs him nothing', cBack.price <= 159,
      '$' + cBack.price + ' home');
/* Vacuous unless the wrong answer was genuinely cheaper-or-equal and available:
 * the rule is only allowed to buy coherence that is free. */
var alt = (DEN.trips.query['return'].carbone || []).filter(function (o) {
    return o.to !== cOut.from && o.price <= cBack.price; });
check('...while the incoherent option really was there at the same price',
      alt.length > 0, alt.length + ' cheaper-or-equal options into another airport');

/* And the group still leaves together: the slack is a ceiling, not a licence. */
check('the group still leaves within the slack',
      backD.spread == null || backD.spread <= 75 + 15,
      'home spread ' + FWF.fmtGap(backD.spread || 0));


console.log('\n-- a smaller option set cannot hold a better answer --');
/* The property that caught the pruning bug, kept as a gate.
 *
 * Removing an airline can only remove that airline's flights, so the
 * recommended trip can never get BOTH cheaper and tighter. When it did, a
 * per-party prune was deleting other carriers' flights: allowing a carrier
 * added a cheap nonstop, that lowered the bar every connection had to clear,
 * and the connections it then cut were the ones the group plan needed. One
 * party was left holding two $225 United nonstops while four $180
 * connections -- the ones that landed the group 15 minutes apart instead of
 * 51 -- were cut for being slower.
 *
 * Measured at 10% of carrier/group pairs before the fix. */
var carriers = {};
Object.keys(LIVE.trips.query.outbound).forEach(function (id) {
    (LIVE.trips.query.outbound[id] || []).forEach(function (o) {
        (o.airlines || []).forEach(function (a) { carriers[a] = 1; });
    });
});
carriers = Object.keys(carriers);

function recommend(parties, avoid) {
    setup(parties);
    T.state.q.avoid = avoid;
    T.clearMemo();
    var l = T.tripLadder();
    if (!l || !l.length) return null;
    var b = T.tripBest(l);
    return { total: b.total, worst: b.worst };
}

var inversions = [], pairs = 0;
SUBSETS.forEach(function (ps) {
    var base = recommend(ps, []);
    if (!base) return;
    carriers.forEach(function (c) {
        var cut = recommend(ps, [c.toLowerCase()]);
        if (!cut) return;
        pairs++;
        if (cut.total < base.total - 1 && cut.worst <= base.worst) {
            inversions.push(ps.map(function (p) { return p.id; }).join('')
                + ' avoid ' + c + ': $' + base.total + '/' + base.worst
                + 'm -> $' + cut.total + '/' + cut.worst + 'm');
        }
    });
});
check('removing a carrier never makes the trip cheaper AND tighter',
      inversions.length === 0,
      inversions.length + ' of ' + pairs + ' pairs\n          '
      + inversions.slice(0, 3).join('\n          '));
check('...and the sweep actually compared something', pairs > 300, pairs + ' pairs');

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail)
                         : 'ALL ' + pass + ' CHECKS PASSED'));
process.exitCode = fail ? 1 : 0;
