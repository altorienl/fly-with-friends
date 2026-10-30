/* Tests for how the pruning rules in compute() INTERACT.
 *
 * optimizer.js is exact and brute-force verified, but every answer it gives is
 * computed over option sets compute() has already filtered. The filters were
 * each added against a separate complaint; these checks pin what they do in
 * combination, on hand-built option sets where the right answer is obvious.
 *
 * compute() is sliced out of the app.js IIFE with vm, the same way
 * test-booking.js and test-airlines.js do it.
 */

var fs = require('fs'), vm = require('vm');
var src = fs.readFileSync(__dirname + '/app.js', 'utf8');
var FWF = require(__dirname + '/optimizer.js');

function slice(a, b, what) {
    var i = src.indexOf(a), j = src.indexOf(b);
    if (i < 0 || j < 0 || j <= i) {
        console.error('FAIL: could not locate ' + what);
        process.exit(1);
    }
    return src.slice(i, j);
}

var ctx = {
    FWF: FWF, console: console,
    APP: { bagFee: 35, carryOnFee: 30, target: 30, maxParties: 8, maxSeats: 9 },
    COLORS: ['#986306', '#177984', '#3c6bc7', '#994cbb', '#bb482c', '#be4066', '#147d45', '#61760a'],
    DATA: null,
    /* The app's own defaults(), so the fixture costs are the ones the screen
     * shows -- a carry-on matters here, it is most of what the margin rule is
     * correcting for. */
    SET: { meId: null, theme: 'dark', target: 30, priceDisplay: 'allin',
           time24: true, bags: { carry_on: 1, checked: 0 } },
    state: { leg: 'outbound', q: null }
};
vm.createContext(ctx);
vm.runInContext([
    slice('function newParty(i) {',
          '/* ------------------------------------------------------------- compute */', 'query model'),
    slice('/* ------------------------------------------------------------- compute */',
          '/* -------------------------------------------------------- autocomplete */', 'compute'),
    'function party(pid) { return state.q.parties.filter(function (p) { return p.id === pid; })[0] || null; }',
    slice('/* ------------------------------------------------------------ airlines',
          'var ALLIANCE_OF = {};', 'airlines'),
    slice('function regretOf(ctx, picks) {',
          '/* Whether a plan is worth offering', 'regretOf'),
    'function worthIt(r) { return r.stops <= 0 && r.mins <= 90; }'
].join('\n'), ctx);

/* ------------------------------------------------------------- fixtures */

var DAY = '2027-02-12 ';
/* opt('09:00', 120, 0, 300, ['Delta']) -- lands 09:00, 2h, nonstop, $300. */
function opt(land, mins, stops, price, airlines, id) {
    var endM = FWF.parseTimeOfDay(land);
    var startM = endM - mins;
    function hhmm(m) {
        var d = ((m % 1440) + 1440) % 1440;
        var h = Math.floor(d / 60), mi = d % 60;
        return (h < 10 ? '0' + h : h) + ':' + (mi < 10 ? '0' + mi : mi);
    }
    return {
        id: id || (airlines[0] + '-' + land),
        depart: DAY + hhmm(startM), arrive: DAY + hhmm(endM),
        duration_minutes: mins, stops: stops, price: price,
        airlines: airlines.slice(),
        bags: { confidence: 'parsed', checked_first_price: 0, carry_on_included: true }
    };
}

function run(q, legData) {
    var parties = Object.keys(legData).map(function (id, i) {
        return { id: id, name: id.toUpperCase(), seats: (q.seats || {})[id] || 1, airports: ['XXX'],
                 rules: (q.rules || {})[id] };
    });
    ctx.state.q = {
        dest: 'PIT', dep: '2027-02-12', ret: '',
        band: { outbound: q.band || { from: '', to: '' }, return: { from: '', to: '' } },
        maxStops: q.maxStops === undefined ? null : q.maxStops,
        maxPremium: q.maxPremium === undefined ? null : q.maxPremium,
        avoid: (q.avoid || []).map(ctx.normAirline),
        clusterReturn: false,
        maxDetour: q.maxDetour === undefined ? 180 : q.maxDetour,
        parties: parties
    };
    ctx.state.leg = 'outbound';
    ctx.DATA = { trips: { query: { outbound: legData } } };
    return ctx.compute('outbound');
}

