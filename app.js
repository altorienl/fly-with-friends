/* Fly with Friends — application logic.
 *
 * Split out of index.html so the markup stays readable and the maths stays
 * testable. optimizer.js holds the window/cost algorithms; airports.js holds the
 * lookup; this file is the glue, the steps, and the rendering.
 *
 * ---------------------------------------------------------------------------
 * THE WORDS
 *
 * Seven captions have already been deleted for saying out loud what the screen
 * was already showing. These are the rules that survived that, written down so
 * the next string does not have to be argued about:
 *
 * 1. State the fact, never the feature. "Jo has no flights on the way out" is a
 *    fact. "This finds the flights that put you all on the ground within minutes
 *    of each other" is the app describing itself, and nobody reads it twice.
 *    If a line would still be true with the feature switched off, cut it.
 *
 * 2. Say it once. If the heading, the label and the hint all describe the same
 *    field, two of them go. A caption that restates the number beside it is the
 *    first thing to delete.
 *
 * 3. Use the words the reader already owns, not the ones in the code. These
 *    leak and must not reach the screen: window, spread, cluster, premium,
 *    subset, leg, party, detour, filter, search service. Where the domain has
 *    its own word, use the airline's: Depart and Return for the two legs of a
 *    round trip (never "departure"/"arrival" -- both legs have one of each),
 *    nonstop, fare, seats.
 *
 * 4. Numbers. Minutes are spelled out on the one line that states the result
 *    ("everyone within 20 minutes of each other") and in the pick card, because
 *    standing alone as the answer "20m" reads as shorthand nobody asked to
 *    decode. In a column of gaps, "10m" beside "7h 21m" is still the right form,
 *    so FWF.fmtGap stays there. Money is whole dollars with a thousands comma.
 *    Dates are "Feb 12 – Feb 15"; ISO belongs in the data, never on screen.
 *    Clock times follow the 12/24h setting, everywhere, including inside
 *    sentences.
 *
 * 5. The group. "Everyone" said to two people is the app talking past them --
 *    two travellers have names, so use them (nameList/landsWithin below). Three
 *    or more and "everyone" is the only word that stays short. Singulars and
 *    plurals agree: no "1 searches", no "2 stop", no "Alex, Sam only has".
 *
 * 6. The reader is the organiser. The app addresses them about the group:
 *    "Who's coming?", "Book Alex's trip". It never speaks as "we" and never
 *    explains its own economics, caching or quota design.
 *
 * 7. Errors say what happened and what to do, in that order, and never quote a
 *    browser or a provider at the reader. "Failed to fetch" is not a sentence.
 *    Empty states name the person who is missing and offer the next move.
 *
 * 8. American spelling on screen (traveler, organize, math, nonstop). The
 *    comments in here are the author's own and stay British; nothing in a
 *    comment reaches a reader.
 * ---------------------------------------------------------------------------
 */
