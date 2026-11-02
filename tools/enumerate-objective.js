#!/usr/bin/env node
/* Is the recommendation the argmin of the app's own objective?
 *
 * Every other check in this repo compares the recommendation against its
 * NEIGHBOURS -- another ladder row, another profile card. That can only ever
 * find a defect the app already computed and then ranked wrongly. It cannot
 * see a better trip the app never built, and that is the one a reader finds
 * by hand on Google Flights.
 *
 * So this builds small groups where the whole space is enumerable -- 3 to 4
 * parties, 5 to 9 options each, a few thousand combinations -- runs the real
 * shipped path to get the recommendation, then scores EVERY combination of
 * one flight per traveller with the app's own tripScore and asserts the
 * recommendation is the minimum.
 *
 * Deliberately not a test-*.js suite: it is slow, and it fails today. See
 * RESULT at the bottom of this comment for what it reports and why.
 *
 * RESULT as of 2026-11-01, app.js at 413fcbd:
 *   generated : 800 of 996 groups optimal (80.3%), 208,224 combinations
 *   real data : 59 of 70 BZN subsets optimal (84.3%), 34,771 combinations
 *   the full 7-party BZN group IS optimal over all 96,768 combinations
 *
 * In 196 of 196 generated counterexamples the better combination is not the
 * money argmin at ANY ladder threshold -- so no choice of row could have
 * reached it. The window is chosen under tripScore, which prices spread at
 * $1.50/min, a connection at $120, an air minute at $0.75 and a late landing
 * on two slopes; the plan INSIDE that window is chosen by minCostAtWindow
 * under money alone. Four of the five terms in the objective never reach the
 * selection. Unpruning the ladder fixes 0 of them, so the prune is not it.
 *
 * Run: node tools/enumerate-objective.js [groups]
 */
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
var FWF = require(path.join(ROOT, 'optimizer.js'));

/* ------------------------------------------------------------ the loader
 * Same slicing test-matches.js uses, plus tripTotal, which this needs to
 * replay a whole render pass. */
function slice(a, b, label) {
    var i = src.indexOf(a), j = src.indexOf(b);
    if (i < 0 || j < 0 || j < i) {
        console.error('FAIL: could not locate ' + label + ' in app.js');
        process.exit(1);
    }
    return src.slice(i, j);
}
var REGIONS = [
    ['query+compute', slice('function newParty(i)',
        '/* -------------------------------------------------------- autocomplete */', 'compute')],
    ['airlines', slice('/* ------------------------------------------------------------ airlines',
        'function airlineSite(o)', 'airlines')],
    ['home+ladder+profiles', slice('/* ------------------------------------------------------- the way home',
        'function tripTotal() {', 'profiles')],
    ['tripTotal', slice('function tripTotal() {',
        '/* --brand-h, measured rather than guessed.', 'tripTotal')],
    ['planOf', slice('function seatsOf(ids) {',
        '/* ------------------------------------------------------------ airlines', 'planOf')]
];
var HOST = { innerHTML: '', className: '' };
var ctx = {
    FWF: FWF, console: console,
    document: { addEventListener: function () {}, querySelector: function () { return null; },
                querySelectorAll: function () { return []; } },
    APP: { bagFee: 35, carryOnFee: 30, target: 30, maxParties: 8, maxSeats: 9 },
    COLORS: ['#986306', '#177984', '#3c6bc7', '#994cbb', '#bb482c', '#be4066', '#147d45', '#61760a'],
    DATA: null, SET: null, C: null, TRIP: null, PICKED_PLAN: null,
    state: { step: 4, leg: 'outbound', recommend: 'value', match: null,
             th: { outbound: null, 'return': null }, q: null }
};
ctx.el = function (id) { return id === 'choices' ? HOST : null; };
ctx.party = function (pid) {
    return (ctx.state.q.parties || []).filter(function (p) { return p.id === pid; })[0];
};
ctx.name = function (id) {
    var t = ((ctx.C && ctx.C.travelers) || []).filter(function (x) { return x.id === id; })[0];
    return t ? t.name : id;
};
ctx.money = function (n) { return '$' + Math.round(n).toLocaleString('en-US'); };
ctx.esc = function (s) { return String(s == null ? '' : s); };
ctx.gapWords = function (m) { return FWF.fmtGap(m); };
ctx.fmtClock = function (m) { return FWF.fmtClock(m, true); };
ctx.titleCase = function (s) { return String(s); };
ctx.thBoth = function (v) { ctx.state.th.outbound = v; ctx.state.th['return'] = v; };
ctx.otherLeg = function () { return ctx.state.leg === 'outbound' ? 'return' : 'outbound'; };
ctx.thGet = function () { return ctx.state.th[ctx.state.leg]; };
ctx.thSet = function (v) { ctx.state.th[ctx.state.leg] = v; };
ctx.thReset = function () { ctx.state.th.outbound = null; ctx.state.th['return'] = null; };
vm.createContext(ctx);
REGIONS.forEach(function (r) {
    try { vm.runInContext(r[1], ctx); }
    catch (e) { console.error('FAIL: region ' + r[0] + ': ' + e.message); process.exit(1); }
});