function kept(C, id) {
    return (C.prep.options[id] || []).map(function (o) { return o.id; });
}

var pass = 0, fail = 0, soft = 0;
function check(name, cond, note) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (note ? '\n        ' + note : '')); }
}
function eq(name, got, want) {
    var g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + '\n        got  ' + g + '\n        want ' + w); }
}
/* A documented current-behaviour wart. Reported, not failed, so the suite stays
 * green while the finding stays visible. */
function known(name, cond, why) {
    soft++;
    console.log((cond ? '  KNOWN ' : '  fixed ') + name + '\n        ' + why);
}

/* ======================================================================
 * 1. A relaxable group preference is applied BEFORE a hard filter, so a
 *    party that could have been relaxed is blocked outright instead.
 * ====================================================================== */
console.log('\n-- maxStops (soft) runs before avoid (hard) --');
{
    /* Group says nonstop. P has a nonstop on an avoided carrier and a one-stop
     * on a fine one. maxStops is a GROUP preference, so the documented contract
     * is "relax it for that party rather than drop them". The right answer is
     * the Delta one-stop with a relaxed note. */
    var C = run({ maxStops: 0, avoid: ['United'] }, {
        a: [opt('09:00', 120, 0, 300, ['Delta'], 'a-ns')],
        p: [opt('09:10', 180, 0, 320, ['United'], 'p-united-ns'),
            opt('09:20', 300, 1, 330, ['Delta'], 'p-delta-1stop')]
    });
    check('P is not left with an empty option set', kept(C, 'p').length > 0,
          'kept(p) = ' + JSON.stringify(kept(C, 'p'))
          + '; blocked = ' + JSON.stringify(C.blocked.map(function (b) { return b.id + ':' + b.rule; })));
    check('the group plan is still feasible', C.prep.complete,
          'prep.missing = ' + JSON.stringify(C.prep.missing)
          + ', subset = ' + (C.subset ? C.subset.included.join('+') : 'null'));
    check('P is reported as relaxed, not blocked',
          C.relaxed.indexOf('p') > -1 && C.blocked.length === 0,
          'relaxed = ' + JSON.stringify(C.relaxed)
          + ', blocked = ' + JSON.stringify(C.blocked.map(function (b) { return b.id + ':' + b.rule; })));
}

/* ======================================================================
 * 2. The budget-carrier margin deletes the only option that let the group
 *    land together, and the screen then blames a filter the option passed.
 * ====================================================================== */
console.log('\n-- budget margin vs landing together --');
{
    /* P can land 18:05 on Spirit ($250) or 09:00 on Delta ($300). Everyone else
     * lands at 18:00. The margin rule wants Spirit to beat Delta by
     * max($40, 18% of 300 = $54), i.e. cost <= $246. At $250 it is dropped --
     * and with it the only flight that put P in the same window as the group. */
    var C = run({}, {
        a: [opt('18:00', 120, 0, 300, ['Delta'], 'a-1800')],
        b: [opt('18:10', 120, 0, 300, ['Delta'], 'b-1810')],
        p: [opt('09:00', 120, 0, 300, ['Delta'], 'p-delta-0900'),
            opt('18:05', 130, 0, 250, ['Spirit'], 'p-spirit-1805')]
    });
    var tight = C.tight ? C.tight.spread : null;
    check('the group can still land inside the 30-minute target', tight != null && tight <= 30,
          'tightest window is ' + tight + ' min; kept(p) = ' + JSON.stringify(kept(C, 'p'))
          + ' -- the $250 Spirit option that landed at 18:05 was pruned for being only $50 under'
          + ' a $300 mainline fare, which is more than the $40/seat floor but under the 18% test.');
}

