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
var ONLY = (process.argv.slice(2).filter(function (a) { return /^--only=/.test(a); })[0] || '')
    .split('=')[1] || '';
function want(s) { return !ONLY || ONLY.split(',').indexOf(s) > -1; }
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
if (want('gen')) {
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

}
var LIVE = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures-live.json'), 'utf8')).scenarios.bzn;

/* ----------------------------------- 2. the one real captured response */
if (want('bzn')) {
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
}

/* ---------------------------------------- 3. the subset path, exhaustive
 *
 * Sections 1 and 2 cannot see this code at all. Both of them bail on
 * `!prep.complete`, so every number above is measured on groups where every
 * party can make the window. The branch that runs when somebody genuinely
 * cannot is a DIFFERENT path -- tripLadder() returns null for an incomplete
 * group, which deletes the one place tripScore reaches the selection -- and it
 * has never been measured against brute force.
 *
 * Who gets seated is not a free variable here, and that is what makes the
 * comparison fair. reachOf() is bestSubset at an infinite window, which seats
 * every party holding any legal option at all, so the reachable set is exactly
 * ids minus prep.missing and every profile is held to it. The argmin below
 * sweeps flights for that same set and adds strandedCost -- a per-group
 * constant -- for the rest. Nothing in this comparison can buy a better score
 * by leaving somebody behind, because both sides seat the identical people.
 *
 * Run: node tools/enumerate-objective.js <groups> --only=subset
 */
/* The stranded party's fare, exactly as tripMatches() adds it to the card:
 * soloOpen for anybody the plan has no pick for. It is constant across the
 * candidates in a group, so it cannot move the argmin -- it is here so the
 * score this section prints is the score the screen is quoting. */
function strandedFor(outCtx, included) {
    var seated = {};
    included.forEach(function (id) { seated[id] = true; });
    return outCtx.ids.reduce(function (n, id) {
        if (seated[id]) return n;
        return n + (outCtx.soloOpen[id] ? outCtx.soloOpen[id].cost : 0);
    }, 0);
}

/* rowOf, for a plan that seats only some of the group. regretOf and latenessOf
 * already skip a party with no pick, so they need no change -- which is itself
 * worth noticing: the stranded party's MONEY is counted and their 1am landing
 * is not. Constant per group, so not a ranking defect, but it does mean a
 * subset card's shadow terms describe a smaller trip than its price does. */
