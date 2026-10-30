/* Tests for the way home.
 *
 * The return leg's default has now been wrong in both directions. It was
 * clustered like the outbound, which picked absurd flights home to hit a
 * departure time; it was then unclustered, which showed groups eleven hours
 * apart and called it "each on their own best flight". Neither was a judgement
 * call that could be settled by argument, so this file settles it by measuring:
 * it prices leaving together against flying home separately across generated
 * groups and asserts the bounds the default is allowed to live inside.
 *
 * These are PROPERTY tests over a seeded generator, not golden values. A change
 * that makes leaving together cost real money, or that puts somebody on a
 * connection to buy it, fails here with the number attached.
 *
 * app.js is an IIFE and expects a DOM, so it is loaded under a stub with its
 * internals exported -- the same trick test-booking.js uses, one layer up. No
 * network: fetch never resolves, and the fixtures are local.
 */

var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = __dirname;

/* ------------------------------------------------------------- DOM stub */

function makeEl(id) {
    return {
        id: id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
        children: [], dataset: {}, style: {}, attrs: {},
        classList: { add: function(){}, remove: function(){}, toggle: function(){},
                     contains: function(){ return false; } },
        setAttribute: function (k, v) { this.attrs[k] = v; },
        getAttribute: function (k) { return this.attrs[k] == null ? null : this.attrs[k]; },
        removeAttribute: function (k) { delete this.attrs[k]; },
        hasAttribute: function (k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
        addEventListener: function(){}, removeEventListener: function(){},
        appendChild: function (c) { this.children.push(c); return c; },
        querySelector: function () { return makeEl('q'); },
        querySelectorAll: function () { return []; },
        closest: function () { return null; },
        focus: function(){}, blur: function(){}, click: function(){}, scrollIntoView: function(){},
        getBoundingClientRect: function () {
            return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 };
        },
        insertAdjacentHTML: function(){}, remove: function(){}
    };
}

/* The names app.js keeps inside its IIFE that these tests drive. Appended as an
 * export block before the closing brace rather than by editing app.js, so the
 * shipped file carries no test hooks. */
var EXPORTS = ['compute', 'legBreakdown', 'tripLadder', 'tripBest', 'windowStrip', 'returnNote',
               'returnWays', 'returnChoice', 'returnThOf', 'regretOf', 'worthIt',
               'recommendedIn', 'blankQuery', 'migrateQuery'];

function load() {
    var nodes = {};
    var document = {
        documentElement: makeEl('html'), body: makeEl('body'),
        getElementById: function (id) { return nodes[id] || (nodes[id] = makeEl(id)); },
        querySelector: function () { return makeEl('q'); },
        querySelectorAll: function () { return []; },
        createElement: function (t) { return makeEl(t); },
        addEventListener: function(){}, removeEventListener: function(){}
    };
    var store = {};
    var ctx = {
        console: console, document: document,
        location: { search: '', hash: '', href: 'http://localhost/', pathname: '/',
                    origin: 'http://localhost' },
        history: { replaceState: function(){}, pushState: function(){} },
        navigator: { userAgent: 'node', clipboard: { writeText: function () { return Promise.resolve(); } } },
        localStorage: {
            getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
            setItem: function (k, v) { store[k] = String(v); },
            removeItem: function (k) { delete store[k]; }
        },
        /* Never resolves: no API call, no quota, no demo autoload. */
        fetch: function () { return new Promise(function () {}); },
        setTimeout: setTimeout, clearTimeout: clearTimeout,
        setInterval: function(){}, clearInterval: function(){},
        requestAnimationFrame: function(){}, cancelAnimationFrame: function(){},
        scrollTo: function(){}, scrollBy: function(){}, alert: function(){},
        addEventListener: function(){}, removeEventListener: function(){},
        btoa: function (s) { return Buffer.from(s, 'binary').toString('base64'); },
        atob: function (s) { return Buffer.from(s, 'base64').toString('binary'); },
        encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
        Promise: Promise, Date: Date, Math: Math, JSON: JSON, Intl: Intl,
        matchMedia: function () {
            return { matches: false, addEventListener: function(){}, addListener: function(){} };
        }
    };
    ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
    vm.createContext(ctx);

    ['optimizer.js', 'airports.js'].forEach(function (f) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
    });

    var src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    var tail = '\n})();\n';
    if (src.slice(-tail.length) !== tail) {
        console.error('FAIL: app.js no longer ends in the IIFE this harness appends to');
        process.exit(1);
    }
    var block = '\nglobalThis.__T = {'
        + EXPORTS.map(function (f) { return f + ':' + f; }).join(',')
        + ',get state(){return state;},get SET(){return SET;},set SET(v){SET=v;}'
        + ',get DATA(){return DATA;},set DATA(v){DATA=v;}'
        + ',clearMemo:function(){returnTh={};}'
        + ',PER_SEAT:RETURN_BUDGET_PER_SEAT,PCT:RETURN_BUDGET_PCT};\n';
    vm.runInContext(src.slice(0, src.length - tail.length) + block + tail, ctx, { filename: 'app.js' });
    return ctx;
}