console.log('\n-- budget margin + band: party blamed for a filter it passes --');
{
    /* Same shape, but the group has asked to land between 16:00 and 20:00.
     * P's only in-band flight is the Spirit one. The margin rule removes it
     * before prepare() ever sees the band, so P lands in prep.missing and the
     * notice says "P can't meet your filters. They have flights, just none that
     * land between 16:00-20:00" -- which is false. */
    var C = run({ band: { from: '16:00', to: '20:00' } }, {
        a: [opt('18:00', 120, 0, 300, ['Delta'], 'a-1800')],
        b: [opt('18:10', 120, 0, 300, ['Delta'], 'b-1810')],
        p: [opt('09:00', 120, 0, 300, ['Delta'], 'p-delta-0900'),
            opt('18:05', 130, 0, 250, ['Spirit'], 'p-spirit-1805')]
    });
    check('P still has an in-band option', kept(C, 'p').length > 0,
          'kept(p) = ' + JSON.stringify(kept(C, 'p')) + ', prep.missing = ' + JSON.stringify(C.prep.missing));
    check('the plan does not fall back to a subset', C.prep.complete && !C.subset,
          'subset = ' + (C.subset ? C.subset.included.join('+') + ' (excluding '
              + C.subset.excluded.map(function (x) { return x.id; }).join(',') + ')' : 'null'));
    /* The misattribution itself: nothing in blocked/relaxed/detoured records the
     * margin rule, so the only explanation the screen can reach for is the band. */
    check('a party emptied by pruning is recorded somewhere compute() exposes',
          C.prep.missing.every(function (id) {
              return C.blocked.some(function (b) { return b.id === id; });
          }),
          'prep.missing = ' + JSON.stringify(C.prep.missing)
          + ' but blocked = ' + JSON.stringify(C.blocked)
          + ' and detoured = ' + JSON.stringify(C.detoured)
          + ' -- renderNotices() will attribute this to the band.');
}

/* ======================================================================
 * 3. maxDetour's baseline is the surviving set, so a hard filter that
 *    removes the quickest flight silently widens the detour cap.
 * ====================================================================== */
console.log('\n-- maxDetour baseline moves with the earlier filters --');
{
    /* P: a 2h nonstop on an avoided carrier, a 5h one-stop, and a 9h20 two-stop.
     * Against the real quickest way to do this route (120 min) the 560-min
     * itinerary is a 7h20 detour and has no business being offered. */
    var legData = {
        a: [opt('09:00', 120, 0, 300, ['Delta'], 'a-ns')],
        p: [opt('08:00', 120, 0, 300, ['United'], 'p-united-2h'),
            opt('13:00', 400, 1, 280, ['Delta'], 'p-delta-6h40'),
            opt('18:00', 560, 2, 260, ['Delta'], 'p-delta-9h20')]
    };
    var open = run({}, legData);
    eq('with no avoid, only the 2h nonstop is within 3h of the quickest',
       kept(open, 'p'), ['p-united-2h']);
    var avoided = run({ avoid: ['United'] }, legData);
    known('avoiding the quickest carrier widens the detour cap',
          kept(avoided, 'p').indexOf('p-delta-9h20') > -1,
          'kept(p) = ' + JSON.stringify(kept(avoided, 'p'))
          + '. Dropping the 2h United flight moved the detour baseline from 120 to 400 min, so'
          + ' the cap became 580 and the 560-min itinerary passed. Defensible -- the 2h flight'
          + ' genuinely is not available to P -- and not fixable by widening the baseline,'
          + ' because `if (sane.length)` then turns the whole rule off instead. Left as is;'
          + ' regretOf still scores the 9h20 at +160 min so worthIt() keeps it out of a'
          + ' recommendation unless every ladder row is already unfair.');
}

/* ======================================================================
 * 3b. maxDetour runs before the band, so it can delete the only in-band
 *     option while keeping an out-of-band one -- and the detour cap exists
 *     to stop absurd itineraries, not to break up the group.
 * ====================================================================== */