(function () {
'use strict';

var VERSION = '3.0.0';
var REPO = 'https://github.com/altorienl/fly-with-friends';
var LINKEDIN = 'https://www.linkedin.com/in/altorienlockwood/';
var LS = 'fwf_settings';

/* Deployed Cloudflare Worker. SerpApi refuses cross-origin browser requests by
 * design, so this proxy is the only way a static page can search at all. */
var API = 'https://fly-with-friends-api.altorien.workers.dev';

var APP = { bagFee: 35, carryOnFee: 30, target: 30, maxParties: 8, maxSeats: 9 };

/* Also hard-coded in the markup, so the first paint is not blank. The two must
 * stay in step. The placeholder already shows a city and a code by example, so
 * this says what the field takes and nothing more -- it used to add "try
 * “cabo”" as well, which made three captions for one input. */
var DEST_HINT = 'Airport code or city';

/* Assigned in order so each party keeps its colour across the timeline, the
 * avatar and the plan rows. */
var COLORS = ['#986306', '#177984', '#3c6bc7', '#994cbb', '#bb482c', '#be4066', '#147d45', '#61760a'];

var DATA = null, SET = null, BUDGET = null, C = null, TRIP = null;
/* Alternative dates, keyed "dep|ret". Each entry is a whole searched trip. */
var SHIFTS = {}, shiftBusy = false, shiftErr = null;
/* Short id for the saved trip, once it has been shared. */
var TRIP_ID = null, savingTrip = false;
/* Bumped by every search and by starting a new trip, so a response that belongs
 * to a trip nobody is looking at any more can be identified and dropped. */
var searchGen = 0;
var state = {
    step: 1, leg: 'outbound', recommend: 'value',
    /* One chosen row per leg: a round trip is two decisions, and pricing the
     * whole trip means holding both at once. */
    th: { outbound: null, return: null },
    /* Which named match the results screen is showing, by key. Held as the key
     * rather than as a threshold so it survives a filter change: "I asked for
     * the cheapest" stays true when the cheapest becomes a different plan. */
    match: null,
    q: null, busy: false, error: null
};
function otherLeg() { return state.leg === 'outbound' ? 'return' : 'outbound'; }
function thGet() { return state.th[state.leg]; }
function thSet(v) { state.th[state.leg] = v; }
/* A match is a decision about the trip, so it sets both legs -- the same thing
 * one tap on a choice has always done. The default only ever set the outbound,
 * which left a clustered return falling back to its own per-leg recommendation:
 * the two agree on today's data, but nothing makes them, and the list now
 * quotes a total per match that the itineraries underneath have to sum to. */
function thBoth(v) { state.th.outbound = v; state.th['return'] = v; }
function thReset() { state.th.outbound = null; state.th.return = null; }

/* .low and .exhausted were derived in the search response handler only, so the
 * allowance notices -- the whole "what does somebody see when the budget is
 * gone" answer -- could never appear on a plain load or a shared link, and
 * canRetarget() never saw an exhausted month either. One place now. */
function setBudget(b) {
    if (!b) return;
    BUDGET = b;
    BUDGET.low = BUDGET.used > BUDGET.limit * 0.8;
    BUDGET.exhausted = BUDGET.used >= BUDGET.limit;
}

var el = function (id) { return document.getElementById(id); };
function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}
function money(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
function clock(m) { return FWF.fmtClock(m, SET.time24); }

/* ------------------------------------------------------------- settings */

function defaults() {
    return { meId: null, theme: 'system', target: APP.target, priceDisplay: 'allin',
             time24: false, bags: { carry_on: 1, checked: 0 } };
}
function loadSet() {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) {}
    var s = defaults();
    for (var k in saved) if (Object.prototype.hasOwnProperty.call(s, k)) s[k] = saved[k];
    return s;
}
function saveSet() { try { localStorage.setItem(LS, JSON.stringify(SET)); } catch (e) {} }

/* ------------------------------------------------------------ the group
 *
 * The same friends fly together more than once -- that is the entire premise --
 * and the app made you retype all of it every single time: four names, four
 * seat counts and up to twenty airport codes, before you could ask it anything.
 * Re-entering the group was the largest single piece of work in the product and
 * it bought nothing, because the answer only changes with the destination and
 * the dates.
 *
 * Stored separately from settings, because it is not a preference: it is the
 * cast. Only ever written after a search the group actually ran, so a half
 * typed card and -- more importantly -- the ?demo=1 example never become
 * somebody's saved friends. */
var GROUP_LS = 'fwf_group';

function saveGroup() {
    /* The example's Alex, Sam, Jo and Ray are not your friends. */
    if (!DATA || DATA.sample) return;
    try {
        var roster = state.q.parties
            .filter(function (p) { return p.airports.length; })
            .map(function (p) {
                return { name: String(p.name || '').slice(0, 22),
                         seats: Math.max(1, p.seats || 1),
                         airports: p.airports.slice(0, 5) };
            });
        if (roster.length < 2) return;
        localStorage.setItem(GROUP_LS, JSON.stringify(roster));
    } catch (e) {}
}

/* Rebuilt through newParty() so a restored card is the same shape as a fresh
 * one -- including a new id, because ids are what the plan, the totals and
 * "which one is you" are keyed on and a stale one would point at nobody. */
function loadGroup() {
    var roster = null;
    try { roster = JSON.parse(localStorage.getItem(GROUP_LS) || 'null'); } catch (e) {}
    if (!Array.isArray(roster) || roster.length < 2) return null;
    var out = [];
    for (var i = 0; i < roster.length && i < APP.maxParties; i++) {
        var r = roster[i] || {};
        if (!Array.isArray(r.airports) || !r.airports.length) continue;
        var p = newParty(i);
        p.name = typeof r.name === 'string' ? r.name : '';
        p.seats = Math.min(APP.maxSeats, Math.max(1, r.seats || 1));
        /* Airports are revalidated on the way in: the closed-airspace list
         * changes between trips, and a code that has since been retired would
         * otherwise sit in a card looking perfectly normal. */
        p.airports = r.airports.filter(function (c) { return !!AIRPORTS.get(c); }).slice(0, 5);
        if (p.airports.length) out.push(p);
    }
    return out.length >= 2 ? out : null;
}

function forgetGroup() { try { localStorage.removeItem(GROUP_LS); } catch (e) {} }
function hasGroup() { return !!loadGroup(); }

/* Names the group for the Forget control. Naming them is the point -- it is the
 * only place the saved roster is visible, so it is how somebody finds out it is
 * being kept at all -- but eight names of up to 22 characters would wrap a pill
 * onto four lines, and a wrapped pill reads as a broken pill. Three names and a
 * count stays on one line at 393px and still says whose group it is. */
function groupNames(roster) {
    var names = (roster || []).map(function (p, i) { return partyLabel(p, i); });
    if (names.length <= 4) return names.join(', ');
    return names.slice(0, 3).join(', ') + ' and ' + (names.length - 3) + ' more';
}

function applyTheme() {
    var m = SET.theme;
    if (m === 'system') {
        m = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    document.documentElement.setAttribute('data-theme', m);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', m === 'light' ? '#ece8e1' : '#0f0d0a');
}

/* ---------------------------------------------------------- query model */

function newParty(i) {
    return { id: 'p' + i + Math.random().toString(36).slice(2, 5), name: '', seats: 1, airports: [] };
}
/* Links shared before a field existed restore without it, so anything the UI
 * mutates in place has to be backfilled rather than assumed. */
function migrateQuery(q) {
    if (!q) return q;
    if (!Array.isArray(q.avoid)) q.avoid = [];
    if (!Array.isArray(q.parties)) q.parties = [];
    /* A link from before this field existed carries no opinion about the way
     * home, so it gets the current default. A link that carries an explicit
     * false was shared by somebody looking at separate flights home, and still
     * opens on separate flights home -- a shared link has to show what the
     * person sharing it saw. */
    if (q.clusterReturn !== false && q.clusterReturn !== 'any') q.clusterReturn = true;
    return q;
}

/* A shared trip is a document written by whoever made the link, not by this
 * app, and several of its fields land in innerHTML. A stranger could POST a
 * trip and hand somebody a link on this origin that ran their script -- which
 * on a booking app means repointing every Book button at a phishing site, on a
 * page the group trusts because a friend sent it. So the payload is coerced to
 * the shape the renderer already assumes. A genuine link is unaffected: it
 * already carries numbers where numbers belong. */
function sanitizeQuery(q) {
    if (!q || typeof q !== 'object') return q;
    var num = function (v, lo, hi, dflt) {
        if (v == null) return null;
        v = Math.round(+v);
        return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
    };
    q.dest = String(q.dest == null ? '' : q.dest).toUpperCase().slice(0, 3);
    q.dep = String(q.dep == null ? '' : q.dep).slice(0, 10);
    q.ret = String(q.ret == null ? '' : q.ret).slice(0, 10);
    q.maxStops = num(q.maxStops, 0, 9, null);
    q.maxPremium = num(q.maxPremium, 0, 100000, null);
    q.maxDetour = num(q.maxDetour, 0, 10080, 180);
    /* Three-valued: true (leave together if affordable), 'any' (the group saw
     * the price and took it anyway), false (separate). A boolean coercion here
     * silently promoted 'any' to true and lost that consent. */
    q.clusterReturn = (q.clusterReturn === false || q.clusterReturn === 'any')
        ? q.clusterReturn : true;
    q.avoid = (Array.isArray(q.avoid) ? q.avoid : [])
        .map(function (a) { return String(a).slice(0, 40); }).slice(0, 40);
    q.parties = (Array.isArray(q.parties) ? q.parties : []).slice(0, 8).map(function (pp, i) {
        pp = pp && typeof pp === 'object' ? pp : {};
        return {
            id: String(pp.id == null ? 'p' + i : pp.id).slice(0, 24),
            name: String(pp.name == null ? '' : pp.name).slice(0, 22),
            seats: num(pp.seats, 1, 9, 1) || 1,
            /* Validated whole, not truncated: slicing first turned "TOOLONG"
             * into the plausible-looking code "TOO". */
            airports: (Array.isArray(pp.airports) ? pp.airports : [])
                .map(function (x) { return String(x).toUpperCase().trim(); })
                .filter(function (x) { return /^[A-Z]{3}$/.test(x); }).slice(0, 5)
        };
    });
    return q;
}

/* option.stops arrives from a shared trip too, and was interpolated bare. */
function stopsText(n) {
    n = Math.round(+n);
    if (!isFinite(n) || n < 0) n = 0;
    return n === 0 ? 'nonstop' : n + (n === 1 ? ' stop' : ' stops');
}

function blankQuery() {
    return {
        dest: '', dep: '', ret: '',
        band: { outbound: { from: '', to: '' }, return: { from: '', to: '' } },
        maxStops: null, maxPremium: null,
        /* Normalised carrier names nobody in the group will fly. Applied in the
         * browser against options we already hold, so changing it is instant and
         * costs no searches -- sending it to the provider instead would make
         * every different selection a fresh paid search for the same trip. */
        avoid: [],
        /* Leave together too, when it is affordable and asks nobody to fly
         * materially worse. On by default -- see returnWays for what changed
         * and what it costs. Set false by the group to fly home separately. */
        clusterReturn: true,
        /* Relative, because nobody knows the right absolute number. "No more
         * than three hours longer than the quickest way to do this route" is
         * always meaningful; "no more than 8 hours" is not. */
        maxDetour: 180,
        parties: [newParty(0), newParty(1), newParty(2)]
    };
}
function partyLabel(p, i) { return (p.name || '').trim() || ('Flight ' + (i + 1)); }

/* Close enough to call it one departure: you can share a ride, or at least wait
 * for each other. The same line the plan heading uses to decide whether to raise
 * its voice, named once because both places are making the same judgement. */
var TOGETHER_MINS = 90;
function together(spread) { return spread != null && spread <= TOGETHER_MINS; }

/* Spelled out, for the one line that states the result. "10m" is fine in a
 * column of gaps; standing alone as the answer it reads as shorthand nobody
 * asked to decode, and a first-time reader took it for something else.
 *
 * Both halves are spelled out. "11 hours 10 min" was half-abbreviating inside
 * the very sentence form that exists not to abbreviate. */
function gapWords(minutes) {
    if (minutes == null) return '';
    var abs = Math.round(Math.abs(minutes));
    var h = Math.floor(abs / 60), m = abs % 60;
    if (h === 0) return m + (m === 1 ? ' minute' : ' minutes');
    var out = h + (h === 1 ? ' hour' : ' hours');
    return m ? out + ' ' + m + (m === 1 ? ' minute' : ' minutes') : out;
}

/* Joins a list the way a person would, so a sentence about two people reads as
 * one. Oxford comma left out to match the rest of the copy. */
function listOf(items, conj) {
    var xs = (items || []).filter(function (x) { return x != null && x !== ''; });
    if (xs.length < 2) return xs.join('');
    return xs.slice(0, -1).join(', ') + ' ' + (conj || 'and') + ' ' + xs[xs.length - 1];
}
function nameList(ids) { return listOf((ids || []).map(name)); }

/* "Everyone" said to a group of two is the app talking past the two people in
 * front of it -- a tester's reaction to exactly that is why this exists. Two
 * travellers have names, so the result line uses them; three or more and
 * "everyone" is the only word that stays short enough to fit. Counted in seats,
 * because two cards can still be five people. */
function isPair() {
    return !!(C && C.ids && C.ids.length === 2 && seatsAll() === 2);
}
/* The subject of the result sentence, with its verb already agreed. */
function landsWithin(minutes) {
    return isPair()
        ? nameList(C.ids) + ' land within ' + gapWords(minutes)
        : 'Everyone lands within ' + gapWords(minutes);
}
/* The same fact mid-sentence, where it follows a heading rather than opening. */
function withinEachOther(minutes) {
    return (isPair() ? nameList(C.ids) : 'everyone')
        + ' within ' + gapWords(minutes) + ' of each other';
}
function groupWord() { return isPair() ? nameList(C.ids) : 'Everyone'; }

/* One sentence for a closed airport, in both places one is shown. Codes get
 * "or" before the last, because a bare comma list of four codes reads as data
 * rather than as advice. */
function codeList(codes) { return listOf(codes, 'or'); }
function closedDestNote(a) {
    return a.note + (a.alternates.length ? ' Try ' + codeList(a.alternates) + ' instead.' : '');
}
function closedOriginNote(a) {
    return a.note + (a.alternates.length
        ? ' People fly from ' + codeList(a.alternates) + ' instead.' : '');
}

/* Resolves a party's rules against the group controls. An ABSENT key inherits
 * the group setting; an explicit null is itself a value ("Any"), which is why
 * the test is for the key rather than for null. `own` records which side the
 * value came from, because that decides whether it may be relaxed: a group
 * preference the organiser set for everyone can be relaxed on one person's
 * behalf and reported. A rule someone set about themselves cannot -- quietly
 * allowing a second connection for the person who said she will not fly two
 * connections is the exact failure a spreadsheet exists to prevent. */
function rulesFor(id) {
    var p = party(id) || {};
    var r = p.rules || {};
    var hasStops = Object.prototype.hasOwnProperty.call(r, 'maxStops');
    return {
        maxStops: hasStops ? r.maxStops : state.q.maxStops,
        own: { maxStops: hasStops }
    };
}

function rulesSummary(p) {
    var r = p.rules || {};
    if (!Object.prototype.hasOwnProperty.call(r, 'maxStops')) return '';
    return r.maxStops === null ? 'any number of stops'
        : r.maxStops === 0 ? 'nonstop only'
        : r.maxStops + (r.maxStops === 1 ? ' stop max' : ' stops max');
}

/* Initials where a name was given, and nothing at all where one was not.
 *
 * It used to fall back to the party number, which made one traveller two
 * different things: a digit on the "who's coming" step and a letter on the
 * results screen the moment a name existed -- and "F1" on the results screen
 * when it did not, because the call sites there pass { name: partyLabel(...) }
 * and the synthetic "Flight 1" arrived here looking like something typed. The
 * colour already identifies the party on the timeline and in the plan, so an
 * unnamed party is its colour, consistently, on every screen, and the glyph
 * appears the moment the name does. The index argument is kept: callers pass
 * it, and it costs nothing to accept. */
function partyInitials(p, i) {
    var n = (p.name || '').trim();
    if (/^Flight \d+$/.test(n)) n = '';
    if (!n) return '';
    /* One booking often covers two people, so names arrive as "Jim / Gary" or
     * "Mum & Dad". Taking the first character of every whitespace-separated
     * token made the separator an initial and drew avatars reading "J/".
     * Splitting on the separators themselves keeps this right for any script,
     * which a letters-only character class would not. */
    var toks = n.split(/[\s/,&+·|\-–—.]+/).filter(function (w) { return w.length; });
    if (!toks.length) return '';
    return toks.slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase();
}
function partyColor(i) { return COLORS[i % COLORS.length]; }

function travelers() {
    return state.q.parties.map(function (p, i) {
        return { id: p.id, name: partyLabel(p, i), origins: p.airports.slice(),
                 seats: Math.max(1, p.seats || 1), color: partyColor(i), bags: SET.bags };
    });
}
function hasReturn() { return !!(state.q && state.q.ret); }
function bandFor(leg) { return (state.q.band || {})[leg] || { from: '', to: '' }; }
function currentBand() { return bandFor(state.leg); }
function bandMinutesFor(leg) {
    var b = bandFor(leg);
    var f = FWF.parseTimeOfDay(b.from), t = FWF.parseTimeOfDay(b.to);
    /* One side is the natural way to say it -- "land by 8pm", "nothing before
     * 9am" -- and it used to be ignored with no warning at all. Fill the open
     * end rather than discarding the constraint. */
    if (f == null && t == null) return null;
    if (f == null) return { from: 0, to: t };
    if (t == null) return { from: f, to: 1439 };
    return { from: f, to: t };
}
function bandMinutes() { return bandMinutesFor(state.leg); }

/* ------------------------------------------------------------- compute */

function compute(leg) {
    leg = leg || state.leg;
    if (!DATA || !state.q) return null;
    var legData = ((DATA.trips || {}).query || {})[leg] || {};
    var tv = travelers();
    var ids = tv.map(function (t) { return t.id; });
    var field = leg === 'outbound' ? 'arrive' : 'depart';
    var band = bandMinutesFor(leg), maxStops = state.q.maxStops;

    var costFn = FWF.makeCostFn(tv, {
        assumedCheckedBagFee: APP.bagFee, assumedCarryOnFee: APP.carryOnFee,
        priceDisplay: SET.priceDisplay
    });

    var relaxed = [], detoured = [], blocked = [], ownBest = {};
    var byParty = {}, legalFor = {};

    /* The two discretionary prunes below -- the budget margin and the detour cap
     * -- run before prepare() applies the landing band, so either can delete the
     * one option that put somebody inside the window the group asked for. That
     * trades a whole plan for a rule about taste, and the notice then blames the
     * band for it, because nothing records which rule actually did the pruning.
     * So: apply them, but never to the last option in the band. */
    function pruneSoftly(list, keepFn) {
        var out = list.filter(keepFn);
        if (!out.length) return list;
        if (!band) return out;
        var inBand = function (o) {
            var t = FWF.toMinutes(o[field]);
            return t != null && FWF.inBand(t, band.from, band.to);
        };
        if (!list.some(inBand) || out.some(inBand)) return out;
        return list.filter(function (o) { return keepFn(o) || inBand(o); });
    }

    ids.forEach(function (id) {
        var all = legData[id] || [];
        var kept = all;
        var rule = rulesFor(id);

        /* Carriers the group refuses. This is never relaxed on anybody's behalf:
         * quietly booking somebody onto the airline they just told us to avoid is
         * the single worst thing this screen could do. If it empties a party we
         * say so and let them choose.
         *
         * It runs FIRST, ahead of the relaxable stops preference, because a soft
         * rule applied before a hard one can make the hard one fatal: with "nonstop
         * only" set, somebody whose only nonstop is on the avoided carrier used to
         * be cut to that one flight by the preference and then blocked outright by
         * the avoid, when relaxing the preference would have given them a perfectly
         * good connection on a carrier the group accepts. */
        var avoid = state.q.avoid || [];
        if (avoid.length && kept.length) {
            var flyable = kept.filter(function (o) {
                return !(o.airlines || []).some(function (nm) {
                    return avoid.indexOf(normAirline(nm)) > -1;
                });
            });
            if (flyable.length) kept = flyable;
            else { blocked.push({ id: id, rule: 'airline' }); kept = []; }
        }

        if (rule.maxStops != null && kept.length) {
            var strict = kept.filter(function (o) { return (o.stops || 0) <= rule.maxStops; });
            if (strict.length) kept = strict;
            else if (rule.own.maxStops) {
                /* Their own rule: block and ask, never relax silently. */
                blocked.push({ id: id, rule: 'stops', best: kept });
                kept = [];
            } else relaxed.push(id);
        }

        /* What this party is allowed to fly at all: their own rules, and the
         * carriers the group refuses. Everything after this point is the app's
         * own judgement about which of those flights are worth offering, which is
         * a different thing and must not be mistaken for a constraint. */
        legalFor[id] = kept;

        /* A budget fare has to actually be a bargain. If Frontier is $8 under
         * Delta it is not cheaper, it is the same price without a bag, a seat
         * or a rebooking -- and picking it is how the app ends up recommending
         * the flight people dread. So a budget option must beat the best
         * mainline option by a real margin or it is dropped. Only applied when
         * a mainline option exists: on routes only a budget carrier flies, the
         * choice is that or nothing.
         *
         * "The best mainline option" means one the group could use INSTEAD, which
         * is a mainline flight landing inside the same window -- not the best
         * mainline flight of the day. Judged against the whole day, a $250 budget
         * flight landing with the group was deleted because a $300 mainline flight
         * existed nine hours earlier, and the group was split to save $50 on a
         * fare nobody was going to pick anyway. Two flights that cannot appear in
         * the same plan are not substitutes and must not be compared.
         *
         * Nor is a mainline flight a substitute when it is materially worse to
         * fly. The rule compares fares and nothing else, so a $250 two-hour
         * nonstop was deleted in favour of a $300 eight-hour connection -- the
         * rule exists because a budget fare understates its own cost by about a
         * bag and a seat, not to buy six extra hours in the air for $50. */
        if (kept.length) {
            /* "The same window" means the widest window this app still calls
             * landing together -- the loosest finite rung of the ladder. Past it
             * the only row left is "each on their own best flight", which is not
             * a group plan, so two flights that far apart were never alternatives
             * to each other and comparing their fares decides nothing. */
            var near = FWF.DEFAULT_THRESHOLDS.filter(function (t) { return isFinite(t); }).pop();
            var detourCap = state.q.maxDetour != null ? state.q.maxDetour : 180;
            var seatsOfParty = Math.max(1, (tv.filter(function (z) { return z.id === id; })[0] || {}).seats || 1);
            var mainline = kept.filter(function (o) { return !isUlcc(o); });
            /* Could the group put `m` in the plan instead of `o`? Same window,
             * no extra connection, and not materially longer -- materially using
             * the same relative yardstick as the detour cap, because an absolute
             * number here would be as meaningless as it is there. */
            var substitutes = function (m, o) {
                var mt = FWF.toMinutes(m[field]), ot = FWF.toMinutes(o[field]);
                if (mt == null || ot == null || Math.abs(mt - ot) > near) return false;
                if ((m.stops == null ? 99 : m.stops) > (o.stops == null ? 99 : o.stops)) return false;
                return !(m.duration_minutes != null && o.duration_minutes != null
                         && m.duration_minutes - o.duration_minutes > detourCap);
            };
            if (mainline.length) {
                kept = pruneSoftly(kept, function (o) {
                    if (!isUlcc(o)) return true;
                    var bestMain = null;
                    mainline.forEach(function (m) {
                        if (!substitutes(m, o)) return;
                        var c = costFn(m, id);
                        if (bestMain === null || c < bestMain) bestMain = c;
                    });
                    if (bestMain === null) return true;
                    var margin = Math.max(40 * seatsOfParty, bestMain * 0.18);
                    return costFn(o, id) <= bestMain - margin;
                });
            }
        }

        /* And a connection has to be worth the connection. cheapestInWindow
         * ranks on money alone and breaks only EXACT ties on stops, so a
         * one-stop a dollar under the nonstop wins the seat -- which is how a
         * 5h55m LAX-IAH-BNA itinerary beat a 3h55m nonstop by $9, and $9 is
         * what it costs to lose that traveller to Google Flights forever.
         *
         * Same shape as the budget rule above: beat the best nonstop by a real
         * margin or be dropped. The margin grows with the extra time in the air,
         * because the extra time is the thing being sold -- $40 a seat never
         * buys somebody three more hours, and on a long-haul where the one-stop
         * is forty minutes longer it should not have to. Only applied when the
         * party has a nonstop at all: on routes nobody flies nonstop, the choice
         * is a connection or nothing.
         *
         * maxDetour below cannot do this job. It is measured from the party's
         * QUICKEST option and is three hours wide, so on a 1h30m CLT-BNA hop it
         * waves through anything under 4h30m. */
        if (kept.length) {
            var nonstop = kept.filter(function (o) { return (o.stops || 0) === 0; });
            if (nonstop.length) {
                var bestDirect = null, directMins = null;
                nonstop.forEach(function (o) {
                    var c = costFn(o, id);
                    if (bestDirect === null || c < bestDirect) bestDirect = c;
                    if (o.duration_minutes != null
                        && (directMins === null || o.duration_minutes < directMins)) {
                        directMins = o.duration_minutes;
                    }
                });
                var seatsHere = Math.max(1, (tv.filter(function (z) { return z.id === id; })[0] || {}).seats || 1);
                /* Through pruneSoftly, like the budget rule: a discretionary
                 * prune must never take a party's last option inside the
                 * landing window they asked for. Applied bare, this rule emptied
                 * parties in the interaction fixtures and left the screen
                 * blaming the band for a flight a different rule removed. */
                kept = pruneSoftly(kept, function (o) {
                    if ((o.stops || 0) === 0) return true;
                    var extra = (o.duration_minutes != null && directMins != null)
                        ? Math.max(0, (o.duration_minutes - directMins) / 60) : 0;
                    return costFn(o, id) <= bestDirect - seatsHere * (40 + 25 * extra);
                });
            }
        }

        /* A 7h18m one-stop beating a 2h43m nonstop because it saved $45 is the
         * kind of answer that loses a user permanently. Duration only ever broke
         * exact price ties, which never happens, so it was effectively ignored. */
        var cap = state.q.maxDetour;
        if (cap != null && kept.length) {
            var quickest = null;
            kept.forEach(function (o) {
                if (o.duration_minutes != null && (quickest == null || o.duration_minutes < quickest)) {
                    quickest = o.duration_minutes;
                }
            });
            if (quickest != null) {
                var sane = pruneSoftly(kept, function (o) {
                    return o.duration_minutes == null || o.duration_minutes <= quickest + cap;
                });
                if (sane.length < kept.length) detoured.push(id);
                kept = sane;
            }
        }

        byParty[id] = kept;
    });

    var prep = FWF.prepare(byParty, ids, field, { band: band });

    /* What each party would pay flying whenever they liked, inside the same
     * filters. This is the baseline the premium is measured from, and it is the
     * number that turns one group total into "who is actually absorbing it".
     *
     * Computed per party rather than via minCostAtWindow(INF), which returns
     * null unless EVERY party has an option -- so one person filtered out used
     * to silently cancel the premium cap for the whole group with nothing on
     * screen saying so. A baseline is a per-party minimum; it never needed
     * everyone to be covered. */
    var solo = {};
    ids.forEach(function (id) {
        var list = prep.options[id] || [];
        var best = null;
        for (var i = 0; i < list.length; i++) {
            var c = costFn(list[i], id);
            if (best === null || c < best) best = c;
        }
        if (best !== null) solo[id] = best;
    });

    /* The fairness cap prunes each party's options to those within their own
     * baseline plus the cap, then re-prepares. Done as a filter on the option
     * set rather than inside the optimiser, so the window algorithms stay
     * exactly as verified. */
    var cap = state.q.maxPremium;
    if (cap != null) {
        var pruned = {};
        ids.forEach(function (id) {
            var base = solo[id];
            /* No baseline means no options survived the filters for this party,
             * so there is nothing to cap against -- leave their set alone rather
             * than emptying it. */
            pruned[id] = base == null ? (byParty[id] || [])
                : (byParty[id] || []).filter(function (o) { return costFn(o, id) <= base + cap; });
            if (!pruned[id].length) pruned[id] = byParty[id] || [];
        });
        prep = FWF.prepare(pruned, ids, field, { band: band });
    }

    /* The flight this party would pick if the group did not exist: quickest,
     * fewest stops. Not the cheapest -- this is the yardstick for what the
     * group is ASKING them to give up, and nobody experiences a connection
     * as a saving.
     *
     * Taken from the SAME set the plans are drawn from, because its only job is
     * to compare one ladder row against another. Measured against a wider set it
     * stops discriminating: with a landing band set, every row reported the same
     * fixed regret against a flight the band forbids, worthIt() was false for all
     * of them, and recommendedIn()'s `if (!fair.length) fair = f` quietly switched
     * the connection guard off for the whole trip. What the filters themselves
     * cost is a separate question, and soloOpen/anyTime answer it. */
    ids.forEach(function (id) {
        var bm = null, bs = null;
        (prep.options[id] || []).forEach(function (o) {
            if (o.duration_minutes != null && (bm == null || o.duration_minutes < bm)) bm = o.duration_minutes;
            var st = o.stops == null ? 99 : o.stops;
            if (bs == null || st < bs) bs = st;
        });
        ownBest[id] = { mins: bm, stops: bs };
    });

    /* The flight each party would take on their own, at any hour. Built from the
     * set they are ALLOWED to fly rather than from the raw results: legBreakdown()
     * uses this as the row it renders for anyone the filters removed, and hopRow()
     * prints the carrier while travellerCard() pins the itinerary into the Book
     * link. Built from legData it offered the one party blocked by the airline
     * filter a flight on exactly the carrier the group had just refused, and
     * offered somebody who said "nonstop only" a two-stop. */
    var soloOpen = {};
    var openPrep = FWF.prepare(legalFor, ids, field);
    ids.forEach(function (id) {
        var list = openPrep.options[id] || [];
        var best = null;
        for (var i = 0; i < list.length; i++) {
            var c = costFn(list[i], id);
            if (best === null || c < best.cost) best = { cost: c, option: list[i] };
        }
        if (best) soloOpen[id] = best;
    });

    var out = { leg: leg, travelers: tv, ids: ids, prep: prep, costFn: costFn, band: band,
                maxStops: maxStops, relaxed: relaxed, detoured: detoured, blocked: blocked,
                ownBest: ownBest,
                cap: cap, solo: solo, soloOpen: soloOpen,
                tight: null, ladder: null, target: null, subset: null, anyTime: null };

    /* The cost of a filter only means anything against the same search without
     * it, and that comparison is free -- same options, no extra request. */
    if (band || maxStops != null) {
        var open = FWF.prepare(legData, ids, field);
        if (open.complete) {
            var b = FWF.minCostAtWindow(open, FWF.INF, costFn);
            if (b) out.anyTime = b.cost;
        }
    }

    if (!prep.complete) {
        out.subset = FWF.bestSubset(prep, SET.target, costFn);
        return out;
    }

    out.tight = FWF.tightestWindow(prep);
    var ths = FWF.DEFAULT_THRESHOLDS.concat([SET.target]).filter(function (v, i, a) { return a.indexOf(v) === i; });
    out.ladder = FWF.ladder(prep, costFn, ths);
    out.target = FWF.minCostAtWindow(prep, SET.target, costFn);
    if (!out.target) out.subset = FWF.bestSubset(prep, SET.target, costFn);
    return out;
}

/* -------------------------------------------------------- autocomplete */

/* One implementation, attached to the destination field and to every party
 * airport field. Keyboard nav mirrors intrinsics: arrows move, Enter commits. */
var acSeq = 0;
function attachAc(input, drop, onPick, opts) {
    /* Metro entries are offered for origins only. As a destination they would
     * let the group land at three different airports, which is the one thing
     * this app exists to prevent. */
    var matches = [], idx = -1, uid = 'ac' + (++acSeq);
    opts = opts || {};
    if (!drop.id) drop.id = uid + 'list';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', drop.id);
    input.setAttribute('aria-expanded', 'false');
    drop.setAttribute('role', 'listbox');

    function close() {
        drop.classList.remove('open');
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
        idx = -1;
    }

    function paint() {
        if (!matches.length) {
            /* An empty field has nothing to say, so it closes. A field with
             * something typed in it and no matches used to do exactly the same
             * thing, which is indistinguishable from the suggestions being
             * broken -- and the suggestions WERE broken for five of the
             * twenty-six opening letters, so "nothing appeared" was not a
             * reliable signal that there was nothing to find. Say it instead.
             * aria-disabled marks it as an option that cannot be chosen, which
             * keeps the listbox a listbox. */
            if (!input.value.trim()) { close(); return; }
            /* The typed string is deliberately NOT quoted back. The destination
             * field renders uppercase and holds the value as typed, so echoing
             * it printed "zzzz" under a field showing ZZZZ -- two spellings of
             * one thing, which is worse than not repeating it. */
            drop.innerHTML = '<div class="ac-none" role="option" aria-disabled="true">'
                + 'No airport matches that.</div>';
            drop.classList.add('open');
            input.setAttribute('aria-expanded', 'true');
            input.removeAttribute('aria-activedescendant');
            return;
        }
        drop.innerHTML = matches.map(function (a, i) {
            return '<button type="button" class="ac-item' + (i === idx ? ' active' : '')
                + (a.closed ? ' closed' : '') + (a.metro ? ' metro' : '')
                + '" data-ac="' + i + '" role="option" tabindex="-1"'
                + ' id="' + uid + '-' + i + '" aria-selected="' + (i === idx) + '">'
                + '<span class="ac-code">' + (a.metro ? String(a.members.length) : esc(a.code)) + '</span>'
                + '<span class="ac-body"><span class="ac-city">' + esc(a.city)
                + (a.metro ? ' — any airport' : a.closed ? ' — no service' : '') + '</span>'
                + '<span class="ac-sub">' + esc(a.name) + '</span></span>'
                + '<span class="ac-flag">' + esc(a.country) + '</span></button>';
        }).join('');
        drop.classList.add('open');
        input.setAttribute('aria-expanded', 'true');
        if (idx >= 0) input.setAttribute('aria-activedescendant', uid + '-' + idx);
    }

    /* search() ranks metro entries first and then applies the limit, so
     * dropping them afterwards could empty a list that was never short: on the
     * destination field, which takes no metros, the single letters A, I, N, O
     * and S each fetched seven metros and then showed NOTHING -- a dead field
     * on the first keystroke of Austin, Atlanta, Istanbul, New York, Oakland,
     * Orlando, Seattle, San Diego, San Francisco. Twenty-two of the twenty-six
     * letters were returning a short list. Over-fetch by the number of metros
     * that could possibly be removed, filter, then trim to the real limit. */
    var AC_LIMIT = 7;
    function refresh() {
        matches = AIRPORTS.search(input.value,
            opts.noMetros ? AC_LIMIT + AIRPORTS.METROS.length : AC_LIMIT);
        if (opts.noMetros) matches = matches.filter(function (a) { return !a.metro; });
        matches = matches.slice(0, AC_LIMIT);
        idx = matches.length ? 0 : -1;
        paint();
    }

    function commit(i) {
        var a = matches[i];
        if (!a) return;
        close();
        onPick(a);
    }

    input.addEventListener('input', refresh);
    input.addEventListener('focus', function () { if (input.value) refresh(); });
    input.addEventListener('blur', function () { setTimeout(close, 140); });
    input.addEventListener('keydown', function (ev) {
        if (ev.key === 'ArrowDown') { ev.preventDefault(); idx = Math.min(idx + 1, matches.length - 1); paint(); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); idx = Math.max(idx - 1, 0); paint(); }
        else if (ev.key === 'Enter') {
            ev.preventDefault();
            if (idx >= 0 && matches[idx]) commit(idx);
            else if (opts.onEnter) opts.onEnter();
        } else if (ev.key === 'Escape') { close(); }
    });
    /* mousedown beats the input's blur so the list is still there; click is what
     * a keyboard Enter and a VoiceOver double-tap actually emit, so both are
     * needed or the suggestions are unusable without a mouse. */
    function activate(ev) {
        var t = ev.target.closest && ev.target.closest('[data-ac]');
        if (!t) return;
        ev.preventDefault();
        commit(+t.getAttribute('data-ac'));
    }
    drop.addEventListener('mousedown', activate);
    drop.addEventListener('click', activate);

    return { close: close };
}

/* ------------------------------------------------------------- steps */

var STEPS = ['Where', 'When', 'Who', 'Flights'];

function showStep(n) {
    /* Which way the screen came from. Going to a lower-numbered step is Back,
     * and the CSS slides it in from the opposite edge; landing on step 4 from a
     * shared link has no previous step and reads as forward. */
    document.documentElement.classList.toggle('stepping-back', n < state.step);
    state.step = n;
    /* 5 is the searching screen. It is a step rather than an overlay because it
     * replaces step 3 completely: leaving the half-filled form visible behind a
     * dimmed button was the thing that made the wait read as nothing happening. */
    [1, 2, 3, 4, 5].forEach(function (i) { el('s' + i).classList.toggle('hidden', i !== n); });
    el('s' + n).focus({ preventScroll: true });
    var rail = el('rail');
    /* The rail counts the three questions. Once they are answered -- searching,
     * or looking at the answer -- it has nothing left to say. */
    rail.classList.toggle('hidden', n >= 4);
    if (n < 4) {
        /* The segments are in the markup and only get their class toggled here.
         * Rewriting the innerHTML made each segment arrive already wearing
         * .done, and a transition cannot run on an element created this frame
         * in its end state -- so the 360ms fill on .seg::after never once
         * played. Same rail, same markup; now it actually moves. */
        if (!rail.querySelector('.seg')) {
            rail.innerHTML = STEPS.slice(0, 3).map(function () {
                return '<span class="seg"></span>';
            }).join('') + '<span class="lbl"></span>';
        }
        var segs = rail.querySelectorAll('.seg');
        for (var i = 0; i < segs.length; i++) segs[i].classList.toggle('done', i < n);
        rail.querySelector('.lbl').textContent = STEPS[n - 1];
    }
    /* The footer depends on which step we are on, and several step changes
     * (to2, back2, back3) never reach render(), so it is updated from here as
     * well -- otherwise it shows the previous step's answer. */
    renderFooter();
    window.scrollTo(0, 0);
}

/* "New trip" on the first screen of a brand new trip does nothing at all, and a
 * control that does nothing, on the one screen a first-time user actually
 * reads, teaches them that taps in this app sometimes do not work. While a
 * search is running it is worse than inert: it abandons searches that have
 * already been paid for. So it is shown only when there is a trip to leave. */
function renderFooter() {
    var nb = el('newBtn');
    if (!nb) return;
    var leavable = !state.busy && (!!DATA || state.step > 1);
    nb.classList.toggle('hidden', !leavable);
    /* The interpunct belongs to the pair, so it leaves with the second item. */
    var sep = nb.previousElementSibling;
    if (sep && sep.classList.contains('sep')) sep.classList.toggle('hidden', !leavable);
}

/* ------------------------------------------------------------ parties */

function renderParties() {
    /* Re-rendering throws away whatever is typed in the inputs, and there are
     * eleven call sites -- expecting each to remember to save first is how a
     * name silently disappears the moment you pick an airport. Save here, once,
     * so no caller can lose it. readNames only writes to parties that still
     * exist, so replacing the query wholesale is unaffected. */
    readNames();

    /* The group as a group. The screen that defines the match never said what
     * had been assembled -- no headcount, no city count -- so this is the one
     * line that was added rather than removed.
     *
     * It counts the same thing validate() counts: a party with no airport, or
     * with nothing but closed ones, cannot be flown and is not a city yet. A
     * row holding only KBP would otherwise let this line promise three cities
     * for a group the search is about to refuse. */
    var placed = state.q.parties.filter(function (p) {
        return p.airports.filter(function (c) {
            var a = AIRPORTS.get(c); return a && !a.closed;
        }).length;
    });
    var heads = placed.reduce(function (n, p) { return n + Math.max(1, p.seats || 1); }, 0);
    var whoLine = !placed.length ? ''
        : placed.length < 2
            ? '<p class="party-who">One city so far. It takes two to land together.</p>'
            : '<p class="party-who">' + heads + (heads === 1 ? ' person' : ' people')
                + ' travelling from ' + placed.length + ' cities</p>';

    el('parties').innerHTML = whoLine + state.q.parties.map(function (p, i) {
        var chips = p.airports.map(function (code) {
            var a = AIRPORTS.get(code);
            return '<span class="chip' + (a && a.closed ? ' closed' : '') + '">'
                + '<span class="code">' + esc(code) + '</span>'
                + '<span class="city">' + esc(a ? a.city : 'unknown') + '</span>'
                + '<button data-rmair="' + esc(code) + '" aria-label="Remove ' + esc(code) + '">&times;</button></span>';
        }).join('');

        var closedNote = p.airports.map(function (code) {
            var a = AIRPORTS.get(code);
            if (!a || !a.closed) return '';
            return '<div class="party-note" style="color:var(--bad)">'
                + esc(closedOriginNote(a)) + '</div>';
        }).join('');

        var label = esc(partyLabel(p, i));
        var has = p.airports.length;
        var n = Math.max(1, p.seats || 1);

        /* Seats before an airport mean nothing, so an untouched row does not
         * carry the control at all. At one seat it is a single word; the minus
         * only exists once there is a seat to remove, and both buttons announce
         * the current count because the control is re-rendered on every tap and
         * the live region would otherwise be a brand-new node each time. */
        var seats = !has ? '' : '<div class="stepper" role="group" aria-label="Seats for ' + label + '">'
            + (n > 1
                ? '<button data-seats="-1" aria-label="Remove a seat. ' + n + ' seats for ' + label + '">&minus;</button>'
                    + '<output class="n" aria-live="polite">' + n + ' seats</output>'
                    + '<button data-seats="1" aria-label="Add a seat. ' + n + ' seats for ' + label + '"'
                    + (n >= APP.maxSeats ? ' disabled' : '') + '>+</button>'
                : '<button class="seat-add" data-seats="1" aria-label="One seat. Add a seat for '
                    + label + '">+ seat</button>')
            + '</div>';

        return '<div class="party" data-pid="' + esc(p.id) + '">'
            + '<div class="party-top">'
            + '<div class="ava" aria-hidden="true" style="background:' + partyColor(i) + '">' + esc(partyInitials(p, i)) + '</div>'
            + '<input class="party-name" data-f="name" placeholder="Name" value="' + esc(p.name)
            + '" maxlength="22" aria-label="Name for departure city ' + (i + 1) + '">'
            + '<div class="stepper" role="group" aria-label="Seats for ' + esc(partyLabel(p, i)) + '">'
            + '<button data-seats="-1" aria-label="One fewer seat for ' + esc(partyLabel(p, i)) + '"'
            + (p.seats <= 1 ? ' disabled' : '') + '>&minus;</button>'
            + '<output class="n" aria-live="polite">' + esc(p.seats) + '</output>'
            + '<button data-seats="1" aria-label="One more seat for ' + esc(partyLabel(p, i)) + '"'
            + (p.seats >= APP.maxSeats ? ' disabled' : '') + '>+</button>'
            + '</div>'
            + (state.q.parties.length > 2
                ? '<button class="party-x" data-rmparty aria-label="Remove ' + label + '">&times;</button>' : '')
            + '</div>'
            + '<div class="party-air">'
            + '<div class="chips">' + chips
            + '<button class="add-air' + (has ? ' more' : '') + '" data-addair aria-label="'
            + (has ? 'Add another airport for ' : 'Pick a departure airport for ') + label
            + '">' + (has ? '+ airport' : '+ Add departure airport') + '</button>'
            + '</div>'
            + seats
            + '</div>'
            + '<div class="field hidden party-airfield" data-airfield>'
            + '<input class="inp" data-airinput placeholder="Airport or city" autocapitalize="characters"'
            + ' autocomplete="off" aria-label="Add an airport for ' + label + '">'
            + '<div class="ac" data-airac></div></div>'
            + closedNote
            + '</div>';
    }).join('');

    /* Autocomplete is attached per card after each rebuild. */
    Array.prototype.forEach.call(document.querySelectorAll('.party'), function (card, ci) {
        var pid = card.getAttribute('data-pid');
        var input = card.querySelector('[data-airinput]');
        var drop = card.querySelector('[data-airac]');

        /* The avatar used to say the party number, so there was never anything
         * for it to catch up with. Now that it says the initials and nothing
         * else, it has to track the field as it is typed: readNames() only runs
         * on the next render, so without this the disc stayed a blank ring for
         * the whole session until some unrelated action happened to rebuild the
         * list. Writing straight to the one node keeps the keyboard up and the
         * caret where it is, which a re-render would not. */
        var nameInput = card.querySelector('[data-f="name"]');
        var ava = card.querySelector('.ava');
        if (nameInput && ava) {
            nameInput.addEventListener('input', function () {
                var p = party(pid);
                if (!p) return;
                p.name = nameInput.value;
                ava.textContent = partyInitials(p, ci);
            });
        }
        attachAc(input, drop, function (a) {
            /* readNames happens inside renderParties now, but the party lookup
             * below needs current state either way. */
            var p = party(pid);
            if (p) {
                /* A city adds all of its airports: for one traveller that is
                 * still a single search, because the provider accepts them
                 * comma-separated. Naming a city and being made to choose
                 * between JFK, LGA and EWR is a question nobody can answer
                 * before seeing prices. */
                var add = a.metro ? a.members : [a.code];
                add.forEach(function (code) {
                    if (p.airports.indexOf(code) === -1 && p.airports.length < 5) p.airports.push(code);
                });
            }
            renderParties();
            var next = document.querySelector('.party[data-pid="' + pid + '"] [data-addair]');
            if (next) next.focus();
        });
    });
}

function party(pid) {
    return state.q.parties.filter(function (p) { return p.id === pid; })[0] || null;
}

/* Pulls whatever is currently typed in the name inputs back into state. Only
 * touches parties that still exist, so it is safe to call before any render. */

function readNames() {
    Array.prototype.forEach.call(document.querySelectorAll('.party'), function (card) {
        var p = party(card.getAttribute('data-pid'));
        if (p) p.name = card.querySelector('[data-f="name"]').value;
    });
}

/* ------------------------------------------------------------ validate */

function validate() {
    var q = state.q;
    if (!AIRPORTS.isKnown(q.dest)) return 'Pick a destination from the list.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.dep)) return 'Pick your dates first.';
    if (q.ret && q.ret < q.dep) return 'The return date is before the departure date.';
    var withAir = q.parties.filter(function (p) { return p.airports.length; });
    if (withAir.length < 2) return 'At least two people need somewhere to fly from.';
    var dead = [];
    q.parties.forEach(function (p, i) {
        var live = p.airports.filter(function (c) { var a = AIRPORTS.get(c); return a && !a.closed; });
        if (p.airports.length && !live.length) dead.push(partyLabel(p, i));
    });
    if (dead.length) {
        return listOf(dead) + (dead.length > 1 ? ' have ' : ' has ')
            + 'only closed airports. Add one that is open.';
    }
    return null;
}

/* -------------------------------------------------------------- search */

/* Returns a promise that settles once the result (or the failure) has been
 * rendered, so a caller that changed part of the query can put it back when the
 * search did not land. It never rejects: every failure path ends in
 * state.error, which is what callers read. */
function doSearch() {
    readNames();

    /* Validate before touching the query: a failed search must not silently eat
     * the cards someone has half-filled in. */
    var bad = validate();
    if (bad) {
        state.error = bad; render();
        /* The notice lives at the top of the page; on a phone the button that
         * triggered it is at the bottom, so the message was simply off-screen. */
        el('nErr').scrollIntoView({ block: 'center', behavior: 'smooth' });
        return Promise.resolve();
    }

    /* Only now drop the cards with no airport, so ids, totals and the plan all
     * agree on who is actually travelling. */
    state.q.parties = state.q.parties.filter(function (p) { return p.airports.length; });
    renderParties();

    /* Starting a new trip while a search is in flight used to be a trap: the
     * request kept running, came back, and dragged you onto the results of the
     * trip you had just cleared -- computed against a party list that no longer
     * existed, so every traveller came back "no flights found". The response
     * cannot be recalled and the search is already paid for, but it can be
     * ignored, which is what this generation counter is for. */
    var gen = ++searchGen;
    var current = function () { return gen === searchGen; };

    state.error = null; state.busy = true; render();
    writeHash();
    /* Hand the wait its own screen. Everything the search is about is already
     * known here -- the cities, the airports, the destination, the number of
     * searches -- so there is no reason for the seconds it takes to look like
     * nothing is happening. */
    startSearching();

    var tv = travelers().filter(function (t) { return t.origins.length; });
    /* fetch has no timeout of its own, so a connection that opens and then
     * stalls -- the normal failure on a phone moving between cells -- left the
     * app waiting for the rest of the morning. 45s is deliberately generous:
     * sixteen upstream searches for eight people round trip is slow but real,
     * and cutting a live search short is worse than waiting. */
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var killer = ctl ? setTimeout(function () { ctl.abort(); }, 45000) : null;
    var clearKiller = function () { if (killer) { clearTimeout(killer); killer = null; } };
    return fetch(API + '/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: ctl ? ctl.signal : undefined,
        body: JSON.stringify({
            dest: [state.q.dest], depart: state.q.dep, ret: state.q.ret || null,
            travelers: tv.map(function (t) {
                /* Closed airports are dropped before the request: they return
                 * nothing and would just burn a search to prove it. */
                return { id: t.id, name: t.name, bags: t.bags,
                         origins: t.origins.filter(function (c) {
                             var a = AIRPORTS.get(c); return a && !a.closed;
                         }) };
            })
        })
    }).then(function (r) {
        clearKiller();
        return r.json().then(function (j) { return { ok: r.ok, body: j }; });
    }).then(function (res) {
        /* The budget figure is true regardless of who is still waiting for it,
         * so it is taken before the abandonment check -- the allowance was spent
         * either way and the notices should say so. */
        if (res.body.budget) {
            BUDGET = res.body.budget;
            BUDGET.low = BUDGET.used > BUDGET.limit * 0.8;
            BUDGET.exhausted = BUDGET.used >= BUDGET.limit;
        }
        if (!current()) return;
        state.busy = false;
        stopSearching();
        /* A failure has to put the form back. The error notice lives at the top
         * of the page, and leaving it on the searching screen would have printed
         * it above a list of people who are no longer being searched for. */
        if (!res.ok) {
            state.error = res.body.error || 'Search failed.';
            showStep(3); render();
            el('nErr').scrollIntoView({ block: 'center', behavior: 'smooth' });
            return;
        }
        DATA = res.body;
        SHIFTS = {}; shiftErr = null; TRIP_ID = null;
        thReset(); state.leg = 'outbound';
        /* Remember who went, now that a real search has confirmed they are a
         * real group. Written after DATA is set so saveGroup can tell the
         * example apart from a search. */
        saveGroup();
        showStep(4); render();
    }).catch(function (e) {
        clearKiller();
        if (!current()) return;
        state.busy = false;
        stopSearching();
        /* An abort is not "the service is down", and more importantly it is not
         * free: the searches were already sent upstream and counted against the
         * month, so telling somebody to simply try again would quietly spend the
         * allowance twice for one trip. Say what happened and let them choose. */
        state.error = (e && e.name === 'AbortError')
            ? 'The search took longer than 45 seconds and was given up on. '
              + 'It may still have counted against this month’s searches, '
              + 'so check your connection before trying it again.'
            : 'Could not reach the search service: ' + ((e && e.message) || 'unknown error');
        showStep(3); render();
        el('nErr').scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
}

function loadDemo() {
    fetch('flights.json', { cache: 'no-store' }).then(function (r) { return r.json(); })
        .then(function (sample) {
            /* Built from blankQuery so the example cannot drift from the real
             * thing. It had already lost avoid, maxDetour, clusterReturn and
             * maxPremium by being a hand-written literal, and the first of
             * those threw the moment anyone touched the airline filter. */
            state.q = blankQuery();
            state.q.dest = 'PIT';
            state.q.dep = '2027-02-12';
            state.q.ret = '2027-02-15';
            state.q.parties = [
                { id: 'alex', name: 'Alex', seats: 1, airports: ['SFO', 'OAK', 'SJC'] },
                { id: 'sam', name: 'Sam', seats: 2, airports: ['ORD'] },
                { id: 'jo', name: 'Jo', seats: 1, airports: ['ATL'] },
                { id: 'ray', name: 'Ray', seats: 1, airports: ['DEN'] }
            ];
            DATA = { generated_at: sample.generated_at, currency: sample.currency,
                     sample: true, trips: { query: sample.trips['pit-feb'] }, errors: [] };
            state.error = null; thReset(); state.leg = 'outbound';
            fillForm(); renderParties(); showStep(4); render();
        })
        .catch(function (e) {
            if (window.console) console.error('example failed', e);
            state.error = 'Could not load the example. Try reloading the page.';
            render();
        });
}

/* --------------------------------------------------------- searching */

/* The wait is the one moment this app is doing something Google Flights cannot,
 * and it was the one moment the app said nothing: the button dimmed and the
 * half-filled form stayed on screen. Everything below exists to make those
 * seconds read as the group converging, and to do it without claiming a single
 * thing that is not measured. */
var sxTimer = null, sxStart = 0;

/* A search is billed per party per leg -- four cities round trip is eight, and
 * eight people round trip is sixteen. That is the honest shape of the wait and
 * the reason it is not instant, so it is the number to put on the screen. */
function searchCount() {
    var n = travelers().filter(function (t) { return t.origins.length; }).length;
    return n * (hasReturn() ? 2 : 1);
}

function sxTick() {
    var foot = el('sxFoot');
    if (!foot || state.step !== 5) return;
    var secs = Math.max(0, Math.round((Date.now() - sxStart) / 1000));
    var n = searchCount();
    /* The clock is aria-hidden and the two spans are separated by real
     * whitespace. Without the first, a polite live region re-announces the
     * whole foot once a second, which is not reassurance, it is a barrier.
     * Without the second, the computed text ran together as "6 flight
     * searches0s". What a screen reader should hear is the count once, and
     * then the slow note if and when it appears. */
    foot.innerHTML = '<span>' + n + (n === 1 ? ' flight search' : ' flight searches')
        + '</span> <span class="sx-el" aria-hidden="true">' + secs + 's</span>'
        + (secs >= 12
            ? '<div class="sx-slow">Still going. Every city is searched for both legs, '
              + 'and a slow connection makes that take a while.</div>'
            : '');
}

function renderSearching() {
    var a = AIRPORTS.get(state.q.dest);
    el('sxDest').textContent = a ? a.city : (state.q.dest || '');
    el('sxCode').textContent = a ? a.code : '';
    el('sxWhen').textContent = state.q.dep
        ? prettyRange(state.q.dep, state.q.ret) + (hasReturn() ? '' : ' · one way')
        : '';

    var ids = state.q.parties.map(function (p) { return p.id; });
    el('sxRows').innerHTML = travelers()
        .filter(function (t) { return t.origins.length; })
        .map(function (t, i) {
            var k = ids.indexOf(t.id), p = state.q.parties[k] || {};
            /* Names are optional and most people never type one, so the common
             * case must read well without them. partyLabel() would say
             * "Flight 1", which on a screen about cities converging is worse
             * than the city sitting right underneath it -- so an unnamed row is
             * headed by where it is leaving from, which is also how step 3 now
             * reads it back ("SFO  San Francisco"). */
            var first = AIRPORTS.get(t.origins[0]);
            var heading = (p.name || '').trim()
                || (first ? first.city : t.origins[0]);
            return '<div class="sx-row">'
                + '<div class="ava" aria-hidden="true" style="background:' + partyColor(k) + '">'
                + esc(partyInitials(p, k)) + '</div>'
                + '<div class="sx-main"><div class="sx-name">' + esc(heading) + '</div>'
                + '<div class="sx-from">' + esc(t.origins.join(' · '))
                + (t.seats > 1 ? ' · ' + t.seats + ' seats' : '') + '</div></div>'
                /* Staggered so the marks read as a sequence of searches rather
                 * than one synchronised blink, which looks like a progress bar
                 * and would be promising progress we cannot see. */
                + '<div class="sx-wait" style="animation-delay:'
                + (i * 0.13).toFixed(2) + 's"></div></div>';
        }).join('');
    sxTick();
}

function startSearching() {
    sxStart = Date.now();
    showStep(5);
    renderSearching();
    if (sxTimer) clearInterval(sxTimer);
    sxTimer = setInterval(sxTick, 1000);
}

function stopSearching() {
    if (sxTimer) { clearInterval(sxTimer); sxTimer = null; }
}

/* ---------------------------------------------------------------- hash */

/* The link carries the decision as well as the search. Without this, the fifth
 * person opens it and their own device picks a different recommended row and a
 * different target, so the group is arguing about two different numbers. */
function hashPayload() {
    return {
        q: state.q,
        v: { th: { outbound: state.th.outbound === FWF.INF ? 'inf' : state.th.outbound,
                    return: state.th.return === FWF.INF ? 'inf' : state.th.return },
             /* Which of the named matches the sender was looking at. Without
              * it the fifth person opens the link, their device resolves the
              * default, and the group argues about two totals -- the same
              * failure the threshold above is carried for. */
             match: state.match,
             leg: state.leg, recommend: state.recommend,
             target: SET.target, bags: SET.bags, priceDisplay: SET.priceDisplay }
    };
}
function writeHash() {
    try {
        var enc = btoa(unescape(encodeURIComponent(JSON.stringify(hashPayload())))).replace(/=+$/, '');
        history.replaceState(null, '', '#s=' + enc);
    } catch (e) {}
}
function tripIdFromHash() {
    var m = /[#&]t=([a-z2-9]{4,16})/.exec(location.hash || '');
    return m ? m[1] : null;
}

function readHash() {
    var m = /[#&]s=([^&]+)/.exec(location.hash || '');
    if (!m) return null;
    try {
        var o = JSON.parse(decodeURIComponent(escape(atob(m[1]))));
        /* Older links carried the bare query. */
        return o && o.parties ? { q: o, v: null } : o;
    } catch (e) { return null; }
}
function shareUrl() {
    if (TRIP_ID) return location.origin + location.pathname + '#t=' + TRIP_ID;
    try {
        return location.origin + location.pathname + '#s='
            + btoa(unescape(encodeURIComponent(JSON.stringify(hashPayload())))).replace(/=+$/, '');
    } catch (e) { return location.href; }
}

/* Saves the finished trip so a shared link costs one read rather than a fresh
 * search for every person who opens it. Returns a promise for the short url. */
function saveTrip() {
    if (TRIP_ID) return Promise.resolve(shareUrl());
    if (!DATA || DATA.sample || savingTrip) return Promise.resolve(shareUrl());
    savingTrip = true;
    return fetch(API + '/trip', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ v: 1, data: DATA, payload: hashPayload() })
    }).then(function (r) { return r.json(); }).then(function (j) {
        savingTrip = false;
        if (j && j.id) { TRIP_ID = j.id; history.replaceState(null, '', '#t=' + j.id); }
        return shareUrl();
    }).catch(function () { savingTrip = false; return shareUrl(); });
}

/* -------------------------------------------------------------- render */

/* Both legs priced together. A one-way shows one number; a round trip shows the
 * number people actually care about, which is what the trip costs. */
/* Per leg: what each party pays, and whether they are inside the window.
 * Everyone is priced -- someone the filters excluded still buys a ticket, and a
 * "total" that silently drops them is the deceptive version of this number. */
/* ------------------------------------------------------- the way home
 *
 * The return used to be clustered like the outbound, and that was turned off
 * after a real complaint: forcing it into a window picked absurd flights home
 * to hit a departure time. The note left behind was "landing together is the
 * point; leaving together only means sharing a ride to the airport".
 *
 * Both halves of that have since stopped being true, and it is worth writing
 * down which, because the conclusion reverses.
 *
 * The absurd flights were a PRUNING problem, and pruning fixed them. maxDetour
 * caps how much longer than their own quickest anybody may be asked to fly,
 * betterOnTie stops a two-stop winning a price tie, and the ULCC margin stops a
 * fare that is only cheap until you carry a bag. With those in place, clustering
 * the return never produces the flight that caused the complaint: across the
 * generated groups in test-return.js it adds a connection zero times. Turn
 * maxDetour off again and somebody flies more than 90 minutes past their own
 * quickest in 45% of those same groups. The unclustered default was a second
 * patch for a wound the pruning had already closed.
 *
 * And it is not "only a shared ride". Priced out, leaving together is close to
 * free -- a median of about a dollar a seat -- while flying home separately puts
 * the typical group thirteen hours apart and, because cheapest means the worst
 * hour of the day, hands one party in five a departure before 07:00 that saved
 * them five dollars. Clustering the way home buys back somebody's morning.
 *
 * So the default is to leave together, and the honest part is the price. The
 * group spends up to a stated budget to do it; past that, or if no window is
 * reachable without asking somebody to fly materially worse, they fly home
 * separately and the screen says so with the number attached.
 *
 * Per seat because that is the unit anybody judges it in -- "four dollars each"
 * is a decision, "twenty-three dollars" is a number -- with a floor-relative
 * term so a group on long-haul fares is not held to a domestic allowance. */
var RETURN_BUDGET_PER_SEAT = 12, RETURN_BUDGET_PCT = 0.03;

/* Both ways home, priced the same way, so the screen can name the one it did
 * not take instead of hiding it behind a link. Memoised per leg because it is
 * asked for once per ladder row; render() clears it when any filter moves. */
var returnTh = {};
function returnWays(ctx) {
    var key = ctx.leg + '|' + (ctx.ids || []).join(',');
    if (returnTh[key] !== undefined) return returnTh[key];

    var floor = FWF.minCostAtWindow(ctx.prep, FWF.INF, ctx.costFn);
    var ways = { apart: FWF.INF, together: FWF.INF, floor: floor, budget: 0, reach: null };
    if (!floor || !ctx.ladder) { returnTh[key] = ways; return ways; }

    var seats = (ctx.travelers || []).reduce(function (n, t) { return n + (t.seats || 1); }, 0);
    ways.budget = Math.max(RETURN_BUDGET_PER_SEAT * seats, RETURN_BUDGET_PCT * floor.cost);

    /* ladder() has already dropped every row that buys nothing, so the rows here
     * run tightest-first at strictly falling cost. That is what makes both the
     * first-match below and the knee further down well defined. */
    var rows = ctx.ladder.rows.filter(function (r) {
        return r.feasible && r.threshold !== FWF.INF;
    });

    /* Flying home separately, tightened for free: same money as no window at
     * all, so a group that asks for separate flights still gets the closest
     * version of them. */
    for (var i = 0; i < rows.length; i++) {
        if (rows[i].result.cost <= floor.cost) { ways.apart = rows[i].threshold; break; }
    }

    /* Leaving together. Only windows that ask nobody to fly materially worse
     * than they would alone -- the return never buys closeness with somebody's
     * connection -- and only inside the budget. */
    var fair = rows.filter(function (r) {
        return worthIt(regretOf(ctx, r.result.picks))
            && r.result.cost <= floor.cost + ways.budget;
    });
    if (fair.length) {
        /* The knee, same rule the outbound uses: the step of looseness that
         * refunds the most money per minute given up. */
        var best = fair[0], rate = -1;
        for (var k = 1; k < fair.length; k++) {
            var add = fair[k].threshold - fair[k - 1].threshold;
            if (add <= 0) continue;
            var r = (fair[k - 1].result.cost - fair[k].result.cost) / add;
            if (r > rate) { rate = r; best = fair[k]; }
        }
        ways.together = best.threshold;
    } else {
        /* Nothing affordable. Keep the tightest fair window anyway, purely so
         * the screen can say what leaving together would have cost rather than
         * leaving the group to wonder. */
        var any = rows.filter(function (r) { return worthIt(regretOf(ctx, r.result.picks)); });
        if (any.length) ways.reach = { th: any[0].threshold, result: any[0].result };
    }

    returnTh[key] = ways;
    return ways;
}

/* Which way home was taken, and why. The screen needs the reason and not just
 * the window, because "flying home separately" has two causes that deserve
 * different sentences: the group asked for it, or it was the only thing inside
 * the budget.
 *
 * clusterReturn is three-valued. true is the default and means "leave together
 * if it is affordable"; 'any' is the group having seen the price and taken it
 * anyway; false is separate flights home. Anything else -- including the
 * undefined in a link shared before the field existed -- normalises to true in
 * migrateQuery. */
function returnChoice(ctx) {
    var w = returnWays(ctx);
    if (state.q.clusterReturn === false) return { how: 'apart', th: w.apart, ways: w };
    if (w.together !== FWF.INF) return { how: 'together', th: w.together, ways: w };
    if (state.q.clusterReturn === 'any' && w.reach) {
        return { how: 'together', th: w.reach.th, ways: w };
    }
    return { how: 'priced-out', th: w.apart, ways: w };
}
function returnThOf(ctx) { return returnChoice(ctx).th; }

function legBreakdown(leg) {
    var ctx = compute(leg);
    if (!ctx) return null;
    /* The return decides its own window -- see returnWays. It is set here rather
     * than read from state so the per-person cards and the headline total can
     * never be priced at two different windows, which is exactly what happened
     * while the trip-level choice strip was also writing to this key. */
    if (leg === 'return') state.th['return'] = returnThOf(ctx);
    var plan = planOf(ctx, state.th[leg] != null ? state.th[leg] : recommendedIn(ctx));
    if (!plan) return null;

    var rows = {};
    plan.included.forEach(function (id) {
        var base = ctx.solo && ctx.solo[id] != null ? ctx.solo[id] : null;
        rows[id] = { cost: plan.picks[id].cost, option: plan.picks[id].option, inWindow: true,
                     premium: base == null ? 0 : Math.round(plan.picks[id].cost - base) };
    });
    (plan.excluded || []).forEach(function (x) {
        var fallback = ctx.soloOpen[x.id];
        if (fallback) {
            rows[x.id] = { cost: fallback.cost, option: fallback.option,
                           inWindow: false, gap: x.gapMinutes };
        }
    });
    /* Anyone the filters removed entirely is still travelling. */
    ctx.ids.forEach(function (id) {
        if (!rows[id] && ctx.soloOpen[id]) {
            rows[id] = { cost: ctx.soloOpen[id].cost, option: ctx.soloOpen[id].option, inWindow: false };
        }
    });

    var everyone = ctx.ids.every(function (id) { return !!rows[id]; });
    return { ctx: ctx, plan: plan, rows: rows, everyone: everyone,
             clustered: plan.included.length, spread: plan.spread,
             total: ctx.ids.reduce(function (n, id) { return n + (rows[id] ? rows[id].cost : 0); }, 0),
             inWindowTotal: plan.cost };
}

/* What a plan costs people in flying, not in money.
 *
 * Money was the only thing the ladder ranked, so a window that cost the same
 * dollars always looked free -- even when it put somebody on a connection and
 * six more hours in the air to pull the group from 60 minutes apart to 30. That
 * is the trade that makes somebody open Google Flights, find a better flight in
 * one search, and never come back. Landing together is worth something, but it
 * is not worth arriving wrecked, and the app has to be able to say which.
 *
 * Regret is measured per party against their OWN best, then reported as the
 * worst single person's -- an average would hide the one person being asked to
 * absorb all of it, who is exactly the person who will veto the trip. */
function regretOf(ctx, picks) {
    var worstStops = 0, worstMins = 0, who = null, whoMins = null;
    ctx.ids.forEach(function (id) {
        var pick = picks[id], base = ctx.ownBest && ctx.ownBest[id];
        if (!pick || !pick.option || !base) return;
        var o = pick.option;
        var st = (o.stops == null ? 99 : o.stops) - (base.stops == null ? 99 : base.stops);
        var mn = (o.duration_minutes != null && base.mins != null) ? o.duration_minutes - base.mins : 0;
        if (st > worstStops) { worstStops = st; who = id; }
        if (mn > worstMins) { worstMins = mn; whoMins = id; }
    });
    return { stops: worstStops, mins: worstMins, who: who || whoMins };
}

/* Whether a plan is worth offering as "closer". A connection nobody needed, or
 * an extra hour and a half in the air, is not bought back by 30 minutes of
 * waiting saved at baggage claim. */
function worthIt(r) { return r.stops <= 0 && r.mins <= 90; }

/* The whole decision, priced across both legs at once, as a handful of named
 * choices rather than a ladder folded away below the fold. The first real user
 * reaction to this app was "that's expensive, why can't it show me the cheapest
 * and what the time difference is" -- which the app already knew and hid. */
function tripLadder() {
    var legs = ['outbound'].concat(hasReturn() ? ['return'] : []);
    var ctxs = legs.map(function (l) { return compute(l); });
    if (ctxs.some(function (c) { return !c || !c.prep.complete || !c.ladder; })) return null;

    var rows = [];
    FWF.DEFAULT_THRESHOLDS.forEach(function (T) {
        var total = 0, worst = 0, ok = true, per = {};
        var reg = { stops: 0, mins: 0, who: null }, conn = {}, mins = 0;
        ctxs.forEach(function (c) {
            /* These rows are the OUTBOUND ladder. The return settles its own
             * window once, by its own rule, and is identical in every row -- so
             * it is priced at that window here, and its spread is left out of
             * the row's "apart" figure because it does not vary down the list
             * and would flatten the one number the rows exist to compare.
             *
             * Pricing it at T instead is what used to make the per-person cards
             * disagree with the headline total: the cards render the return at
             * its own window, the headline was quoting it at this row's. The
             * gap ran to $600 on the groups in test-return.js. The two must
             * come from one function or they drift again. */
            var ownWindow = c.leg === 'return';
            var r = FWF.minCostAtWindow(c.prep, ownWindow ? returnThOf(c) : T, c.costFn);
            if (!r) { ok = false; return; }
            total += r.cost;
            if (!ownWindow) worst = Math.max(worst, r.spread);
            var g = regretOf(c, r.picks);
            if (g.stops > reg.stops) { reg.stops = g.stops; reg.who = g.who; }
            if (g.mins > reg.mins) { reg.mins = g.mins; if (!reg.who) reg.who = g.who; }
            c.ids.forEach(function (id) {
                per[id] = (per[id] || 0) + r.picks[id].cost;
                var dm = r.picks[id].option.duration_minutes;
                if (dm != null) mins += dm;
                /* Who ends up on a connection, across both legs. Counted per
                 * person rather than per leg so "two connections" never means
                 * one person changing planes each way. */
                if ((r.picks[id].option.stops || 0) > 0) conn[id] = true;
            });
        });
        if (!ok) return;
        /* Budget is per person, so what matters is the worst-off traveller --
         * a group average would hide exactly the person who cannot afford it. */
        var topPer = 0, topId = null;
        for (var id in per) {
            var t = ctxs[0].travelers.filter(function (z) { return z.id === id; })[0];
            var each = t && t.seats > 1 ? per[id] / t.seats : per[id];
            if (each > topPer) { topPer = each; topId = id; }
        }
        rows.push({ th: T, total: total, worst: worst, per: per, regret: reg,
                    mins: mins, conn: Object.keys(conn),
                    topPer: Math.round(topPer), topId: topId });
    });
    if (!rows.length) return null;

    /* Keep only the rows that actually buy something. A wider window that costs
     * the same or more money is never worth offering -- and neither is a tighter
     * one bought with somebody's connection, which used to be free in this
     * comparison because only dollars were counted. */
    var kept = [], best = Infinity;
    rows.forEach(function (r) {
        if (r.total < best) { kept.push(r); best = r.total; }
    });
    return kept;
}

/* Three honest options: as close as possible, the knee, and the cheapest. */
/* The group wants an answer, not a menu. Three equally-weighted rows made the
 * reader do the optimising -- and the row labelled "as close as they can get"
 * reads as the aspirational one even when it is the worst flight on the page.
 *
 * So this picks one: the knee of the curve, where another dollar stops buying
 * much closeness, restricted to plans that do not ask anybody to fly materially
 * worse than they would alone. Same rule the per-leg recommendation uses. The
 * alternatives stay one tap away rather than competing for attention. */
function tripBest(l) {
    if (!l || !l.length) return null;
    var fair = l.filter(function (r) { return worthIt(r.regret || { stops: 0, mins: 0 }); });
    if (!fair.length) fair = l;
    if (fair.length === 1) return fair[0];

    /* l runs cheapest-last, so walk it tightest-first to measure what each step
     * of looseness refunds. */
    var best = fair[0], rate = -1;
    for (var i = 1; i < fair.length; i++) {
        var added = fair[i].worst - fair[i - 1].worst;
        if (added <= 0) continue;
        var r = (fair[i - 1].total - fair[i].total) / added;
        if (r > rate) { rate = r; best = fair[i]; }
    }
    return best;
}

/* ------------------------------------------------------- named matches */

/* What this screen renders: several named matches, as peers.
 *
 * The owner's complaint was that the app shows one answer and keeps the rest
 * behind filters, so he re-runs the search to find out what else was possible
 * -- and a re-run is a real billed search per party per leg against a 250-a-
 * month allowance. Switching between matches here costs nothing. They are
 * different readings of option sets already in hand; nothing below fetches.
 *
 * ONE ENTRY PER MATCH, and this is the contract the computation has to meet:
 *
 *   key     stable profile id -- 'cheapest', 'balanced', 'route'. Selection is
 *           stored and shared as this string, so it has to survive a
 *           re-render, a filter change and a link opened on another phone.
 *   name    display name, sentence case, no trailing punctuation. Budget 16
 *           characters: it shares a 353px line with the price.
 *   total   group total. Every leg, every seat, every party -- including
 *           anyone the filters excluded, who is still buying a ticket.
 *   topPer  the worst single traveller's cost, per seat. Not an average: an
 *           average hides the one person who cannot afford it.
 *   spread  the worst clustered leg's arrival spread, in minutes, or null when
 *           no leg is being clustered.
 *   mins    total time in the air, summed over every person and every leg.
 *   conn    party ids who change planes on at least one leg.
 *   picks   the per-party picks, keyed by party id.
 *   th      optional. The arrival-window threshold this match is equivalent
 *           to. Only needed for as long as the plan underneath is rendered
 *           from state.th rather than from picks.
 *   plan    optional. A stable signature for the flights themselves. Two
 *           profiles that produced the same trip are collapsed on it; without
 *           it the signature is built from picks.
 *   why     optional. One phrase naming what this match bought, used in place
 *           of the generic line. Only reach for it if the objective is not
 *           expressible as a spread and a count of connections -- the rows are
 *           far easier to compare when every sub-line says the same two things
 *           about a different plan.
 *
 * THE ARRAY ARRIVES RECOMMENDED-FIRST. That order is the priority order: it is
 * what gets kept when the list is capped, and its head is what is selected
 * when nothing has been chosen yet. Display order is by price, which is a
 * different thing and is decided below. */

/* Memoised for the length of one render. The ladder behind it is walked once
 * per threshold per leg, and renderChoices, the default selection and the
 * plan all ask for the same answer. Cleared in render(). */
var MATCHES = null;

/* Two profiles that produced the same flights are one match. "Cheapest" and
 * "Balanced" side by side with identical contents is the version of this
 * screen that makes somebody stop believing any of it. */
function matchSig(m) {
    if (m.plan != null) return String(m.plan);
    if (m.picks) {
        return Object.keys(m.picks).sort().map(function (id) {
            var p = m.picks[id], o = (p && p.option) || p;
            return id + ':' + (o ? [o.from, o.to, o.depart, o.arrive, o.price].join('/') : '-');
        }).join('|');
    }
    return 'th' + m.th;
}

function matchList(raw) {
    var seen = {}, out = [];
    (raw || []).forEach(function (m) {
        if (!m) return;
        var sig = matchSig(m);
        if (seen[sig]) return;
        seen[sig] = true;
        out.push(m);
    });
    /* Capped in priority order, so the recommendation survives the cut. Four is
     * the ceiling: past that this is a search result again, and the owner's
     * other constraint is that there be as little on the screen as possible. */
    out = out.slice(0, 4);
    /* The head of the delivered order is the recommendation, and it is marked
     * before the sort destroys that order. Display order is cheapest-first,
     * which is a different question: a column of prices that runs in order is
     * the whole reason three prices can be compared at a glance rather than
     * read one at a time. */
    if (out.length) out[0].rec = true;
    out.sort(function (a, b) { return a.total - b.total; });
    return out;
}

/* STUB. The profiles themselves -- what "cheapest", "route optimisation" and
 * "balanced" are actually optimising -- are being defined separately, and this
 * function is the seam they land on: replace the body, keep the shape. It is
 * here so the presentation could be built and looked at against real option
 * sets rather than invented numbers, and it derives four honest profiles from
 * the ladder the app already computes. Recommended first. */
function tripMatches() {
    if (MATCHES) return MATCHES;
    var l = tripLadder();
    if (!l || !l.length) { MATCHES = []; return MATCHES; }
    var least = function (f) {
        return l.reduce(function (a, b) { return f(b) < f(a) ? b : a; });
    };
    var row = function (key, nm, r) {
        return r && { key: key, name: nm, total: r.total, topPer: r.topPer,
                      spread: r.worst, mins: r.mins, conn: r.conn,
                      picks: null, th: r.th, plan: 'th' + r.th };
    };
    MATCHES = matchList([
        row('balanced', 'Balanced', tripBest(l)),
        row('cheapest', 'Cheapest', least(function (r) { return r.total; })),
        row('together', 'Closest together', least(function (r) { return r.worst; })),
        row('shortest', 'Least flying', least(function (r) { return r.mins; }))
    ]);
    return MATCHES;
}

/* The selected one. Falls back to the recommendation when nothing has been
 * chosen, or when what was chosen has stopped existing because a filter
 * changed underneath it. */
function matchOf(ms) {
    if (!ms || !ms.length) return null;
    var hit = ms.filter(function (m) { return m.key === state.match; })[0];
    if (hit) return hit;
    return ms.filter(function (m) { return m.rec; })[0] || ms[0];
}

/* The line that has to decide it without a tap, and the reason a tap is not
 * needed. Not gapWords: that spells a gap out for the one line that states the
 * result, and this is a column of gaps, which is the case it was never for.
 *
 * It prints only what DIFFERS across the matches. A fact that is identical on
 * every row cannot decide anything, so printing it three times is three things
 * on the screen that do no work -- and "Alex changes planes" under all three
 * names is exactly that. The division is: the chooser states the differences,
 * the plan below states the trip. Who changes planes is in the itineraries
 * anyway, per person, which is the more useful place for it. */
function matchWhy(m, ms) {
    if (m.why) return m.why;
    var list = (ms && ms.length) ? ms : [m];
    var varies = function (f) {
        var v = String(f(m));
        return list.some(function (o) { return String(f(o)) !== v; });
    };
    var bits = [];
    if (m.spread != null && varies(function (o) { return o.spread; })) {
        bits.push(FWF.fmtGap(m.spread) + ' apart');
    }
    if (varies(function (o) { return (o.conn || []).slice().sort().join(','); })) {
        var n = (m.conn || []).length;
        bits.push(!n ? 'everyone nonstop'
            : n === 1 ? name(m.conn[0]) + ' changes planes'
            : n + ' people change planes');
    }
    /* Neither told them apart, so say it in time in the air. Something always
     * differs: two matches that differ in nothing were collapsed into one. */
    if (!bits.length && m.mins != null) bits.push(FWF.fmtGap(m.mins) + ' in the air');
    return bits.join(' · ');
}

/* Choosing one. A different reading of option sets already in hand: no fetch,
 * no billed search, nothing to wait for.
 *
 * And no scrollTo. The jump to the top of the page was there because the
 * choices sat below the plan, so tapping one changed something you could not
 * see; the list now sits above the plan, so the row stays where the thumb left
 * it and the itineraries redraw below it.
 *
 * Focus is restored because innerHTML threw away the element that was just
 * pressed, and with it the only thing that would tell a screen reader what
 * changed. */
function selectMatch(key) {
    state.match = key;
    writeHash(); render();
    var mr = document.querySelector('.mrow.on');
    if (mr && mr.focus) {
        try { mr.focus({ preventScroll: true }); } catch (e) { mr.focus(); }
    }
}

/* Arrow keys inside the list. role="radiogroup" promises them, and an ARIA
 * contract that is announced but not honoured is worse than plain buttons: the
 * screen reader says "2 of 3" and then the arrows do nothing. Selection
 * follows focus, which is what a radio group does; the roving tabindex that
 * goes with it is set in renderChoices. */
document.addEventListener('keydown', function (ev) {
    var k = ev.key, back = k === 'ArrowUp' || k === 'ArrowLeft';
    if (!back && k !== 'ArrowDown' && k !== 'ArrowRight' && k !== 'Home' && k !== 'End') return;
    var cur = ev.target && ev.target.closest && ev.target.closest('.mrow[data-match]');
    if (!cur) return;
    var all = [].slice.call(document.querySelectorAll('.mrow[data-match]'));
    var at = all.indexOf(cur);
    var to = k === 'Home' ? 0
        : k === 'End' ? all.length - 1
        : (at + (back ? -1 : 1) + all.length) % all.length;
    if (!all[to] || to === at) return;
    ev.preventDefault();
    selectMatch(all[to].getAttribute('data-match'));
});

/* One row per match, hairline-separated, the same two facts in the same two
 * places every time. The selected row is the answer and carries the hero
 * number; the others are the identical row with a smaller one. That is what
 * "peers" has to mean if it is to mean anything -- any row can become the big
 * one, and none of them is a footnote to another.
 *
 * This list is also what makes the screen SHORTER. It replaced an amber label,
 * a window sentence, a 40px total, a sentence of prose comparing the pick to
 * the cheapest, and a row of chips -- five kinds of thing saying one answer --
 * with one kind of thing saying three. The prose went because the list says
 * it: "$48 over the cheapest, which lands them 5h 50m apart" is a narration of
 * the row directly above. */
function renderChoices() {
    var host = el('choices');
    var ms = tripMatches();
    /* Emptied, not just hidden. Three prices for a trip that no longer exists,
     * sitting in the DOM above the screen they were computed for, is the kind
     * of thing that comes back as a stale number in somebody's group chat. */
    if (!ms.length) { host.className = 'choices hidden'; host.innerHTML = ''; return; }
    var sel = matchOf(ms);
    /* A list of one is worse than no list: there is nothing to choose, and the
     * selector invites a tap that cannot do anything. */
    var many = ms.length > 1;

    host.className = 'choices';
    host.innerHTML = '<div class="match"'
        + (many ? ' role="radiogroup" aria-label="Matches"' : '') + '>'
        + ms.map(function (m) {
            var on = m.key === sel.key;
            var tag = many ? 'button' : 'div';
            return '<' + tag + ' class="mrow' + (on ? ' on' : '') + '"'
                + (many ? ' data-match="' + esc(m.key) + '" role="radio"'
                        + ' aria-checked="' + (on ? 'true' : 'false') + '"'
                        /* Roving: one stop on the Tab path for the whole group,
                         * and the arrows move inside it. */
                        + ' tabindex="' + (on ? '0' : '-1') + '"' : '')
                + '><span class="m-main">'
                + '<span class="m-n">' + esc(m.name) + '</span>'
                + '<span class="m-s">' + esc(matchWhy(m, ms)) + '</span>'
                + '</span><span class="m-right">'
                + '<span class="m-v mono">' + money(m.total) + '</span>'
                /* Only under the selected total. It is a can-everyone-afford-
                 * this check on the trip being shown, not a fifth number to
                 * rank the others by -- it tracks the total anyway. */
                + (on ? '<span class="m-e mono">' + money(m.topPer) + ' each at most</span>' : '')
                + '</span></' + tag + '>';
        }).join('')
        + '</div>';
}

/* What the trip costs, for everybody, both ways. */
function tripTotal() {
    if (!DATA || !state.q) return null;
    var out = legBreakdown('outbound');
    if (!out) return null;
    var back = hasReturn() ? legBreakdown('return') : null;

    var perPerson = {};
    (out.ctx.ids).forEach(function (id) {
        var o = out.rows[id], b = back ? back.rows[id] : null;
        perPerson[id] = {
            out: o ? o.cost : null, back: b ? b.cost : null,
            total: (o ? o.cost : 0) + (b ? b.cost : 0),
            outInWindow: o ? o.inWindow : false,
            backInWindow: b ? b.inWindow : true
        };
    });

    return {
        out: out.total, back: back ? back.total : null,
        total: out.total + (back ? back.total : 0),
        everyone: out.everyone && (!back || back.everyone),
        allClustered: (out.plan.excluded || []).length === 0
            && (!back || (back.plan.excluded || []).length === 0),
        perPerson: perPerson, legOut: out, legBack: back
    };
}

function render() {
    /* Cleared every pass: the memo is keyed by leg and party, but the option
     * sets it summarises change whenever a filter does. */
    returnTh = {};
    C = compute();
    renderNotices();
    renderGear();
    el('go').textContent = state.busy ? 'Searching…' : 'Land them together';
    el('go').setAttribute('aria-disabled', state.busy ? 'true' : 'false');
    el('go').setAttribute('aria-busy', state.busy ? 'true' : 'false');
    el('go').classList.toggle('busy', state.busy);
    renderFooter();
    if (state.step !== 4) return;
    if (!C) { showStep(3); return; }
    /* The selected match is what the plan is printed from, so its quoted total
     * and the itineraries underneath it are the same trip. Resolved before
     * tripTotal() because tripTotal() reads state.th. Falls back to the per-leg
     * recommendation when no match can be built at all -- which happens when
     * one leg has somebody with no options. */
    var sel0 = matchOf(tripMatches());
    if (sel0) {
        state.match = sel0.key;
        if (sel0.th != null) thBoth(sel0.th);
    } else if (thGet() === null && C.ladder) thSet(recommendedIn(C));
    renderResHead();
    /* The plan is rendered from TRIP, so it still has to be computed -- it just
     * no longer prints a panel of its own. */
    TRIP = tripTotal();
    if (!TRIP) {
        /* The plan was cleared here and nothing else was, so the pick card from
         * the previous filter stayed on screen -- "$1,788, everyone lands within
         * 20 minutes" sitting directly under "No total until everyone has a
         * flight". The controls still have to render, because loosening one of
         * them is the only way out of this state. */
        el('planView').innerHTML = '';
        el('choices').className = 'choices hidden';
        el('shifts').className = 'shifts hidden';
        el('shareBox').innerHTML = '';
        renderStopPills();
        return;
    }
    renderChoices();
    renderStopPills();
    renderPlanView();
    renderShifts();
    renderShare();
}

function renderGear() {
    var g = el('gearBtn');
    if (SET.meId) {
        var t = travelers().filter(function (x) { return x.id === SET.meId; })[0];
        if (t) {
            var i = state.q.parties.map(function (p) { return p.id; }).indexOf(SET.meId);
            g.style.background = partyColor(i);
            g.style.borderColor = partyColor(i);
            g.innerHTML = '<span class="ini">'
                + esc(partyInitials(state.q.parties[i], i)) + '</span>';
            return;
        }
    }
    g.style.background = '';
    g.style.borderColor = '';
    g.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<circle cx="12" cy="12" r="3"/>'
        + '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
}

function renderNotices() {
    var s = el('nSample');
    if (DATA && DATA.sample) {
        s.className = 'notice warn';
        /* "so you can see how it works" was the app narrating its own demo. */
        s.innerHTML = '<b>Example data.</b> These fares are invented. '
            + 'Start a new trip to search for real.';
    } else s.className = 'notice hidden';

    var st = el('nStale'), gen = DATA && DATA.generated_at ? new Date(DATA.generated_at) : null;
    var days = gen ? Math.floor((Date.now() - gen.getTime()) / 86400000) : null;
    if (DATA && !DATA.sample && days != null && days >= 10) {
        st.className = 'notice warn';
        st.innerHTML = '<b>These fares are ' + days + ' days old.</b> Search again before anyone books.';
    } else st.className = 'notice warn hidden';

    /* The standing allowance notice below says this already, and in better
     * words than the provider's own 429 body. Two red bars saying one thing is
     * how a reader stops reading either. */
    var dupQuota = !!(state.error && BUDGET && BUDGET.exhausted
        && /allowance|flight-data/i.test(state.error));
    var e = el('nErr');
    if (state.error && !dupQuota) { e.className = 'notice bad'; e.innerHTML = esc(state.error); }
    else e.className = 'notice bad hidden';

    /* Nobody is rationed per person, so the only thing worth saying is when the
     * shared allowance is nearly gone -- which is the signal to upgrade rather
     * than to start turning people away. */
    var q = el('nQuota');
    if (BUDGET && BUDGET.exhausted) {
        /* The date arrived as 2026-11-01 and went to the screen that way. ISO
         * belongs in the data; every other date in the app is "Nov 1". */
        q.className = 'notice bad';
        q.innerHTML = '<b>Out of searches until ' + esc(prettyDate(BUDGET.resetsAt) || 'next month')
            + '.</b> Shared links still open, and so does anything already searched.';
    } else if (BUDGET && BUDGET.low) {
        var left = Math.max(BUDGET.limit - BUDGET.used, 0);
        q.className = 'notice warn';
        q.innerHTML = '<b>' + left + (left === 1 ? ' search' : ' searches') + ' left this month.</b> '
            + 'Opening a shared link does not use one.';
    } else q.className = 'notice warn hidden';

    var sh = el('nShort');
    if (state.step === 4 && C && C.prep && !C.prep.complete) {
        /* A party emptied by the airline filter has flights, just none we are
         * allowed to offer -- so it belongs with "can't meet your filters", not
         * with "no flights found", which would read as a search failure. */
        var byRule = (C.blocked || []).map(function (b) { return b.id; });
        var blocked = C.prep.missing.filter(function (id) {
            return (C.prep.dropped || {})[id] > 0 || byRule.indexOf(id) > -1;
        });
        var none = C.prep.missing.filter(function (id) { return blocked.indexOf(id) === -1; });
        var bits = [];
        if (blocked.length) {
            /* "your filters" named a thing that appears nowhere on screen, and
             * "Loosen one above" pointed up the page at a panel that is below
             * this notice -- the controls live under the plan, not over it. */
            bits.push('<b>' + (blocked.length === C.ids.length
                    ? 'Nobody can fly any of these.'
                    : esc(nameList(blocked)) + ' can’t fly any of these.')
                + '</b> There are flights, just none that ' + esc(filterText())
                + '. Loosen the search below.');
        }
        if (none.length) {
            bits.push('<b>No flights for ' + esc(nameList(none)) + ' on the way '
                + (state.leg === 'outbound' ? 'out' : 'home') + '.</b> '
                + 'Try other dates, or another airport.');
        }
        /* One short fact instead of a paragraph about why a partial total would
         * be dishonest. The reader can see the plan is short; they only need to
         * know the money is not on screen yet. */
        bits.push('No total until everyone has a flight.');
        sh.className = 'notice bad';
        sh.innerHTML = bits.join('<br><br>');
    } else sh.className = 'notice bad hidden';
}

function name(id) {
    var t = (C && C.travelers || []).filter(function (x) { return x.id === id; })[0];
    return t ? t.name : id;
}
function legVerb() { return state.leg === 'outbound' ? 'land' : 'leave'; }
/* Sentence-ready, and on the reader's clock. This printed raw 24-hour strings
 * from the band inputs, so a 12-hour user was told "land between 05:00–12:00",
 * and the en dash sat in the middle of a sentence where "and" belongs. */
function bandText() {
    var b = currentBand();
    var f = FWF.parseTimeOfDay(b.from), t = FWF.parseTimeOfDay(b.to);
    if (f != null && t == null) return 'after ' + clock(f);
    if (f == null && t != null) return 'by ' + clock(t);
    if (f == null && t == null) return '';
    return 'between ' + clock(f) + ' and ' + clock(t);
}
function filterText() {
    var bits = [];
    if (C.band && bandText()) bits.push(legVerb() + ' ' + bandText());
    if (C.maxStops === 0) bits.push('are nonstop');
    else if (C.maxStops != null) bits.push('have at most ' + esc(C.maxStops) + ' stop');
    if (C.cap != null) bits.push('cost them no more than ' + money(C.cap) + ' over their own cheapest');
    if ((state.q.avoid || []).length) bits.push('avoid ' + esc(avoidedNames().join(', ')));
    return bits.join(' and ');
}

function renderResHead() {
    /* If the month's allowance ran out while the field was open -- the budget
     * is refreshed in the background -- take the field away rather than leave
     * one that cannot do anything. */
    if (destEditing && BUDGET && BUDGET.exhausted) destEditClose(false);
    var q = state.q, a = AIRPORTS.get(q.dest);
    var seats = travelers().reduce(function (n, t) { return n + t.seats; }, 0);
    var city = a ? a.city : q.dest;
    /* The city is the control, not a label. It drops back to plain text when a
     * new search could not run anyway -- one is already in flight, or the
     * month's allowance is gone and the notice above already says so -- because
     * a tap that leads nowhere is worse than no tap at all. */
    el('resT').innerHTML = (canRetarget()
            ? '<button class="dest-btn" id="destBtn" aria-label="Change destination, currently '
                + esc(city) + '">' + esc(city) + '</button>'
            : esc(city))
        /* British spelling in the one place the app counts people, next to an
         * en-dash date range and a dollar total. "people" needs no spelling
         * decision and is the word the group uses. */
        + ' · ' + seats + ' people';
    var gen = DATA.generated_at ? new Date(DATA.generated_at) : null;
    var hrs = gen ? Math.round((Date.now() - gen.getTime()) / 3600000) : null;
    /* Mid-retarget the title already reads as the new city, so the status line
     * has to say the fares underneath are not it yet. The freshness chip is
     * where this screen already keeps "how much should I trust this", so the
     * word goes there rather than into a line of its own. */
    var cls = state.busy ? 'fresh-sample'
        : DATA.sample ? 'fresh-sample'
        : hrs == null ? 'fresh-mid' : hrs < 6 ? 'fresh-ok' : hrs < 24 ? 'fresh-mid' : 'fresh-old';
    var word = state.busy ? 'searching…'
        : DATA.sample ? 'example data'
        : hrs == null ? 'age unknown' : hrs < 1 ? 'fares just now' : 'fares ' + hrs + 'h old';
    el('resS').innerHTML = esc(prettyRange(q.dep, q.ret))
        + ' &nbsp;<span class="fresh"><span class="dot ' + cls + '"></span>' + esc(word) + '</span>';
}

/* ------------------------------------------------- retarget the trip */

/* Typing a different city in the header is a whole new search: one per party
 * per leg, so eight people on a round trip is sixteen. It is deliberately not
 * gated behind a confirmation -- the owner's line is upgrade rather than
 * ration, and a group searching hard is the point of the thing. What it is
 * gated behind is intent: opening the field costs nothing and Escape puts it
 * back, so a thumb that brushes the header has spent nothing. The spend
 * happens only when an airport is chosen from the list. */
var destEditing = false, destEditAc = null, destEditErr = false;

function canRetarget() {
    return !state.busy && !(BUDGET && BUDGET.exhausted);
}

function destEditOpen() {
    if (!canRetarget() || destEditing) return;
    destEditing = true;
    var a = AIRPORTS.get(state.q.dest);
    el('resTitle').classList.add('hidden');
    el('resEdit').classList.remove('hidden');
    var inp = el('resDest');
    /* Focused empty, then filled: the autocomplete opens its list on focus when
     * the field has text, and a list whose only entry is where you are already
     * going is noise. Filled and selected means the first keystroke replaces
     * it, which is what "type another city in here" means. */
    inp.value = '';
    inp.focus();
    inp.value = a ? a.code : (state.q.dest || '');
    inp.select();
}

function destEditClose(refocus) {
    if (!destEditing) return;
    destEditing = false;
    if (destEditAc) destEditAc.close();
    el('resEdit').classList.add('hidden');
    el('resTitle').classList.remove('hidden');
    if (destEditErr) {
        /* The closed-airport note belonged to the field. Abandoning the edit
         * takes it with it rather than leaving the results sitting under a red
         * banner about a city nobody is going to. */
        destEditErr = false;
        state.error = null;
        render();
    }
    /* Focus was inside a field that is now gone, so it has to be put back on
     * the thing that opened it or a keyboard user lands at the top of the page. */
    if (refocus) { var b = el('destBtn'); if (b) b.focus(); }
}

function retargetDest(a) {
    /* The autocomplete commits on mousedown and again on click, because a
     * keyboard Enter and a VoiceOver double-tap only emit the latter -- so a
     * mouse pick arrives twice and the second arrival must not buy a second
     * search. By then the first one is already in flight. */
    if (state.busy) return;
    /* A closed airport is still a known airport, so validate() waves it through
     * and the request would spend a search per party per leg to come back with
     * nothing -- doSearch already strips closed airports from the origins for
     * exactly that reason. Step 1 answers this with the note and the
     * alternates; this is the same answer, on the error line the app already
     * owns, with the field left open so the next guess is one keystroke away. */
    if (a.closed) {
        destEditErr = true;
        state.error = closedDestNote(a);
        render();
        el('resDest').focus();
        return;
    }
    /* Picking the city you are already in is not a search. */
    if (a.code === state.q.dest) { destEditClose(true); return; }

    var prev = state.q.dest;
    destEditErr = false;
    destEditClose(false);
    state.error = null;
    state.q.dest = a.code;
    doSearch().then(function () {
        if (!state.error) return;
        /* The search failed, so everything below the header still belongs to the
         * old city. Putting the destination back is the difference between "that
         * did not work" and a screen quietly claiming to be somewhere it is not.
         * doSearch only clears the chosen rows on success, so the plan on screen
         * is still the one that matches this destination. */
        state.q.dest = prev;
        writeHash();
        render();
    });
}

/* Nobody thinks in 24-hour clock times when they are picking a flight -- they
 * think "morning", or "not the middle of the night". Two blank time pickers
 * asked for precision the group does not have yet, so these fill them in. The
 * band itself is unchanged: a preset is a shortcut to the same from/to pair,
 * which keeps one mechanism to reason about and leaves the exact inputs
 * meaningful for the case that actually needs them, like a villa check-in. */
var BAND_PRESETS = [
    { k: 'any',   l: 'Any time',   from: '',      to: ''      },
    { k: 'morn',  l: 'Morning',    from: '05:00', to: '12:00' },
    { k: 'aft',   l: 'Afternoon',  from: '12:00', to: '18:00' },
    { k: 'eve',   l: 'Evening',    from: '18:00', to: '23:00' },
    { k: 'noLate', l: 'Not late night', from: '06:00', to: '23:00' }
];

function presetFor(band) {
    var f = (band && band.from) || '', t = (band && band.to) || '';
    for (var i = 0; i < BAND_PRESETS.length; i++) {
        if (BAND_PRESETS[i].from === f && BAND_PRESETS[i].to === t) return BAND_PRESETS[i].k;
    }
    return 'exact';
}

function bandPresetHtml(cur) {
    return BAND_PRESETS.map(function (x) {
        var on = cur === x.k;
        return '<button class="pill' + (on ? ' on' : '') + '" role="radio" aria-checked="' + on
            + '" data-bpre="' + x.k + '">' + esc(x.l) + '</button>';
    }).join('');
}

function renderBandPresets() {
    var cur = presetFor(state.q.band.outbound);

    /* Also on the results screen, where you can see the plan you are
     * constraining. The click handler sets the step-2 inputs, which are in the
     * DOM on every step, so one handler serves both copies. The exact-time
     * pickers stay on the step that has room for them. */
    var res = el('bandPills');
    if (res) {
        res.setAttribute('role', 'radiogroup');
        res.setAttribute('aria-label', 'Landing time');
        res.innerHTML = '<span class="k">Landing time</span>' + bandPresetHtml(cur);
    }


}

function renderStepStops() {
    renderBandPresets();
    var host = el('sStops');
    if (!host) return;
    var o = [{ v: 0, l: 'Nonstop' }, { v: 1, l: 'Up to 1 stop' }, { v: null, l: 'Any' }];
    host.innerHTML = o.map(function (x) {
        var on = state.q.maxStops === x.v;
        return '<button class="pill' + (on ? ' on' : '') + '" role="radio" aria-checked="' + on
            + '" data-stops="' + (x.v === null ? '' : x.v) + '">' + x.l + '</button>';
    }).join('');
}

function renderStopPills() {
    renderAirlinePills();
    renderBandPresets();
    var o = [{ v: 0, l: 'Nonstop' }, { v: 1, l: 'Up to 1 stop' }, { v: null, l: 'Any' }];
    el('stopPills').setAttribute('role', 'radiogroup');
    el('stopPills').setAttribute('aria-label', 'Maximum stops');
    el('stopPills').innerHTML = '<span class="k">Stops</span>' + o.map(function (x) {
        var on = state.q.maxStops === x.v;
        return '<button class="pill' + (on ? ' on' : '') + '" role="radio" aria-checked="' + on
            + '" data-stops="' + (x.v === null ? '' : x.v) + '">' + x.l + '</button>';
    }).join('');
}

/* The display names of the carriers currently being avoided, for the sentence
 * that explains why somebody has no flights. */
function avoidedNames() {
    var all = carriersInResults(), out = [];
    (state.q.avoid || []).forEach(function (k) {
        var hit = all.filter(function (c) { return c.key === k; })[0];
        out.push(hit ? hit.name : k);
    });
    return out;
}

function renderAirlinePills() {
    var host = el('airlinePills');
    if (!host) return;
    var carriers = carriersInResults();
    /* Nothing to choose between with a single carrier on the route. */
    if (carriers.length < 2) { host.className = 'pills airlines hidden'; return; }
    host.className = 'pills airlines';

    var present = {};
    carriers.forEach(function (c) { if (c.alliance) present[c.alliance] = true; });
    var shown = ALLIANCES.filter(function (a) { return present[a.k]; });
    var avoiding = (state.q.avoid || []).length;

    host.innerHTML = '<span class="k">Airlines</span>'
        + '<div class="air-row">'
        + carriers.map(function (c) {
            var off = isAvoided(c.name);
            /* The name stays put and aria-pressed carries the state. It used to
             * be the other way round: the label flipped to "Allow American" at
             * the same moment aria-pressed went true, so a screen reader was
             * told "Allow American, pressed" about an airline nobody is flying.
             * The label also replaces the content, which was "American8" --
             * .air-n is an option count, not part of the airline's name. */
            return '<button class="pill air' + (off ? ' off' : '') + '" data-air="' + esc(c.key)
                + '" aria-pressed="' + off + '"'
                + ' aria-label="Avoid ' + esc(c.name) + '"'
                + ' title="Avoid ' + esc(c.name) + '">'
                + esc(c.name) + '<span class="air-n">' + c.n + '</span></button>';
        }).join('')
        + '</div>'
        /* Alliances, because "only the one I have status with" is the common
         * version of this request and naming twenty carriers by hand is not a
         * thing anybody will do on a phone. */
        + (shown.length ? '<div class="air-row alli">'
            + shown.map(function (a) {
                /* One bubble, two targets. The ? used to sit outside as its own
                 * circle, which made three alliances read as six controls. It
                 * cannot be a button inside a button, so the bubble is a span
                 * and both halves are buttons within it. */
                return '<span class="alli-g">'
                    + '<button class="alli-b" data-alli="' + a.k + '">Only ' + esc(a.name) + '</button>'
                    + '<button class="qm" data-qm="' + a.k + '" aria-expanded="false"'
                    + ' aria-label="Which airlines are in ' + esc(a.name) + '">?</button>'
                    + '</span>';
            }).join('')
            + (avoiding ? '<button class="pill alli-b clear" data-air-clear="1">Allow all</button>' : '')
            + '</div>'
            + shown.map(function (a) {
                /* Membership moves between alliances, so this prints what we
                 * actually believe rather than asking anyone to trust it. The
                 * ones on this route are marked; the rest are context. */
                return '<div class="qm-pop hidden" id="qm-' + a.k + '">'
                    + '<b>' + esc(a.name) + '</b>'
                    + '<div class="qm-list">' + a.members.map(function (m) {
                        var here = carriers.filter(function (c) { return c.key === normAirline(m); }).length > 0;
                        return '<span' + (here ? ' class="here"' : '') + '>' + esc(m) + '</span>';
                    }).join('') + '</div>'
                    /* The second sentence explained what the button next to it
                     * already says. "Only Star Alliance" is not ambiguous. */
                    + '<div class="qm-f">Bold carriers fly this route.</div></div>';
            }).join('')
            : (avoiding ? '<div class="air-row alli">'
                + '<button class="pill alli-b clear" data-air-clear="1">Allow all</button></div>' : ''));
}


function seatsOf(ids) {
    return (ids || []).reduce(function (n, id) {
        var t = (C.travelers || []).filter(function (x) { return x.id === id; })[0];
        return n + ((t && t.seats) || 1);
    }, 0);
}
function seatsAll() { return seatsOf(C.ids); }

/* The one plan every part of the results screen must agree on. */
function planOf(ctx, th) {
    if (!ctx) return null;
    if (th === 'subset' || !ctx.prep.complete) {
        if (ctx.subset && ctx.subset.included.length) {
            return { picks: ctx.subset.picks, included: ctx.subset.included,
                     excluded: ctx.subset.excluded, spread: ctx.subset.summary.spread,
                     cost: ctx.subset.cost, subset: true };
        }
        return null;
    }
    var row = ctx.ladder && ctx.ladder.rows.filter(function (r) {
        return r.feasible && r.threshold === th;
    })[0];
    var res = row ? row.result : null;
    if (!res && typeof th === 'number') {
        /* Not in the kept rows because it was dominated; still a valid window. */
        res = FWF.minCostAtWindow(ctx.prep, th, ctx.costFn);
    }
    if (!res) return null;
    return { picks: res.picks, included: ctx.ids.slice(), excluded: [],
             spread: res.spread, cost: res.cost, subset: false };
}
function selectedPlan() { return planOf(C, thGet()); }

/* The group total is not what anyone pays. This says whose fare moved. */
function whoPays(plan) {
    if (!plan || !C.solo) return '';
    var rows = (plan.included || C.ids).map(function (id) {
        return { id: id, prem: premiumFor(id, plan.picks[id]) };
    }).filter(function (r) { return r.prem != null && r.prem > 0; })
      .sort(function (a, b) { return b.prem - a.prem; });

    if (!rows.length) return '<div class="note">Nobody pays extra to land together on this plan.</div>';

    var total = rows.reduce(function (n, r) { return n + r.prem; }, 0);
    var top = rows[0];
    var share = total > 0 ? Math.round((top.prem / total) * 100) : 0;

    return '<div class="note"><strong>Who carries it:</strong> '
        + rows.map(function (r) { return esc(name(r.id)) + ' ' + money(r.prem); }).join(', ')
        + (rows.length > 1 && share >= 60
            ? '. That is ' + share + '% of the premium on ' + esc(name(top.id))
              + ' alone — worth deciding before anyone books.'
            : '.')
        + '</div>';
}

function recommendedIn(ctx) {
    if (!ctx || !ctx.ladder) {
        /* No ladder at all means somebody has no options whatsoever on these
         * filters, so a subset is genuinely the only thing left to show. */
        return (ctx && ctx.subset && ctx.subset.included.length) ? 'subset' : null;
    }
    var f = ctx.ladder.rows.filter(function (r) { return r.feasible; });
    if (!f.length) return (ctx.subset && ctx.subset.included.length) ? 'subset' : null;
    /* Missing the target is not a reason to leave someone behind: fall through
     * to the tightest window the whole group can actually make. */
    /* Rows that do not ask anybody to fly materially worse than they would on
     * their own. If every row does, we keep them all rather than recommending
     * nothing -- but then the tightest is no longer automatically the answer. */
    var fair = f.filter(function (r) {
        return r.result && r.result.picks && worthIt(regretOf(ctx, r.result.picks));
    });
    if (!fair.length) fair = f;

    /* "Tightest" is an explicit request, so it is honoured as asked. */
    if (state.recommend === 'tightest') return f[0].threshold;
    if (!ctx.target) return fair[0].threshold;
    if (state.recommend === 'target') {
        var at = f.filter(function (r) { return r.threshold <= SET.target; });
        return (at.length ? at[at.length - 1] : f[0]).threshold;
    }
    var best = fair[0], rate = -1;
    for (var i = 1; i < fair.length; i++) {
        if (fair[i].threshold === FWF.INF) continue;
        var add = fair[i].threshold - fair[i - 1].threshold;
        if (add <= 0) continue;
        var r = (fair[i - 1].result.cost - fair[i].result.cost) / add;
        if (r > rate) { rate = r; best = fair[i]; }
    }
    return best.threshold;
}

/* ------------------------------------------------------------ airlines

 * Alliance membership, so a group can say "only the one I have status with"
 * without naming twenty carriers by hand. Kept as names rather than IATA codes
 * because that is what the search results carry on every option, whereas codes
 * only arrive on a fresh search.
 *
 * Membership moves: SAS left Star Alliance in August 2024 and joined SkyTeam the
 * next day, and Alaska has been oneworld since 2021. Both are wrong in a lot of
 * older lists, which is exactly why the tooltip prints the members -- somebody
 * filtering for their status carrier should be able to see what we believe. */
var ALLIANCES = [
    { k: 'star', name: 'Star Alliance', members: [
        'United', 'Air Canada', 'Lufthansa', 'Swiss', 'Austrian', 'Brussels Airlines',
        'TAP Air Portugal', 'Turkish Airlines', 'LOT', 'Croatia Airlines', 'Aegean',
        'Air China', 'Air India', 'Air New Zealand', 'ANA', 'All Nippon Airways',
        'Asiana', 'Singapore Airlines', 'Thai', 'EVA Air', 'Shenzhen Airlines',
        'Avianca', 'Copa', 'Ethiopian', 'EgyptAir', 'South African Airways'] },
    { k: 'sky', name: 'SkyTeam', members: [
        'Delta', 'Air France', 'KLM', 'Virgin Atlantic', 'ITA Airways', 'Air Europa',
        'Aeromexico', 'Aerolineas Argentinas', 'Korean Air', 'China Eastern',
        'China Airlines', 'Xiamen Air', 'Vietnam Airlines', 'Garuda Indonesia',
        'Saudia', 'Middle East Airlines', 'Kenya Airways', 'TAROM', 'SAS'] },
    { k: 'one', name: 'oneworld', members: [
        'American', 'Alaska', 'British Airways', 'Iberia', 'Finnair', 'Qatar Airways',
        'Cathay Pacific', 'Japan Airlines', 'Malaysia Airlines', 'Qantas',
        'Fiji Airways', 'Oman Air', 'Royal Air Maroc', 'Royal Jordanian',
        'SriLankan Airlines'] }
];

/* "Delta Air Lines", "Delta" and "DELTA" are one carrier. Only a trailing
 * Airlines/Airways is stripped, never a leading "Air" -- doing that collapses
 * Air China (Star) and China Airlines (SkyTeam) into the same key, which would
 * put a traveller on the wrong alliance entirely. */
function normAirline(n) {
    return String(n == null ? '' : n).toLowerCase().replace(/[^a-z0-9]/g, '')
        .replace(/(airlines|airways|airline|airlrs)$/, '');
}

/* Ultra-low-cost carriers. These are not a taste judgement -- their fares are
 * not comparable to a mainline fare at the same number, because they exclude a
 * carry-on, a seat assignment, and any change or cancellation. Google reports
 * the base fare, so a Frontier row looks cheapest right up until the group
 * reaches the airport with bags.
 *
 * allInCost already adds a carry-on fee when the data says one is not included,
 * but that data is free text and frequently absent, so it corrects only some of
 * the gap. The rest is handled by requiring a real saving before one of these is
 * offered at all -- see the margin rule in compute(). */
var ULCC = {};
['Frontier', 'Spirit', 'Allegiant', 'Ryanair', 'Wizz Air', 'Play', 'Norse Atlantic',
 'VivaAerobus', 'Volaris', 'Jetstar', 'Scoot', 'Sun Country', 'Avelo', 'Breeze'
].forEach(function (n) { ULCC[normAirline(n)] = true; });
function isUlcc(option) {
    var names = (option && option.airlines) || [];
    /* Any segment on a budget carrier makes the whole itinerary one. */
    for (var i = 0; i < names.length; i++) if (ULCC[normAirline(names[i])]) return true;
    return false;
}

var ALLIANCE_OF = {};
ALLIANCES.forEach(function (a) {
    a.members.forEach(function (m) { ALLIANCE_OF[normAirline(m)] = a.k; });
});
function allianceOf(airlineName) { return ALLIANCE_OF[normAirline(airlineName)] || null; }

/* Every carrier appearing in the current results, most options first, so the
 * filter offers what is actually bookable instead of a list of every airline on
 * earth. Counted across both legs: a carrier you refuse to fly home on is one
 * you refuse to fly out on. */
function carriersInResults() {
    if (!DATA || !DATA.trips) return [];
    var seen = {};
    Object.keys(DATA.trips).forEach(function (tid) {
        var trip = DATA.trips[tid] || {};
        ['outbound', 'return'].forEach(function (leg) {
            var byParty = trip[leg] || {};
            Object.keys(byParty).forEach(function (pid) {
                (byParty[pid] || []).forEach(function (o) {
                    (o.airlines || []).forEach(function (nm) {
                        var k = normAirline(nm);
                        if (!k) return;
                        if (!seen[k]) seen[k] = { key: k, name: nm, n: 0, alliance: allianceOf(nm) };
                        seen[k].n++;
                    });
                });
            });
        });
    });
    return Object.keys(seen).map(function (k) { return seen[k]; })
        .sort(function (a, b) { return b.n - a.n || a.name.localeCompare(b.name); });
}

function isAvoided(nm) { return (state.q.avoid || []).indexOf(normAirline(nm)) > -1; }

/* Airline home pages, for people who would rather buy direct. Deliberately NOT
 * per-carrier deep links: every airline has its own undocumented format and
 * several block anything that looks automated, so these go to the front door
 * and say so. Google Flights stays primary because we CAN pin an exact
 * itinerary there (see tfsEncode) and its page carries the airline's own book
 * button anyway. */
var AIRLINE_SITES = {
    'United': 'https://www.united.com/en/us/book-flight/united-reservations',
    'American': 'https://www.aa.com/booking/find-flights',
    'Delta': 'https://www.delta.com/flight-search/book-a-flight',
    'Alaska': 'https://www.alaskaair.com/',
    'Southwest': 'https://www.southwest.com/air/booking/',
    'JetBlue': 'https://www.jetblue.com/booking/flights',
    'Spirit': 'https://www.spirit.com/book/flights',
    'Frontier': 'https://www.flyfrontier.com/',
    'Hawaiian': 'https://www.hawaiianairlines.com/',
    'Allegiant': 'https://www.allegiantair.com/',
    'Sun Country': 'https://www.suncountry.com/',
    'Air Canada': 'https://www.aircanada.com/',
    'WestJet': 'https://www.westjet.com/',
    'British Airways': 'https://www.britishairways.com/travel/home/public/en_us/',
    'Lufthansa': 'https://www.lufthansa.com/us/en/homepage',
    'Air France': 'https://wwws.airfrance.us/',
    'KLM': 'https://www.klm.com/',
    'Iberia': 'https://www.iberia.com/',
    'Aer Lingus': 'https://www.aerlingus.com/',
    'Virgin Atlantic': 'https://www.virginatlantic.com/',
    'Emirates': 'https://www.emirates.com/',
    'Qatar Airways': 'https://www.qatarairways.com/',
    'Turkish Airlines': 'https://www.turkishairlines.com/',
    'Aeromexico': 'https://aeromexico.com/',
    'Volaris': 'https://www.volaris.com/',
    'Copa': 'https://www.copaair.com/',
    'LOT': 'https://www.lot.com/',
    'Ryanair': 'https://www.ryanair.com/',
    'easyJet': 'https://www.easyjet.com/',
    'Icelandair': 'https://www.icelandair.com/',
    'Norse Atlantic': 'https://flynorse.com/',
    'Play': 'https://www.flyplay.com/'
};


function airlineSite(o) {
    var names = o.airlines || [];
    for (var i = 0; i < names.length; i++) {
        if (AIRLINE_SITES[names[i]]) return { name: names[i], url: AIRLINE_SITES[names[i]] };
    }
    return null;
}

/* ------------------------------------------------------------ booking

 * Google Flights encodes a search in a `tfs` parameter: a protobuf message,
 * base64url'd. Field 4 of each leg pins a SPECIFIC flight by carrier and number,
 * which flips the page from search results to the booking screen -- the one with
 * the actual "Continue" buttons. So we can hand somebody the flight this app
 * chose for them instead of a search they have to redo by hand, which was the
 * single most annoying thing left in the flow: the app does the work, then asks
 * you to go find its answer yourself.
 *
 * Two things to respect about this surface:
 *
 * 1. It is undocumented. Field numbers could be renumbered without notice. Every
 *    call site therefore falls back to the plain route+date search link, which
 *    cannot break, rather than treating the deep link as load-bearing.
 * 2. Google does NOT validate flight numbers server-side. A wrong number returns
 *    the same page shell and silently shows an empty booking screen -- worse than
 *    a search, because it looks like the app lied. So numbers come only from a
 *    live search result, and if any segment is missing one we do not build this
 *    at all. Never synthesise a flight number from a schedule guess. */
function tfsEncode(legs, seats, cabin) {
    var B = [];
    function varint(n) { while (n > 127) { B.push((n & 127) | 128); n >>>= 7; } B.push(n); }
    function utf8(str) {
        var out = [], e = encodeURIComponent(str);
        for (var i = 0; i < e.length; i++) {
            if (e[i] === '%') { out.push(parseInt(e.substr(i + 1, 2), 16)); i += 2; }
            else out.push(e.charCodeAt(i));
        }
        return out;
    }
    function sub(f, build) {
        var save = B; B = []; build(); var body = B; B = save;
        varint((f << 3) | 2); varint(body.length);
        for (var i = 0; i < body.length; i++) B.push(body[i]);
    }
    function str(f, v) {
        var b = utf8(v); varint((f << 3) | 2); varint(b.length);
        for (var i = 0; i < b.length; i++) B.push(b[i]);
    }
    function num(f, n) { varint((f << 3) | 0); varint(n); }

    legs.forEach(function (L) {
        sub(3, function () {
            str(2, L.date);
            /* One field-4 per segment, so a connection pins both hops rather
             * than leaving Google to pick the second one. */
            (L.segs || []).forEach(function (sg) {
                sub(4, function () {
                    str(1, sg.from); str(2, sg.date); str(3, sg.to);
                    str(5, sg.carrier); str(6, String(sg.number));
                });
            });
            sub(13, function () { num(1, 1); str(2, L.from); });
            sub(14, function () { num(1, 1); str(2, L.to); });
        });
    });
    for (var i = 0; i < Math.max(1, seats || 1); i++) num(8, 1);
    num(9, cabin || 1);
    num(19, legs.length > 1 ? 1 : 2);

    var bin = '';
    for (i = 0; i < B.length; i++) bin += String.fromCharCode(B[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* True only when every segment of every leg carries a real carrier and number
 * from the live search. Anything less and the caller must use a search link. */
function pinnable(options) {
    if (!options.length) return false;
    return options.every(function (o) {
        var segs = o && o.segs;
        if (!segs || !segs.length) return false;
        if (segs.length !== (o.stops || 0) + 1) return false;
        return segs.every(function (sg) {
            return sg && sg.carrier && sg.number && sg.from && sg.to && sg.date;
        });
    });
}

function deepLink(options, seats) {
    if (!pinnable(options)) return null;
    try {
        var legs = options.map(function (o) {
            return { from: o.from, to: o.to, date: String(o.depart).slice(0, 10), segs: o.segs };
        });
        return 'https://www.google.com/travel/flights/booking?tfs='
            + tfsEncode(legs, seats, 1) + '&hl=en&gl=us&curr=' + (DATA && DATA.currency || 'USD');
    } catch (e) { return null; }
}

/* One action per person, not one per leg. Deep-links straight to the booking
 * screen for the exact flights this app picked when every segment is pinnable,
 * and degrades to a round-trip search covering both dates when it is not. The
 * card prints the two times either way, so the fallback is still usable. */
function tripBookUrl(origin, dest, dep, ret, seats, options) {
    var deep = options && options.length ? deepLink(options, seats) : null;
    if (deep) return deep;
    var q = 'Flights from ' + origin + ' to ' + dest + ' on ' + dep
        + (ret ? ' returning ' + ret : '')
        + (seats > 1 ? ' ' + seats + ' passengers' : '');
    return 'https://www.google.com/travel/flights?q=' + encodeURIComponent(q);
}

function bookUrl(o, seats) {
    /* booking_token is still unused: live responses carried none at all, and its
     * lifetime is undocumented even when present. The tfs deep link needs no
     * token and does not expire, so it replaces it outright. */
    var deep = deepLink([o], seats);
    if (deep) return deep;
    var carrier = (o.airlines || [])[0];
    var q = 'Flights from ' + o.from + ' to ' + o.to + ' on ' + String(o.depart).slice(0, 10)
        + (carrier ? ' ' + carrier : '') + (seats > 1 ? ' ' + seats + ' passengers' : '');
    return 'https://www.google.com/travel/flights?q=' + encodeURIComponent(q);
}


/* A block you can paste into the group chat. The decision happens there, not
 * here, and until now the app handed the organiser a screenful of numbers and no
 * way to move them. Covers both legs, because nobody books half a trip.
 * Stamped with the capture time on purpose: fares move, and a pasted total with
 * no date is the kind of thing a group argues with on Friday. */
function legLines(leg, heading) {
    var b = legBreakdown(leg);
    if (!b) return [];
    var prevLeg = state.leg, prevC = C;
    state.leg = leg; C = b.ctx;

    var verb = leg === 'outbound' ? 'lands' : 'leaves';
    /* Pasted into a chat this is a sentence, not a column, so the gap is spelled
     * out here the same way it is on the line that states the result.
     *
     * The way home is unclustered by default, so "everyone within 11 hours 10
     * minutes of each other" claimed a target nobody aimed at -- the same lie
     * the shaded band was removed from the return timeline for. Report it the
     * way the screen does: an outcome, stated as a gap. */
    var loose = leg === 'return' && !state.q.clusterReturn;
    var lines = [heading + ' — ' + (loose
        ? gapWords(b.spread) + ' apart'
        : b.plan.excluded && b.plan.excluded.length
            ? seatsOf(b.plan.included) + ' of ' + seatsAll() + ' within ' + gapWords(b.spread)
            : withinEachOther(b.spread))];

    b.ctx.ids.slice().sort(function (x, y) {
        var ox = b.rows[x], oy = b.rows[y];
        return (ox ? ox.option.clusterMin : 0) - (oy ? oy.option.clusterMin : 0);
    }).forEach(function (id) {
        var r = b.rows[id];
        if (!r) return;
        var t = b.ctx.travelers.filter(function (z) { return z.id === id; })[0];
        var o = r.option;
        lines.push('  • ' + t.name + ' — ' + o.from + ' to ' + o.to + ', ' + verb + ' '
            + clock(leg === 'outbound' ? o.arriveMin : o.departMin)
            + ', ' + money(r.cost) + (t.seats > 1 ? ' for ' + t.seats : '')
            + ((o.airlines || []).length ? ', ' + o.airlines.join('/') : '')
            + (o.stops === 0 ? ', nonstop' : ', ' + o.stops + (o.stops === 1 ? ' stop' : ' stops'))
            + (r.inWindow ? '' : '  (' + (leg === 'outbound' ? 'lands apart' : 'leaves apart') + ')'));
    });

    state.leg = prevLeg; C = prevC;
    return lines;
}

function chatBlock() {
    if (!TRIP || !C) return '';
    var a = AIRPORTS.get(state.q.dest);
    var lines = [];
    lines.push((a ? a.city + ' (' + a.code + ')' : state.q.dest) + ' · '
        + prettyRange(state.q.dep, state.q.ret));
    lines.push('');
    lines = lines.concat(legLines('outbound', 'GETTING THERE'));
    if (hasReturn()) { lines.push(''); lines = lines.concat(legLines('return', 'GETTING HOME')); }

    lines.push('');
    lines.push('WHAT EACH PERSON PAYS');
    C.ids.forEach(function (id) {
        var t = C.travelers.filter(function (x) { return x.id === id; })[0];
        var pp = TRIP.perPerson[id];
        if (!t || !pp) return;
        lines.push('  • ' + t.name + ' ' + money(pp.total)
            + (t.seats > 1 ? ' (' + money(Math.round(pp.total / t.seats)) + ' each)' : ''));
    });

    lines.push('');
    lines.push(groupWord() + ', ' + (hasReturn() ? 'round trip' : 'one way') + ': ' + money(TRIP.total)
        + (SET.priceDisplay === 'fare' ? ' (fares only)' : ' including bags'));
    var gen = DATA && DATA.generated_at ? new Date(DATA.generated_at) : null;
    lines.push('Fares as of ' + (gen ? gen.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'unknown')
        + ' — check before paying.');
    lines.push(shareUrl());
    return lines.join('\n');
}

/* The block that says which way home the app took, what it cost, and how to
 * have the other one.
 *
 * It replaces "Each on their own best flight home." plus a "Leave together
 * instead" link, which failed in two ways at once: it described the outcome as
 * a kindness rather than a trade, and it put the alternative in a link with no
 * price on it, which is the fine print somebody skips on the way to deciding
 * the app got it wrong. Every sentence here carries a number the reader can
 * check against the dots above it, and the button says what taking it does.
 *
 * Returns the note only -- the heading above it already states the spread, so
 * none of these repeat it. */
function returnNote(b, allIn) {
    /* With somebody outside the window the honest sentence is the one about who
     * cannot make it, which the strip prints directly below this. */
    if (!allIn) return '';
    var ch = returnChoice(b.ctx), w = ch.ways;
    if (!w.floor) return '';

    var apart = FWF.minCostAtWindow(b.ctx.prep, w.apart, b.ctx.costFn);
    if (!apart) return '';

    function btn(to, text) {
        /* A pill, not a link. "no one is going to see that fien print button"
         * was about exactly this control, and an underlined phrase inside a
         * sentence is the shape of fine print however real the button is. Same
         * treatment the match rows use for an alternative that changes the plan
         * and the total, because that is what this is. */
        return '<div class="win-alt"><button data-clusterback="' + to + '">'
            + text + '</button></div>';
    }

    if (ch.how === 'together') {
        /* Nothing to offer if flying home separately lands on the same window,
         * which happens when the cheap flights were already in one bank. */
        if (apart.spread === b.spread) return '';
        var extra = Math.round(b.inWindowTotal - apart.cost);
        return '<div class="win-note">'
            + (extra > 0
                ? 'Costs ' + money(extra) + ' more than flying home separately, which would '
                  + 'spread the group over ' + gapWords(apart.spread) + '.'
                  + btn('0', 'Fly home separately, save ' + money(extra))
                : 'Costs nothing extra. Flying home separately would spread the group over '
                  + gapWords(apart.spread) + ' for the same money.'
                  + btn('0', 'Fly home separately anyway'))
            + '</div>';
    }

    /* Both remaining cases are flying home separately, and both have to name the
     * price of the other way rather than imply there is not one. */
    var reach = w.together !== FWF.INF ? { th: w.together } : w.reach;
    if (!reach) {
        return '<div class="win-note">Each on their own flight home. No window gets the '
            + 'group out together without putting somebody on a materially worse flight '
            + 'than they would take alone.</div>';
    }
    var tog = FWF.minCostAtWindow(b.ctx.prep, reach.th, b.ctx.costFn);
    if (!tog) return '';
    var cost = Math.round(tog.cost - b.inWindowTotal);

    if (ch.how === 'priced-out') {
        return '<div class="win-note">Flying home separately because leaving together is not '
            + 'cheap on these dates: the closest they can all get out is '
            + gapWords(tog.spread) + ' apart, and that costs ' + money(cost)
            + ' more across the group.'
            + btn('any', 'Leave together for ' + money(cost))
            + '</div>';
    }
    return '<div class="win-note">Each on their own flight home, as asked. Leaving together '
        + 'would put everyone within ' + gapWords(tog.spread) + ' of each other'
        + (cost > 0 ? ' for ' + money(cost) + ' more.' : ' for the same money.')
        + btn('1', cost > 0 ? 'Leave together for ' + money(cost) : 'Leave together')
        + '</div>';
}

function windowStrip(leg, b, label) {
    if (!b) return '';
    /* "Leaving together" printed over flights eleven hours apart is a lie, so
     * the heading follows what the leg actually did rather than what was asked
     * for. Kept here with the rest of the return's copy: the word and the
     * computation behind it have to move together. */
    var loose = leg === 'return' && returnChoice(b.ctx).how !== 'together';
    if (leg === 'return') label = loose ? 'Flying home' : 'Leaving together';
    var prevLeg = state.leg, prevC = C;
    state.leg = leg; C = b.ctx;

    var picks = {};
    var included = [], excluded = [];
    b.ctx.ids.forEach(function (id) {
        var r = b.rows[id];
        if (!r) return;
        if (r.inWindow) { picks[id] = { option: r.option, cost: r.cost }; included.push(id); }
        else excluded.push({ id: id, gapMinutes: r.gap, nearest: r.option });
    });

    var tight = b.ctx.tight;
    /* Somebody with no flights at all has no row, so they were not in `excluded`
     * either -- which let the heading say "everyone within 20 minutes" over a
     * timeline with one of the five missing from it. */
    var absent = b.ctx.ids.filter(function (id) { return !b.rows[id]; });
    var allIn = excluded.length === 0 && absent.length === 0;
    var tightestRow = b.ctx.ladder
        ? b.ctx.ladder.rows.filter(function (r) { return r.feasible; })[0] : null;
    var more = (allIn && tightestRow && tightestRow.result)
        ? tightestRow.result.cost - b.inWindowTotal : 0;

    /* The arrival leg is the whole product -- the one fact no flight site can
     * hand you -- and it was a muted caption to the right of a generic heading.
     * Here it is the headline and the leg name drops to the quiet line above.
     * The way home does not get the same treatment: two headlines is no
     * headline, and it has its own claim and its own price below. */
    var hero = leg === 'outbound';
    /* On the unclustered leg the spread is an outcome, not a target, so it is
     * reported without implying we aimed for it. */
    var measure = loose ? gapWords(b.spread) + ' apart'
        : allIn ? withinEachOther(b.spread)
        : seatsOf(included) + ' of ' + seatsAll() + ' within ' + gapWords(b.spread);
    /* At display size the line breaks at the first space, which put the number
     * on one line and its unit on the next. The number is the only part anybody
     * reads, so in the hero the phrase is one word. */
    var html = '<div class="win">'
        + (hero
            ? '<div class="win-head hero"><div class="t">' + esc(label) + '</div>'
              + '<div class="r">' + esc(measure).replace(/ /g, '\u00a0') + '</div></div>'
            : '<div class="win-head"><span class="t">' + esc(label) + '</span>'
              + '<span class="s">' + esc(measure) + '</span></div>')
        + timeline(picks, included, excluded, !loose)
        /* Not fine print: the way home states what it cost and offers the other
         * answer as a priced control. */
        + (leg === 'return' ? returnNote(b, allIn) : '')
        /* The choice strip above already prices tighter-vs-cheaper for the whole
         * trip, so repeating it per leg was noise pointing the wrong way.
         *
         * Who it is, what they get, in that order -- "a connection was allowed
         * rather than dropping the plan" was the optimiser narrating its own
         * fallback, and "short-enough option" described duration when the rule
         * it is relaxing is about stops. */
        + (b.ctx.relaxed && b.ctx.relaxed.length
            ? '<div class="win-note">No '
              + (b.ctx.maxStops === 0 ? 'nonstop' : 'flight with that few stops')
              + ' for ' + esc(nameList(b.ctx.relaxed))
              + ', so this plan has them changing planes.</div>'
            : '')
        /* "cannot make this window" named the algorithm's word for the thing the
         * line above has just stated in minutes. */
        + (excluded.length
            ? '<div class="win-note" style="color:var(--bad)">'
              + esc(nameList(excluded.map(function (x) { return x.id; })))
              + ' cannot land that close. '
              + (tight
                  ? 'The closest the whole group can get is ' + gapWords(tight.spread) + '.'
                  : 'Nothing on these dates gets the whole group closer.') + '</div>'
            : '')
        + '</div>';

    state.leg = prevLeg; C = prevC;
    return html;
}

function priceLevel(leg, id) {
    var ins = ((DATA || {}).insights || {})[leg] || {};
    var x = ins[id];
    if (!x || !x.level) return '';
    var lvl = String(x.level).toLowerCase();
    if (lvl === 'low') return '<span class="lvl low">good price for this route</span>';
    if (lvl === 'high') return '<span class="lvl high">high for this route</span>';
    return '';
}

function hopRow(dir, r, leg, id, seats) {
    if (!r) return '';
    var o = r.option;
    seats = seats || 1;
    var code = (o.airlines || [])[0] || '';
    var fb = code.split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
    var logo = o.airline_logo
        ? '<img class="pax-logo" src="' + esc(o.airline_logo) + '" alt="" '
          + 'onerror="this.outerHTML=\'<div class=&quot;pax-fb&quot;>' + esc(fb) + '</div>\'">'
        : '<div class="pax-fb">' + esc(fb) + '</div>';
    var showMin = leg === 'outbound' ? o.arriveMin : o.departMin;
    return '<div class="hop"><span class="hop-dir">' + dir + '</span>' + logo
        + '<div class="hop-main"><div class="hop-route">' + esc(o.from) + ' &rarr; ' + esc(o.to)
        + '</div><div class="hop-meta">' + esc((o.airlines || []).join(', ')) + ' · '
        + stopsText(o.stops) + ' · ' + FWF.fmtGap(o.duration_minutes)
        + (r.inWindow ? '' : ' · <span style="color:var(--bad)">outside the window</span>') + '</div>'
        + priceLevel(leg, id) + '</div>'
        + '<div class="hop-right"><div class="hop-time mono">'
        + (leg === 'outbound' ? 'lands ' : 'leaves ') + clock(showMin) + '</div>'
        + '<div class="hop-cost mono">' + money(r.cost)
        + (seats > 1 ? ' <span class="for-seats">for ' + seats + '</span>' : '')
        + '</div></div>'
        /* This number was previously a bare orange "+$16" beside the fare, which
         * reads as a fee to add on. It is not: it is already inside the fare.
         * A tester added it to their own total for every traveller.
         *
         * It sits OUTSIDE .hop-right, as its own grid item spanning the row. In
         * the fare column it inherited white-space: nowrap, forced that column
         * to ~220px and wrapped "ORD -> PIT" onto three lines -- and it had no
         * CSS rule at all, so it rendered at body size over the route.
         *
         * And nobody lands together on the way home: on the return leg this
         * premium is what the group paid to leave at the same time. */
        + (r.premium > 0
            ? '<div class="hop-prem">incl. ' + money(r.premium) + ' to '
              + (leg === 'return' ? 'leave' : 'land') + ' together</div>'
            : '')
        + '</div>';
}

function travellerCard(id, i) {
    var t = C.travelers.filter(function (x) { return x.id === id; })[0];
    var pp = TRIP.perPerson[id];
    if (!t || !pp) return '';
    var o = TRIP.legOut.rows[id];
    var b = TRIP.legBack ? TRIP.legBack.rows[id] : null;
    var idx = state.q.parties.map(function (x) { return x.id; }).indexOf(id);
    var apart = !pp.outInWindow || !pp.backInWindow;
    var origin = o ? o.option.from : (t.origins[0] || '');
    var each = t.seats > 1 ? Math.round(pp.total / t.seats) : pp.total;

    /* The exact flights this person was given, in leg order -- so the Book
     * button can open their booking screen rather than a search they have to
     * solve again. Pinning both legs also makes Google price them as one round
     * trip, which is frequently cheaper than the two one-ways we quote. */
    var chosen = [];
    if (o && o.option) chosen.push(o.option);
    if (b && b.option) chosen.push(b.option);

    return '<div class="trav' + (apart ? ' apart' : '') + '">'
        + '<div class="trav-top">'
        + '<div class="ava" aria-hidden="true" style="background:' + partyColor(idx < 0 ? 0 : idx) + '">'
        + esc(partyInitials(state.q.parties[idx] || { name: t.name }, idx < 0 ? 0 : idx)) + '</div>'
        + '<div><div class="trav-name">' + esc(t.name)
        + (t.seats > 1 ? ' <span class="badge seats">' + t.seats + ' seats</span>' : '')
        + (apart ? ' <span class="badge out">not with the group</span>' : '') + '</div></div>'
        + '<div class="trav-tot mono">' + money(pp.total)
        + '<span>' + (t.seats > 1 ? money(each) + ' each' : 'all in') + '</span></div>'
        + '</div>'
        /* "Depart" and "Return" are what airlines label the two legs of a round
         * trip, and a tester read "Out"/"Back" as something else entirely.
         * Not "departure"/"arrival": both legs have one of each. */
        + hopRow('Depart', o, 'outbound', id, t.seats)
        + (b ? hopRow('Return', b, 'return', id, t.seats) : '')
        + '<div class="trav-book">'
        + '<a class="btn primary" style="display:block;text-align:center;text-decoration:none" href="'
        + esc(tripBookUrl(origin, state.q.dest, state.q.dep, state.q.ret || null, t.seats, chosen))
        + '" target="_blank" rel="noopener">Book ' + esc(t.name) + '&rsquo;s trip &rarr;</a>'
        + '</div></div></div>';
}

function renderPlanView() {
    var host = el('planView');
    if (!TRIP || !C) { host.innerHTML = ''; return; }

    /* No "The plan" heading, and no verdict line under it. It was the largest
     * thing above the fold and the only thing up there that said nothing, so the
     * eye landed on furniture and the result read as its caption. Both halves of
     * the verdict are now stated louder by the headline itself -- "3 of 5 within
     * 20 minutes", "Everyone within 7 hours 25 min of each other" -- and the red
     * note below the strip still names anyone who cannot make the window. The
     * section is still announced to screen readers by #planView's aria-label. */
    var html = '';

    html += windowStrip('outbound', TRIP.legOut, 'Landing together');
    /* The heading reports the outcome, not the setting.
     *
     * "Leaving together" over flights eleven hours apart is a lie, so it is
     * earned by the spread rather than by the flag. And the flag is not the
     * outcome either: free tightening means an unclustered leg often comes out
     * together anyway, in which case "each on their own best flight" describes
     * the method and buries the result.
     *
     * Leaving them on their own best flights is a result too, and it is stated
     * as one. It used to read "Flying home" over a grey apology, which is what
     * made the answer look like the app giving up. "Flying home" survives for
     * the one case where neither claim is true: a clustered leg whose window is
     * too wide to call a shared departure. */
    if (TRIP.legBack) {
        html += windowStrip('return', TRIP.legBack,
            together(TRIP.legBack.spread) ? 'Leaving together'
                : state.q.clusterReturn ? 'Flying home'
                : 'Everyone on their best flight home');
    }

    html += C.ids.map(travellerCard).join('');

    host.innerHTML = html;
}

/* The window ladder used to live here, folded, as a table of every threshold
 * and its cost. It was removed: the choice strip above prices the same decision
 * in three rows people actually read, its "land between" control duplicated the
 * one on the when step, and a second table of the same numbers is how somebody
 * loses the thread of what this screen is telling them. */

/* "What if it's cheaper the next day?" -- the obvious question, and SerpApi has
 * no flexible-date window, so each alternative date is a full set of searches.
 * That makes it an explicit, priced action rather than something that quietly
 * spends a tenth of the month's quota. */
function shiftDays(iso, n) {
    var d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

function shiftCandidates() {
    if (!state.q || !state.q.dep) return [];
    return [-1, 1].map(function (n) {
        var dep = shiftDays(state.q.dep, n);
        if (dep < todayISO()) return null;
        return { n: n, dep: dep, ret: state.q.ret ? shiftDays(state.q.ret, n) : null };
    }).filter(Boolean);
}

function shiftKey(c) { return c.dep + '|' + (c.ret || ''); }

function shiftCost() {
    var parties = travelers().filter(function (t) { return t.origins.length; }).length;
    var legs = hasReturn() ? 2 : 1;
    return shiftCandidates().filter(function (c) { return !SHIFTS[shiftKey(c)]; }).length * parties * legs;
}

/* Prices one alternative trip from an already-fetched payload. */
function priceShift(payload) {
    var tv = travelers();
    var ids = tv.map(function (t) { return t.id; });
    var costFn = FWF.makeCostFn(tv, {
        assumedCheckedBagFee: APP.bagFee, assumedCarryOnFee: APP.carryOnFee,
        priceDisplay: SET.priceDisplay
    });
    var legs = ['outbound'].concat(hasReturn() ? ['return'] : []);
    var total = 0, worst = 0;
    for (var i = 0; i < legs.length; i++) {
        var leg = legs[i];
        var data = ((payload.trips || {}).query || {})[leg] || {};
        var prep = FWF.prepare(data, ids, leg === 'outbound' ? 'arrive' : 'depart');
        if (!prep.complete) return null;
        /* Same window the user is currently looking at, so it is like for like. */
        var th = state.th.outbound;
        var r = (typeof th === 'number' || th === FWF.INF)
            ? FWF.minCostAtWindow(prep, th, costFn) : null;
        if (!r) r = FWF.minCostAtWindow(prep, FWF.INF, costFn);
        if (!r) return null;
        total += r.cost;
        worst = Math.max(worst, r.spread);
    }
    return { total: total, worst: worst };
}

function runShiftScan() {
    var todo = shiftCandidates().filter(function (c) { return !SHIFTS[shiftKey(c)]; });
    if (!todo.length || shiftBusy) return;
    shiftBusy = true; shiftErr = null; renderShifts();

    var tv = travelers().filter(function (t) { return t.origins.length; });
    Promise.all(todo.map(function (c) {
        return fetch(API + '/search', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                dest: [state.q.dest], depart: c.dep, ret: c.ret,
                travelers: tv.map(function (t) {
                    return { id: t.id, name: t.name, bags: t.bags,
                             origins: t.origins.filter(function (x) {
                                 var a = AIRPORTS.get(x); return a && !a.closed;
                             }) };
                })
            })
        }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j, c: c }; }); });
    })).then(function (res) {
        shiftBusy = false;
        res.forEach(function (x) {
            if (x.body && x.body.budget) setBudget(x.body.budget);
            if (!x.ok) { shiftErr = x.body.error || 'Could not check other dates.'; return; }
            SHIFTS[shiftKey(x.c)] = { c: x.c, priced: priceShift(x.body) };
        });
        renderShifts();
    }).catch(function (e) {
        shiftBusy = false;
        if (window.console) console.error('date scan failed', e);
        shiftErr = 'Could not check other dates. Try again in a moment.';
        renderShifts();
    });
}

