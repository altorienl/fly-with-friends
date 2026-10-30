/* Tests for the named match profiles.
 *
 * The thing that can silently go wrong here is not a crash. It is a profile
 * that carries a confident name and returns somebody else's plan, or returns a
 * plan that is worse than the one next to it in every way the card reports. You
 * cannot see either of those in the UI -- both render perfectly. So this suite
 * does two jobs:
 *
 *   1. ASSERT the definitional invariants. "Closest" must be the tightest of
 *      the profiles on offer and "Cheapest" the cheapest, every time, or the
 *      names are lying. "Balanced" must still be exactly the single
 *      recommendation the app made before profiles existed, or this change
 *      quietly re-decided every trip already shared by link.
 *
 *   2. COUNT distinctness over generated groups. Five hand-built fixtures can
 *      show a profile working; only a few hundred can show it is its own answer
 *      often enough to deserve a button.
 *
 * Run `node test-matches.js --show` to print each fixture group's profiles side
 * by side with the per-party flights, which is the form you want when deciding
 * whether a profile is answering the question its name asks.
 *
 * No network. app.js is sliced into a vm with no fetch defined at all, so a
 * profile that reached for the provider would throw rather than spend a search.
 */

var fs = require('fs'), vm = require('vm');
var src = fs.readFileSync(__dirname + '/app.js', 'utf8');
var FWF = require(__dirname + '/optimizer.js');
var F = require(__dirname + '/fixtures.js');

/* app.js expects a DOM. Slice out the regions that hold the maths and run them
 * bare, the way test-booking.js and test-airlines.js already do. */
function cut(a, b, label) {
    var i = src.indexOf(a), j = src.indexOf(b);
    if (i < 0 || j < 0 || j < i) {
        console.error('FAIL: could not locate ' + label + ' in app.js');
        process.exit(1);
    }
    return src.slice(i, j);
}
var REGIONS = [
    ['query+compute', cut('function newParty(i)',
        '/* -------------------------------------------------------- autocomplete */', 'compute')],
    ['airlines', cut('/* ------------------------------------------------------------ airlines',
        'function airlineSite(o)', 'airlines')],
    /* One contiguous slice: the return pipeline, legBreakdown, regret, the
     * ladder and every named-match function through renderChoices. They are
     * adjacent in app.js on purpose and cutting between them would leave the
     * profiles referring to a half-built way home. */
    ['home+ladder+profiles', cut('/* ------------------------------------------------------- the way home',
        'function tripTotal() {', 'profiles')],
    ['planOf', cut('function seatsOf(ids) {',
        '/* ------------------------------------------------------------ airlines', 'planOf')]
];

/* The fake results host, so renderChoices can be asserted on without a DOM. */
var HOST = { innerHTML: '', className: '' };

/* The sliced region registers a keydown listener at module level, for the
 * arrow keys inside the radiogroup. Enough document to let it attach; nothing
 * in this suite dispatches events. */
var DOC = {
    addEventListener: function () {},
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; }
};

var ctx = {
    FWF: FWF, console: console, document: DOC,
    APP: { bagFee: 35, carryOnFee: 30, target: 30, maxParties: 8, maxSeats: 9 },
    COLORS: ['#986306', '#177984', '#3c6bc7', '#994cbb', '#bb482c', '#be4066', '#147d45', '#61760a'],
    DATA: null, SET: null, C: null, TRIP: null,
    state: { step: 4, leg: 'outbound', recommend: 'value', match: null,
             th: { outbound: null, 'return': null }, q: null },
    /* render() sets this immediately before tripTotal(); legBreakdown reads it.
     * There is no render() here, so the tests set it themselves where they are
     * asserting on what a selected match actually renders. */
    PICKED_PLAN: null
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

var pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '\n          ' + detail : '')); }
}

function load(g) {
    ctx.SET = { meId: null, theme: 'dark', target: 30, priceDisplay: 'allin',
                time24: false, bags: { carry_on: 1, checked: 0 } };
    ctx.state.q = ctx.blankQuery();
    ctx.state.q.dest = g.dest; ctx.state.q.dep = g.dep; ctx.state.q.ret = g.ret;
    ctx.state.q.parties = JSON.parse(JSON.stringify(g.parties));
    ctx.state.th = { outbound: null, 'return': null };
    ctx.state.profile = 'balanced';
    ctx.state.leg = 'outbound';
    ctx.DATA = { currency: 'USD', sample: true, trips: { query: g.trip }, errors: [] };
    ctx.C = ctx.compute('outbound');
    /* render() clears both of these every pass. MATCHES is null-when-empty
     * here, not undefined: tripMatches() caches an array and tests the cache
     * for truthiness. */
    ctx.MATCHES = null;
    ctx.returnTh = {};
    ctx.PICKED_PLAN = null;
}