console.log('\n-- maxDetour + band --');
{
    /* The group asked to land between 16:00 and 20:00. P's quickest flight is a
     * 2h nonstop that lands 09:00; their only evening flight is a 6h40 one-stop.
     * The detour cap is measured against 120 min, so 400 min is a detour and
     * goes -- leaving P with nothing in the band. The flight the cap kept is the
     * one the band forbids. */
    var C = run({ band: { from: '16:00', to: '20:00' } }, {
        a: [opt('18:00', 120, 0, 300, ['Delta'], 'a-1800')],
        b: [opt('18:10', 120, 0, 300, ['Delta'], 'b-1810')],
        p: [opt('09:00', 120, 0, 300, ['Delta'], 'p-0900-2h'),
            opt('18:10', 400, 1, 300, ['Delta'], 'p-1810-6h40')]
    });
    eq('the in-band option survives the detour cap', kept(C, 'p'), ['p-1810-6h40']);
    check('the group is not pushed into a subset by the detour cap', C.prep.complete,
          'prep.missing = ' + JSON.stringify(C.prep.missing)
          + ', subset = ' + (C.subset ? C.subset.included.join('+') : 'null')
          + '. With maxDetour off the whole group lands inside 10 minutes: '
          + (function () {
                var L = run({ band: { from: '16:00', to: '20:00' }, maxDetour: null }, {
                    a: [opt('18:00', 120, 0, 300, ['Delta'], 'a-1800')],
                    b: [opt('18:10', 120, 0, 300, ['Delta'], 'b-1810')],
                    p: [opt('09:00', 120, 0, 300, ['Delta'], 'p-0900-2h'),
                        opt('18:10', 400, 1, 300, ['Delta'], 'p-1810-6h40')]
                });
                return L.tight ? L.tight.spread + ' min, everyone in' : 'still broken';
            })());
    eq('and nothing was actually dropped, so nothing is reported', C.detoured, []);
}

/* ======================================================================
 * 3c. maxDetour can never empty a party on its own -- the baseline IS a
 *     surviving option -- so the `if (sane.length)` guard is unreachable.
 *     Pinned because it is the reason 3b surfaces only with a band.
 * ====================================================================== */
console.log('\n-- maxDetour always keeps the quickest --');
{
    var C = run({ maxDetour: 0 }, {
        a: [opt('09:00', 120, 0, 300, ['Delta'], 'a-ns')],
        p: [opt('08:00', 120, 0, 300, ['Delta'], 'p-2h'),
            opt('13:00', 400, 1, 280, ['Delta'], 'p-6h40')]
    });
    eq('a zero-minute detour cap leaves the quickest standing', kept(C, 'p'), ['p-2h']);
}

/* ======================================================================
 * 3d. `detoured` is collected and never read.
 * ====================================================================== */
console.log('\n-- what the screen is told about each rule --');
{
    var afterCompute = src.slice(src.indexOf('/* -------------------------------------------------------- autocomplete */'));
    known('`detoured` is collected and never read', !/detoured/.test(afterCompute),
          'compute() declares, fills and exports `detoured`; nothing in the rest of app.js ever'
          + ' mentions it. With pruneSoftly() in place the detour cap can no longer break a'
          + ' plan, so this is now a disclosure gap rather than a wrong answer: a party can'
          + ' still lose their preferred flight to it with nothing on screen about it. The'
          + ' `relaxed` note two lines below in winBlock() is the pattern to copy.');
    var ft = src.slice(src.indexOf('function filterText'), src.indexOf('function renderResHead'));
    known('filterText() cannot name the margin or the detour cap',
          !/bargain|budget|margin|detour|longer/.test(ft),
          'It lists band, stops, premium cap and avoid. That used to make the notice "they have'
          + ' flights, just none that <filterText()>" an outright lie whenever the margin rule'
          + ' emptied a party; neither discretionary rule can empty a party any more, so the'
          + ' remaining uncovered cause of prep.missing is maxPremium, which has no UI.');
}