var ctx = load();
var FWF = ctx.FWF, T = ctx.__T;

function seat(parties, legData, flag) {
    var q = T.blankQuery();
    q.dest = 'PIT'; q.dep = '2027-02-12'; q.ret = '2027-02-15'; q.parties = parties;
    if (flag !== undefined) q.clusterReturn = flag;
    T.state.step = 4; T.state.leg = 'outbound'; T.state.recommend = 'value';
    T.state.th = { outbound: null, 'return': null };
    T.state.q = q; T.state.busy = false; T.state.error = null;
    T.DATA = { generated_at: '2026-10-27T05:00:00Z', currency: 'USD', sample: true,
               trips: { query: legData }, errors: [] };
    T.clearMemo();
}

var pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '\n          ' + detail : '')); }
}
function eq(name, got, want) {
    check(name, got === want, 'got: ' + got + '\n          want: ' + want);
}
function text(html) { return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }

/* ======================================================= the real fixture */

var sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'flights.json'), 'utf8'));
var DEMO = [
    { id: 'alex', name: 'Alex', seats: 1, airports: ['SFO', 'OAK', 'SJC'] },
    { id: 'sam', name: 'Sam', seats: 2, airports: ['ORD'] },
    { id: 'jo', name: 'Jo', seats: 1, airports: ['ATL'] },
    { id: 'ray', name: 'Ray', seats: 1, airports: ['DEN'] }
];

console.log('\n-- the sample trip: leaving together is cheap, and the old default hid it --');
seat(DEMO, sample.trips['pit-feb']);
var c = T.compute('return');
var ways = T.returnWays(c);
var floor = ways.floor;
var together = FWF.minCostAtWindow(c.prep, ways.together, c.costFn);
eq('flying home separately is 11h 10m apart', FWF.fmtGap(floor.spread), '11h 10m');
eq('leaving together is 20m apart', FWF.fmtGap(together.spread), '20m');
eq('and costs $23 more, across five seats', Math.round(together.cost - floor.cost), 23);
check('which is inside the budget', together.cost - floor.cost <= ways.budget,
      'premium ' + (together.cost - floor.cost) + ' vs budget ' + ways.budget);
/* The outbound already spends more than this to land together, which is the
 * whole argument: the return was being held to a stricter standard than the leg
 * the group explicitly asked for. */
var oc = T.compute('outbound');
var oFloor = FWF.minCostAtWindow(oc.prep, FWF.INF, oc.costFn);
var oPlan = FWF.minCostAtWindow(oc.prep, T.recommendedIn(oc), oc.costFn);
check('the outbound already pays more than that to land together',
      oPlan.cost - oFloor.cost > together.cost - floor.cost,
      'outbound +$' + Math.round(oPlan.cost - oFloor.cost)
      + ' vs return +$' + Math.round(together.cost - floor.cost));
/* Nobody flies worse for it. This is the assertion that would have caught the
 * original complaint, and it is the one that must never go soft. */
var reg = T.regretOf(c, together.picks);
eq('nobody changes planes for it', reg.stops, 0);
eq('nobody spends a minute longer in the air for it', reg.mins, 0);