/* Nearby-date search is the one feature with a hard marginal cost: SerpApi has
 * no flexible-date window, so every alternative day is a full set of searches
 * for the whole group. That makes it the natural first paid feature, so it is
 * held back rather than given away and taken back later.
 *
 * Drawn rather than set in an emoji font: the glyph should match the type and
 * the palette, and a system emoji renders as a different colour and weight on
 * every platform. Inherits currentColor so it works in both themes. */
function lockIcon(px) {
    var n = px || 13;
    return '<svg class="lk" width="' + n + '" height="' + n + '" viewBox="0 0 24 24"'
        + ' fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"'
        + ' stroke-linejoin="round" aria-hidden="true" focusable="false">'
        + '<rect x="4" y="10.5" width="16" height="11" rx="2.5"></rect>'
        + '<path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"></path></svg>';
}

/* Unlocked per device. There is no paid tier yet, so this is how the feature
 * stays testable without being on for everyone. */
function shiftsUnlocked() {
    try { return localStorage.getItem('fwf_unlock_dates') === '1'; } catch (e) { return false; }
}

function renderShifts() {
    var host = el('shifts');
    if (!TRIP || !state.q || DATA.sample) { host.className = 'shifts hidden'; return; }

    var cands = shiftCandidates();
    if (!cands.length) { host.className = 'shifts hidden'; return; }
    host.className = 'shifts';

    var done = cands.filter(function (c) { return SHIFTS[shiftKey(c)]; });
    if (!done.length) {
        var n = shiftCost();
        if (!shiftsUnlocked()) {
            /* The lock is the whole message. Explaining the billing model
             * under it was the app talking about itself. */
            host.innerHTML = '<button class="btn wide locked" id="shiftLock" aria-disabled="true">'
                + lockIcon(14) + '<span>Is another day cheaper?</span></button>';
            return;
        }
        /* "of your remaining searches" was wrong twice over: the allowance is
         * shared, not yours, and "there is no way to see nearby dates for free"
         * is the app explaining its own billing to somebody about to tap a
         * button. The number is the only part that changes a decision. */
        host.innerHTML = '<button class="btn wide" id="shiftBtn"' + (shiftBusy ? ' disabled' : '') + '>'
            + (shiftBusy ? 'Checking…' : 'Is another day cheaper?') + '</button>'
            + '<div class="share-note">Checks the day before and the day after. Uses <b>'
            + n + '</b> of this month\u2019s searches.'
            + (shiftErr ? '<br><span style="color:var(--bad)">' + esc(shiftErr) + '</span>' : '')
            + '</div>';
        return;
    }

    var rows = [{ label: prettyRange(state.q.dep, state.q.ret),
                  total: TRIP.total, worst: null, here: true }];
    cands.forEach(function (c) {
        var got = SHIFTS[shiftKey(c)];
        if (!got) return;
        rows.push({ label: prettyRange(c.dep, c.ret),
                    total: got.priced ? got.priced.total : null,
                    worst: got.priced ? got.priced.worst : null, here: false });
    });
    rows.sort(function (a, b) { return (a.label < b.label) ? -1 : 1; });

    var best = rows.filter(function (r) { return r.total != null; })
        .reduce(function (a, b) { return b.total < a.total ? b : a; });

    host.innerHTML = '<span class="k">Other dates</span>'
        + rows.map(function (r) {
            if (r.total == null) {
                return '<div class="shift"><span class="s-d mono">' + esc(r.label)
                    + '</span><span class="s-n">nothing covers everyone</span></div>';
            }
            var diff = r.total - TRIP.total;
            return '<div class="shift' + (r.here ? ' here' : '') + (r === best && !r.here ? ' best' : '') + '">'
                + '<span class="s-d mono">' + esc(r.label) + (r.here ? ' · your dates' : '') + '</span>'
                + '<span class="s-p mono">' + money(r.total)
                + (r.here ? '' : '<em>' + (diff < 0 ? '−' + money(-diff) : diff > 0 ? '+' + money(diff) : 'same') + '</em>')
                + '</span></div>';
        }).join('')
        /* The second sentence pointed at "the previous screen", which is the Who
         * step -- the dates are two screens back. A wrong direction is worse
         * than none, and Back is where people look anyway. */
        + (best && !best.here
            ? '<div class="share-note" style="color:var(--good)">Moving the trip to ' + esc(best.label)
              + ' saves <b>' + money(TRIP.total - best.total) + '</b>.</div>'
            : '<div class="share-note">Your dates are the cheapest.</div>');
}