function load(g) {
    ctx.SET = { meId: null, theme: 'dark', target: 30, priceDisplay: 'allin',
                time24: false, bags: { carry_on: 1, checked: 0 } };
    ctx.state.q = ctx.blankQuery();
    ctx.state.q.dest = g.dest; ctx.state.q.dep = g.dep; ctx.state.q.ret = g.ret || '';
    ctx.state.q.parties = JSON.parse(JSON.stringify(g.parties));
    if (g.band) ctx.state.q.band.outbound = { from: g.band.from, to: g.band.to };
    ctx.state.th = { outbound: null, 'return': null };
    ctx.state.leg = 'outbound'; ctx.state.match = null;
    ctx.DATA = { currency: 'USD', sample: true, trips: { query: g.trip }, errors: [] };
    /* The per-pass memos render() clears. Missing one of these makes a stale
     * outbound steer the next group's way home. */
    ctx.returnTh = {}; ctx.COHERENT_MEMO = {}; ctx.OUT_PICKS = null;
    ctx.MATCHES = null; ctx.PICKED_PLAN = null;
    ctx.C = ctx.compute('outbound');
}

/* --------------------------------------------------------- the scoring
 * The row tripLadder() would build for an arbitrary combination, through the
 * app's own regret, lateness and way-home rules. Verified below against
 * tripLadder's real rows before any counterexample is believed: a scoring
 * function derived from anything but the shipped one would manufacture
 * findings rather than find them. */
function rowOf(outCtx, retCtx, combo) {
    var picks = {}, times = [], total = 0, mins = 0, conn = {};
    for (var i = 0; i < outCtx.ids.length; i++) {
        var id = outCtx.ids[i], o = combo[id];
        if (!o) return null;
        var c = outCtx.costFn(o, id);
        picks[id] = { option: o, cost: c };
        total += c; times.push(o.clusterMin);
        if (o.duration_minutes != null) mins += o.duration_minutes;
        if ((o.stops || 0) > 0) conn[id] = true;
    }
    var worst = Math.max.apply(null, times) - Math.min.apply(null, times);
    var late = ctx.latenessOf(outCtx, picks, 'outbound');
    var g = ctx.regretOf(outCtx, picks);
    var reg = { stops: g.stops, mins: g.mins, who: g.who };
    if (retCtx) {
        var keep = ctx.OUT_PICKS;
        ctx.OUT_PICKS = picks;
        var th = ctx.returnThOf(retCtx);
        var rr = ctx.coherentReturn(retCtx, th)
              || FWF.minCostAtWindow(retCtx.prep, th, retCtx.costFn);
        ctx.OUT_PICKS = keep;
        if (!rr) return null;
        total += rr.cost;
        late += ctx.latenessOf(retCtx, rr.picks, 'return');
        var g2 = ctx.regretOf(retCtx, rr.picks);
        if (g2.stops > reg.stops) reg.stops = g2.stops;
        if (g2.mins > reg.mins) reg.mins = g2.mins;
    }
    return { total: total, worst: worst, regret: reg, mins: mins,
             conn: Object.keys(conn), late: late, picks: picks };
}
function sweep(ids, pool, visit) {
    var combo = {}, n = ids.length;
    (function rec(i) {
        if (i === n) { visit(combo); return; }
        var list = pool[ids[i]];
        for (var j = 0; j < list.length; j++) { combo[ids[i]] = list[j]; rec(i + 1); }
    }(0));
}
function argmin(outCtx, retCtx, pool) {
    var best = null, score = Infinity;
    sweep(outCtx.ids, pool, function (combo) {
        ctx.OUT_PICKS = null;
        var row = rowOf(outCtx, retCtx, combo);
        if (!row) return;
        var s = ctx.tripScore(row);
        if (s < score - 1e-9) {
            score = s;
            var c = {}; outCtx.ids.forEach(function (id) { c[id] = combo[id]; });
            best = { score: s, row: row, combo: c };
        }
    });
    return best;
}