var IDS = ['balanced', 'cheapest', 'closest', 'easiest'];
function by(m, id) { return m.filter(function (e) { return e.id === id; })[0]; }
function liveOf(m) {
    return m.filter(function (e) { return e.feasible && !e.dupeOf && !e.dominatedBy; });
}

/* -------------------------------------------------- the named fixtures */

console.log('\n-- the five fixture groups --');
F.groups.forEach(function (g) {
    load(g);
    var m = ctx.matchProfiles();
    check(g.name.slice(0, 48) + ': profiles build', !!m);
    if (!m) return;
    var live = liveOf(m);
    check('  at least one distinct match', live.length >= 1, live.length + ' live');
    /* Every profile must hand every party exactly one flight on every leg, or
     * the per-person cards silently drop somebody from a "total". */
    var whole = true;
    m.forEach(function (e) {
        if (!e.feasible) return;
        m.legs.forEach(function (leg) {
            var p = e.plans[leg];
            if (!p) { whole = false; return; }
            if (Object.keys(p.picks).length !== m.ctxs[leg].ids.length) whole = false;
            m.ctxs[leg].ids.forEach(function (id) {
                if (!p.picks[id] || !p.picks[id].option) whole = false;
            });
        });
    });
    check('  every profile seats every party on every leg', whole);
});

/* ----------------------------------------- cost is money, not a score */

console.log('\n-- picks[id].cost is real money on every profile --');
/* The whole reason a shadow cost exists is that about twenty display sites read
 * picks[id].cost as dollars. If a penalty ever leaks into that number, the
 * group total stops matching what anybody pays and nothing on screen says so. */
(function () {
    var bad = [], checked = 0;
    F.groups.concat([F.makeGroup(7919), F.makeGroup(15838), F.makeGroup(23757)])
        .forEach(function (g) {
            load(g);
            var m = ctx.matchProfiles();
            if (!m) return;
            m.forEach(function (e) {
                if (!e.feasible) return;
                m.legs.forEach(function (leg) {
                    var lctx = m.ctxs[leg], p = e.plans[leg];
                    lctx.ids.forEach(function (id) {
                        checked++;
                        var want = lctx.costFn(p.picks[id].option, id);
                        if (p.picks[id].cost !== want) {
                            bad.push(e.id + '/' + leg + '/' + id + ': ' + p.picks[id].cost + ' != ' + want);
                        }
                    });
                });
                /* And the plan total must be the sum of those, to the cent. */
                m.legs.forEach(function (leg) {
                    var p = e.plans[leg];
                    var sum = Object.keys(p.picks).reduce(function (n, id) {
                        return n + p.picks[id].cost;
                    }, 0);
                    if (Math.abs(sum - p.cost) > 1e-9) bad.push(e.id + '/' + leg + ': total != sum of picks');
                });
            });
        });
    check('every pick is priced by costFn, not by the shadow cost (' + checked + ' picks)',
          bad.length === 0, bad.slice(0, 4).join('\n          '));
}());

/* ------------------------------------- the invariants the names promise */