function renderShare() {
    var host = el('shareBox');
    if (!TRIP) { host.innerHTML = ''; return; }
    /* The trip is going to a group chat, and on a phone the native sheet puts
     * Messages, WhatsApp and Mail one tap away. Copying to the clipboard and
     * then switching apps to paste is three steps to do the same thing, so the
     * clipboard becomes the fallback rather than the only route. It is still
     * what desktop gets, and still what an iOS share that is refused falls
     * back to, so nothing that worked before stops working. */
    var canShare = typeof navigator.share === 'function';
    host.innerHTML = '<button class="btn primary wide" id="copyBtn">'
        + (canShare ? 'Send the trip to the group' : 'Copy the whole trip for the group chat')
        + '</button><div class="share-note" id="copyNote"></div>';

    el('copyBtn').addEventListener('click', function () {
        el('copyNote').textContent = 'Getting the link\u2026';
        el('copyNote').className = 'share-note';
        /* The save has to happen first and cannot be skipped: a link without a
         * saved trip is the self-contained #s= form, and opening one of those
         * runs a FRESH PAID SEARCH on the recipient's phone. Five friends
         * opening an unsaved link is five more searches off a 250-a-month
         * allowance. WebKit keeps user activation alive for five seconds, and
         * the save is a single write to our own worker, so the share sheet
         * still opens in the normal case; where it does not, the catch below
         * puts the text on the clipboard instead. */
        saveTrip().then(function () {
            if (!canShare) { doCopy(); return; }
            var text = chatBlock();
            navigator.share({ text: text }).then(function () {
                el('copyNote').textContent = '';
            }).catch(function (err) {
                /* Dismissing the sheet is a decision, not a failure, and must
                 * not leave an error sitting under the button. */
                if (err && err.name === 'AbortError') { el('copyNote').textContent = ''; return; }
                doCopy();
            });
        });
    });

    function doCopy() {
        var text = chatBlock();
        var done = function (ok) {
            el('copyNote').textContent = ok ? 'Copied. Paste it in the group chat.'
                : 'Could not copy it for you. Select the plan above and copy it by hand.';
            el('copyNote').className = 'share-note' + (ok ? ' ok' : '');
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
        } else {
            var ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (e) {}
            document.body.removeChild(ta);
            done(ok);
        }
    }
}