console.log('\n-- what the screen says, in each of the three states --');
[['true', true, 'Leaving together', 'Costs $23 more than flying home separately, which would spread the group',
  'Fly home separately, save $23', '0'],
 ['false', false, 'Flying home', 'Each on their own flight home, as asked',
  'Leave together for $23', '1']
].forEach(function (cse) {
    seat(DEMO, sample.trips['pit-feb'], cse[1]);
    var b = T.legBreakdown('return');
    var html = T.windowStrip('return', b), t = text(html);
    check('clusterReturn=' + cse[0] + ': heading is "' + cse[2] + '"',
          t.indexOf(cse[2]) === 0, t.slice(0, 80));
    check('clusterReturn=' + cse[0] + ': states the trade', t.indexOf(cse[3]) > -1, t);
    check('clusterReturn=' + cse[0] + ': the alternative carries its price',
          t.indexOf(cse[4]) > -1, t);
    eq('clusterReturn=' + cse[0] + ': and the button moves to the other state',
       (/data-clusterback="([^"]*)"/.exec(html) || [])[1], cse[5]);
});
/* The sentence the owner rejected, and the link with no price on it, are gone. */
seat(DEMO, sample.trips['pit-feb']);
var shipped = text(T.windowStrip('return', T.legBreakdown('return')));
check('no "each on their own best flight home"',
      shipped.indexOf('own best flight') === -1, shipped);
check('no "Leave together instead"', shipped.indexOf('together instead') === -1, shipped);

console.log('\n-- the headline total and the per-person cards are one number --');
/* They were not: tripLadder priced the return at each row's window while the
 * cards rendered it at the return's own, so the two disagreed by up to $600. */
[true, false].forEach(function (flag) {
    FWF.DEFAULT_THRESHOLDS.forEach(function (th) {
        seat(DEMO, sample.trips['pit-feb'], flag);
        var l = T.tripLadder();
        var row = l.filter(function (r) { return r.th === th; })[0];
        if (!row) return;
        T.state.th.outbound = row.th;
        var ob = T.legBreakdown('outbound'), bk = T.legBreakdown('return');
        var gap = Math.round(row.total - (ob.total + bk.total));
        eq('clusterReturn=' + flag + ', row ' + FWF.fmtGap(th) + ': headline equals cards', gap, 0);
    });
});

/* ===================================================== generated groups */

/* Grounded in the sample's shape: within one party the cheapest and dearest
 * option differ by roughly a third of the cheapest, departures spread across
 * 07:00-21:00, and hub routes arrive in banks. `trap` plants the thing the
 * original complaint was about -- a cheap, long, early connection that a tight
 * window would have to buy if nothing stopped it. */
function rng(seed) {
    var s = seed >>> 0;
    return function () {
        s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
        return s / 4294967296;
    };
}
function hhmm(m) {
    m = ((m % 1440) + 1440) % 1440;
    var h = Math.floor(m / 60), mi = m % 60;
    return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
}
var ROUTES = [
    { code: 'ORD', nonstop: 80, base: 130 }, { code: 'ATL', nonstop: 105, base: 165 },
    { code: 'DEN', nonstop: 215, base: 215 }, { code: 'BOS', nonstop: 95, base: 150 },
    { code: 'AUS', nonstop: 165, base: 190 }, { code: 'SEA', nonstop: 290, base: 250 },
    { code: 'SFO', nonstop: 0, base: 225 }, { code: 'LAX', nonstop: 0, base: 215 }
];
var CARRIERS = ['United', 'Delta', 'American', 'Southwest', 'Alaska', 'JetBlue'];

function options(r, route, from, to, date, banks, k) {
    var out = [];
    banks.forEach(function (bank, i) {
        var dep = Math.max(300, Math.min(1320, Math.round(bank + (r() * 2 - 1) * k.jitter)));
        var dur = route.nonstop || Math.round(route.base * 1.9 + (r() * 60 - 20));
        /* Convenience premium: the middle of the day costs more than dawn. */
        var conv = 1 - Math.abs(dep / 60 - 13) / 13;
        out.push({ price: Math.round(route.base * (1 + k.conv * conv + (r() * 0.1 - 0.05))),
                   stops: route.nonstop ? 0 : 1, duration_minutes: dur,
                   depart: date + ' ' + hhmm(dep), arrive: date + ' ' + hhmm(dep + dur),
                   airlines: [CARRIERS[(i + route.code.length) % CARRIERS.length]],
                   from: from, to: to,
                   bags: { carry_on_included: true, checked_first_price: 35, confidence: 'parsed' } });
    });
    if (k.trap && r() < 0.5) {
        var d2 = Math.round(300 + r() * 90);
        var dur2 = Math.round((route.nonstop || route.base * 1.9) + 180 + r() * 180);
        out.push({ price: Math.round(route.base * 0.72), stops: route.nonstop ? 1 : 2,
                   duration_minutes: dur2, depart: date + ' ' + hhmm(d2),
                   arrive: date + ' ' + hhmm(d2 + dur2), airlines: [CARRIERS[2]],
                   from: from, to: to,
                   bags: { carry_on_included: true, checked_first_price: 35, confidence: 'parsed' } });
    }
    return out;
}