/* -------------------------------------------------------- the generator
 * Seeded, so a counterexample is reproducible from its number alone. The
 * knobs are the ones that move the objective: price dispersion, a cheap
 * option that lands in the small hours, one party whose arrivals sit nowhere
 * near anybody else's, a return leg, and a landing band. */
function rng(seed) {
    var s = (seed >>> 0) || 1;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function stamp(day, m) {
    var h = Math.floor(m / 60) % 24, mi = ((m % 60) + 60) % 60, d = day + Math.floor(m / 1440);
    return '2027-02-' + (d < 10 ? '0' + d : d) + ' '
        + (h < 10 ? '0' + h : h) + ':' + (mi < 10 ? '0' + mi : mi);
}
var CARRIERS = ['Delta', 'United', 'American', 'Alaska', 'JetBlue', 'Southwest'];
function opt(day, at, dur, stops, price, carrier, from, to) {
    return { price: Math.round(price), depart: stamp(day, at - dur), arrive: stamp(day, at),
             duration_minutes: dur, stops: stops, airlines: [carrier], from: from, to: to,
             airline_logo: null, booking_token: null,
             extensions: ['Checked baggage for a fee'],
             bags: { carry_on_included: true, checked_first_price: null, confidence: 'fee_unknown' } };
}
function makeGroup(seed) {
    var r = rng(seed);
    var n = 3 + (r() < 0.5 ? 0 : 1);
    var night = r() < 0.4, outlier = r() < 0.3, roundTrip = r() < 0.4;
    var wide = r() < 0.5, bandOn = r() < 0.2;
    var parties = [], out = {}, back = {};
    for (var i = 0; i < n; i++) {
        var id = 'p' + i, seats = r() < 0.2 ? 2 : 1;
        var base = 150 + Math.floor(r() * 450), dur = 90 + Math.floor(r() * 330);
        var carrier = CARRIERS[Math.floor(r() * CARRIERS.length)];
        var k = 5 + Math.floor(r() * 4);
        var lo = (outlier && i === 0) ? 1150 : 420, hi = (outlier && i === 0) ? 1560 : 1200;
        var list = [];
        for (var j = 0; j < k; j++) {
            var at = lo + Math.floor(r() * (hi - lo));
            var st = r() < 0.45 ? (r() < 0.25 ? 2 : 1) : 0;
            list.push(opt(12, at, dur + st * (50 + Math.floor(r() * 150)), st,
                base * (wide ? 0.6 + r() * 1.8 : 0.92 + r() * 0.2),
                CARRIERS[Math.floor(r() * CARRIERS.length)], 'A' + i, 'ZZZ'));
        }
        /* The case the two-slope lateness term was added for: cheap, nonstop,
         * and it puts you on the ground at one in the morning. */
        if (night) list.push(opt(12, 1460 + Math.floor(r() * 150), dur, 0, base * 0.42,
                                 carrier, 'A' + i, 'ZZZ'));
        out[id] = list;
        if (roundTrip) {
            var bl = [];
            for (var q = 0; q < k; q++) {
                var s2 = r() < 0.4 ? 1 : 0;
                bl.push(opt(15, 420 + Math.floor(r() * 780), dur + s2 * 120, s2,
                    base * (wide ? 0.6 + r() * 1.6 : 0.92 + r() * 0.2),
                    CARRIERS[Math.floor(r() * CARRIERS.length)], 'ZZZ', 'A' + i));
            }
            back[id] = bl;
        }
        parties.push({ id: id, name: 'P' + i, seats: seats, airports: ['A' + i] });
    }
    var g = { seed: seed, dest: 'ZZZ', dep: '2027-02-12', ret: roundTrip ? '2027-02-15' : '',
              parties: parties,
              trip: roundTrip ? { outbound: out, 'return': back } : { outbound: out } };
    if (bandOn) g.band = { from: '06:00', to: '21:00' };
    return g;
}

/* ------------------------------------------------- 0. trust the scoring */
var mismatch = 0, rowsChecked = 0;
for (var v = 1; v <= 60; v++) {
    var gv = makeGroup(v * 1013 + 7);
    load(gv);
    var cv = ctx.compute('outbound');
    if (!cv || !cv.prep.complete) continue;
    var rv = gv.ret ? ctx.compute('return') : null;
    if (rv && !rv.prep.complete) rv = null;
    (ctx.tripLadder() || []).forEach(function (row) {
        var r = FWF.minCostAtWindow(cv.prep, row.th, cv.costFn);
        if (!r) return;
        var combo = {};
        cv.ids.forEach(function (id) { combo[id] = r.picks[id].option; });
        ctx.OUT_PICKS = null;
        var mine = rowOf(cv, rv, combo);
        rowsChecked++;
        if (Math.abs(ctx.tripScore(mine) - ctx.tripScore(row)) > 1e-6) mismatch++;
    });
}
console.log('scoring agrees with tripLadder on ' + (rowsChecked - mismatch)
            + ' of ' + rowsChecked + ' real rows');
if (mismatch) { console.error('FAIL: the scoring does not reproduce the app. Stop.'); process.exit(1); }

/* --------------------------------------------- 1. generated, exhaustive */
var N = +(process.argv[2] || 300);
var gen = { groups: 0, pass: 0, combos: 0, gaps: [], worst: null, noRowReaches: 0, unprunedWins: 0 };
for (var i = 0; i < N; i++) {
    var seed = 1000 + i * 37, g = makeGroup(seed);
    load(g);
    var c = ctx.compute('outbound');
    if (!c || !c.prep || !c.prep.complete) continue;
    var rc = g.ret ? ctx.compute('return') : null;
    if (rc && !rc.prep.complete) rc = null;
    var size = c.ids.reduce(function (n, id) { return n * (c.prep.options[id] || []).length; }, 1);
    if (!size || size > 20000) continue;
    ctx.MATCHES = null; ctx.PICKED_PLAN = null; ctx.OUT_PICKS = null;
    var rec = ctx.matchOf(ctx.tripMatches());
    if (!rec || !rec.picks || Object.keys(rec.picks).length !== c.ids.length) continue;
    var rcombo = {}; c.ids.forEach(function (id) { rcombo[id] = rec.picks[id].option; });
    ctx.OUT_PICKS = null;
    var rrow = rowOf(c, rc, rcombo);
    if (!rrow) continue;
    var rscore = ctx.tripScore(rrow);
    var best = argmin(c, rc, c.prep.options);
    gen.groups++; gen.combos += size;
    if (rscore <= best.score + 1e-6) { gen.pass++; continue; }
    gen.gaps.push(rscore - best.score);
    /* Could ANY ladder row have reached it, pruned or not? If not, no choice
     * of window could have found this plan and the gap is in the selection
     * inside the window, not in the ranking of the rows. */
    var reached = false, unpruned = Infinity, sig = JSON.stringify(best.combo);
    FWF.DEFAULT_THRESHOLDS.forEach(function (T) {
        var r = FWF.minCostAtWindow(c.prep, T, c.costFn);
        if (!r) return;
        var cc = {}; c.ids.forEach(function (id) { cc[id] = r.picks[id].option; });
        ctx.OUT_PICKS = null;
        var row = rowOf(c, rc, cc);
        if (!row) return;
        unpruned = Math.min(unpruned, ctx.tripScore(row));
        if (JSON.stringify(cc) === sig) reached = true;
    });
    if (!reached) gen.noRowReaches++;
    if (unpruned < rscore - 1e-6) gen.unprunedWins++;
    if (!gen.worst || rscore - best.score > gen.worst.gap) {
        gen.worst = { seed: seed, gap: rscore - best.score,
                      rec: '$' + rrow.total + ' / ' + rrow.worst + 'm apart / late $'
                           + rrow.late.toFixed(0) + ' / regret ' + rrow.regret.stops + ':' + rrow.regret.mins,
                      best: '$' + best.row.total + ' / ' + best.row.worst + 'm apart / late $'
                           + best.row.late.toFixed(0) + ' / regret ' + best.row.regret.stops + ':' + best.row.regret.mins };
    }
}
gen.gaps.sort(function (a, b) { return a - b; });
var fail = gen.groups - gen.pass;
console.log('\n-- generated groups, every combination enumerated --');
console.log('  groups ' + gen.groups + ', combinations ' + gen.combos);
console.log('  recommendation is the argmin in ' + gen.pass + ' of ' + gen.groups
            + '  (' + (100 * gen.pass / gen.groups).toFixed(1) + '%)');
if (fail) {
    console.log('  median gap $' + gen.gaps[gen.gaps.length >> 1].toFixed(2)
                + ', worst $' + gen.gaps[gen.gaps.length - 1].toFixed(2));
    console.log('  no ladder row reaches the better plan : ' + gen.noRowReaches + ' of ' + fail);
    console.log('  an UNPRUNED ladder row would win      : ' + gen.unprunedWins + ' of ' + fail);
    console.log('  worst: seed ' + gen.worst.seed + '\n      recommended ' + gen.worst.rec
                + '\n      argmin      ' + gen.worst.best);
}

/* ----------------------------------- 2. the one real captured response */
var LIVE = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures-live.json'), 'utf8')).scenarios.bzn;
var live = { groups: 0, pass: 0, combos: 0, worst: null };
for (var mask = 1; mask < (1 << LIVE.parties.length); mask++) {
    var ps = [], bits = 0;
    for (var b2 = 0; b2 < LIVE.parties.length; b2++) {
        if (mask & (1 << b2)) { ps.push(LIVE.parties[b2]); bits++; }
    }
    if (bits !== 3 && bits !== 4) continue;
    var trip = { outbound: {} };
    ps.forEach(function (p) { trip.outbound[p.id] = LIVE.trips.query.outbound[p.id]; });
    load({ dest: LIVE.dest, dep: LIVE.dep, ret: '', parties: ps, trip: trip });
    var lc = ctx.compute('outbound');
    if (!lc || !lc.prep.complete) continue;
    var lsize = lc.ids.reduce(function (n, id) { return n * lc.prep.options[id].length; }, 1);
    if (lsize > 60000) continue;
    ctx.MATCHES = null; ctx.PICKED_PLAN = null; ctx.OUT_PICKS = null;
    var lrec = ctx.matchOf(ctx.tripMatches());
    if (!lrec || !lrec.picks || Object.keys(lrec.picks).length !== lc.ids.length) continue;
    var lcombo = {}; lc.ids.forEach(function (id) { lcombo[id] = lrec.picks[id].option; });
    var lrow = rowOf(lc, null, lcombo), lscore = ctx.tripScore(lrow);
    var lbest = argmin(lc, null, lc.prep.options);
    live.groups++; live.combos += lsize;
    if (lscore <= lbest.score + 1e-6) { live.pass++; continue; }
    var tag = ps.map(function (p) { return p.id; }).join('');
    if (!live.worst || lscore - lbest.score > live.worst.gap) {
        live.worst = { ids: tag, gap: lscore - lbest.score,
            lands: lc.ids.map(function (id) {
                return FWF.fmtClock(lrec.picks[id].option.clusterMin, true); }).join('/'),
            rec: '$' + lrow.total + ' / ' + lrow.worst + 'm apart / late $' + lrow.late.toFixed(0),
            best: '$' + lbest.row.total + ' / ' + lbest.row.worst + 'm apart / late $'
                  + lbest.row.late.toFixed(0),
            bestLands: lc.ids.map(function (id) {
                return FWF.fmtClock(lbest.combo[id].clusterMin, true); }).join('/') };
    }
}
console.log('\n-- real BZN capture, every 3 and 4 party subset --');
console.log('  groups ' + live.groups + ', combinations ' + live.combos);
console.log('  recommendation is the argmin in ' + live.pass + ' of ' + live.groups
            + '  (' + (100 * live.pass / live.groups).toFixed(1) + '%)');
if (live.worst) {
    console.log('  worst: ' + live.worst.ids + '  gap $' + live.worst.gap.toFixed(0));
    console.log('      recommended ' + live.worst.rec + '   lands ' + live.worst.lands);
    console.log('      argmin      ' + live.worst.best + '   lands ' + live.worst.bestLands);
}