/* ======================================================================
 * 4. ownBest, and therefore regret, is measured against the pruned set.
 * ====================================================================== */
console.log('\n-- regret measured against a pruned baseline --');
{
    /* P's own best flight is a 2h nonstop on Spirit. The margin rule deletes it
     * ($250 vs a $300 mainline is not an 18% saving), so ownBest becomes the 8h
     * one-stop that is left, and the plan that puts P on that 8h connection
     * reports zero regret. */
    var C = run({ maxDetour: null }, {
        a: [opt('18:00', 120, 0, 300, ['Delta'], 'a-1800')],
        p: [opt('18:05', 480, 1, 300, ['Delta'], 'p-delta-8h'),
            opt('18:10', 120, 0, 250, ['Spirit'], 'p-spirit-2h')]
    });
    /* Was ['p-delta-8h', 'p-spirit-2h']. The connection-premium rule now also
     * drops the 8h one-stop, because it is $50 DEARER than P's own 2h nonstop
     * -- an eight-hour connection that costs more buys nobody anything. The
     * point of the fixture stands: the 2h nonstop survives. */
    eq('the 2h nonstop is not deleted to protect a $50 fare difference',
       kept(C, 'p'), ['p-spirit-2h']);
    var plan = FWF.minCostAtWindow(C.prep, 30, C.costFn);
    var r = ctx.regretOf(C, plan.picks);
    check('and regret still has a baseline that can see the difference',
          C.ownBest.p.mins === 120 && C.ownBest.p.stops === 0,
          'ownBest(p) = ' + JSON.stringify(C.ownBest.p) + ', regret = ' + JSON.stringify(r)
          + ', worthIt = ' + ctx.worthIt(r)
          + ' -- with the 2h nonstop pruned, ownBest became the 8h connection and putting P on'
          + ' it reported zero regret, so worthIt() called the trade free.');
}

console.log('\n-- ownBest combines the best stops and the best duration from different options --');
{
    /* No single option is both. The baseline is a flight nobody can book, so
     * every real pick reports regret on one axis or the other. */
    var C = run({ maxDetour: null }, {
        a: [opt('09:00', 120, 0, 300, ['Delta'], 'a-ns')],
        p: [opt('09:10', 400, 0, 300, ['Delta'], 'p-slow-nonstop'),
            opt('09:20', 200, 1, 300, ['Delta'], 'p-quick-onestop')]
    });
    /* Was { mins: 200, stops: 0 } -- a baseline stitched from the duration of
     * the quick one-stop and the stop count of the slow nonstop, describing a
     * flight nobody could book. The connection-premium rule removes that
     * one-stop (same price, one more stop), so the baseline is now a real
     * flight. The quirk is still possible in principle; this fixture no longer
     * triggers it. */
    eq('ownBest is now a flight that exists', C.ownBest.p, { mins: 400, stops: 0 });
    var r = ctx.regretOf(C, { a: { option: (C.prep.options.a || [])[0] },
                              p: { option: kept(C, 'p').indexOf('p-slow-nonstop') > -1
                                   ? C.prep.options.p.filter(function (o) { return o.id === 'p-slow-nonstop'; })[0]
                                   : C.prep.options.p[0] } });
    /* Was asserting regret > 0, which was the symptom of the impossible
     * baseline above. With the baseline now equal to the only option P has,
     * zero regret is the correct answer -- P is on their own best flight. */
    check('P on their own best option reports no regret', r.mins === 0,
          'regret = ' + JSON.stringify(r) + ' against ownBest ' + JSON.stringify(C.ownBest.p));
}

/* ======================================================================
 * 5. The relax/block asymmetry: who ends up with an empty set, and what
 *    compute() tells the screen about why.
 * ====================================================================== */