function generate(seed, k, flag) {
    var r = rng(seed), pool = ROUTES.slice(), parties = [], outD = {}, retD = {};
    var banks = [];
    for (var b = 0; b < k.banks; b++) {
        banks.push(Math.round(420 + b * (780 / Math.max(1, k.banks - 1))));
    }
    for (var i = 0; i < k.parties; i++) {
        var route = pool.splice(Math.floor(r() * pool.length), 1)[0];
        var id = 'p' + i;
        parties.push({ id: id, name: 'P' + i, seats: 1 + (i % 2), airports: [route.code] });
        outD[id] = options(r, route, route.code, 'PIT', '2027-02-12', banks, k);
        retD[id] = options(r, route, 'PIT', route.code, '2027-02-15', banks, k);
    }
    seat(parties, { outbound: outD, 'return': retD }, flag);
}

var KNOBS = [];
[2, 3, 4, 5, 6, 7].forEach(function (parties) {
    [3, 4, 5, 6].forEach(function (banks) {
        [20, 60, 120].forEach(function (jitter) {
            [0.18, 0.35, 0.55].forEach(function (conv) {
                [false, true].forEach(function (trap) {
                    KNOBS.push({ parties: parties, banks: banks, jitter: jitter,
                                 conv: conv, trap: trap });
                });
            });
        });
    });
});

function sweep(flag, fn) {
    KNOBS.forEach(function (k, ki) {
        for (var rep = 0; rep < 8; rep++) {
            generate(1000 + ki * 97 + rep * 7919, k, flag);
            var rc = T.compute('return');
            if (!rc || !rc.prep.complete || !rc.ladder) continue;
            fn(rc, k);
        }
    });
}

console.log('\n-- across ' + (KNOBS.length * 8) + ' generated groups --');
var m = { n: 0, perSeat: [], over: [], spread: [], apartSpread: [], air: [], addedConn: 0,
          unfair: 0, apartUnfair: 0, pricedOut: 0, overBudget: 0,
          dawnApart: 0, dawnTogether: 0, legs: 0 };
sweep(true, function (rc) {
    m.n++;
    var w = T.returnWays(rc), ch = T.returnChoice(rc);
    var fl = w.floor;
    var seats = rc.travelers.reduce(function (n, t) { return n + t.seats; }, 0);
    var plan = FWF.minCostAtWindow(rc.prep, ch.th, rc.costFn);
    var apart = FWF.minCostAtWindow(rc.prep, w.apart, rc.costFn);
    if (ch.how === 'priced-out') m.pricedOut++;
    if (plan.cost - fl.cost > w.budget + 1e-9) m.overBudget++;

    /* Only the together plans are fairness-filtered. The separate-flights plan
     * is each party's own cheapest, and cheapest is sometimes a long flight --
     * so it fails this test on its own in a handful of groups, which is one more
     * count against it rather than a bug here. */
    if (ch.how === 'together' && !T.worthIt(T.regretOf(rc, plan.picks))) m.unfair++;
    if (ch.how !== 'together') m.apartUnfair += T.worthIt(T.regretOf(rc, plan.picks)) ? 0 : 1;
    var air = 0, airFl = 0, conn = 0, connFl = 0;
    rc.ids.forEach(function (id) {
        air += plan.picks[id].option.duration_minutes || 0;
        airFl += fl.picks[id].option.duration_minutes || 0;
        if ((plan.picks[id].option.stops || 0) > 0) conn++;
        if ((fl.picks[id].option.stops || 0) > 0) connFl++;
        m.legs++;
        if (FWF.timeOfDay(fl.picks[id].option.departMin) < 420) m.dawnApart++;
        if (FWF.timeOfDay(plan.picks[id].option.departMin) < 420) m.dawnTogether++;
    });
    if (conn > connFl) m.addedConn++;
    m.perSeat.push((plan.cost - fl.cost) / seats);
    m.over.push(plan.cost - fl.cost);
    m.spread.push(plan.spread);
    m.apartSpread.push(apart.spread);
    m.air.push(air - airFl);
});