console.log('\n-- the invariants the names promise, over generated groups --');
(function () {
    var N = 0, args = process.argv.slice(2);
    args.forEach(function (a) { if (/^\d+$/.test(a)) N = +a; });
    N = N || 300;

    var live = {}, dupe = {}, dom = {}, infeas = {};
    IDS.forEach(function (k) { live[k] = dupe[k] = dom[k] = infeas[k] = 0; });
    var runs = 0, noProfiles = 0, counts = {};
    var tightFail = [], cheapFail = [], balancedFail = [], shapeFail = [];
    var connFixed = 0, easeCost = [];

    for (var s = 1; s <= N; s++) {
        var g = F.makeGroup(s * 7919);
        load(g);
        var m = ctx.matchProfiles();
        if (!m) { noProfiles++; continue; }
        runs++;

        m.forEach(function (e) {
            if (!e.feasible) { infeas[e.id]++; return; }
            if (e.dupeOf) { dupe[e.id]++; return; }
            if (e.dominatedBy) { dom[e.id]++; return; }
            live[e.id]++;
        });
        var n = liveOf(m).length;
        counts[n] = (counts[n] || 0) + 1;

        var feas = m.filter(function (e) { return e.feasible; });
        var cl = by(m, 'closest'), ch = by(m, 'cheapest'), ea = by(m, 'easiest'),
            ba = by(m, 'balanced');

        /* "Closest landing" that is not the closest is a lie with a label. */
        if (cl && cl.feasible && !feas.every(function (e) { return cl.worst <= e.worst; })) {
            tightFail.push(s);
        }
        /* Same for "Cheapest". */
        if (ch && ch.feasible && !feas.every(function (e) { return ch.total <= e.total; })) {
            cheapFail.push(s);
        }
        /* Spread must be consistent with the flights actually handed out. */
        feas.forEach(function (e) {
            m.legs.forEach(function (leg) {
                var p = e.plans[leg];
                var t = m.ctxs[leg].ids.map(function (id) { return p.picks[id].option.clusterMin; });
                var got = Math.max.apply(null, t) - Math.min.apply(null, t);
                if (got !== p.spread) shapeFail.push(s + '/' + e.id + '/' + leg);
            });
        });

        /* Balanced must reproduce the pre-profile recommendation exactly. */
        var tl = ctx.tripLadder(), tb = tl && ctx.tripBest(tl);
        if (tb && ba && ba.feasible) {
            var same = true;
            m.legs.forEach(function (leg) {
                var lctx = m.ctxs[leg];
                var ref = FWF.minCostAtWindow(lctx.prep, tb.th, lctx.costFn);
                if (!ref) { same = false; return; }
                lctx.ids.forEach(function (id) {
                    if (ref.picks[id].option !== ba.plans[leg].picks[id].option) same = false;
                });
            });
            if (!same) balancedFail.push(s);
        }

        if (ea && ba && ea.feasible && ba.feasible) {
            if (ea.conn.length < ba.conn.length) connFixed++;
            easeCost.push(ea.total - ba.total);
        }
    }

    check('closest is the tightest profile on offer, every group',
          tightFail.length === 0, 'failed on seeds ' + tightFail.slice(0, 6).join(','));
    check('cheapest is the cheapest profile on offer, every group',
          cheapFail.length === 0, 'failed on seeds ' + cheapFail.slice(0, 6).join(','));
    check('every profile\'s reported spread matches its own flights',
          shapeFail.length === 0, shapeFail.slice(0, 4).join(', '));
    check('balanced still IS the pre-profile recommendation, every group',
          balancedFail.length === 0, 'failed on seeds ' + balancedFail.slice(0, 6).join(','));

    /* Distinctness. A profile is allowed to collapse -- "the cheapest is also
     * the balanced pick" is a useful thing to be told -- but a profile that
     * collapses nearly always is a filter wearing a name. */
    function rate(k) { return runs ? live[k] / runs : 0; }
    check('closest is its own answer in most groups',
          rate('closest') > 0.8, Math.round(100 * rate('closest')) + '%');
    /* 0.8 while profiles scored both legs: with two legs a plan signature spans
     * twice as many picks, so two profiles agreed far less often and nearly
     * every one looked distinct. Profiles now decide the outbound only -- the
     * return's window comes from returnThOf() and a profile's return plan was
     * being discarded before anything rendered it -- which is a fairer and
     * harder test of whether "Easiest flights" is its own answer. Measured at
     * 63% over 300 groups, and it removes a connection balanced imposed in 34%
     * of them for a median of $0. A third of groups getting somebody off a
     * connection for nothing is worth a button; the card is hidden in the rest. */
    check('easiest is its own answer in most groups',
          rate('easiest') > 0.55, Math.round(100 * rate('easiest')) + '%');
    check('cheapest is its own answer often enough to offer',
          rate('cheapest') > 0.25, Math.round(100 * rate('cheapest')) + '%');
    check('no group is left with nothing to show', (counts[0] || 0) === 0);

    console.log('');
    console.log('  over ' + runs + ' generated groups (' + noProfiles + ' fell through to the subset screen):');
    IDS.forEach(function (k) {
        console.log('    ' + k.padEnd(9)
            + 'distinct ' + String(Math.round(100 * live[k] / runs) + '%').padStart(4)
            + '   same plan as another ' + String(Math.round(100 * dupe[k] / runs) + '%').padStart(4)
            + '   dominated ' + String(Math.round(100 * dom[k] / runs) + '%').padStart(4));
    });
    console.log('    cards shown: '
        + Object.keys(counts).sort().map(function (k) {
            return k + '×' + Math.round(100 * counts[k] / runs) + '%';
        }).join('  '));
    easeCost.sort(function (a, b) { return a - b; });
    console.log('    easiest removes a connection balanced imposed in '
        + Math.round(100 * connFixed / runs) + '% of groups, median +$'
        + Math.round(easeCost[Math.floor(easeCost.length / 2)] || 0));
}());

