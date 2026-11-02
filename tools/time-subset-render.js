#!/usr/bin/env node
/* What subsetBalancedTh costs a render.
 *
 * It adds up to twelve solveAt calls, and solveAt on an incomplete group is a
 * bestSubset sweep over every distinct arrival time -- so the honest place to
 * read the cost is a group that is actually INCOMPLETE. A complete group is
 * timed too, and it is the control: the new code is behind
 * `!ctx.prep.complete`, so if that number moves at all something is wrong.
 *
 * Times the whole per-pass computation a render does -- compute the legs,
 * build every match, pick one, sum the trip. The DOM string building after it
 * is untouched by any of this.
 *
 * Run: node tools/time-subset-render.js
 *      APP_JS=/tmp/base-app.js node tools/time-subset-render.js   (baseline)
 */
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var src = fs.readFileSync(process.env.APP_JS || path.join(ROOT, 'app.js'), 'utf8');
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
    if (g.avoid) ctx.state.q.avoid = g.avoid.slice();
    ctx.state.th = { outbound: null, 'return': null };
    ctx.state.leg = 'outbound'; ctx.state.match = null;
    ctx.DATA = { currency: 'USD', sample: true, trips: { query: g.trip }, errors: [] };
    ctx.returnTh = {}; ctx.COHERENT_MEMO = {}; ctx.OUT_PICKS = null;
    ctx.MATCHES = null; ctx.PICKED_PLAN = null;
    ctx.C = ctx.compute('outbound');
}
function renderPass() {
    ctx.returnTh = {}; ctx.COHERENT_MEMO = {}; ctx.OUT_PICKS = null;
    ctx.MATCHES = null; ctx.PICKED_PLAN = null;
    ctx.C = ctx.compute();
    var ms = ctx.tripMatches();
    var sel = ctx.matchOf(ms);
    ctx.PICKED_PLAN = sel ? sel.plan : null;
    if (sel) { ctx.state.match = sel.key; if (sel.th != null) ctx.thBoth(sel.th); }
    ctx.TRIP = ctx.tripTotal();
    return sel;
}

var LIVE = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures-live.json'), 'utf8')).scenarios.bzn;

function bump(stamp, mins) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(stamp);
    if (!m) return stamp;
    var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) + mins * 60000;
    var d = new Date(t), p = function (v) { return v < 10 ? '0' + v : '' + v; };
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate())
        + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}
/* The captured BZN sets run 3 to 8 options a party; a live search on a busy
 * route returns far more, and every solve is linear in the option count. So
 * the cost is read at a realistic ceiling rather than at the one fixture in
 * hand: each clone takes a new hour and a new price, which is the shape of a
 * real day's departures rather than duplicates the prunes would fold away. */
function inflate(list, mult, seed) {
    /* Deep, not slice(): a shallow copy shares option objects with the
     * fixture, so stranding one party by rewriting its carrier silently
     * strands every other party built from the same captured list. */
    var out = list.map(function (o) { return JSON.parse(JSON.stringify(o)); }), s = seed;
    var rnd = function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    for (var k = 1; k < mult; k++) {
        for (var i = 0; i < list.length; i++) {
            var c = JSON.parse(JSON.stringify(list[i]));
            var shift = Math.floor(rnd() * 600) - 300;
            c.depart = bump(c.depart, shift);
            c.arrive = bump(c.arrive, shift);
            c.price = Math.max(40, Math.round(c.price * (0.75 + rnd() * 0.6)));
            out.push(c);
        }
    }
    return out;
}

/* strand: put one party on a carrier the group refuses, which empties their
 * list and nobody else's. The same instrument section 3 of the enumerator
 * uses, so the thing being timed is the thing being measured. */
function build(n, mult, strand, withReturn) {
    var ps = [], trip = { outbound: {} }, back = withReturn ? {} : null;
    for (var i = 0; i < n; i++) {
        var srcP = LIVE.parties[i % LIVE.parties.length];
        var id = 'q' + i;
        var p = JSON.parse(JSON.stringify(srcP));
        p.id = id;
        ps.push(p);
        trip.outbound[id] = inflate(LIVE.trips.query.outbound[srcP.id], mult || 1, 7 + i * 31);
        if (back) {
            /* The same captured legs with the airports swapped, so the way
             * home is exercised at a realistic size. The return-aware scoring
             * is the expensive half of this change, so the round trip is the
             * number that matters. */
            back[id] = inflate(LIVE.trips.query.outbound[srcP.id], mult || 1, 99 + i * 13)
                .map(function (o) {
                    var c = JSON.parse(JSON.stringify(o));
                    var f = c.from; c.from = c.to; c.to = f;
                    return c;
                });
        }
    }
    if (back) trip['return'] = back;
    var g = { dest: LIVE.dest, dep: LIVE.dep, ret: withReturn ? LIVE.dep : '',
              parties: ps, trip: trip };
    if (strand) {
        trip.outbound[ps[ps.length - 1].id].forEach(function (o) { o.airlines = ['Zephyr']; });
        g.avoid = ['zephyr'];
    }
    return g;
}

function timeIt(n, mult, strand, reps, withReturn) {
    var g = build(n, mult, strand, withReturn);
    load(g);
    var c = ctx.compute('outbound');
    var complete = c.prep.complete;
    if (strand === !!complete) {
        console.error('FAIL: wanted complete=' + !strand + ', got ' + complete);
        process.exit(1);
    }
    var opts = c.ids.map(function (id) { return (c.prep.options[id] || []).length; });
    renderPass(); renderPass();
    var t0 = process.hrtime.bigint();
    for (var i = 0; i < reps; i++) { load(g); renderPass(); }
    var ms = Number(process.hrtime.bigint() - t0) / 1e6 / reps;
    console.log('  ' + n + ' travelers, ' + (withReturn ? 'round trip, ' : 'one way, ')
        + (strand ? 'one stranded (subset path)' : 'all seatable (control)')
        + '  options ' + opts.join('/') + '  ->  ' + ms.toFixed(2) + ' ms');
    return ms;
}

console.log('one render pass, median of ' + (process.argv[2] || 200) + ' reps');
var REPS = +(process.argv[2] || 200);
timeIt(3, 1, false, REPS);
timeIt(3, 1, true, REPS);
timeIt(8, 1, false, REPS);
timeIt(8, 1, true, REPS);
console.log('  -- round trip, where the return-aware scoring costs most --');
timeIt(3, 1, false, REPS, true);
timeIt(3, 1, true, REPS, true);
timeIt(8, 1, false, REPS, true);
timeIt(8, 1, true, REPS, true);
console.log('  -- inflated to ~5x the captured option count --');
timeIt(8, 5, false, Math.max(40, REPS / 4));
timeIt(8, 5, true, Math.max(40, REPS / 4));
timeIt(8, 5, true, Math.max(40, REPS / 4), true);
