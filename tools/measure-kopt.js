#!/usr/bin/env node
/* What the coordinated-move sweep actually did, measured rather than claimed.
 *
 * enumerate-objective.js answers "is the recommendation the argmin". That is
 * the acceptance gate, and it is not enough on its own to ship a change to
 * the thing every group sees: a rate can rise while some individual group
 * gets a worse trip than it had yesterday, and that group is a person opening
 * the app to find the answer moved the wrong way.
 *
 * So this runs the SAME groups twice in the SAME process -- once with the
 * sweep switched off at KOPT_MAX_K = 0, once with it on -- and compares the
 * recommendation's own tripScore per group. Same loader, same memos cleared
 * between passes, so the only difference between the two numbers is the
 * sweep. It also times the render path at three and at eight travellers, and
 * sweeps k so the cost of the next neighbourhood is a measurement.
 *
 * Run: node tools/measure-kopt.js [groups] [maxK]
 */
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
var FWF = require(path.join(ROOT, 'optimizer.js'));

function slice(a, b, label) {
    var i = src.indexOf(a), j = src.indexOf(b);
    if (i < 0 || j < 0 || j < i) { console.error('FAIL: ' + label); process.exit(1); }
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
    ctx.returnTh = {}; ctx.COHERENT_MEMO = {}; ctx.OUT_PICKS = null;
    ctx.MATCHES = null; ctx.PICKED_PLAN = null;
    ctx.C = ctx.compute('outbound');
}
/* The per-pass memos render() clears, without re-reading the query. A second
 * pass over the same group has to start where the first one did or the
 * comparison is between two different renders. */
function freshPass() {
    ctx.returnTh = {}; ctx.COHERENT_MEMO = {}; ctx.OUT_PICKS = null;
    ctx.MATCHES = null; ctx.PICKED_PLAN = null;
    ctx.state.match = null; ctx.state.th = { outbound: null, 'return': null };
}

/* Identical to the enumerator's rowOf: the row tripLadder() would build for an
 * arbitrary combination. Copied rather than imported because the enumerator is
 * a script, and verified against it by the rates both tools report. */
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