/* ------------------------- narrowing the search must not empty the list */

console.log('\n-- the chooser survives a narrowed landing band --');
(function () {
    /* "if i adjust the search it doesnt show the updated cheapest balanced and
     * closest landing info" -- it showed nothing at all. minCostAtWindow returns
     * null unless EVERY party has an option in the window, the profiles were
     * built on it alone, so the moment a band left anybody out matchProfiles
     * returned null and renderChoices hid the strip. The plan below still
     * rendered, from the subset: a trip with no way to ask for a different one,
     * which is the exact state the chooser was built to end. */
    var BANDS = [['Morning', '05:00', '12:00'], ['Afternoon', '12:00', '18:00'],
                 ['Evening', '18:00', '23:00'], ['Not late night', '06:00', '23:00']];
    BANDS.forEach(function (bd) {
        var empty = 0, runs = 0, subsetRuns = 0, unnamed = [];
        for (var s2 = 1; s2 <= 200; s2++) {
            load(F.makeGroup(s2 * 7919));
            ctx.state.q.band.outbound = { from: bd[1], to: bd[2] };
            ctx.MATCHES = null; ctx.returnTh = {};
            var c = ctx.compute('outbound');
            /* A band nobody at all can make is a search with no answer, not a
             * chooser with no rows -- that case is out of scope here. */
            if (!c || !ctx.reachOf(c)) continue;
            runs++;
            var ms = ctx.tripMatches();
            if (!ms.length) { empty++; continue; }
            if (!c.prep.complete) {
                subsetRuns++;
                /* Every row that leaves somebody behind has to say so, or the
                 * cheapest row is a different trip at a better price. */
                ms.forEach(function (r) {
                    if (r.seated < r.reach
                        && ctx.matchWhy(r, ms).indexOf(r.seated + ' of ' + r.reach) !== 0) {
                        unnamed.push(s2 + '/' + r.key);
                    }
                });
            }
        }
        check(bd[0] + ': every group with a seatable plan still offers one',
              empty === 0, empty + ' of ' + runs + ' groups had an empty chooser');
        check(bd[0] + ': and a row that leaves somebody behind says so',
              unnamed.length === 0,
              unnamed.slice(0, 4).join(', ') + ' (' + subsetRuns + ' subset groups)');
    });

    /* The guarantee that makes the rest of it safe: a plan that drops somebody
     * must never hide one that brings them. Dominance compares headcount first
     * and as a veto, not as one axis among four -- otherwise the cheapest plan
     * on a narrowed band is routinely the one that quietly leaves a person out,
     * and it would hide every plan that does not. */
    var hidden = [];
    for (var s3 = 1; s3 <= 200; s3++) {
        load(F.makeGroup(s3 * 7919));
        ctx.state.q.band.outbound = { from: '12:00', to: '18:00' };
        ctx.MATCHES = null; ctx.returnTh = {};
        var m = ctx.matchProfiles();
        if (!m) continue;
        m.forEach(function (e) {
            if (!e.feasible || !e.dominatedBy) return;
            var by = m.filter(function (x) { return x.id === e.dominatedBy; })[0];
            if (by && by.seated < e.seated) hidden.push(s3 + ': ' + e.id + ' hidden by ' + by.id);
        });
    }
    check('no plan is ever hidden by one that seats fewer people',
          hidden.length === 0, hidden.slice(0, 4).join(', '));

    /* And "Closest landing" must still mean closest. ctx.tight is null when the
     * group cannot be fully covered, and the old code read it unguarded -- the
     * fallback would have been INF, the loosest window there is. */
    var wrong = [];
    for (var s4 = 1; s4 <= 200; s4++) {
        load(F.makeGroup(s4 * 7919));
        ctx.state.q.band.outbound = { from: '12:00', to: '18:00' };
        ctx.MATCHES = null; ctx.returnTh = {};
        var m2 = ctx.matchProfiles();
        if (!m2) continue;
        var cl = by(m2, 'closest');
        if (!cl || !cl.feasible) continue;
        var feas = m2.filter(function (e) { return e.feasible && e.seated >= cl.seated; });
        if (!feas.every(function (e) { return cl.worst <= e.worst; })) wrong.push(s4);
    }
    check('closest is still the tightest of the plans that seat as many',
          wrong.length === 0, 'seeds ' + wrong.slice(0, 6).join(','));
}());