/* Each party's share of the premium: what this plan costs them minus what they
 * would have paid flying whenever they liked. One group total hides the fact
 * that it rarely lands evenly, and the person furthest away usually eats it. */
function premiumFor(id, pick) {
    if (!C.solo || C.solo[id] == null || !pick || pick.cost == null) return null;
    return Math.round(pick.cost - C.solo[id]);
}

function paxRow(id, pick, out, gap) {
    var t = C.travelers.filter(function (x) { return x.id === id; })[0];
    var o = pick.option;
    if (!o || !t) return '';
    var i = state.q.parties.map(function (p) { return p.id; }).indexOf(id);
    var b = FWF.allInCost(o, t, { assumedCheckedBagFee: APP.bagFee, assumedCarryOnFee: APP.carryOnFee });

    var show = state.leg === 'outbound' ? o.arriveMin : o.departMin;
    var other = state.leg === 'outbound' ? o.departMin : o.arriveMin;
    var code = (o.airlines || [])[0] || '';
    var fb = code.split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();

    var logo = o.airline_logo
        ? '<img class="pax-logo" src="' + esc(o.airline_logo) + '" alt="" '
          + 'onerror="this.outerHTML=\'<div class=&quot;pax-fb&quot;>' + esc(fb) + '</div>\'">'
        : '<div class="pax-fb">' + esc(fb) + '</div>';

    var badges = '';
    if (t.seats > 1) badges += ' <span class="badge seats">' + t.seats + ' seats</span>';
    if (SET.meId === id) badges += ' <span class="badge me">you</span>';
    if (out) badges += ' <span class="badge out">+' + FWF.fmtGap(gap) + ' outside</span>';

    var price = SET.priceDisplay === 'fare'
        ? money(o.price * t.seats) + (t.seats > 1 ? ' · ' + money(o.price) + ' each' : ' fare')
        : money(b.total) + (b.bagFee > 0 ? ' incl. ' + money(b.bagFee) + ' bags' : ' all-in');

    var prem = out ? null : premiumFor(id, pick);
    var premLine = prem == null ? ''
        : prem > 0
            ? '<div class="prem over">+' + money(prem) + ' to land together</div>'
            : '<div class="prem">their own cheapest anyway</div>';

    return '<div class="pax' + (out ? ' out' : '') + '">'
        + '<div class="ava" style="background:' + partyColor(i < 0 ? 0 : i) + '">'
        + esc(partyInitials(state.q.parties[i] || { name: t.name }, i < 0 ? 0 : i)) + '</div>'
        + logo
        + '<div class="pax-main"><div class="pax-name">' + esc(t.name) + badges + '</div>'
        + '<div class="pax-meta">' + esc(o.from) + ' &rarr; ' + esc(o.to) + ' · '
        + esc((o.airlines || []).join(', ')) + ' · ' + stopsText(o.stops)
        + ' · ' + FWF.fmtGap(o.duration_minutes) + '</div>'
        + premLine
        + '<div class="links"><a class="book" href="' + esc(bookUrl(o, t.seats)) + '" target="_blank" rel="noopener">'
        + 'Book this flight &rarr;</a>'
        + (airlineSite(o)
            ? '<a class="book alt" href="' + esc(airlineSite(o).url) + '" target="_blank" rel="noopener"'
              + ' title="Goes to '
              + esc(airlineSite(o).name) + '\u2019s booking page, not this exact flight">'
              + esc(airlineSite(o).name) + ' \u2197</a>'
            : '')
        + '</div>'
        + '</div><div class="pax-right"><div class="pax-time mono">' + clock(show) + '</div>'
        + '<div class="pax-price mono">' + price + '</div>'
        + '<div class="pax-price mono dim">'
        + (state.leg === 'outbound' ? 'dep ' : 'arr ') + clock(other) + '</div></div></div>';
}