/* The generator, verbatim from the enumerator so the seeds mean the same. */
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
function makeGroup(seed, forceN, forceK) {
    var r = rng(seed);
    var n = forceN || (3 + (r() < 0.5 ? 0 : 1));
    var night = r() < 0.4, outlier = r() < 0.3, roundTrip = !forceN && r() < 0.4;
    var wide = r() < 0.5, bandOn = !forceN && r() < 0.2;
    var parties = [], out = {}, back = {};
    for (var i = 0; i < n; i++) {
        var id = 'p' + i, seats = r() < 0.2 ? 2 : 1;
        var base = 150 + Math.floor(r() * 450), dur = 90 + Math.floor(r() * 330);
        var carrier = CARRIERS[Math.floor(r() * CARRIERS.length)];
        var k = forceK || (5 + Math.floor(r() * 4));
        var lo = (outlier && i === 0) ? 1150 : 420, hi = (outlier && i === 0) ? 1560 : 1200;
        var list = [];
        for (var j = 0; j < k; j++) {
            var at = lo + Math.floor(r() * (hi - lo));
            var st = r() < 0.45 ? (r() < 0.25 ? 2 : 1) : 0;
            list.push(opt(12, at, dur + st * (50 + Math.floor(r() * 150)), st,
                base * (wide ? 0.6 + r() * 1.8 : 0.92 + r() * 0.2),
                CARRIERS[Math.floor(r() * CARRIERS.length)], 'A' + i, 'ZZZ'));
        }
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

/* The recommendation this render produces, scored as a whole trip. */
function recScore(c, rc) {
    freshPass();
    var rec = ctx.matchOf(ctx.tripMatches());
    if (!rec || !rec.picks || Object.keys(rec.picks).length !== c.ids.length) return null;
    var combo = {}; c.ids.forEach(function (id) { combo[id] = rec.picks[id].option; });
    ctx.OUT_PICKS = null;
    var row = rowOf(c, rc, combo);
    if (!row) return null;
    return { score: ctx.tripScore(row), row: row, combo: combo };
}

/* MAXK defaults to whatever app.js actually ships, not to a number of this
 * tool's own. It is written into ctx.KOPT_MAX_K below to isolate one
 * neighbourhood, and a default of 3 silently measured something narrower than
 * production: koptNeighborhoods() only takes the exhaustive branch when
 * n <= KOPT_MAX_K, so a capped run makes every 4-party group skip the whole-
 * space sweep it gets in the app. That under-reported the real BZN subsets as
 * 98.6% with a $358 miss, where the shipped setting reaches the argmin in all
 * 70. A measurement tool whose default disagrees with the build is worse than
 * no tool, because the number looks like the answer. Pass a smaller k
 * explicitly to study a narrower neighbourhood. */
var N = +(process.argv[2] || 1200), MAXK = +(process.argv[3] || ctx.KOPT_MAX_K);

/* ----------------------------------------- 1. per group, off versus on */
var tally = { groups: 0, better: 0, worse: 0, same: 0, offPass: 0, onPass: 0,
              gapOff: 0, gapOn: 0, worstRegression: 0 };
for (var i = 0; i < N; i++) {
    var g = makeGroup(1000 + i * 37);
    load(g);
    var c = ctx.compute('outbound');
    if (!c || !c.prep || !c.prep.complete) continue;
    var rc = g.ret ? ctx.compute('return') : null;
    if (rc && !rc.prep.complete) rc = null;
    var size = c.ids.reduce(function (n, id) { return n * (c.prep.options[id] || []).length; }, 1);
    if (!size || size > 20000) continue;

    ctx.KOPT_MAX_K = 0;
    var off = recScore(c, rc);
    ctx.KOPT_MAX_K = MAXK;
    var on = recScore(c, rc);
    if (!off || !on) continue;
    ctx.OUT_PICKS = null;
    var best = argmin(c, rc, c.prep.options);

    tally.groups++;
    tally.gapOff += off.score - best.score;
    tally.gapOn += on.score - best.score;
    if (off.score <= best.score + 1e-6) tally.offPass++;
    if (on.score <= best.score + 1e-6) tally.onPass++;
    if (on.score > best.score + 1e-6) {
        /* What the sweep could not reach, and whether the way home is why. */
        tally.misses = (tally.misses || []);
        tally.misses.push((1000 + i * 37) + ' gap $' + (on.score - best.score).toFixed(0)
            + ' parties ' + c.ids.length + ' roundTrip ' + (rc ? 'yes' : 'no')
            + ' options ' + c.ids.map(function (id) { return c.prep.options[id].length; }).join('x'));
    }
    if (on.score < off.score - 1e-6) tally.better++;
    else if (on.score > off.score + 1e-6) {
        tally.worse++;
        if (on.score - off.score > tally.worstRegression) {
            tally.worstRegression = on.score - off.score;
            tally.worstSeed = 1000 + i * 37;
        }
    } else tally.same++;
}
console.log('-- generated groups, sweep off vs on (k<=' + MAXK + ') --');
console.log('  groups ' + tally.groups
    + '   argmin off ' + (100 * tally.offPass / tally.groups).toFixed(1) + '%'
    + '  on ' + (100 * tally.onPass / tally.groups).toFixed(1) + '%');
console.log('  improved ' + tally.better + '   WORSENED ' + tally.worse
    + '   unchanged ' + tally.same);
console.log('  mean gap to argmin  $' + (tally.gapOff / tally.groups).toFixed(2)
    + '  ->  $' + (tally.gapOn / tally.groups).toFixed(2));
(tally.misses || []).forEach(function (m) { console.log('  still missing: ' + m); });
if (tally.worse) console.log('  worst regression $' + tally.worstRegression.toFixed(2)
    + ' at seed ' + tally.worstSeed);

/* ------------------------------------------- 2. the real BZN subsets */
var LIVE = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures-live.json'), 'utf8')).scenarios.bzn;
var lt = { groups: 0, better: 0, worse: 0, same: 0, offPass: 0, onPass: 0 };
var misses = [];
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
    ctx.KOPT_MAX_K = 0;
    var loff = recScore(lc, null);
    ctx.KOPT_MAX_K = MAXK;
    var lon = recScore(lc, null);
    if (!loff || !lon) continue;
    ctx.OUT_PICKS = null;
    var lbest = argmin(lc, null, lc.prep.options);
    var tag = ps.map(function (p) { return p.id; }).join('');
    lt.groups++;
    if (loff.score <= lbest.score + 1e-6) lt.offPass++;
    if (lon.score <= lbest.score + 1e-6) lt.onPass++;
    else misses.push({ tag: tag, parties: bits, gap: lon.score - lbest.score,
        lands: lc.ids.map(function (id) { return FWF.fmtClock(lon.combo[id].clusterMin, true); }).join('/'),
        want: lc.ids.map(function (id) { return FWF.fmtClock(lbest.combo[id].clusterMin, true); }).join('/') });
    if (lon.score < loff.score - 1e-6) lt.better++;
    else if (lon.score > loff.score + 1e-6) lt.worse++;
    else lt.same++;
    if (tag === 'bfg') {
        console.log('\n-- the BZN b/f/g group --');
        console.log('  off : $' + loff.row.total + ' / ' + loff.row.worst + 'm apart / late $'
            + loff.row.late.toFixed(0) + '  lands '
            + lc.ids.map(function (id) { return FWF.fmtClock(loff.combo[id].clusterMin, true); }).join('/'));
        console.log('  on  : $' + lon.row.total + ' / ' + lon.row.worst + 'm apart / late $'
            + lon.row.late.toFixed(0) + '  lands '
            + lc.ids.map(function (id) { return FWF.fmtClock(lon.combo[id].clusterMin, true); }).join('/'));
        console.log('  argmin: $' + lbest.row.total + ' / ' + lbest.row.worst + 'm apart / late $'
            + lbest.row.late.toFixed(0) + '  lands '
            + lc.ids.map(function (id) { return FWF.fmtClock(lbest.combo[id].clusterMin, true); }).join('/'));
        console.log('  reached the argmin: ' + (lon.score <= lbest.score + 1e-6));
    }
}
console.log('\n-- real BZN subsets, sweep off vs on (k<=' + MAXK + ') --');
console.log('  groups ' + lt.groups + '   argmin off ' + (100 * lt.offPass / lt.groups).toFixed(1)
    + '%  on ' + (100 * lt.onPass / lt.groups).toFixed(1) + '%');
console.log('  improved ' + lt.better + '   WORSENED ' + lt.worse + '   unchanged ' + lt.same);
misses.forEach(function (m) {
    console.log('  miss ' + m.tag + ' (' + m.parties + ' parties) gap $' + m.gap.toFixed(0)
        + '  got ' + m.lands + '  want ' + m.want);
});

/* ------------------------------------------------------ 3. render cost
 * What a render pays for the chooser: the option sets prepared, the ladder
 * solved, the four profiles built and the recommendation chosen. Timed with
 * the per-pass memos cleared each iteration, because a render clears them. */
/* k = 8 means "the shipped rule, whatever it decides". Any lower k pins the
 * neighbourhood AND lifts the combination budget, so the column measures that
 * neighbourhood rather than what the budget would have allowed. */
function bench(g, k, reps) {
    load(g);
    ctx.KOPT_MAX_K = k;
    ctx.KOPT_PASS_BUDGET = k < 8 ? Infinity : 500000;
    ctx.KOPT_EXACT_BUDGET = k < 8 ? 0 : 20000;
    for (var w = 0; w < 30; w++) { freshPass(); ctx.compute('outbound'); ctx.matchOf(ctx.tripMatches()); }
    var t0 = process.hrtime.bigint();
    for (var r = 0; r < reps; r++) {
        freshPass();
        ctx.compute('outbound');
        ctx.matchOf(ctx.tripMatches());
    }
    var ms = Number(process.hrtime.bigint() - t0) / 1e6 / reps;
    ctx.KOPT_PASS_BUDGET = 500000; ctx.KOPT_EXACT_BUDGET = 20000;
    return ms;
}
console.log('\n-- render cost, ms per render (mean of 200) --');
[[3, 20], [3, 12], [8, 12], [8, 20]].forEach(function (shape) {
    var g = makeGroup(90210, shape[0], shape[1]);
    var line = '  ' + shape[0] + ' travellers x ' + shape[1] + ' options: ';
    var off = bench(g, 0, 200);
    line += 'off ' + off.toFixed(2);
    for (var k = 1; k <= 4; k++) line += '   k<=' + k + ' ' + bench(g, k, 200).toFixed(2);
    line += '   SHIPPED ' + bench(g, 8, 200).toFixed(2);
    console.log(line);
});

/* The real seven-party BZN search, which is the only live shape in the repo
 * and the one the owner will actually open. */
(function () {
    var g = { dest: LIVE.dest, dep: LIVE.dep, ret: '', parties: LIVE.parties,
              trip: { outbound: LIVE.trips.query.outbound } };
    /* What the sweep actually spent here, because the option counts after
     * the prunes are nothing like the raw ones and the budget reads the
     * pruned sets. */
    load(g);
    var pc = ctx.compute('outbound');
    ctx.KOPT_MAX_K = 8; ctx.KOPT_PASS_BUDGET = 500000; ctx.KOPT_EXACT_BUDGET = 20000;
    freshPass();
    ctx.koptTrace.leaves = 0; ctx.koptTrace.moves = 0;
    ctx.matchOf(ctx.tripMatches());
    console.log('  real BZN after the prunes: '
        + pc.ids.map(function (id) { return pc.prep.options[id].length; }).join('x')
        + ' = ' + pc.ids.reduce(function (n, id) { return n * pc.prep.options[id].length; }, 1)
        + ' combinations; the sweep scored ' + ctx.koptTrace.leaves
        + ' at k=' + ctx.koptTrace.k + ' and moved ' + ctx.koptTrace.moves + ' times');
    console.log('  real BZN, 7 parties x 8-14 options: off ' + bench(g, 0, 200).toFixed(2)
        + '   k<=2 ' + bench(g, 2, 200).toFixed(2)
        + '   k<=3 ' + bench(g, 3, 200).toFixed(2)
        + '   SHIPPED ' + bench(g, 8, 200).toFixed(2));
}());
/* The shapes the app actually sees, so the headline number is not a worst
 * case nobody meets: the generator's own groups, averaged. */
(function () {
    var gs = [];
    for (var i = 0; i < 120; i++) {
        var g = makeGroup(1000 + i * 37);
        load(g);
        var c = ctx.compute('outbound');
        if (c && c.prep && c.prep.complete) gs.push(g);
    }
    var line = '  generated mix (' + gs.length + ' groups): ';
    [0, 1, 2, 3, 8].forEach(function (k) {
        var t0 = process.hrtime.bigint();
        for (var rep = 0; rep < 8; rep++) {
            gs.forEach(function (g) { load(g); ctx.KOPT_MAX_K = k; freshPass();
                ctx.compute('outbound'); ctx.matchOf(ctx.tripMatches()); });
        }
        var ms = Number(process.hrtime.bigint() - t0) / 1e6 / (8 * gs.length);
        line += (k === 8 ? '   SHIPPED ' : k ? '   k<=' + k + ' ' : 'off ') + ms.toFixed(2);
    });
    console.log(line);
}());
ctx.KOPT_MAX_K = MAXK;