/* --------------------------------------- the quoted total is current */

console.log('\n-- the cards re-price when the trip changes --');
(function () {
    /* "fly home seperately is interesting bc if you hit it you cant see the new
     * price reflected anywhere" -- the cards quoted the trip with the old way
     * home. MATCHES was cleared nowhere: computed once on load and served from
     * the memo for the rest of the session, so every filter on the screen had
     * the same bug. It renders perfectly and the numbers are simply stale,
     * which is the only failure mode of this feature nobody can see. */
    load(F.groups[1]);
    ctx.state.q.clusterReturn = true;
    var together = ctx.tripMatches().map(function (m) { return m.key + ':' + m.total; });
    /* Exactly what render() does every pass. */
    ctx.MATCHES = null; ctx.returnTh = {};
    ctx.state.q.clusterReturn = false;
    var apart = ctx.tripMatches().map(function (m) { return m.key + ':' + m.total; });
    check('flying home separately changes every quoted total',
          together.join() !== apart.join(),
          'together ' + together.join(' ') + '\n          apart     ' + apart.join(' '));
    check('and it changes them downward, by the saving the button promises',
          apart.every(function (x, i) {
              return +x.split(':')[1] <= +together[i].split(':')[1];
          }), apart.join(' '));

    /* The memo exists because tripMatches() is called more than once per pass.
     * Asserted against the source because render() needs a DOM this suite does
     * not build -- and the bug was exactly a missing line in render(), so a
     * test that cannot see render() is a test that would have passed. */
    var r = src.slice(src.indexOf('function render() {'), src.indexOf('function renderGear('));
    check('render() clears the match memo every pass', /MATCHES = null;/.test(r));
    check('...alongside the other per-pass memos it is grouped with',
          /returnTh = \{\};[\s\S]{0,800}?MATCHES = null;[\s\S]{0,80}?C = compute\(\);/.test(r));
}());

/* --------------------------- no row may read as strictly worse than another */

console.log('\n-- no row reads as strictly worse than the one next to it --');
(function () {
    /* A caption showing nothing better than another row's, at a price no lower,
     * gives a reader no reason to tap it and every reason to distrust a screen
     * that offered it. It happened on 40% of multi-row screens: "13h 59m apart
     * $4,377" sitting above "10h 2m apart $4,303". Four out of five of those
     * rows genuinely were better -- at time in the air, which the caption had
     * no reason to print. The fifth was worse at everything and survived only
     * on worstBurden, the one dominance axis that appears nowhere on screen. */
    var unexplained = [], runs = 0, beaten = 0;
    [['', ''], ['05:00', '12:00'], ['12:00', '18:00'], ['18:00', '23:00']].forEach(function (bd) {
        for (var s2 = 1; s2 <= 200; s2++) {
            load(F.makeGroup(s2 * 7919));
            ctx.state.q.band.outbound = { from: bd[0], to: bd[1] };
            ctx.MATCHES = null; ctx.returnTh = {};
            var c = ctx.compute('outbound');
            if (!c || !ctx.reachOf(c)) continue;
            var ms = ctx.tripMatches();
            if (ms.length < 2) continue;
            runs++;
            ms.forEach(function (m) {
                var by = null;
                ms.forEach(function (o) {
                    if (o === m || by) return;
                    if (o.total <= m.total && o.seated >= m.seated && o.spread <= m.spread
                        && (o.conn || []).length <= (m.conn || []).length
                        && (o.total < m.total || o.spread < m.spread)) by = o;
                });
                if (!by) return;
                beaten++;
                /* Beaten is allowed; beaten and silent about why is not. */
                if (m.mins < by.mins && ctx.matchWhy(m, ms).indexOf('in the air') > -1) return;
                /* Balanced is exempt from dominance on purpose -- it is the
                 * default, the baseline the others are described against, and
                 * the row the selection falls back to. It is also the
                 * RECOMMENDED row, so nobody is being asked to justify tapping
                 * it against a rival. One such row in 548 screens. */
                if (m.key === 'balanced') return;
                unexplained.push(bd.join('-') + '/' + s2 + ': ' + m.key + ' "'
                    + ctx.matchWhy(m, ms) + '" vs ' + by.key + ' "' + ctx.matchWhy(by, ms) + '"');
            });
        }
    });
    check('every beaten row states the thing it is better at ('
          + beaten + ' beaten rows across ' + runs + ' screens)',
          unexplained.length === 0, unexplained.slice(0, 4).join('\n          '));

    /* The rule behind it: dominance may only compare what a card can print. */
    var r = src.slice(src.indexOf('var cmp = ['), src.indexOf('var cmp = [') + 60);
    check('dominance does not compare on worstBurden, which is never shown',
          r.indexOf('worstBurden') === -1, r);
}());