/* band=false on a leg that is not a shared departure. The shaded band says
 * "everyone is inside this"; drawn across an unclustered return it turned a
 * deliberate choice into what looks like a failed match spanning eleven hours.
 * Where the way home IS one departure -- asked for, or free -- the band is
 * drawn, because then it is telling the truth and the leg should read like the
 * outbound. The dots always tell the truth about the times. */
function timeline(picks, included, excluded, band) {
    var times = included.map(function (id) { return picks[id].option.clusterMin; });
    var lo = Math.min.apply(null, times), hi = Math.max.apply(null, times);
    var pad = Math.max(Math.round((hi - lo) * 0.45), 25);
    var from = lo - pad, to = hi + pad, span = (to - from) || 1;
    var pct = function (m) { return ((m - from) / span) * 100; };
    var idxOf = function (id) { return state.q.parties.map(function (p) { return p.id; }).indexOf(id); };

    var groups = {};
    included.forEach(function (id) {
        var m = picks[id].option.clusterMin;
        (groups[m] = groups[m] || []).push({ id: id, dim: false });
    });
    (excluded || []).forEach(function (x) {
        if (!x.nearest) return;
        var m = x.nearest.clusterMin;
        if (m < from || m > to) return;
        (groups[m] = groups[m] || []).push({ id: x.id, dim: true });
    });

    var keys = Object.keys(groups).map(Number).sort(function (a, b) { return a - b; });
    var html = '<div class="timeline">'
        + '<div class="tl-axis"></div>'
        + (band === false ? '' : '<div class="tl-span" style="left:' + Math.max(pct(lo), 0)
            + '%;width:' + Math.max(Math.min(pct(hi), 100) - Math.max(pct(lo), 0), 1.5) + '%"></div>');

    var minGap = (48 / 390) * 100, last = -999, alt = false;
    keys.forEach(function (m) {
        var p = pct(m);
        alt = (p - last < minGap) ? !alt : false;
        last = p;
        var dots = groups[m].map(function (g) {
            var i = idxOf(g.id);
            var style = g.dim ? 'background:var(--edge);color:var(--muted)' : 'background:' + partyColor(i < 0 ? 0 : i);
            return '<div class="tl-dot" style="' + style + '">'
                + esc(partyInitials(state.q.parties[i] || { name: name(g.id) }, i < 0 ? 0 : i)) + '</div>';
        }).join('');
        html += '<div class="tl-mark" style="left:' + p + '%"><div class="tl-dots">' + dots + '</div>'
            + '<div class="tl-t mono' + (alt ? ' alt' : '') + '">' + clock(m) + '</div></div>';
    });

    return html + '</div>';
}