console.log('\n-- relax / block asymmetry --');
{
    /* Group preference, no nonstop: relaxed, party kept. */
    var C1 = run({ maxStops: 0 }, {
        a: [opt('09:00', 120, 0, 300, ['Delta'], 'a-ns')],
        p: [opt('09:10', 300, 1, 300, ['Delta'], 'p-1stop')]
    });
    eq('group preference with no nonstop relaxes for that party', C1.relaxed, ['p']);
    eq('and does not block them', C1.blocked, []);

    /* Their own rule, no nonstop: blocked, as designed. */
    var C2 = run({ maxStops: null, rules: { p: { maxStops: 0 } } }, {
        a: [opt('09:00', 120, 0, 300, ['Delta'], 'a-ns')],
        p: [opt('09:10', 300, 1, 300, ['Delta'], 'p-1stop')]
    });
    eq('a personal rule blocks instead', C2.blocked.map(function (b) { return b.id + ':' + b.rule; }),
       ['p:stops']);

    /* A party with NO options at all, who also happens to have a personal rule.
     * There is nothing for the rule to reject, but it claims the block anyway,
     * and the notice then says "they have flights, just none that are nonstop". */
    var C3 = run({ rules: { p: { maxStops: 0 } } }, {
        a: [opt('09:00', 120, 0, 300, ['Delta'], 'a-ns')],
        p: []
    });
    check('a party with no flights at all is not reported as filtered out',
          !C3.blocked.some(function (b) { return b.id === 'p'; }),
          'blocked = ' + JSON.stringify(C3.blocked)
          + ' -- renderNotices() will say "P can’t meet your filters. They have flights, just'
          + ' none that are nonstop", when the search returned nothing for P at all.');
}

console.log('\n-- the relaxed note names the group rule, not the rule that was relaxed --');
{
    /* Group allows 1 stop; P's own rule allows 2. P has only a two-stop, so
     * nothing is relaxed for P -- but Q inherits the group rule and is relaxed.
     * The note is driven by ctx.maxStops, the group value, which is right here.
     * The wrong case is the reverse: see the KNOWN note below. */
    var C = run({ maxStops: 1 }, {
        a: [opt('09:00', 120, 0, 300, ['Delta'], 'a-ns')],
        q: [opt('09:10', 400, 2, 300, ['Delta'], 'q-2stop')]
    });
    eq('Q is relaxed off the group rule', C.relaxed, ['q']);
    eq('and the group value the note prints is the group rule', C.maxStops, 1);
}

/* ======================================================================
 * 6. maxPremium: the fairness cap throws instead of filtering.
 * ====================================================================== */
console.log('\n-- maxPremium --');
{
    var threw = null;
    try {
        run({ maxPremium: 100 }, {
            a: [opt('09:00', 120, 0, 300, ['Delta'], 'a-ns')],
            p: [opt('09:10', 120, 0, 300, ['Delta'], 'p-ns')]
        });
    } catch (e) { threw = e; }
    check('compute() does not throw when a premium cap is set', !threw,
          threw ? threw.name + ': ' + threw.message
                + ' -- app.js:326 reads a free variable `loner` that is declared nowhere in the'
                + ' repo, inside a "use strict" IIFE.' : '');
}

/* ======================================================================
 * 7. Things that ARE right, pinned so a fix does not break them.
 * ====================================================================== */