/* ------------------------------------- no two rows may read the same */

console.log('\n-- every row on a screen says something different --');
(function () {
    var clash = [], runs = 0;
    for (var s2 = 1; s2 <= 300; s2++) {
        load(F.makeGroup(s2 * 7919));
        var ms = ctx.tripMatches();
        if (!ms || ms.length < 2) continue;
        runs++;
        var seen = {};
        ms.forEach(function (m) {
            var w = ctx.matchWhy(m, ms);
            if (seen[w]) {
                clash.push(s2 + ': "' + w + '" on both ' + seen[w] + ' ('
                    + ctx.money(ms.filter(function (x) { return x.key === seen[w]; })[0].total)
                    + ') and ' + m.key + ' (' + ctx.money(m.total) + ')');
            }
            seen[w] = m.key;
        });
    }
    /* Two rows at different prices under one sentence is an unexplained
     * surcharge, and the reason somebody closes the tab. */
    check('no two rows on the same screen carry the same caption ('
          + runs + ' screens)', clash.length === 0, clash.slice(0, 4).join('\n          '));
    /* And no caption may be empty -- a nameless row with a price is worse. */
    var blank = 0;
    for (var s3 = 1; s3 <= 120; s3++) {
        load(F.makeGroup(s3 * 7919));
        var m2 = ctx.tripMatches();
        if (m2) m2.forEach(function (m) { if (!ctx.matchWhy(m, m2)) blank++; });
    }
    check('every row has something to say for itself', blank === 0, blank + ' blank');
}());

/* ------------------------------------------------- degenerate groups */

console.log('\n-- degenerate groups --');
(function () {
    var one = F.groups.filter(function (g) { return g.parties.length === 1; })[0];
    load(one);
    var m = ctx.matchProfiles();
    check('one party: flagged trivial', !!m && m.trivial === true);
    check('one party: closeness profiles collapse into the default',
          !!m && !!by(m, 'closest').dupeOf && !!by(m, 'cheapest').dupeOf,
          m ? 'closest->' + by(m, 'closest').dupeOf + ' cheapest->' + by(m, 'cheapest').dupeOf : '');
    /* And that is the whole answer for one party: there is no window to
     * coordinate, their cheapest flight here is also their shortest and their
     * only nonstop, so all four profiles are the same ticket. The chooser
     * renders that as "The trip -- one plan covers it" rather than four buttons
     * that do the same thing. Asserted, because four identical cards is exactly
     * what a profile layer produces when nobody checks. */
    check('one party: the profiles collapse to one plan',
          !!m && liveOf(m).length === 1, m ? liveOf(m).map(function (e) { return e.id; }).join(',') : '');

    var two = F.groups.filter(function (g) { return g.parties.length === 2; })[0];
    load(two);
    var m2 = ctx.matchProfiles();
    check('two parties: not flagged trivial', !!m2 && m2.trivial === false);
    check('two parties: more than one distinct match', !!m2 && liveOf(m2).length >= 2,
          m2 ? liveOf(m2).map(function (e) { return e.id; }).join(',') : '');

    /* Somebody with no option at all used to make the profiles stand aside, on
     * the grounds that the subset screen owned the case. It does own the PLAN
     * -- and it rendered one, with the chooser hidden above it, so the reader
     * had a trip and no way to ask for a cheaper or a closer one. Profiles now
     * answer over whoever can be seated, which is the same question about the
     * same plan, and every row states the shortfall. */
    var g3 = JSON.parse(JSON.stringify(F.groups[0]));
    g3.trip.outbound[g3.parties[1].id] = [];
    load(g3);
    var m3 = ctx.matchProfiles();
    check('a party with no flights at all still gets matches, over the subset',
          !!m3 && liveOf(m3).length >= 1,
          m3 ? liveOf(m3).map(function (e) { return e.id; }).join(',') : 'null');
    check('...and none of them seats the party with no flights',
          !!m3 && liveOf(m3).every(function (e) {
              return !e.plans.outbound.picks[g3.parties[1].id];
          }));
    var rows3 = ctx.tripMatches();
    check('...and every row says so rather than quoting a total for everybody',
          rows3.length > 0 && rows3.every(function (r) {
              return ctx.matchWhy(r, rows3).indexOf(r.seated + ' of ' + r.reach) === 0;
          }), rows3.map(function (r) { return r.key + ': "' + ctx.matchWhy(r, rows3) + '"'; }).join(' | '));
    /* ...and the plan still renders, from the subset. */
    check('planOf still returns the subset plan in that case',
          !!ctx.planOf(ctx.compute('outbound'), 'subset'));

    /* Nobody seatable at all is still a search with no answer. */
    var g4 = JSON.parse(JSON.stringify(F.groups[0]));
    g4.parties.forEach(function (pt) { g4.trip.outbound[pt.id] = []; });
    load(g4);
    check('nobody seatable at all yields no profiles', ctx.matchProfiles() === null);
}());