/* --------------------------------------------------------------- sheets */

var sheetReturn = null;

function focusables(root) {
    return Array.prototype.filter.call(
        root.querySelectorAll('button, a[href], input, select, [tabindex]:not([tabindex="-1"])'),
        function (n) { return !n.disabled && n.offsetParent !== null; });
}

function openSheet(html) {
    var sheet = el('sheet');
    sheetReturn = document.activeElement;
    sheet.innerHTML = '<div class="grip"></div>' + html
        + '<button class="btn primary wide" id="sheetClose" style="margin-top:8px">Done</button>';
    sheet.classList.remove('hidden', 'out');
    el('scrim').classList.remove('hidden', 'out');
    /* The page must not stay tabbable behind the scrim. The install card is a
     * sibling of main, so it needs naming separately -- the scrim covers it to
     * the eye and to the finger, but not to the Tab key. */
    document.querySelector('main').setAttribute('inert', '');
    document.querySelector('.brand').setAttribute('inert', '');
    el('installBanner').setAttribute('inert', '');
    sheet.focus();
}

/* Matches the .sheet.out animation in the stylesheet. Honouring the reduced
 * motion preference in CSS alone leaves the element on screen for the full
 * timeout with nothing happening, so the timing has to know about it too. */
function sheetOutMs() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220;
}

function closeSheet() {
    var sheet = el('sheet'), scrim = el('scrim');
    if (sheet.classList.contains('hidden')) return;
    document.querySelector('main').removeAttribute('inert');
    document.querySelector('.brand').removeAttribute('inert');
    el('installBanner').removeAttribute('inert');
    /* Hand the close animation its starting point. Dismissing by drag has
     * already moved the sheet, and animating from 0 would snap it back up a
     * hundred pixels before it leaves. */
    sheet.classList.remove('dragging', 'settling');
    sheet.classList.add('out');
    scrim.classList.add('out');
    setTimeout(function () {
        sheet.classList.add('hidden'); sheet.classList.remove('out');
        sheet.style.removeProperty('--drag');
        scrim.classList.add('hidden'); scrim.classList.remove('out');
    }, sheetOutMs());
    if (sheetReturn && sheetReturn.focus) sheetReturn.focus();
    sheetReturn = null;
}

/* Drag to dismiss. A bottom sheet that can only be closed by a button is the
 * single loudest "this is a web page" tell left in the app, because every sheet
 * on the phone closes with a downward flick.
 *
 * Two rules keep it from fighting the content: the drag only starts when the
 * sheet is scrolled to its top, so a list inside it still scrolls normally, and
 * upward movement is heavily damped rather than blocked, so pulling the wrong
 * way feels like resistance instead of a dead gesture. */
(function sheetDrag() {
    var sheet = el('sheet');
    if (!sheet || !('ontouchstart' in window)) return;
    var startY = 0, startT = 0, dy = 0, active = false;

    sheet.addEventListener('touchstart', function (ev) {
        if (ev.touches.length !== 1 || sheet.scrollTop > 0) return;
        active = true; dy = 0;
        startY = ev.touches[0].clientY;
        startT = Date.now();
        sheet.classList.remove('settling');
    }, { passive: true });

    sheet.addEventListener('touchmove', function (ev) {
        if (!active) return;
        dy = ev.touches[0].clientY - startY;
        var dragging = sheet.classList.contains('dragging');
        /* An upward move from the top of a sheet is someone scrolling its
         * contents, so hand the gesture back rather than translating and
         * scrolling at the same time. Once the sheet is already pulled down,
         * upward is the way back and gets damped instead. */
        if (dy < 0 && !dragging) { active = false; return; }
        if (dy < 0) dy = dy / 6;
        /* Below a few pixels this is a tap, not a drag, and claiming it would
         * stop buttons inside the sheet from firing. */
        if (!dragging && dy < 6) return;
        sheet.classList.add('dragging');
        sheet.style.setProperty('--drag', dy + 'px');
    }, { passive: true });

    function release() {
        if (!active) return;
        active = false;
        if (!sheet.classList.contains('dragging')) return;
        var flick = dy / Math.max(Date.now() - startT, 1);   /* px per ms */
        sheet.classList.remove('dragging');
        /* Either far enough or fast enough. The velocity test is what makes a
         * short sharp flick work, which is how people actually close these. */
        if (dy > sheet.offsetHeight * 0.3 || flick > 0.6) {
            closeSheet();
        } else {
            sheet.classList.add('settling');
            sheet.style.removeProperty('--drag');
        }
    }
    sheet.addEventListener('touchend', release, { passive: true });
    sheet.addEventListener('touchcancel', release, { passive: true });
    sheet.addEventListener('transitionend', function (ev) {
        if (ev.propertyName === 'transform') sheet.classList.remove('settling');
    });
})();

document.addEventListener('keydown', function (ev) {
    var sheet = el('sheet');
    if (sheet.classList.contains('hidden')) return;
    if (ev.key === 'Escape') { ev.preventDefault(); closeSheet(); return; }
    if (ev.key !== 'Tab') return;
    var f = focusables(sheet);
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (ev.shiftKey && (document.activeElement === first || document.activeElement === sheet)) {
        ev.preventDefault(); last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault(); first.focus();
    }
});

function settingsSheet() {
    var people = state.q ? travelers() : [];
    var pill = function (on, set, val, label) {
        return '<button class="pill' + (on ? ' on' : '') + '" data-set="' + set + '" data-val="' + val + '">'
            + esc(label) + '</button>';
    };
    var gen = DATA && DATA.generated_at ? new Date(DATA.generated_at) : null;

    openSheet('<h2 id="sheetTitle">Settings</h2><div class="sub">Kept on this device.</div>'
        /* "Which one is you" was not a sentence. The tip under it said it
         * highlights your row everywhere, which nothing on the results screen
         * has done since the per-leg rows were replaced -- a setting that
         * promises a thing it no longer does is worse than one with no tip. */
        + '<div class="grp"><span class="k">Which one are you</span><div class="pills">'
        + people.map(function (p, i) { return pill(SET.meId === p.id, 'meId', p.id, p.name); }).join('')
        + pill(!SET.meId, 'meId', '', 'Not set')
        + '</div></div>'

        + '<div class="grp"><span class="k">Theme</span><div class="pills">'
        + pill(SET.theme === 'dark', 'theme', 'dark', 'Dark')
        + pill(SET.theme === 'light', 'theme', 'light', 'Light')
        + pill(SET.theme === 'system', 'theme', 'system', 'System')
        + '</div></div>'

        /* "Landing window" + "The window everyone has to land inside for the trip
         * to count as working" is the app's own word twice and its own scoring
         * once. "Land within: 30 min" is the whole setting. */
        + '<div class="grp"><span class="k">Land within</span><div class="pills">'
        + [15, 30, 45, 60].map(function (n) { return pill(SET.target === n, 'target', n, n + ' min'); }).join('')
        + '</div></div>'

        + '<div class="grp"><span class="k">Bags</span><div class="pills">'
        + '<button class="pill' + (SET.bags.carry_on > 0 ? ' on' : '') + '" data-bag="carry_on">Carry-on</button>'
        + '<button class="pill' + (SET.bags.checked > 0 ? ' on' : '') + '" data-bag="checked">Checked bag</button>'
        + '</div><div class="tip">Counted for everyone. Where Google publishes no fee, '
        + money(APP.bagFee) + ' is assumed rather than nothing.</div></div>'

        + '<div class="grp"><span class="k">Prices</span><div class="pills">'
        + pill(SET.priceDisplay === 'allin', 'priceDisplay', 'allin', 'All-in')
        + pill(SET.priceDisplay === 'fare', 'priceDisplay', 'fare', 'Fares only')
        + '</div></div>'

        /* Only shown when there is something to forget, so a first run is not
         * offered a button that would do nothing. Naming the people is the
         * point: this is the one place the saved group is visible as a list,
         * which is how somebody discovers it is being kept at all. */
        + (hasGroup()
            ? '<div class="grp"><span class="k">Your group</span><div class="pills">'
              + '<button class="pill" data-forgetgroup="1">Forget '
              + esc(groupNames(loadGroup())) + '</button></div>'
              + '<div class="tip">Kept so a new trip starts with the same people. '
              + 'Forgetting them empties the cards; nothing else changes.</div></div>'
            : '')

        + '<div class="grp"><span class="k">Time</span><div class="pills">'
        + pill(!SET.time24, 'time24', '12', '1:40pm') + pill(SET.time24, 'time24', '24', '13:40')
        + '</div></div>'

        + '<div class="sheet-foot"><span>' + (DATA ? (DATA.sample ? 'example data'
            : 'fares ' + (gen ? gen.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'unknown'))
            : 'nothing loaded') + '</span>'
        + '<span>v' + VERSION + ' · <a href="' + REPO + '" target="_blank" rel="noopener">source</a></span></div>');
}

function aboutSheet() {
    openSheet('<h2 id="sheetTitle">About</h2><div class="sub">Fly with Friends</div><div class="about-body">'
        + '<p>Three or more people in three or more cities agree on somewhere to meet. Then everyone '
        + 'opens Google Flights alone, and the group ends up with one person landing at 7am and another '
        + 'at 11pm, with nobody able to say whether the $80 someone saved cost the group five hours in '
        + 'an arrivals hall.</p>'
        + '<p>This works out the opposite: the flights that put everyone on the ground inside '
        + 'the same few minutes, and what that costs compared with everyone booking separately.</p>'

        + '<h3>How it decides</h3>'
        + '<p>It finds the closest everyone can actually get, then prices the trade — because '
        + '<strong>landing together and landing cheaply pull against each other</strong>. There is rarely '
        + 'one right answer, so it picks one and shows what the cheapest and the closest would cost '
        + 'instead.</p>'
        + '<p>Where a group is big enough that one person wrecks the timing, it says so by name rather '
        + 'than quietly spreading everyone out.</p>'

        + '<h3>Why I built this</h3>'
        + '<p>I’m <strong>Altorien Lockwood</strong> — FP&amp;A Analyst and CPA candidate. I kept trying '
        + 'to organize trips with friends spread across the country and doing the arithmetic by hand in a '
        + 'spreadsheet. The math is not hard, it is just tedious and nobody does it, so groups end up '
        + 'landing hours apart by default. This does it in a second.</p>'

        + '<h3>Honest limits</h3>'
        + '<p>Fares come from Google Flights and move constantly — confirm on the airline’s own site '
        + 'before paying. Google publishes almost no baggage pricing, so bag costs are an assumption and '
        + 'the app marks them as one. Some airports have no service at all, like Ukraine’s since 2022; '
        + 'the app will tell you rather than return an empty result.</p>'

        + '<h3>Say something</h3>'
        + '<p>Feedback, ideas, or just want to say what’s up? Find me on '
        + '<a href="' + LINKEDIN + '" target="_blank" rel="noopener">LinkedIn</a>.</p>'
        + '</div>');
}

/* --------------------------------------------------------------- events */

document.addEventListener('click', function (ev) {
    var tgt = ev.target;
    if (tgt.closest('#shiftBtn')) { runShiftScan(); return; }
    if (tgt.closest('#shiftLock')) return;
    if (tgt.closest('#gearBtn')) { settingsSheet(); return; }
    if (tgt.closest('#aboutBtn')) { aboutSheet(); return; }
    if (tgt.id === 'sheetClose' || tgt.id === 'scrim') { closeSheet(); return; }
    if (tgt.closest && tgt.closest('[data-forgetgroup]')) {
        forgetGroup();
        /* Clearing the saved roster has to clear the cards too, or Settings
         * would say the group is forgotten while the group is still on screen
         * and about to be saved again by the next search. */
        state.q.parties = blankQuery().parties;
        if (SET.meId) { SET.meId = null; saveSet(); }
        renderParties(); renderGear();
        settingsSheet();
        return;
    }
    /* #installX and #installAdd are handled by installPrompt(), which owns the
     * card's dismissal animation and its snooze window. */

    var t = tgt.closest && tgt.closest('[data-threshold],[data-set],[data-bag],'
        + '[data-stops],[data-match],[data-clusterback],[data-seats],'
        + '[data-rmparty],[data-addair],[data-rmair],[data-air],[data-alli],'
        + '[data-air-clear],[data-qm]');
    if (!t) return;
    var card = t.closest('.party');
    var p = card ? party(card.getAttribute('data-pid')) : null;

    if (t.hasAttribute('data-seats')) {
        readNames();
        p.seats = Math.min(APP.maxSeats, Math.max(1, p.seats + (+t.getAttribute('data-seats'))));
        renderParties();
    } else if (t.hasAttribute('data-rmparty')) {
        readNames();
        state.q.parties = state.q.parties.filter(function (x) { return x.id !== p.id; });
        renderParties();
    } else if (t.hasAttribute('data-addair')) {
        var f = card.querySelector('[data-airfield]');
        f.classList.remove('hidden');
        card.querySelector('[data-airinput]').focus();
    } else if (t.hasAttribute('data-rmair')) {
        readNames();
        var code = t.getAttribute('data-rmair');
        p.airports = p.airports.filter(function (c) { return c !== code; });
        renderParties();
    } else if (t.hasAttribute('data-match')) {
        selectMatch(t.getAttribute('data-match'));
    } else if (t.hasAttribute('data-clusterback')) {
        /* The button names the state it moves to rather than toggling, because
         * there are three of them and a toggle cannot reach 'any'. */
        var cb = t.getAttribute('data-clusterback');
        state.q.clusterReturn = cb === '0' ? false : cb === 'any' ? 'any' : true;
        state.th['return'] = null;
        writeHash(); render();
    } else if (t.hasAttribute('data-stops')) {
        var raw = t.getAttribute('data-stops');
        state.q.maxStops = raw === '' ? null : +raw;
        thReset(); renderStepStops(); writeHash(); render();
    } else if (t.hasAttribute('data-air')) {
        /* Toggle one carrier. No re-search: we filter options already in hand. */
        var key = t.getAttribute('data-air');
        var at = state.q.avoid.indexOf(key);
        if (at > -1) state.q.avoid.splice(at, 1); else state.q.avoid.push(key);
        thReset(); writeHash(); render();
    } else if (t.hasAttribute('data-alli')) {
        /* "Only this alliance" = avoid every carrier on the route outside it.
         * Expressed as exclusions so there is one mechanism to reason about,
         * and so a carrier that appears later is not silently let in. */
        var want = t.getAttribute('data-alli');
        state.q.avoid = carriersInResults()
            .filter(function (c) { return c.alliance !== want; })
            .map(function (c) { return c.key; });
        thReset(); writeHash(); render();
    } else if (t.hasAttribute('data-air-clear')) {
        state.q.avoid = [];
        thReset(); writeHash(); render();
    } else if (t.hasAttribute('data-qm')) {
        var pop = el('qm-' + t.getAttribute('data-qm'));
        if (pop) {
            var open = pop.className.indexOf('hidden') > -1;
            /* One open at a time: these are tall on a phone. */
            Array.prototype.forEach.call(document.querySelectorAll('.qm-pop'), function (x) {
                x.className = 'qm-pop hidden';
            });
            Array.prototype.forEach.call(document.querySelectorAll('.qm'), function (x) {
                x.setAttribute('aria-expanded', 'false');
            });
            if (open) { pop.className = 'qm-pop'; t.setAttribute('aria-expanded', 'true'); }
        }
    } else if (t.hasAttribute('data-threshold')) {
        var v = t.getAttribute('data-threshold');
        var sect = t.closest('.leg');
        var legOf = sect && sect.id === 'legBack' ? 'return' : 'outbound';
        state.th[legOf] = v === 'subset' ? 'subset' : (v === 'Infinity' ? FWF.INF : +v);
        render();
    } else if (t.hasAttribute('data-set')) {
        var key = t.getAttribute('data-set'), val = t.getAttribute('data-val');
        if (key === 'target') val = +val;
        else if (key === 'time24') val = val === '24';
        else if (key === 'meId' && val === '') val = null;
        SET[key] = val; saveSet();
        if (key === 'theme') applyTheme();
        thReset();
        settingsSheet(); render();
    } else if (t.hasAttribute('data-bag')) {
        var w = t.getAttribute('data-bag');
        var b = { carry_on: SET.bags.carry_on || 0, checked: SET.bags.checked || 0 };
        b[w] = b[w] > 0 ? 0 : 1;
        SET.bags = b; saveSet(); thReset();
        settingsSheet(); render();
    }
});

function fillBand() {
    /* Step 2 asks about the outbound landing window specifically. */
    var ob = bandFor('outbound');
    renderStepStops();
}
function todayISO() { return new Date().toISOString().slice(0, 10); }

/* ---------------------------------------------------------- dates */

var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var DOW = ['S','M','T','W','T','F','S'];

function ymd(iso) {
    var p = String(iso || '').split('-');
    return p.length === 3 ? { y: +p[0], m: +p[1] - 1, d: +p[2] } : null;
}
function iso(y, m, d) {
    return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

/* "Dec 3" / "Dec 3 – Dec 8" / "Dec 28 – Jan 3" — no year unless the range
 * crosses one, which is how every airline writes it. ISO belongs in the data,
 * not on the screen. */
function prettyDate(isoStr, withYear) {
    var p = ymd(isoStr);
    if (!p) return '';
    return MON[p.m] + ' ' + p.d + (withYear ? ', ' + p.y : '');
}
function prettyRange(a, b) {
    var pa = ymd(a), pb = ymd(b);
    if (!pa) return '';
    var crossesYear = pb && pb.y !== pa.y;
    if (!pb) return prettyDate(a, crossesYear) + ' · one way';
    return prettyDate(a, crossesYear) + ' – ' + prettyDate(b, crossesYear);
}
function weekdayShort(isoStr) {
    var p = ymd(isoStr);
    if (!p) return '';
    return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(Date.UTC(p.y, p.m, p.d)).getUTCDay()];
}

/* ------------------------------------------------------ range picker */

var calOpen = false, calCursor = null, calView = 'days';