console.log('\n-- invariants worth keeping --');
{
    var C = run({ avoid: ['Spirit'] }, {
        a: [opt('09:00', 120, 0, 300, ['Delta'], 'a-ns')],
        p: [opt('09:10', 120, 0, 150, ['Spirit'], 'p-spirit')]
    });
    eq('avoid is never relaxed, even when it empties a party',
       C.blocked.map(function (b) { return b.id + ':' + b.rule; }), ['p:airline']);
    eq('and the party really is empty', kept(C, 'p'), []);

    var C2 = run({}, {
        a: [opt('09:00', 120, 0, 300, ['Delta'], 'a-ns')],
        p: [opt('09:10', 120, 0, 150, ['Spirit'], 'p-spirit')]
    });
    eq('a budget fare that IS a bargain survives the margin', kept(C2, 'p'), ['p-spirit']);

    var C3 = run({}, { p: [opt('09:10', 120, 0, 150, ['Spirit'], 'p-spirit')] });
    eq('a route only a budget carrier flies keeps the budget option', kept(C3, 'p'), ['p-spirit']);

    /* The $40 floor and the 18% test both scale linearly with seats, and so does
     * cost, so the bar is per seat however many seats there are. Pinned because
     * the seats term looks like it should change the answer and must not. */
    var seatsCase = {
        a: [opt('09:00', 120, 0, 100, ['Delta'], 'a-ns')],
        p: [opt('09:05', 120, 0, 100, ['Delta'], 'p-delta'),
            opt('09:10', 120, 0, 55, ['Spirit'], 'p-spirit')]
    };
    eq('margin verdict for 1 seat', kept(run({}, seatsCase), 'p'), ['p-delta', 'p-spirit']);
    eq('margin verdict for 2 seats is the same',
       kept(run({ seats: { p: 2 } }, seatsCase), 'p'), ['p-delta', 'p-spirit']);
    eq('margin verdict for 5 seats is the same',
       kept(run({ seats: { p: 5 } }, seatsCase), 'p'), ['p-delta', 'p-spirit']);
}

/* ======================================================================
 * 8. A party the hard filters emptied is still shown -- and still made
 *    bookable -- on the very option the filter removed.
 * ====================================================================== */
console.log('\n-- the fallback row ignores every filter --');
{
    /* legBreakdown() (app.js:812) fills in "anyone the filters removed entirely"
     * from ctx.soloOpen, which compute() builds from the RAW legData: no avoid,
     * no band, no stops, no margin, no detour. hopRow() then prints the carrier
     * and travellerCard() pushes the option into `chosen`, which is what the
     * Book button pins. */
    var C = run({ avoid: ['United'] }, {
        a: [opt('09:00', 120, 0, 300, ['Delta'], 'a-ns')],
        p: [opt('09:10', 120, 0, 320, ['United'], 'p-united')]
    });
    eq('P is blocked by the airline rule',
       C.blocked.map(function (b) { return b.id + ':' + b.rule; }), ['p:airline']);
    check('the fallback the screen will show P is not on the avoided carrier',
          !(C.soloOpen.p && (C.soloOpen.p.option.airlines || []).some(function (nm) {
              return ctx.normAirline(nm) === ctx.normAirline('United');
          })),
          'soloOpen.p = ' + JSON.stringify(C.soloOpen.p && C.soloOpen.p.option.airlines)
          + ' -- the carrier the group just told the app to avoid, rendered as that'
          + ' party’s flight and pinned into the Google Flights deep link.');

    /* Same hole for a party merely excluded by the window, and for the stops
     * rule somebody set about themselves. */
    var C2 = run({ maxStops: null, rules: { p: { maxStops: 0 } } }, {
        a: [opt('09:00', 120, 0, 300, ['Delta'], 'a-ns')],
        p: [opt('09:10', 400, 2, 300, ['Delta'], 'p-2stop')]
    });
    check('a party blocked by their own nonstop rule is not shown a two-stop',
          !(C2.soloOpen.p && C2.soloOpen.p.option.stops > 0),
          'soloOpen.p.stops = ' + (C2.soloOpen.p && C2.soloOpen.p.option.stops)
          + ' -- the rule exists so this exact itinerary is never offered to them.');
}

/* ======================================================================
 * 9. The band and the regret baseline disagree, so the fairness guard in
 *    recommendedIn() turns itself off whenever a band is set.
 * ====================================================================== */