/* ------------------------------------------------------- the strip DOM */

console.log('\n-- the choice strip renders the profiles --');
(function () {
    load(F.groups[1]);
    ctx.renderChoices();
    var html = HOST.innerHTML;
    var ms = ctx.tripMatches();
    var sel = ctx.matchOf(ms);
    check('strip is visible', HOST.className === 'choices');
    check('one row per distinct match',
          (html.match(/class="mrow/g) || []).length === ms.length,
          (html.match(/class="mrow/g) || []).length + ' rows, ' + ms.length + ' matches');
    check('more than one match to choose between', ms.length > 1,
          ms.map(function (m) { return m.key; }).join(','));
    ms.forEach(function (m) {
        check('  offers ' + m.key, html.indexOf('data-match="' + m.key + '"') > -1);
        check('  quotes ' + m.key + ' at ' + ctx.money(m.total),
              html.indexOf(ctx.money(m.total)) > -1);
    });
    check('exactly one row is selected',
          (html.match(/aria-checked="true"/g) || []).length === 1);
    check('the selected row is the one matchOf picked',
          html.indexOf('data-match="' + sel.key + '" role="radio" aria-checked="true"') > -1);

    /* Display order is cheapest-first. A column of prices that does not run in
     * order is the reason three prices cannot be compared at a glance. */
    var order = (html.match(/data-match="([a-z]+)"/g) || []).map(function (x) {
        return x.slice(12, -1);
    });
    var totals = order.map(function (k) {
        return ms.filter(function (m) { return m.key === k; })[0].total;
    });
    check('rows run cheapest-first', totals.every(function (t, i) {
        return i === 0 || totals[i - 1] <= t;
    }), totals.join(' '));

    /* Exactly one row carries the recommendation, and it survived the cut. */
    check('one row is the recommendation',
          ms.filter(function (m) { return m.rec; }).length === 1);

    /* ---- the thing the whole feature exists for ---- */

    /* Every row's quoted total must be the sum of the per-person costs the plan
     * underneath it prints. This failed in exactly the way that is invisible:
     * the card was priced on a return leg legBreakdown discards, so "Cheapest"
     * said $1,740 and 11h 10m apart above a plan that summed to $1,763 and
     * landed the group 5h 50m apart. Four numbers, none of them agreeing. */
    var mismatch = [];
    ms.forEach(function (m) {
        ctx.PICKED_PLAN = m.plan;
        ctx.state.match = m.key;
        if (m.th != null) ctx.thBoth(m.th);
        var out = ctx.legBreakdown('outbound');
        var back = ctx.hasReturn() ? ctx.legBreakdown('return') : null;
        var sum = out.total + (back ? back.total : 0);
        if (Math.abs(sum - m.total) > 0.5) {
            mismatch.push(m.key + ': card ' + ctx.money(m.total) + ' vs plan ' + ctx.money(sum));
        }
        if (out.spread !== m.spread) {
            mismatch.push(m.key + ': card ' + FWF.fmtGap(m.spread)
                + ' apart vs plan ' + FWF.fmtGap(out.spread));
        }
    });
    ctx.PICKED_PLAN = null;
    check('every card\'s price and spread are the plan it opens',
          mismatch.length === 0, mismatch.join('\n          '));

    /* One row says nothing unless there is something to flag. It used to say
     * "One plan covers it -- cheapest, closest and least flying are the same
     * flights", and narrowing the landing band makes one row the common case
     * (26% on Afternoon, 67% on Evening) rather than the rare one. */
    load(F.groups[4]);
    var one = ctx.tripMatches();
    ctx.renderChoices();
    check('a single row carries no explanation of itself',
          one.length === 1 && HOST.innerHTML.indexOf('One plan covers it') === -1
          && HOST.innerHTML.indexOf('m-s') === -1,
          HOST.innerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());

    /* ...but a single row that leaves somebody behind still has to say so. */
    var g5 = JSON.parse(JSON.stringify(F.groups[0]));
    g5.trip.outbound[g5.parties[1].id] = [];
    load(g5);
    var sub = ctx.tripMatches();
    ctx.renderChoices();
    var short1 = sub.filter(function (r) { return r.seated < r.reach; })[0];
    check('a row that leaves somebody behind prints the shortfall',
          !!short1 && HOST.innerHTML.indexOf(short1.seated + ' of ' + short1.reach) > -1,
          HOST.innerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());

    /* And selecting one must move the flights, not just the caption. */
    load(F.groups[1]);
    load(F.groups[1]);
    var all = ctx.tripMatches();
    var arrivalsOf = function (m) {
        ctx.PICKED_PLAN = m.plan;
        var b = ctx.legBreakdown('outbound');
        return b.ctx.ids.map(function (id) {
            return b.rows[id].option.arrive + '@' + b.rows[id].cost;
        }).join(' ');
    };
    var seen = {}, distinct = 0;
    all.forEach(function (m) {
        var k = arrivalsOf(m);
        if (!seen[k]) { seen[k] = 1; distinct++; }
    });
    ctx.PICKED_PLAN = null;
    check('selecting a match changes the flights, not only the caption',
          distinct === all.length, distinct + ' distinct plans across ' + all.length + ' matches');
}());

/* ----------------------------------------------------------- the table */

if (process.argv.indexOf('--show') > -1) {
    F.groups.forEach(function (g) {
        load(g);
        var m = ctx.matchProfiles();
        console.log('\n================================================================');
        console.log(g.name);
        if (!m) { console.log('  no profiles'); return; }
        console.log('  tightest the group can land: '
            + (ctx.C.tight ? FWF.fmtGap(ctx.C.tight.spread) : 'n/a')
            + '   lowest fares on the page (our two rules lifted): '
            + (m.rawFloor == null ? 'n/a' : ctx.money(m.rawFloor)));
        console.log('');
        console.log('  ' + ['match', 'total', 'apart', 'in air', 'conns', 'most/pp',
                            'worst burden', ''].join('\t'));
        m.forEach(function (e) {
            if (!e.feasible) { console.log('  ' + e.id + '\tinfeasible'); return; }
            console.log('  ' + [e.id, ctx.money(e.total), FWF.fmtGap(e.worst),
                FWF.fmtGap(e.mins), e.conn.length, ctx.money(e.topPer),
                ctx.money(e.worstBurden) + (e.worstBurdenWho ? ' (' + e.worstBurdenWho + ')' : ''),
                e.dupeOf ? 'same plan as ' + e.dupeOf
                    : e.dominatedBy ? 'worse than ' + e.dominatedBy + ' in every way' : ''
            ].join('\t'));
        });
        console.log('');
        liveOf(m).forEach(function (e) {
            console.log('  -- ' + e.label + ': ' + e.asks);
            m.legs.forEach(function (leg) {
                var p = e.plans[leg], lctx = m.ctxs[leg];
                console.log('     ' + leg + '  window '
                    + (e.th[leg] === Infinity ? 'open' : e.th[leg] + 'm')
                    + '  spread ' + FWF.fmtGap(p.spread) + '  ' + ctx.money(p.cost));
                lctx.ids.forEach(function (id) {
                    var o = p.picks[id].option;
                    console.log('       ' + id.padEnd(7) + o.from + '>' + o.to
                        + '  ' + (leg === 'outbound' ? 'lands ' : 'leaves ')
                        + FWF.fmtClock(leg === 'outbound' ? o.arriveMin : o.departMin, true)
                        + '  ' + (o.stops === 0 ? 'nonstop' : o.stops + ' stop')
                        + '  ' + FWF.fmtGap(o.duration_minutes)
                        + '  ' + ctx.money(p.picks[id].cost)
                        + '  ' + (o.airlines || []).join('/'));
                });
            });
        });
    });
}

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail)
                         : 'ALL ' + pass + ' CHECKS PASSED'));
process.exitCode = fail ? 1 : 0;