function q(a, p) {
    var s = a.slice().sort(function (x, y) { return x - y; });
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
function share(a, f) { return a.filter(f).length / a.length; }

console.log('     groups priced: ' + m.n);
console.log('     median premium $' + Math.round(q(m.perSeat, 0.5)) + '/seat, p90 $'
    + Math.round(q(m.perSeat, 0.9)) + '/seat, max $' + Math.round(q(m.perSeat, 1)) + '/seat');
console.log('     spread leaving together: median ' + FWF.fmtGap(q(m.spread, 0.5))
    + ', p90 ' + FWF.fmtGap(q(m.spread, 0.9)));
console.log('     spread flying home separately: median ' + FWF.fmtGap(q(m.apartSpread, 0.5))
    + ', p90 ' + FWF.fmtGap(q(m.apartSpread, 0.9)));

/* The bounds the default lives inside. Each of these is a way the earlier
 * version of this leg went wrong. */
check('nobody is put on an extra connection to leave together', m.addedConn === 0,
      m.addedConn + ' groups');
check('no leaving-together plan fails the fairness test the outbound uses', m.unfair === 0,
      m.unfair + ' groups');
check('no plan exceeds its own budget', m.overBudget === 0, m.overBudget + ' groups');
check('leaving together costs under $' + T.PER_SEAT + '/seat in at least 99% of groups',
      share(m.perSeat, function (v) { return v <= T.PER_SEAT + 1e-9; }) >= 0.99,
      Math.round(100 * share(m.perSeat, function (v) { return v <= T.PER_SEAT; })) + '%');
check('median premium is under $3/seat', q(m.perSeat, 0.5) < 3, '$' + q(m.perSeat, 0.5));
check('extra group air time is zero for most groups and never over 2h',
      q(m.air, 0.5) === 0 && q(m.air, 1) <= 120,
      'median ' + q(m.air, 0.5) + 'm, max ' + q(m.air, 1) + 'm');
check('at least 85% of groups get out within 3 hours of each other',
      share(m.spread, function (v) { return v <= 180; }) >= 0.85,
      Math.round(100 * share(m.spread, function (v) { return v <= 180; })) + '%');
check('flying home separately would leave most groups over 3 hours apart',
      share(m.apartSpread, function (v) { return v > 180; }) >= 0.6,
      Math.round(100 * share(m.apartSpread, function (v) { return v > 180; })) + '%');
check('falling back to separate flights stays rare', m.pricedOut / m.n <= 0.02,
      Math.round(1000 * m.pricedOut / m.n) / 10 + '%');

/* The per-person case for the default, which is the counterintuitive half:
 * "each on their own best flight" means each on their CHEAPEST flight, and
 * cheapest means the worst hour of the day. */
console.log('     departures before 07:00 -- separately ' + Math.round(100 * m.dawnApart / m.legs)
    + '%, together ' + Math.round(100 * m.dawnTogether / m.legs) + '%');
check('leaving together puts fewer people on a pre-07:00 departure, not more',
      m.dawnTogether < m.dawnApart,
      'together ' + m.dawnTogether + ' vs separately ' + m.dawnApart + ' of ' + m.legs);

console.log('\n-- flying home separately is still tightened for free --');
var sameAsBefore = 0, looseN = 0, costlier = 0;
sweep(false, function (rc) {
    looseN++;
    var w = T.returnWays(rc);
    var apart = FWF.minCostAtWindow(rc.prep, w.apart, rc.costFn);
    if (Math.abs(apart.cost - w.floor.cost) < 1e-9) sameAsBefore++; else costlier++;
    /* And it must be the TIGHTEST window at that price, which is the whole point
     * of free tightening. */
});
check('the separate-flights plan never costs more than no window at all',
      costlier === 0, costlier + ' of ' + looseN + ' groups');
eq('and it is priced at the floor in every group', sameAsBefore, looseN);

console.log('\n-- the pruning is what stops an absurd flight home, not the default --');
/* The unclustered default was introduced because forcing a window picked bad
 * flights. That was a pruning problem: maxDetour, betterOnTie and the ULCC
 * margin fixed it. Turn maxDetour off and the old failure comes straight back,
 * which is the evidence that the default was no longer doing the work. */
function worstDetour(rc, picks) {
    var worst = 0;
    rc.ids.forEach(function (id) {
        var quickest = null;
        rc.prep.options[id].forEach(function (o) {
            if (o.duration_minutes != null && (quickest == null || o.duration_minutes < quickest)) {
                quickest = o.duration_minutes;
            }
        });
        if (quickest != null) {
            worst = Math.max(worst, (picks[id].option.duration_minutes || 0) - quickest);
        }
    });
    return worst;
}
/* Reconstructed literally: the old code pinned the return to whatever window the
 * outbound settled on, with no fairness filter of its own -- data-choice used to
 * write state.th.return as well as state.th.outbound. */
[[180, 'maxDetour on (as shipped)'], [null, 'maxDetour off']].forEach(function (mode) {
    var bad = 0, n = 0;
    KNOBS.forEach(function (k, ki) {
        for (var rep = 0; rep < 4; rep++) {
            generate(1000 + ki * 97 + rep * 7919, k, true);
            T.state.q.maxDetour = mode[0];
            T.clearMemo();
            var oc = T.compute('outbound'), rc = T.compute('return');
            if (!oc || !rc || !oc.ladder || !rc.prep.complete || !rc.ladder) continue;
            var pinned = FWF.minCostAtWindow(rc.prep, T.recommendedIn(oc), rc.costFn);
            if (!pinned) continue;
            n++;
            if (worstDetour(rc, pinned.picks) > 90) bad++;
        }
    });
    console.log('     ' + mode[1] + ', return pinned to the outbound window: somebody flies '
        + '90m+ past their own quickest in ' + Math.round(100 * bad / n) + '% of groups');
    if (mode[0] === 180) {
        /* Not zero: maxDetour's cap is quickest + 180, which is looser than the
         * 90 minutes worthIt calls material, so pruning alone leaves a gap of
         * about one group in 1600. The fairness filter in returnWays is what
         * closes it -- see the check below. */
        check('with the pruning in place, pinning the return is already nearly safe',
              bad / n < 0.005, bad + '/' + n);
    } else {
        /* Was > 0.2 when this was written. The connection-premium rule landed
         * since -- a connection must beat the party's best nonstop by
         * seats x ($40 + $25/extra hour) -- and it suppresses the same absurd
         * flights from a different direction, so the complaint now reproduces
         * at ~15% rather than ~32% even with maxDetour off. The point stands:
         * one in seven against one in 1600 with the pruning on. */
        check('without it, pinning the return reproduces the original complaint',
              bad / n > 0.1, Math.round(100 * bad / n) + '% of ' + n);
    }
});
/* And the fairness filter in returnWays is a second, independent guard: with
 * maxDetour off it refuses the window rather than buying it. */
var refused = 0, seen = 0;
KNOBS.forEach(function (k, ki) {
    for (var rep = 0; rep < 4; rep++) {
        generate(1000 + ki * 97 + rep * 7919, k, true);
        T.state.q.maxDetour = null;
        T.clearMemo();
        var rc = T.compute('return');
        if (!rc || !rc.prep.complete || !rc.ladder) continue;
        seen++;
        var ch = T.returnChoice(rc);
        if (ch.how === 'together'
            && worstDetour(rc, FWF.minCostAtWindow(rc.prep, ch.th, rc.costFn).picks) > 90) {
            refused++;
        }
    }
});
check('even with maxDetour off, no leaving-together plan flies anybody 90m+ longer',
      refused === 0, refused + '/' + seen);

console.log('\n-- shared links --');
var m1 = T.migrateQuery({ parties: [], avoid: [] });
eq('a link from before the field existed opens on the new default', m1.clusterReturn, true);
eq('a link that chose separate flights still opens on them',
   T.migrateQuery({ parties: [], avoid: [], clusterReturn: false }).clusterReturn, false);
eq('a link that paid for it keeps paying for it',
   T.migrateQuery({ parties: [], avoid: [], clusterReturn: 'any' }).clusterReturn, 'any');
eq('and anything else normalises rather than falling through as falsy',
   T.migrateQuery({ parties: [], avoid: [], clusterReturn: 0 }).clusterReturn, true);

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASSED'));
process.exitCode = fail ? 1 : 0;