function subRowOf(outCtx, retCtx, combo, included) {
    var picks = {}, times = [], total = 0, mins = 0, conn = {};
    for (var i = 0; i < included.length; i++) {
        var id = included[i], o = combo[id];
        if (!o) return null;
        var c = outCtx.costFn(o, id);
        picks[id] = { option: o, cost: c };
        total += c; times.push(o.clusterMin);
        if (o.duration_minutes != null) mins += o.duration_minutes;
        if ((o.stops || 0) > 0) conn[id] = true;
    }
    total += strandedFor(outCtx, included);
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

/* Is a better plan already ON THE SCREEN? The recommendation is always
 * Balanced -- matchList marks the head of the profile order and Balanced is
 * first -- but the other cards select under their own shadow costs, and
 * "Easiest flights" in particular prices stops and air minutes, which is the
 * term left in the residual. If a card beside the recommended one scores
 * better on tripScore, the app already computed the better trip and simply
 * did not point at it, and the fix is a ranking change rather than a search.
 * Only cards seating at least as many people count. */
function bestCardScore(outCtx, retCtx, ms, floorSeated) {
    var best = Infinity;
    (ms || []).forEach(function (m) {
        if (!m.plan || !m.plan.included.length) return;
        if (m.plan.included.length < floorSeated) return;
        var cb = {}, ok = true;
        m.plan.included.forEach(function (id) {
            var pk = m.picks[id]; if (!pk) { ok = false; return; } cb[id] = pk.option;
        });
        if (!ok) return;
        ctx.OUT_PICKS = null;
        var row = subRowOf(outCtx, retCtx, cb, m.plan.included);
        if (!row) return;
        best = Math.min(best, ctx.tripScore(row));
    });
    return best;
}

function subArgmin(outCtx, retCtx, included) {
    var best = null, score = Infinity;
    sweep(included, outCtx.prep.options, function (combo) {
        ctx.OUT_PICKS = null;
        var row = subRowOf(outCtx, retCtx, combo, included);
        if (!row) return;
        var sc = ctx.tripScore(row);
        if (sc < score - 1e-9) {
            score = sc;
            var c = {}; included.forEach(function (id) { c[id] = combo[id]; });
            best = { score: sc, row: row, combo: c };
        }
    });
    return best;
}

/* The SAME population section 1 measures, with one party made unseatable.
 *
 * Built by post-processing makeGroup rather than by writing a second
 * generator, because the number this section reports only means anything
 * against the 80.2% above it. A fresh generator with its own price dispersion
 * and its own arrival spread would produce a rate that is lower for reasons
 * nobody could separate from the code under test -- a first attempt here did
 * exactly that and read 20%, which says more about the generator than the app.
 *
 * Two ways to strand somebody, because they leave different evidence:
 *
 *  avoid -- the group refuses a carrier and one party flies nothing else. The
 *    cleanest instrument there is: it empties exactly one party's list and
 *    leaves every hour of the day in play for everyone else, so the lateness
 *    term still has something to price.
 *
 *  band -- the documented case, which strands 43% of groups on "Afternoon".
 *    It empties the odd party by moving their arrivals outside the band, and
 *    it also deletes the small hours for the REST of the group, which is a
 *    real property of a band and not a generator artifact. Reported in its own
 *    bucket so the two are never averaged into one misleading number.
 */
function makeStranded(seed) {
    var g = makeGroup(seed);
    var r = rng(seed ^ 0x5bf03635);
    var ids = g.parties.map(function (p) { return p.id; });
    var odd = ids[Math.floor(r() * ids.length)];
    var viaBand = r() < 0.5;
    var lists = g.trip.outbound;

    if (viaBand) {
        /* 06:00-21:00. The odd party's arrivals move into the late evening,
         * which is outside it; nobody else's times are touched. */
        g.band = { from: '06:00', to: '21:00' };
        lists[odd].forEach(function (o, i) {
            var at = 1290 + ((i * 37) % 140);     /* 21:30 - 23:50 */
            o.arrive = stamp(12, at);
            o.depart = stamp(12, at - (o.duration_minutes || 120));
        });
    } else {
        /* Delta is the refused carrier. Everyone else is moved off it first,
         * so the avoid list can only ever empty the one party it is aimed at. */
        ids.forEach(function (id) {
            if (id === odd) return;
            (lists[id] || []).forEach(function (o) {
                if ((o.airlines || [])[0] === 'Delta') o.airlines = ['United'];
            });
            ((g.trip['return'] || {})[id] || []).forEach(function (o) {
                if ((o.airlines || [])[0] === 'Delta') o.airlines = ['United'];
            });
        });
        (lists[odd] || []).forEach(function (o) { o.airlines = ['Delta']; });
        g.avoid = ['delta'];
    }
    g.strandedBy = viaBand ? 'band' : 'avoid';
    g.odd = odd;
    return g;
}


if (want('subset')) {

var SN = +((process.argv.slice(2).filter(function (a) { return /^\d+$/.test(a); })[0]) || 300);
var sub = { groups: 0, pass: 0, combos: 0, gaps: [], worst: null,
            short: 0, noWindowReaches: 0, scoredWindowWins: 0, byBand: [0, 0], byAvoid: [0, 0],
            /* Cause attribution. ladderNull counts the groups where
             * tripLadder() returns nothing, which is the hypothesis; thFree
             * counts the groups where the window Balanced actually used is
             * the money-only one Cheapest would have picked. If those two are
             * the whole population, "Balanced IS Cheapest here" is not a
             * reading of the code, it is a measurement. */
            ladderNull: 0, thFree: 0, thInf: 0, cardWins: 0, cardWinsOB: 0,
            /* Which term of tripScore the money-only choice is throwing away,
             * summed over the misses in the objective's own units. */
            dec: { money: 0, spread: 0, late: 0, regret: 0 } };
var DUMP = {};
for (var si = 0; si < SN; si++) {
    var sseed = 7000 + si * 53, sg = makeStranded(sseed);
    load(sg);
    if (sg.avoid) ctx.state.q.avoid = sg.avoid.slice();
    var sc0 = ctx.compute('outbound');
    /* The whole point of this section: only groups the other two skip. */
    if (!sc0 || !sc0.prep || sc0.prep.complete) continue;
    var reachIds = sc0.ids.filter(function (id) { return (sc0.prep.options[id] || []).length; });
    if (reachIds.length < 2) continue;
    var ssize = reachIds.reduce(function (n, id) { return n * sc0.prep.options[id].length; }, 1);
    if (!ssize || ssize > 20000) continue;
    var src = sg.ret ? ctx.compute('return') : null;
    if (src && !src.prep.complete) src = null;

    ctx.MATCHES = null; ctx.PICKED_PLAN = null; ctx.OUT_PICKS = null;
    var srec = ctx.matchOf(ctx.tripMatches());
    if (!srec || !srec.plan || !srec.plan.included.length) continue;
    var sinc = srec.plan.included.slice();
    var scombo = {};
    var okPicks = sinc.every(function (id) {
        var p = srec.picks[id]; if (!p) return false; scombo[id] = p.option; return true;
    });
    if (!okPicks) continue;
    ctx.OUT_PICKS = null;
    var srow = subRowOf(sc0, src, scombo, sinc);
    if (!srow) continue;
    var sscore = ctx.tripScore(srow);
    var sbest = subArgmin(sc0, src, reachIds);
    if (!sbest) continue;

    /* The hypothesis, measured rather than read off the source. */
    if (!ctx.tripLadder()) sub.ladderNull++;
    if (srec.th === ctx.freeTighten(sc0, sc0.costFn)) sub.thFree++;
    if (srec.th === FWF.INF) sub.thInf++;

    sub.groups++; sub.combos += ssize;
    var bucket = sg.strandedBy === 'band' ? sub.byBand : sub.byAvoid;
    bucket[1]++;
    /* Seating fewer than the reach is its own defect and is counted apart from
     * the scoring gap: a plan that leaves a seatable party behind is not a
     * worse answer to the same question, it is an answer to a smaller one. */
    if (sinc.length < reachIds.length) sub.short++;
    DUMP[sseed] = { score: sscore, seated: sinc.length, reach: reachIds.length,
                    best: sbest.score, size: ssize };
    if (sscore <= sbest.score + 1e-6) { sub.pass++; bucket[0]++; continue; }
    sub.gaps.push(sscore - sbest.score);
    sub.dec.money += srow.total - sbest.row.total;
    sub.dec.spread += 1.5 * (srow.worst - sbest.row.worst);
    sub.dec.late += srow.late - sbest.row.late;
    sub.dec.regret += 120 * (srow.regret.stops - sbest.row.regret.stops)
                    + 0.75 * (srow.regret.mins - sbest.row.regret.mins);

    /* Could any WINDOW have reached the argmin, and would scoring the windows
     * by tripScore have found a better one? The first says whether the defect
     * is the window choice or the plan inside it; the second bounds what a
     * scored window search can actually recover on this path. */
    var sig2 = JSON.stringify(sbest.combo), reached2 = false, scoredBest = Infinity;
    FWF.DEFAULT_THRESHOLDS.forEach(function (T) {
        var r2 = ctx.solveAt(sc0, T, sc0.costFn);
        if (!r2 || (r2.included || sc0.ids).length < reachIds.length) return;
        var cc = {}; reachIds.forEach(function (id) { cc[id] = r2.picks[id].option; });
        ctx.OUT_PICKS = null;
        var row2 = subRowOf(sc0, src, cc, reachIds);
        if (!row2) return;
        scoredBest = Math.min(scoredBest, ctx.tripScore(row2));
        if (JSON.stringify(cc) === sig2) reached2 = true;
    });
    if (!reached2) sub.noWindowReaches++;
    if (scoredBest < sscore - 1e-6) sub.scoredWindowWins++;
    ctx.MATCHES = null; ctx.PICKED_PLAN = null; ctx.OUT_PICKS = null;
    if (bestCardScore(sc0, src, ctx.tripMatches(), sinc.length) < sscore - 1e-6) sub.cardWins++;
    /* The same question with the way home left out. matchList ranks the cards
     * on the OUTBOUND score alone, so if this counter is zero while the one
     * above is not, the whole residual is the return leg reacting to the
     * outbound choice and flipping the order. */
    ctx.MATCHES = null; ctx.PICKED_PLAN = null; ctx.OUT_PICKS = null;
    var obOnly = bestCardScore(sc0, null, ctx.tripMatches(), sinc.length);
    ctx.OUT_PICKS = null;
    var obRec = subRowOf(sc0, null, scombo, sinc);
    if (obRec && obOnly < ctx.tripScore(obRec) - 1e-6) sub.cardWinsOB++;

    if (!sub.worst || sscore - sbest.score > sub.worst.gap) {
        sub.worst = { seed: sseed, gap: sscore - sbest.score, how: sg.strandedBy,
            seated: sinc.length + ' of ' + sc0.ids.length,
            rec: '$' + srow.total.toFixed(0) + ' / ' + srow.worst + 'm apart / late $'
                 + srow.late.toFixed(0) + ' / regret ' + srow.regret.stops + ':' + srow.regret.mins,
            best: '$' + sbest.row.total.toFixed(0) + ' / ' + sbest.row.worst + 'm apart / late $'
                 + sbest.row.late.toFixed(0) + ' / regret ' + sbest.row.regret.stops + ':' + sbest.row.regret.mins };
    }
}
sub.gaps.sort(function (a, b) { return a - b; });
var sfail = sub.groups - sub.pass;
console.log('\n-- the subset path, every combination over the seatable set --');
console.log('  groups ' + sub.groups + ', combinations ' + sub.combos);
console.log('  recommendation is the argmin in ' + sub.pass + ' of ' + sub.groups
            + '  (' + (100 * sub.pass / sub.groups).toFixed(1) + '%)');
console.log('  stranded by band  ' + sub.byBand[0] + ' of ' + sub.byBand[1]
            + '   stranded by avoid  ' + sub.byAvoid[0] + ' of ' + sub.byAvoid[1]);
console.log('  recommendation seats fewer than the reach : ' + sub.short + ' of ' + sub.groups);
console.log('  tripLadder() returns null                 : ' + sub.ladderNull + ' of ' + sub.groups);
console.log('  Balanced used the money-only window       : ' + sub.thFree + ' of ' + sub.groups
            + '   (of which wide open: ' + sub.thInf + ')');
if (sfail) {
    console.log('  median gap $' + sub.gaps[sub.gaps.length >> 1].toFixed(2)
                + ', mean $' + (sub.gaps.reduce(function (a, b) { return a + b; }, 0) / sfail).toFixed(2)
                + ', worst $' + sub.gaps[sub.gaps.length - 1].toFixed(2));
    console.log('  gap by term: money $' + sub.dec.money.toFixed(0)
                + ', spread $' + sub.dec.spread.toFixed(0)
                + ', lateness $' + sub.dec.late.toFixed(0)
                + ', regret $' + sub.dec.regret.toFixed(0));
    console.log('  no window at full reach gets there    : ' + sub.noWindowReaches + ' of ' + sfail);
    console.log('  a tripScore-ranked window would win   : ' + sub.scoredWindowWins + ' of ' + sfail);
    console.log('  a card already on screen scores better: ' + sub.cardWins + ' of ' + sfail
                + '   (outbound score only: ' + sub.cardWinsOB + ')');
    console.log('  worst: seed ' + sub.worst.seed + ' (' + sub.worst.how + ', seats '
                + sub.worst.seated + ')  gap $' + sub.worst.gap.toFixed(0)
                + '\n      recommended ' + sub.worst.rec + '\n      argmin      ' + sub.worst.best);
}
var DF = (process.argv.slice(2).filter(function (a) { return /^--dump=/.test(a); })[0] || '').split('=')[1];
if (DF) { fs.writeFileSync(DF, JSON.stringify(DUMP)); console.log('  per-group scores -> ' + DF); }

}

/* ------------------------- 4. the subset path, on the real captured data
 *
 * Section 2 enumerates all 70 three- and four-party BZN subsets and every one
 * of them is COMPLETE, because the capture carries no filters -- so not one
 * real row exercises the branch section 3 is about. That is a hole: section 3
 * strands people with a generator, and a generator can be wrong about the
 * shape of a real option set in ways that flatter or damn the code under
 * test.
 *
 * So: the same real subsets, with a landing band over them. A band is the
 * commonest way a real group ends up incomplete -- it strands 43% of groups
 * on "Afternoon" and 88% on "Evening" -- and applying one to captured data
 * leaves the fares, the durations, the connections and the arrival times
 * exactly as SerpApi returned them. Only the groups the band actually strands
 * somebody in are counted; the rest are section 2's problem.
 */
if (want('rsub')) {

/* A grid, not a hand-picked list. The four obvious bands -- morning,
 * afternoon, evening, no-small-hours -- strand NOBODY in this capture: every
 * one of the seven parties holds a midday arrival, so a wide band leaves the
 * group complete and this section measures nothing. Hand-picking the bands
 * that do strand somebody would be choosing the test to suit the code, so
 * instead every hour-start crossed with four widths is tried and the ones
 * that happen to break the group are kept. */
var BANDS = [];
(function () {
    var p2 = function (v) { return (v < 10 ? '0' : '') + v; };
    for (var h = 6; h <= 23; h++) {
        [60, 90, 150, 240].forEach(function (w) {
            var a = h * 60, b = a + w;
            if (b > 23 * 60 + 59) return;
            BANDS.push({ from: p2(h) + ':00', to: p2(Math.floor(b / 60)) + ':' + p2(b % 60) });
        });
    }
}());
var rs = { groups: 0, pass: 0, combos: 0, gaps: [], worst: null, short: 0,
           noWindowReaches: 0, cardWins: 0, byBand: {} };
var RDUMP = {}, RSEEN = {};
for (var rmask = 1; rmask < (1 << LIVE.parties.length); rmask++) {
    var rps = [], rbits = 0;
    for (var rb = 0; rb < LIVE.parties.length; rb++) {
        if (rmask & (1 << rb)) { rps.push(LIVE.parties[rb]); rbits++; }
    }
    if (rbits !== 3 && rbits !== 4) continue;
    for (var bi = 0; bi < BANDS.length; bi++) {
        var rtrip = { outbound: {} };
        rps.forEach(function (p) { rtrip.outbound[p.id] = LIVE.trips.query.outbound[p.id]; });
        load({ dest: LIVE.dest, dep: LIVE.dep, ret: '', parties: rps, trip: rtrip,
               band: BANDS[bi] });
        var rc0 = ctx.compute('outbound');
        /* Only the groups the band actually breaks. */
        if (!rc0 || !rc0.prep || rc0.prep.complete) continue;
        var rreach = rc0.ids.filter(function (id) { return (rc0.prep.options[id] || []).length; });
        if (rreach.length < 2) continue;
        var rsize = rreach.reduce(function (n, id) { return n * rc0.prep.options[id].length; }, 1);
        if (!rsize || rsize > 60000) continue;

        /* Different bands routinely leave the identical surviving options --
         * 09:00-10:00 and 09:00-10:30 are the same problem here -- and
         * counting one problem twice would inflate whichever way it falls. */
        var rkey = rc0.ids.map(function (id) {
            return id + ':' + (rc0.prep.options[id] || []).map(function (o) {
                return o.clusterMin + '#' + o.price; }).join(',');
        }).join('|');
        if (RSEEN[rkey]) continue;
        RSEEN[rkey] = true;

        ctx.MATCHES = null; ctx.PICKED_PLAN = null; ctx.OUT_PICKS = null;
        var rrec = ctx.matchOf(ctx.tripMatches());
        if (!rrec || !rrec.plan || !rrec.plan.included.length) continue;
        var rinc = rrec.plan.included.slice(), rcombo = {};
        var rok = rinc.every(function (id) {
            var pk = rrec.picks[id]; if (!pk) return false; rcombo[id] = pk.option; return true;
        });
        if (!rok) continue;
        ctx.OUT_PICKS = null;
        var rrow = subRowOf(rc0, null, rcombo, rinc);
        if (!rrow) continue;
        var rscore = ctx.tripScore(rrow);
        var rbest = subArgmin(rc0, null, rreach);
        if (!rbest) continue;

        var btag = BANDS[bi].from + '-' + BANDS[bi].to;
        if (!rs.byBand[btag]) rs.byBand[btag] = [0, 0];
        rs.byBand[btag][1]++;
        rs.groups++; rs.combos += rsize;
        if (rinc.length < rreach.length) rs.short++;
        var rtag = rps.map(function (p) { return p.id; }).join('') + '@' + btag;
        RDUMP[rtag] = { score: rscore, seated: rinc.length, reach: rreach.length,
                        best: rbest.score, size: rsize };
        if (rscore <= rbest.score + 1e-6) { rs.pass++; rs.byBand[btag][0]++; continue; }
        rs.gaps.push(rscore - rbest.score);

        var rsig = JSON.stringify(rbest.combo), rreached = false;
        FWF.DEFAULT_THRESHOLDS.forEach(function (T) {
            var rr2 = ctx.solveAt(rc0, T, rc0.costFn);
            if (!rr2 || (rr2.included || rc0.ids).length < rreach.length) return;
            var rcc = {}; rreach.forEach(function (id) { rcc[id] = rr2.picks[id].option; });
            if (JSON.stringify(rcc) === rsig) rreached = true;
        });
        if (!rreached) rs.noWindowReaches++;
        ctx.MATCHES = null; ctx.PICKED_PLAN = null; ctx.OUT_PICKS = null;
        if (bestCardScore(rc0, null, ctx.tripMatches(), rinc.length) < rscore - 1e-6) rs.cardWins++;

        if (!rs.worst || rscore - rbest.score > rs.worst.gap) {
            rs.worst = { tag: rtag, gap: rscore - rbest.score,
                seated: rinc.length + ' of ' + rc0.ids.length,
                rec: '$' + rrow.total.toFixed(0) + ' / ' + rrow.worst + 'm apart / late $'
                     + rrow.late.toFixed(0),
                lands: rinc.map(function (id) {
                    return FWF.fmtClock(rrec.picks[id].option.clusterMin, true); }).join('/'),
                best: '$' + rbest.row.total.toFixed(0) + ' / ' + rbest.row.worst + 'm apart / late $'
                     + rbest.row.late.toFixed(0),
                bestLands: rreach.map(function (id) {
                    return FWF.fmtClock(rbest.combo[id].clusterMin, true); }).join('/') };
        }
    }
}
rs.gaps.sort(function (a, b) { return a - b; });
console.log('\n-- real BZN capture, banded until somebody is stranded --');
console.log('  groups ' + rs.groups + ', combinations ' + rs.combos);
if (rs.groups) {
    console.log('  recommendation is the argmin in ' + rs.pass + ' of ' + rs.groups
                + '  (' + (100 * rs.pass / rs.groups).toFixed(1) + '%)');
    Object.keys(rs.byBand).forEach(function (k) {
        console.log('    band ' + k + '  ' + rs.byBand[k][0] + ' of ' + rs.byBand[k][1]);
    });
    console.log('  recommendation seats fewer than the reach : ' + rs.short + ' of ' + rs.groups);
    var chose = 0, chosePass = 0;
    Object.keys(RDUMP).forEach(function (k) {
        if (RDUMP[k].size < 4) return;
        chose++;
        if (RDUMP[k].score <= RDUMP[k].best + 1e-6) chosePass++;
    });
    /* A group whose seated parties have one or two combinations between them
     * has no decision to get wrong. Narrow bands on a thin route produce a
     * lot of those, and leaving them in flatters the before and the after
     * equally -- so the rate where a choice actually exists is reported too,
     * and it is the honest one. */
    console.log('  ...of the ' + chose + ' with 4+ combinations to choose from: '
                + chosePass + '  (' + (chose ? (100 * chosePass / chose).toFixed(1) : '0') + '%)');
}
if (rs.gaps.length) {
    console.log('  median gap $' + rs.gaps[rs.gaps.length >> 1].toFixed(2)
                + ', mean $' + (rs.gaps.reduce(function (a, b) { return a + b; }, 0) / rs.gaps.length).toFixed(2)
                + ', worst $' + rs.gaps[rs.gaps.length - 1].toFixed(2));
    console.log('  no window at full reach gets there : ' + rs.noWindowReaches + ' of ' + rs.gaps.length);
    console.log('  a card already on screen scores better : ' + rs.cardWins + ' of ' + rs.gaps.length);
    console.log('  worst: ' + rs.worst.tag + ' (seats ' + rs.worst.seated + ')  gap $'
                + rs.worst.gap.toFixed(0));
    console.log('      recommended ' + rs.worst.rec + '   lands ' + rs.worst.lands);
    console.log('      argmin      ' + rs.worst.best + '   lands ' + rs.worst.bestLands);
}
var RDF = (process.argv.slice(2).filter(function (a) { return /^--rdump=/.test(a); })[0] || '').split('=')[1];
if (RDF) { fs.writeFileSync(RDF, JSON.stringify(RDUMP)); console.log('  per-group scores -> ' + RDF); }

}