console.log('\n-- band vs the regret baseline --');
{
    /* ownBest is computed from `kept`, which is BEFORE prepare() applies the
     * band. P's quickest is a 2h nonstop landing 09:00; the group asked to land
     * in the evening, so the only flight P can actually take is the 6h40
     * one-stop. Every row of the ladder therefore reports a connection the band
     * made unavoidable, worthIt() is false for all of them, and `fair` collapses
     * to `f` -- the guard against recommending somebody's connection is gone. */
    var C = run({ band: { from: '16:00', to: '20:00' }, maxDetour: null }, {
        a: [opt('18:00', 120, 0, 300, ['Delta'], 'a-1800')],
        p: [opt('09:00', 120, 0, 300, ['Delta'], 'p-0900-2h'),
            opt('18:10', 400, 1, 300, ['Delta'], 'p-1810-6h40')]
    });
    eq('ownBest is the best flight P can actually take, not the one the band forbids',
       C.ownBest.p, { mins: 400, stops: 1 });
    var allUnfair = C.ladder.rows.filter(function (r) { return r.feasible; })
        .every(function (r) { return !ctx.worthIt(ctx.regretOf(C, r.result.picks)); });
    check('at least one ladder row passes the fairness test', !allUnfair,
          'every feasible row reports regret {stops:+1, mins:+280} because the baseline is a'
          + ' 09:00 flight the band forbids. recommendedIn() then does `if (!fair.length)'
          + ' fair = f`, so the connection guard silently stops applying.');
}

/* ======================================================================
 * 10. The real fixture. Scoping the budget margin to substitutable flights
 *     must not reopen the complaint it was built for, and the plan the demo
 *     screen shows must not move.
 * ====================================================================== */
console.log('\n-- flights.json, the ?demo=1 example --');
{
    var sample = JSON.parse(fs.readFileSync(__dirname + '/flights.json', 'utf8'));
    ctx.state.q = {
        dest: 'PIT', dep: '2027-02-12', ret: '2027-02-15',
        band: { outbound: { from: '', to: '' }, return: { from: '', to: '' } },
        maxStops: null, maxPremium: null, avoid: [], clusterReturn: false, maxDetour: 180,
        parties: [
            { id: 'alex', name: 'Alex', seats: 1, airports: ['SFO', 'OAK', 'SJC'] },
            { id: 'sam', name: 'Sam', seats: 2, airports: ['ORD'] },
            { id: 'jo', name: 'Jo', seats: 1, airports: ['ATL'] },
            { id: 'ray', name: 'Ray', seats: 1, airports: ['DEN'] }
        ]
    };
    ctx.state.leg = 'outbound';
    ctx.DATA = { trips: { query: sample.trips['pit-feb'] } };
    var C = ctx.compute('outbound');

    /* Alex's Spirit flight lands 22:15; the nearest mainline is American at
     * 19:05, 190 minutes away -- inside the loosest window this app still calls
     * landing together, so they ARE alternatives and the fares are comparable.
     * All-in, Spirit is $228 against American's $236: a $8 "saving" for a carrier
     * that charges for the carry-on. It must still be pruned. */
    var alex = kept(C, 'alex');
    check('Spirit at $8 under a mainline 3h away is still pruned',
          alex.indexOf('alex-spirit') === -1 && (C.prep.options.alex || []).every(function (o) {
              return !ctx.isUlcc(o);
          }),
          'alex kept ' + JSON.stringify((C.prep.options.alex || []).map(function (o) {
              return (o.airlines || []).join('/') + '@' + o.arrive.slice(11);
          })));

    /* And the whole ladder on the demo data is unchanged from before the fix:
     * same rows, same carriers, same totals, same spreads. */
    var got = C.ladder.rows.filter(function (r) { return r.feasible; }).map(function (r) {
        return (r.threshold === FWF.INF ? 'inf' : r.threshold) + ':$' + Math.round(r.result.cost)
             + '/' + r.result.spread;
    });
    /* Last rung was 'inf:$868/350' until DEFAULT_THRESHOLDS gained 300/360/480.
     * Same cost, same spread -- a 350-minute spread now lands on a finite rung
     * instead of falling through to "any time", which is the whole point of the
     * new rungs. Every other row is untouched. */
    eq('the outbound ladder is byte-for-byte what it was',
       got, ['15:$1072/8', '30:$916/20', '120:$915/110', '180:$892/145', '360:$868/350']);
    eq('and the tightest window the group can make', C.tight.spread, 8);
}

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASSED')
    + (soft ? '  (' + soft + ' documented)' : ''));
process.exitCode = fail ? 1 : 0;