function calMonths() {
    return window.matchMedia && window.matchMedia('(min-width: 620px)').matches ? 2 : 1;
}

/* Where the calendar opens. The month holding the departure if there is one,
 * otherwise this month -- unless this month has less than a week of bookable
 * days left, in which case the next one is the honest answer. Opened on the
 * 30th, "October" is two days and "November" is a month, and nobody planning a
 * trip with three friends is flying tomorrow. The tail of this month is one
 * tap back, because the chevron that used to be a dead grey ghost is live. */
function calHome() {
    var p = ymd(state.q.dep);
    if (p) return { y: p.y, m: p.m, d: 1 };
    var t = ymd(todayISO());
    var left = new Date(Date.UTC(t.y, t.m + 1, 0)).getUTCDate() - t.d + 1;
    if (left >= 7) return { y: t.y, m: t.m, d: 1 };
    var m = t.m + 1;
    return { y: t.y + Math.floor(m / 12), m: m % 12, d: 1 };
}

/* `withLabel` is false when the header already names the month, which on a
 * phone is always. It printed "Oct 2026" here AND in .cal-title, 88px apart. */
function monthGrid(y, m, withLabel) {
    var lead = new Date(Date.UTC(y, m, 1)).getUTCDay();
    var days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    var today = todayISO(), td = ymd(today);
    var dep = state.q.dep, ret = state.q.ret;
    /* A band needs two ends. With only a departure picked, `start` on its own
     * painted a half-band running out of the side of a lone circle, which read
     * as a clipping fault rather than a range. */
    var band = !!(dep && ret);
    var firstISO = iso(y, m, 1), lastISO = iso(y, m, days);
    var runsIn = band && dep < firstISO && ret >= firstISO;
    var runsOut = band && ret > lastISO && dep <= lastISO;

    /* Weeks wholly behind us are not drawn at all. On the 30th the old grid
     * spent five rows on 29 unbookable numbers in order to offer two live
     * days; it now opens on the week we are actually in. The empty cells
     * inside that week stay, because they are what keeps the 30th under F. */
    var from = 0;
    if (td.y === y && td.m === m) from = Math.floor((lead + td.d - 1) / 7) * 7;
    var total = Math.ceil((lead + days) / 7) * 7;

    var cells = '';
    for (var i = from; i < total; i++) {
        var d = i - lead + 1;
        if (d < 1 || d > days) {
            /* Padding outside the month carries the band, so a range that
             * continues past the month edge runs off the edge of the grid
             * instead of stopping square in the middle of a row. */
            cells += '<span class="cal-cell' + ((d < 1 ? runsIn : runsOut) ? ' mid' : '') + '"></span>';
            continue;
        }
        var v = iso(y, m, d);
        /* A past day is drawn as nothing, not as a greyed-out number. 29
         * tombstones made the month read "mostly broken"; nothing makes it
         * read "starts here". */
        if (v < today) { cells += '<span class="cal-cell"></span>'; continue; }
        var isDep = v === dep, isRet = band && v === ret;
        var inRange = band && v > dep && v < ret;
        cells += '<span class="cal-cell' + (band && isDep ? ' start' : '') + (isRet ? ' end' : '') + (inRange ? ' mid' : '') + '">'
            + '<button class="cal-d' + (isDep || isRet ? ' on' : '') + (v === today ? ' today' : '')
            + '" data-day="' + v + '"' + (v === today ? ' aria-current="date"' : '')
            + ' aria-label="' + weekdayShort(v) + ' ' + prettyDate(v, true)
            + (isDep ? ', flying out' : isRet ? ', coming back' : inRange ? ', in your trip' : '')
            + '">' + d + '</button></span>';
    }
    /* The column letters are hidden from assistive tech: "S M T W T F S" is
     * noise when every day already announces its own weekday. */
    return '<div>' + (withLabel ? '<div class="cal-mon">' + MON[m] + ' ' + y + '</div>' : '')
        + '<div class="cal-dow" aria-hidden="true">' + DOW.map(function (x) { return '<span>' + x + '</span>'; }).join('') + '</div>'
        + '<div class="cal-grid">' + cells + '</div></div>';
}

function renderCal() {
    var host = el('cal');
    if (!calOpen) { host.className = 'cal hidden'; el('dateBtn').setAttribute('aria-expanded', 'false'); return; }
    var t = ymd(todayISO());
    /* The calendar can be opened from more than one place, so the cursor is
     * established here rather than relying on whoever opened it. A shared link
     * can carry dates that have since passed, so it is also clamped forward:
     * there is nothing bookable behind today, and a month drawn entirely of
     * empty cells would look like a fault. */
    if (!calCursor) calCursor = calHome();
    if (calCursor.y < t.y || (calCursor.y === t.y && calCursor.m < t.m)) calCursor = { y: t.y, m: t.m, d: 1 };
    host.className = 'cal';
    el('dateBtn').setAttribute('aria-expanded', 'true');

    var n = calMonths(), base = calCursor, body, title, step, backOff;

    if (calView === 'months') {
        /* The chevrons step a year here. +-12 on the month index is the same
         * arithmetic the day view already does, so the handler is unchanged. */
        step = 12; title = String(base.y); backOff = base.y === t.y;
        var dp = ymd(state.q.dep), mos = '';
        for (var k = 0; k < 12; k++) {
            var sel = !!dp && dp.y === base.y && dp.m === k;
            mos += '<button class="cal-mo' + (sel ? ' sel' : k === base.m ? ' on' : '') + '" data-mo="' + k + '"'
                + (base.y === t.y && k < t.m ? ' disabled' : '')
                + ' aria-label="' + MON[k] + ' ' + base.y + '">' + MON[k] + '</button>';
        }
        body = '<div class="cal-mgrid">' + mos + '</div>';
    } else {
        step = 1; title = n === 2 ? String(base.y) : MON[base.m] + ' ' + base.y;
        backOff = base.y === t.y && base.m === t.m;
        var months = '';
        for (var i = 0; i < n; i++) {
            var mm = base.m + i;
            months += monthGrid(base.y + Math.floor(mm / 12), ((mm % 12) + 12) % 12, n === 2);
        }
        body = '<div class="cal-months' + (n === 2 ? ' two' : '') + '">' + months + '</div>';
    }

    /* Two states, not three. The third used to repeat the range that the
     * trigger button directly above already shows, and the second repeated the
     * one-way advice that #s2sub already gives -- at 393px that spilled onto
     * three lines and pushed the footer taller than the row of actions. */
    var hint = calView === 'months' ? ''
        : !state.q.dep ? 'Pick the day you fly out'
        : !state.q.ret ? 'Now pick the return' : '';

    host.innerHTML = '<div class="cal-head">'
        + '<button class="cal-nav" data-cal="' + (-step) + '" aria-label="Previous ' + (step === 12 ? 'year' : 'month') + '"'
        + (backOff ? ' disabled' : '') + '>&#8249;</button>'
        + '<button class="cal-title" data-cal="view" aria-expanded="' + (calView === 'months') + '" aria-label="'
        + esc(calView === 'months' ? base.y + ', back to the days' : MON[base.m] + ' ' + base.y + ', jump to another month') + '">'
        + esc(title) + '<span class="caret" aria-hidden="true">' + (calView === 'months' ? '&#9652;' : '&#9662;') + '</span></button>'
        + '<button class="cal-nav" data-cal="' + step + '" aria-label="Next ' + (step === 12 ? 'year' : 'month') + '">&#8250;</button></div>'
        + body
        + '<div class="cal-foot">' + (hint ? '<span class="cal-hint">' + esc(hint) + '</span>' : '')
        + '<span class="cal-acts">' + (state.q.dep ? '<button class="cal-clear" data-cal="clear">Clear</button>' : '')
        + '<button class="btn primary" data-cal="done">Done</button></span></div>';
}

/* Arrow-key navigation has to be able to cross a month edge, which means
 * moving the cursor and re-rendering, so focus is restored by date rather
 * than held on an element that no longer exists. */
function calFocusDay(from, delta) {
    var p = ymd(from);
    if (!p) return;
    var dt = new Date(Date.UTC(p.y, p.m, p.d + delta));
    var want = iso(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
    if (want < todayISO()) want = todayISO();
    var q = ymd(want);
    if (q.y !== calCursor.y || q.m !== calCursor.m) { calCursor = { y: q.y, m: q.m, d: 1 }; renderCal(); }
    var b = el('cal').querySelector('[data-day="' + want + '"]');
    if (b) b.focus();
}

function setDateLabel() {
    var b = el('dateBtn'), l = el('dateLabel');
    if (!state.q.dep) { b.className = 'datefield empty'; l.textContent = 'When are you going?'; return; }
    b.className = 'datefield';
    l.textContent = prettyRange(state.q.dep, state.q.ret);
}

function pickDay(v) {
    /* First tap sets the outbound. Second extends it, unless it is earlier, in
     * which case treating it as a new outbound is what people actually mean. */
    if (!state.q.dep || state.q.ret || v < state.q.dep) {
        state.q.dep = v; state.q.ret = '';
    } else if (v === state.q.dep) {
        state.q.ret = '';
    } else {
        state.q.ret = v;
    }
    el('dep').value = state.q.dep; el('ret').value = state.q.ret;
    thReset();
    /* renderCal() destroys the button that was just activated, so a keyboard
     * user was dropped back to <body> after every pick. Put focus on the same
     * date again. A pointer tap shows no ring, because the rule is
     * :focus-visible. */
    var hadFocus = !!(document.activeElement && document.activeElement.hasAttribute
        && document.activeElement.hasAttribute('data-day'));
    setDateLabel(); renderCal();
    calRefocus('[data-day="' + v + '"]', hadFocus);
}

/* A date input with no value opens at `min`, so pointing the return's min at
 * the departure date is what stops it opening months earlier. */
function syncDateBounds() {
    if (state.q.ret && state.q.dep && state.q.ret < state.q.dep) state.q.ret = '';
    el('dep').value = state.q.dep || '';
    el('ret').value = state.q.ret || '';
    setDateLabel();
}

function fillForm() {
    var a = AIRPORTS.get(state.q.dest);
    el('dest').value = a ? a.code : (state.q.dest || '');
    el('dep').value = state.q.dep || '';
    el('ret').value = state.q.ret || '';
    syncDateBounds();
    fillBand();
}

/* Band inputs live inside the leg sections, which are re-rendered, so they are
 * wired by delegation rather than by id. */
document.addEventListener('change', function (ev) {
    var n = ev.target.closest && ev.target.closest('[data-bleg]');
    if (!n) return;
    var leg = n.getAttribute('data-bleg'), end = n.getAttribute('data-bend');
    var cur = bandFor(leg);
    state.q.band[leg] = { from: cur.from || '', to: cur.to || '' };
    state.q.band[leg][end] = n.value;
    state.th[leg] = null;
    writeHash(); render();
});
document.addEventListener('click', function (ev) {
    var n = ev.target.closest && ev.target.closest('[data-bclear]');
    if (!n) return;
    var leg = n.getAttribute('data-bclear');
    state.q.band[leg] = { from: '', to: '' };
    state.th[leg] = null;
    writeHash(); render();
});

el('to2').addEventListener('click', function () {
    if (!AIRPORTS.isKnown(state.q.dest)) {
        el('destHint').className = 'hint bad';
        el('destHint').textContent = 'Pick an airport from the list.';
        el('dest').focus();
        el('dest').scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
    }
    showStep(2);
    if (!state.q.dep) { calOpen = true; renderCal(); }
});
el('to3').addEventListener('click', function () {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(state.q.dep)) {
        state.error = 'Pick your dates first.';
        calOpen = true; renderCal(); render(); return;
    }
    if (state.q.ret && state.q.ret < state.q.dep) { state.error = 'The return date is before the departure date.'; render(); return; }
    state.error = null; render(); showStep(3);
});
el('back2').addEventListener('click', function () { showStep(1); });
el('back3').addEventListener('click', function () { showStep(2); });
el('back4').addEventListener('click', function () { showStep(3); });
el('go').addEventListener('click', function () { if (!state.busy) doSearch(); });
/* The example button is gone: the first screen should ask for a destination,
 * not offer a detour around it. The example itself stays reachable at ?demo=1,
 * because it renders every screen in the app without spending a search. */
if (/[?&]demo=1\b/.test(location.search)) loadDemo();
/* ?unlock=dates turns the nearby-date search on for this device and remembers
 * it, so the feature can be used and tested before there is anything to buy. */
if (/[?&]unlock=dates\b/.test(location.search)) {
    try { localStorage.setItem('fwf_unlock_dates', '1'); } catch (e) {}
}
/* The mark doubles as the home button. Same action as "New trip", which was
 * only reachable by scrolling to the footer. */
if (el('homeBtn')) el('homeBtn').addEventListener('click', function () { newTrip(); });
/* A new trip is a new destination and new dates, not new friends. Keeping the
 * group is the whole reason the roster is saved -- clearing it here would mean
 * the app remembered your people right up until you asked it for another trip.
 * Forgetting them is a separate, deliberate act, in Settings. */
function newTrip() {
    /* Orphans any search still in flight so it cannot come back and take over
     * the screen, and stops the clock on the searching view. */
    searchGen++;
    state.busy = false;
    stopSearching();
    var keep = loadGroup();
    state.q = blankQuery();
    if (keep) state.q.parties = keep;
    DATA = null; state.error = null; thReset();
    history.replaceState(null, '', location.pathname);
    fillForm(); renderParties(); showStep(1); render();
}
el('newBtn').addEventListener('click', newTrip);
el('addParty').addEventListener('click', function () {
    if (state.q.parties.length >= APP.maxParties) {
        state.error = APP.maxParties + ' departure cities is the limit.'; render(); return;
    }
    readNames();
    state.q.parties.push(newParty(state.q.parties.length));
    renderParties();
});
el('dateBtn').addEventListener('click', function () {
    calOpen = !calOpen;
    calView = 'days';
    calCursor = calHome();
    renderCal();
});

/* Every control in here is thrown away and rebuilt by renderCal(), so a
 * keyboard user ends up on <body> after each press unless focus is put back by
 * selector. It is only put back when the control actually held focus, which a
 * pointer tap on iOS does not do -- so a tap never gets a ring it did not ask
 * for, and Tab/Enter never loses its place. */
function calRefocus(sel, had) {
    if (!had) return;
    var b = el('cal').querySelector(sel);
    if (b && !b.disabled) b.focus();
}

el('cal').addEventListener('click', function (ev) {
    var day = ev.target.closest('[data-day]');
    if (day && !day.disabled) { pickDay(day.getAttribute('data-day')); return; }
    /* The month jump: twelve months in place of the day grid. */
    var mo = ev.target.closest('[data-mo]');
    if (mo && !mo.disabled) {
        var hadMo = document.activeElement === mo;
        calCursor = { y: calCursor.y, m: +mo.getAttribute('data-mo'), d: 1 };
        calView = 'days'; renderCal();
        calRefocus('.cal-title', hadMo);
        return;
    }
    var act = ev.target.closest('[data-cal]');
    if (!act) return;
    var v = act.getAttribute('data-cal'), had = document.activeElement === act;
    if (v === 'done') { calOpen = false; calView = 'days'; renderCal(); el('dateBtn').focus(); }
    else if (v === 'clear') {
        state.q.dep = ''; state.q.ret = ''; thReset(); syncDateBounds(); renderCal();
        /* Clear is gone from the footer the moment it works, so focus has
         * nowhere to go back to. Done is the neighbour it leaves behind. */
        calRefocus('[data-cal="done"]', had);
    }
    else if (v === 'view') {
        calView = calView === 'days' ? 'months' : 'days';
        renderCal();
        calRefocus('.cal-title', had);
    } else {
        /* +-1 in the day view, +-12 in the month view. The month index carries
         * the overflow either way, so there is one branch for both. */
        var m = calCursor.m + (+v), y = calCursor.y + Math.floor(m / 12);
        calCursor = { y: y, m: ((m % 12) + 12) % 12, d: 1 };
        renderCal();
        calRefocus('[data-cal="' + v + '"]', had);
    }
});

var CAL_KEYS = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, PageUp: -28, PageDown: 28 };

document.addEventListener('keydown', function (ev) {
    if (!calOpen) return;
    if (ev.key === 'Escape') { calOpen = false; calView = 'days'; renderCal(); el('dateBtn').focus(); return; }
    if (calView !== 'days') return;
    var cur = document.activeElement;
    if (!cur || !cur.hasAttribute || !cur.hasAttribute('data-day')) return;
    var delta = CAL_KEYS[ev.key];
    if (!delta) return;
    ev.preventDefault();
    calFocusDay(cur.getAttribute('data-day'), delta);
});

/* The landing window is set on the results screen now, where the plan it
 * filters is on the page. Asking for it before any flights existed was a
 * question nobody could answer yet -- and it was the same control twice. The
 * presets write state directly; they used to write the two time inputs and read
 * them back, which only made sense while those inputs were the real control. */
function setBand(from, to) {
    state.q.band.outbound = { from: from || '', to: to || '' };
    renderBandPresets();
    thReset();
    writeHash();
    if (state.step === 4) render();
}
document.addEventListener('click', function (ev) {
    var n = ev.target.closest && ev.target.closest('[data-bpre]');
    if (!n) return;
    var pre = BAND_PRESETS.filter(function (x) { return x.k === n.getAttribute('data-bpre'); })[0];
    if (pre) setBand(pre.from, pre.to);
});

if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () {
        if (SET.theme === 'system') applyTheme();
    });
}

/* ----------------------------------------------------------------- boot */

SET = loadSet();
applyTheme();

var sharedId = tripIdFromHash();
var shared = readHash();
/* A shared link carries its own cast and always wins -- opening somebody else's
 * trip must show their group, not yours. Failing that, the group from last time
 * if there is one, and only then three empty cards. */
state.q = migrateQuery((shared && shared.q && shared.q.parties) ? shared.q : blankQuery());
if (!(shared && shared.q && shared.q.parties)) {
    var savedGroup = loadGroup();
    if (savedGroup) state.q.parties = savedGroup;
}
if (shared && shared.v) {
    /* Adopt the sender's reading of the trip so both people see one number. */
    var v = shared.v;
    if (v.target) SET.target = v.target;
    if (v.bags) SET.bags = v.bags;
    if (v.priceDisplay) SET.priceDisplay = v.priceDisplay;
    if (v.leg === 'outbound' || v.leg === 'return') state.leg = v.leg;
    if (v.recommend) state.recommend = v.recommend;
    if (v.match) state.match = v.match;
    if (v.th) {
        state.th.outbound = v.th.outbound === 'inf' ? FWF.INF : v.th.outbound;
        state.th.return = v.th.return === 'inf' ? FWF.INF : v.th.return;
    } else if (v.threshold != null) {
        state.th[v.leg || 'outbound'] = v.threshold === 'inf' ? FWF.INF : v.threshold;
    }
}

attachAc(el('dest'), el('destAc'), function (a) {
    state.q.dest = a.code;
    /* The code only. The hint directly below already spells out the city and
     * the airport name, so repeating it here bought nothing and overflowed the
     * field at any city name longer than "Cabo". */
    el('dest').value = a.code;
    if (a.closed) {
        el('destHint').className = 'hint bad';
        el('destHint').textContent = closedDestNote(a);
    } else {
        el('destHint').className = 'hint good';
        el('destHint').textContent = a.city + ' — ' + a.name;
    }
}, { noMetros: true, onEnter: function () { el('to2').click(); } });

el('dest').addEventListener('input', function () {
    if (!AIRPORTS.isKnown(state.q.dest) || el('dest').value.indexOf(state.q.dest) !== 0) state.q.dest = '';
    el('destHint').className = 'hint';
    el('destHint').textContent = DEST_HINT;
});

/* The same autocomplete, the same rule: a destination is one airport, because a
 * group landing at three airports is not landing together. */
destEditAc = attachAc(el('resDest'), el('resDestAc'), retargetDest, { noMetros: true });

/* #resT is rebuilt on every render, so the city button cannot hold its own
 * listener. */
document.addEventListener('click', function (ev) {
    if (ev.target.closest && ev.target.closest('#destBtn')) destEditOpen();
});
el('resDest').addEventListener('keydown', function (ev) {
    /* Escape abandons the edit outright, without a search. The autocomplete's
     * own handler has already shut the list by the time this runs; stopping
     * propagation keeps the key from reaching the page-level handlers. */
    if (ev.key === 'Escape') { ev.stopPropagation(); destEditClose(true); }
});
el('resDest').addEventListener('blur', function () {
    /* Tapping away is the other way to mean "never mind". The delay matches the
     * grace period the autocomplete gives its own list, so a tap on a
     * suggestion still lands -- that path clears destEditing first, so this
     * only fires on an edit that was genuinely abandoned. */
    setTimeout(function () {
        if (destEditing && document.activeElement !== el('resDest')) destEditClose(false);
    }, 200);
});

fillForm();
renderParties();
showStep(1);
render();

/* The app is built to live on a home screen -- that is where the launch screen,
 * the status bar handling and the full-height layout come from -- so someone who
 * only ever opens it in Safari is using a worse version of it without knowing
 * there is a better one. This is the only thing that tells them.
 *
 * It is deliberately quiet: not on the first visit, dismissible, and silent for
 * a fortnight afterwards. An install prompt that argues is worse than none. */
(function installPrompt() {
    var card = el('installBanner');
    if (!card) return;

    var ua = navigator.userAgent;
    /* iPadOS reports itself as a Mac, so the giveaway is a Mac with a
     * touchscreen. Chrome and Firefox on iOS cannot add to the home screen at
     * all, and their own UA strings are the only way to tell. */
    var iOS = /iPhone|iPod/i.test(ua)
        || (/iPad/i.test(ua))
        || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    var iOSSafari = iOS && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
    var standalone = window.navigator.standalone
        || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

    var deferred = null;
    window.addEventListener('beforeinstallprompt', function (ev) {
        /* Chrome's own mini-infobar would otherwise cover this card. */
        ev.preventDefault();
        deferred = ev;
        el('installT').textContent = 'Keep it on your home screen';
        el('installS').textContent = 'One tap. It opens full screen, with no address bar.';
        el('installAdd').classList.remove('hidden');
        offer();
    });

    function store(v) { try { localStorage.setItem('fwf_install', v); } catch (e) {} }
    function read() { try { return localStorage.getItem('fwf_install'); } catch (e) { return null; } }

    function muted() {
        var s = read();
        if (!s) return false;
        if (s === 'installed') return true;
        var until = Date.parse(s);
        return isFinite(until) && Date.now() < until;
    }

    function offer() {
        if (standalone || muted() || !card.classList.contains('hidden')) return;
        card.classList.remove('hidden');
    }

    function dismiss() {
        card.classList.add('out');
        setTimeout(function () { card.classList.add('hidden'); card.classList.remove('out'); },
                   sheetOutMs());
        store(new Date(Date.now() + 14 * 86400000).toISOString());
    }

    card.addEventListener('click', function (ev) {
        if (ev.target.closest('#installX')) { dismiss(); return; }
        if (ev.target.closest('#installAdd') && deferred) {
            deferred.prompt();
            deferred.userChoice.then(function (r) {
                if (r.outcome === 'accepted') store('installed');
                deferred = null;
                dismiss();
            });
        }
    });

    window.addEventListener('appinstalled', function () { store('installed'); dismiss(); });

    /* Asking on arrival is asking before the app has earned it. Second visit
     * onward, and after the first screen has settled. */
    if (iOSSafari && !standalone && !muted()) {
        var visits = 0;
        try { visits = (+localStorage.getItem('fwf_visits') || 0) + 1;
              localStorage.setItem('fwf_visits', visits); } catch (e) { visits = 2; }
        if (visits >= 2) setTimeout(offer, 1600);
    }
})();

if (API) {
    fetch(API + '/budget').then(function (r) { return r.json(); })
        .then(function (b) { setBudget(b); if (state.step === 4) render(); }).catch(function () {});
}

if (sharedId) {
    /* Opening someone else's trip must not cost a search. */
    TRIP_ID = sharedId;
    state.error = null;
    fetch(API + '/trip/' + sharedId).then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, body: j }; });
    }).then(function (res) {
        if (!res.ok || !res.body || !res.body.data) {
            state.error = (res.body && res.body.error)
                || 'Could not open that trip. Ask for a fresh link, or start a new trip.';
            TRIP_ID = null; render(); return;
        }
        var pay = res.body.payload || {};
        if (pay.q && pay.q.parties) state.q = migrateQuery(sanitizeQuery(pay.q));
        if (pay.v) {
            var v = pay.v;
            if (v.target) SET.target = v.target;
            if (v.bags) SET.bags = v.bags;
            if (v.priceDisplay) SET.priceDisplay = v.priceDisplay;
            if (v.recommend) state.recommend = v.recommend;
            if (v.match) state.match = v.match;
            if (v.th) {
                state.th.outbound = v.th.outbound === 'inf' ? FWF.INF : v.th.outbound;
                state.th['return'] = v.th['return'] === 'inf' ? FWF.INF : v.th['return'];
            }
        }
        DATA = res.body.data;
        fillForm(); renderParties();
        showStep(4); render();
    }).catch(function (e) {
        if (window.console) console.error('shared trip failed', e);
        state.error = 'Could not open that trip. Check your connection, or start a new trip.';
        TRIP_ID = null; render();
    });
} else if (shared && shared.q && shared.q.parties && validate() === null) {
    doSearch();
}

})();
