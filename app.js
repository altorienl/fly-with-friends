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
/* Set once per render pass, immediately before tripTotal(), and cleared when
 * no match could be built. Not state: it is derived from the option sets the
 * pass is already holding, and a stale one would price a plan against filters
 * that have since moved. */
var PICKED_PLAN = null;

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
    return { meId: null, target: APP.target, priceDisplay: 'allin',
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

/* applyTheme() is gone with the second theme. The app is light, the status bar
 * colour is the masthead, and there is nothing left to decide at runtime. */

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
/* Names arrive however somebody typed them on a phone, which is usually
 * lowercase, and they are then printed as headings, in the group-chat block and
 * in an email subject. Only the first letter of each word is raised -- the rest
 * is left exactly as typed, so "McDonald" and an all-caps "NICK" both survive,
 * and "jim / gary" becomes "Jim / Gary" because the separator is not a letter. */
/* Where an airport is, for the one question three letters cannot answer: "am I
 * sure I clicked the right one". ONT is Ontario, California. PDX is Portland,
 * Oregon, and there is a Portland in Maine. SJC and SJO are both San Jose.
 * Falls back to the city alone, which is every airport outside the US, Canada
 * and the one ambiguous pair -- for those the country is the disambiguator and
 * it is already on the row. */
function placeOf(a) {
    if (!a) return '';
    /* JFK and LGA are in the city of New York in the state of New York, and
     * "New York, New York" is a lyric, not a disambiguation. The data stays
     * right -- they ARE in New York state -- and the repeat is suppressed where
     * it would be read. */
    if (!a.region || a.region === a.city) return a.city;
    return a.city + ', ' + a.region;
}

function titleCase(str) {
    return String(str).replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, function (m, pre, ch) {
        return pre + ch.toUpperCase();
    });
}
/* "Friend 1", not "Flight 1". Reported after a real session: filling this
 * page is most of the work in the app, and typing three names before you can
 * see a single fare is the part people give up on. A name nobody entered
 * should still read as a person, so the placeholder and the fallback are the
 * same string -- leave it blank and the results say "Friend 2 lands 7:40pm",
 * which is a sentence, where "Flight 2 lands 7:40pm" is a row in a table.
 *
 * It stays a PLACEHOLDER rather than a prefilled value, which is what makes
 * it disappear on the first keystroke with nothing to backspace through. */
function partyLabel(p, i) {
    var n = (p.name || '').trim();
    return n ? titleCase(n) : defaultPartyName(i);
}
function defaultPartyName(i) { return 'Friend ' + (i + 1); }

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

/* Somebody whose only airport IS the destination already lives there.
 *
 * The app treated them as a traveller with no flights: a red dashed card, "not
 * with the group", and $0 all in, next to a Book button for a trip that does
 * not exist. That is the failure state, and being at the meeting point already
 * is the opposite of a failure. It is also not rare -- the friend who lives in
 * the city is exactly why that city got picked.
 *
 * They stay in the trip and in the head count. They are just not flying, so
 * nothing searches for them, nothing prices them, and no window has to cover
 * them. */
function isLocal(t) {
    var dest = (state.q && state.q.dest) ? [String(state.q.dest).toUpperCase()] : [];
    if (!dest.length || !t.origins || !t.origins.length) return false;
    return t.origins.every(function (a) {
        return dest.indexOf(String(a).toUpperCase()) > -1;
    });
}

function allParties() {
    return state.q.parties.map(function (p, i) {
        return { id: p.id, name: partyLabel(p, i), origins: p.airports.slice(),
                 seats: Math.max(1, p.seats || 1), color: partyColor(i), bags: SET.bags };
    });
}

/* Everyone the optimiser has to find a flight for -- which is everyone who is
 * not already there. Every window, every total and every search is built from
 * this list; locals come back in at render time. */
function travelers() {
    return allParties().filter(function (t) { return !isLocal(t); });
}

function locals() {
    return allParties().filter(isLocal);
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
                    /* Never drop a connection that is simply CHEAPER than the
                     * best nonstop. The margin below asks a connection to be
                     * worth its hassle, and that judgement now exists with
                     * units on it in tripScore -- EASE_PER_STOP and
                     * EASE_PER_MIN -- where it can be weighed against what the
                     * group gains. Here it is applied per party, before the
                     * optimiser sees any of it, so it was deleting flights the
                     * group plan needed.
                     *
                     * Measured on the live BZN fixture: removing a carrier
                     * made the recommended trip strictly cheaper AND tighter
                     * in 10% of carrier/group pairs, which is impossible from
                     * a smaller option set and so could only be this prune.
                     * One party kept exactly two $225+ United nonstops while
                     * four $180 connections were cut for being slower -- and
                     * those four were what landed the group 15 minutes apart
                     * instead of 51, for $45 less. Deleting the rule outright
                     * fixes the inversion and breaks six tests; this keeps it
                     * for the absurd flights it was written for, which are the
                     * ones that are slower AND no cheaper. */
                    if (leg === 'outbound' && costFn(o, id) < bestDirect) return true;
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
                + '<span class="ac-body"><span class="ac-city">'
                + esc(a.metro ? a.city : placeOf(a))
                + (a.metro ? ' — any airport' : a.closed ? ' — no service' : '') + '</span>'
                + '<span class="ac-sub">' + esc(a.name) + '</span></span>'
                /* Only where the place line has not already said it. "Charlotte,
                 * North Carolina" followed by "US" is the country twice, and
                 * the second one is the less useful of the two. */
                + (a.region ? '' : '<span class="ac-flag">' + esc(a.country) + '</span>')
                + '</button>';
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
        /* The choice is made, so the keyboard has nothing left to type into --
         * and on iOS it stays up until something blurs, covering half the
         * screen and the confirmation line that says which airport was picked.
         * Before onPick, because onPick can move focus itself and blurring
         * afterwards would take that focus away again. */
        if (input && input.blur) input.blur();
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
            + '<input class="party-name" data-f="name" placeholder="'
            + esc(defaultPartyName(i)) + '" value="' + esc(p.name)
            + '" maxlength="22" aria-label="Name for departure city ' + (i + 1) + '">'
            /* The seat stepper used to be here AS WELL as below the airports,
             * two controls doing one job -- reported as "the + seat and the
             * - 1 + both do the same and waste space". The one that survives
             * is the conditional one: it stays out of the way until the row
             * has an airport, because seats before a departure city mean
             * nothing, and it reads "+ seat" rather than "- 1 +" until there
             * is a second seat to remove. */
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
    var tv = travelers().filter(function (t) { return t.origins.length; });
    /* Fewer than two people actually flying is not a question this app
     * answers, and the worker refuses it with "Add at least two people" --
     * which reads as nonsense to somebody who added four, two of whom live at
     * the destination. Said here, in their terms, before a search is spent. */
    if (tv.length < 2) {
        var here = locals();
        state.error = here.length
            ? nameList(here.map(function (t) { return t.id; }))
              + (here.length === 1 ? ' is' : ' are') + ' already in '
              + ((AIRPORTS.get(state.q.dest) || {}).city || state.q.dest)
              + ', so there is nobody to land together. Add someone who is flying in.'
            : 'Add at least two people who are flying.';
        state.busy = false; render();
        return Promise.resolve();
    }

    startSearching();

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
        /* A search produces a different document: different fares, and a plan
         * nobody in the group has seen. Carrying somebody's "booked" across
         * would be the app asserting a purchase against flights that may not be
         * the ones they bought. */
        SHIFTS = {}; shiftErr = null; TRIP_ID = null;
        thReset(); state.leg = 'outbound';
        /* Remember who went, now that a real search has confirmed they are a
         * real group. Written after DATA is set so saveGroup can tell the
         * example apart from a search. */
        saveGroup();
        showStep(4); render();
        /* Save immediately, not when somebody taps share. The expensive link is
         * the one copied out of the address bar, and until the trip exists in
         * storage that link is a replayable paid search. Two KV writes against a
         * 1,000-a-day ceiling, once per search, buys every future opener a free
         * read -- including the sender's own reload. */
        saveTrip().then(function () { writeHash(); });
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
/* Once the trip is saved, the address bar carries the trip id as well as the
 * view. This is the whole economics of sharing: a bare #s= link is a self-
 * contained search, and opening one runs a FRESH PAID SEARCH on the opener's
 * device -- for an eight-person round trip, sixteen of the month's searches,
 * per recipient, every time the leg cache has gone cold. #t= is one KV read,
 * forever. The share buttons already save first, but the link people actually
 * copy is the one in the address bar, and that was still the expensive form.
 *
 * Both parts are kept: #t= so the results come out of storage, &s= so the
 * sender's current reading of them travels too. tripIdFromHash and readHash
 * already match on [#&], so both halves are found either way round. */
function writeHash() {
    /* A saved trip already has the URL it wants, and it is the cheap one:
     * overwriting ?t= with the self-contained #s= form would convert a link
     * costing one KV read into one that buys a fresh paid search on every
     * recipient's device. Changing a filter is a local reading of the document,
     * not a new document, so the address bar stays pointed at the document. */
    if (TRIP_ID) return;
    try {
        var enc = btoa(unescape(encodeURIComponent(JSON.stringify(hashPayload())))).replace(/=+$/, '');
        history.replaceState(null, '', TRIP_ID ? '#t=' + TRIP_ID + '&s=' + enc : '#s=' + enc);
    } catch (e) {}
}
/* A trip is a document the group keeps coming back to, so it gets a URL rather
 * than a position inside one. Three forms are read, one is written:
 *
 *   ?t=<id>   written. A real URL -- the server sees it, a bookmark keeps it,
 *             a chat client cannot eat it the way some eat a fragment, and it
 *             works unchanged on GitHub Pages, on the Cloudflare asset Worker
 *             and on a plain `python3 -m http.server`.
 *   /t/<id>   read only. The prettier form, but it needs the host to serve the
 *             app for unknown paths. The deployed asset Worker does
 *             (not_found_handling = single-page-application); Pages and a local
 *             server do not, so writing it would break the two places this is
 *             developed. Reading it costs one regex and means the day the app
 *             sits behind a rewrite, those links already work.
 *   #t=<id>   read only, forever. Every link already pasted into somebody's
 *             group chat is this form, and a shared link that stops opening is
 *             the one failure this whole feature exists to prevent. */
function tripIdFromUrl() {
    var m = /[?&]t=([a-z2-9]{4,16})(?:&|$)/.exec(location.search || '');
    if (m) return m[1];
    m = /^.*\/t\/([a-z2-9]{4,16})\/?$/.exec(location.pathname || '');
    if (m) return m[1];
    m = /[#&]t=([a-z2-9]{4,16})/.exec(location.hash || '');
    return m ? m[1] : null;
}

/* Where the app lives, with any /t/<id> suffix stripped -- so New trip and the
 * share link do not inherit the path of the trip somebody was reading. */
function basePath() {
    return (location.pathname || '/').replace(/\/t\/[a-z2-9]{4,16}\/?$/, '/');
}
function appUrl() { return location.origin + basePath(); }

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
    if (TRIP_ID) return appUrl() + '?t=' + TRIP_ID;
    try {
        return appUrl() + '#s='
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
        if (j && j.id) {
            TRIP_ID = j.id;
            history.replaceState(null, '', basePath() + '?t=' + j.id);
            rememberTrip();
            /* The trip only becomes a document people can write to at this
             * moment, so this is where the roster control appears. */
            if (state.step === 4) render();
        }
        return shareUrl();
    }).catch(function () { savingTrip = false; return shareUrl(); });
}

/* ------------------------------------------------------ the roster state
 *
 * The product was being built as a better flight search. A group does not need
 * a better flight search; it needs somewhere the answer stays put while five
 * people get around to acting on it. The share flow already produced a block of
 * text to paste into a chat, after which the group argued in a medium this app
 * cannot see -- and the one fact that argument keeps circling is "has Ray
 * actually bought his ticket".
 *
 * So the trip holds one string per person and nothing else. Not comments, not
 * votes, not a thread: the group already has a better place to talk, and what
 * it does not have is a ledger the talking keeps asking about.
 *
 * WRITES: one per real status change, so at most one per person per trip.
 * Zero on open, zero on refresh, zero on claiming an identity, and zero for
 * re-posting a state somebody is already in. Eight people fully booked costs
 * eight writes against a 1,000-a-day ceiling, and the search allowance caps the
 * app at roughly one shareable trip a day. See worker.js for the arithmetic.
 *
 * TRUST: there is no login and there is not going to be one, so the link is the
 * credential and first claim wins. The first device to mark somebody mints a
 * random key kept in that device's localStorage; the Worker stores it beside
 * the mark and never returns it to anybody. After that only that device can
 * change that person's state. A stranger who later finds the link can still
 * claim a person nobody has claimed -- that is the honest price of no accounts,
 * and it is the right trade: a group passing a private link around needs
 * protecting from a link leaking later, not from each other. What it must never
 * be possible to do is UN-book somebody, because that is the move that makes
 * the document lie about money, and that is closed. */


function randKey() {
    var out = '', i;
    if (window.crypto && window.crypto.getRandomValues) {
        var a = new Uint8Array(20);
        window.crypto.getRandomValues(a);
        for (i = 0; i < a.length; i++) out += 'abcdefghijkmnopqrstuvwxyz23456789'[a[i] % 33];
        return out;
    }
    while (out.length < 20) out += Math.random().toString(36).replace(/[^a-z0-9]/g, '');
    return out.slice(0, 20);
}

/* Minted lazily and kept per trip, so the key only exists for a person this
 * device has actually spoken for. A ring rather than a history: twelve trips is
 * well past anything anybody is still booking, and localStorage is not a place
 * to accumulate secrets forever. */
/* claimFor, sanitizeMarks, loadMarks and postMark went with the "I'm booked"
 * button they served. The worker still has /mark and /marks and they are still
 * tested -- the trip is still a document the group could write to, there is
 * just nothing on screen asking them to. */
function partyIds() {
    return ((state.q && state.q.parties) || []).map(function (p) { return p.id; });
}

/* Fares are the only part of a trip that goes off. Flight numbers, routes and
 * times are published months ahead and do not move; the price moves daily. So
 * the sentence has to name which half of the document to stop trusting -- and
 * the answer is deliberately not "search again". Book opens Google's live price
 * for the exact pinned itinerary, free, which is a better re-price than eight
 * paid searches off a 230-a-month allowance, and it does not replace the
 * document the group has been ticking itself off on. */
function fareAgeDays() {
    var gen = DATA && DATA.generated_at ? Date.parse(DATA.generated_at) : NaN;
    if (!isFinite(gen)) return null;
    return Math.floor((Date.now() - gen) / 86400000);
}

/* The age itself is the freshness chip's job, up in the title, and it has been
 * all along -- so when the booking count leads this line the number is not
 * repeated here, only its consequence. Standing alone it needs an anchor, and
 * then the age is it. One number, one place either way. */
function staleLine(hasLead) {
    var d = fareAgeDays();
    if (d == null || d < 3) return '';
    return (hasLead ? '' : '<b>These fares are ' + d + ' days old.</b> ')
        + 'The flights and the times still hold; only the prices move. Book opens the live fare.';
}

/* How old the fares are, and nothing else now.
 *
 * This used to lead with "3 of 5 booked. Alex and Ray haven't yet", fed by an
 * "I'm booked" button on every card. Both are gone -- "its weird and awkward",
 * and the roll-up was the only place the button's answer ever surfaced. What
 * is left is the one line that answers a question somebody re-opening
 * yesterday's trip actually has. */
function renderTripState() {
    var host = el('tripState');
    if (!host) return;
    if (state.step !== 4 || !C || !DATA || DATA.sample) { host.innerHTML = ''; return; }

    var stale = staleLine(false);
    var html = stale ? '<div class="tst-line">' + stale + '</div>' : '';

    /* Only on a real change. This is an aria-live region and render() runs on
     * every filter tap, so writing identical markup back would re-announce it
     * on each one -- the live region turning into a stutter. */
    if (host.innerHTML !== html) host.innerHTML = html;
}

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
        return worthItHome(regretOf(ctx, r.result.picks))
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
        var any = rows.filter(function (r) { return worthItHome(regretOf(ctx, r.result.picks)); });
        if (any.length) {
            ways.reach = { th: any[0].threshold, result: any[0].result };
        } else if (rows.length) {
            /* Nothing is fair. Offer the tightest window anyway, flagged with
             * what it asks, rather than refusing with no number -- the group can
             * weigh "two hours more flying for Nick" against "four hours apart"
             * better than a threshold can. */
            ways.reach = { th: rows[0].threshold, result: rows[0].result,
                           asks: regretOf(ctx, rows[0].result.picks) };
        }
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

/* The two legs are searched separately, so nothing was holding a person's
 * trip together.
 *
 * Measured on a real four-person search: Carbone went out LGA to DEN on
 * Southwest and came back DEN to JFK on JetBlue, $159 + $159 = $318, while
 * Google had the Southwest LGA-DEN ROUND TRIP at $317. A dollar less, one
 * airline, and the same airport at both ends. The split bought nothing and
 * cost two things -- his car was at LGA, and a round trip pinned across two
 * carriers is the one shape Google refuses to open as a booking.
 *
 * Both fall out of the same gap: the return is the cheapest return, chosen
 * with no knowledge of the outbound. So it is now chosen WITH it, under a
 * shadow cost -- the same device the match profiles use. The option set, the
 * window and the arrival times are untouched; only the argmin moves, and the
 * winner is re-priced in real money before anything downstream reads it.
 *
 * Deliberately small. These break near-ties and nothing else: at a dollar
 * apart Carbone's pairing flips, at forty dollars apart it does not, because
 * a person who would rather land at the other airport and save forty dollars
 * is right and the app should not overrule them. */
var HOME_AIRPORT_SHADOW = 25;   /* per seat, for landing where you left from */
var ONE_AIRLINE_SHADOW = 12;    /* per seat, for one ticket instead of two */
/* How much wider the way home may be solved to close somebody's loop for free.
 * A ceiling, not a dial: the coherence actually purchasable on real data costs
 * 10, 14, 19 or 51 minutes of extra spread and then nothing at all until past
 * three hours, so every value between 51 and 90 gives the same answers. 75
 * sits above the observed 51 and below the point where leaving together stops
 * meaning a shared ride. */
var COHERENCE_SLACK = 75;
var COHERENCE_WIDTHS = [10, 15, 20, 30, 45, 60, 75];
var RETURN_DRIFT_PER_MIN = 0.05;

var OUT_PICKS = null;

function firstCarrier(o) {
    if (o && o.segs && o.segs.length && o.segs[0].carrier) return o.segs[0].carrier;
    var a = (o && o.airlines) || [];
    return a.length ? normAirline(a[0]) : null;
}

/* Prefers the return that closes the person's own loop, when closing it is
 * nearly free. Returns null when there is no outbound to be coherent with. */
/* tripLadder asks for the way home once per rung, and the widening below can
 * run eight solves before it answers. Keyed on the window and on the outbound
 * it is being made coherent WITH, because those are the only two things it
 * reads -- cleared in render() with the other per-pass memos, since a filter
 * change rebuilds the option sets underneath it. */
var COHERENT_MEMO = {};

function coherentReturn(ctx, th) {
    if (!OUT_PICKS) return null;
    var key = ctx.leg + '|' + th + '|' + ctx.ids.map(function (id) {
        var o = OUT_PICKS[id] && OUT_PICKS[id].option;
        return o ? o.from + '@' + o.depart : '-';
    }).join(',');
    if (Object.prototype.hasOwnProperty.call(COHERENT_MEMO, key)) return COHERENT_MEMO[key];
    var out = coherentReturnUncached(ctx, th);
    COHERENT_MEMO[key] = out;
    return out;
}

function coherentReturnUncached(ctx, th) {
    var shadow = function (o, id) {
        var money = ctx.costFn(o, id);
        var out = OUT_PICKS[id] && OUT_PICKS[id].option;
        if (!out) return money;
        var seats = seatsFor(ctx, id), pen = 0;
        /* Landing at the airport you left from. Only meaningful for somebody
         * who gave more than one -- for everybody else these are equal and
         * the penalty never fires. */
        if (o.to && out.from && o.to !== out.from) pen += HOME_AIRPORT_SHADOW * seats;
        var a = firstCarrier(o), b = firstCarrier(out);
        if (a && b && a !== b) pen += ONE_AIRLINE_SHADOW * seats;
        return money + pen;
    };
    var base = solveAt(ctx, th, shadow);
    if (!base) return null;

    /* The shadow above could never win an argument it was not allowed to have.
     * `th` arrives from returnThOf -> returnWays, which reads ctx.ladder, and
     * ladder() keeps only rows strictly cheaper than the next tighter one. So
     * when money is flat across widths -- which on real data it very often is
     * -- every wider rung is dropped as dominated before coherence is ever
     * consulted, and the shadow is handed a one-element choice set. Measured
     * across 36 multi-airport party-trips: every single airport break had NO
     * same-airport option inside the chosen window at any price. Raising
     * HOME_AIRPORT_SHADOW to 50, or to 500, changes nothing.
     *
     * So the width itself has to be negotiable. Widen, but only buy what is
     * free: a candidate is taken only if it costs no more money, drops nobody,
     * and asks nobody onto a connection. 11% of multi-airport travellers were
     * being sent home to the wrong airport when the right one was available at
     * the same price, and one group in four contained such a traveller. */
    var fixable = ctx.ids.some(function (id) {
        var out = OUT_PICKS[id] && OUT_PICKS[id].option;
        var got = base.picks[id] && base.picks[id].option;
        if (!out || !got || !got.to || !out.from || got.to === out.from) return false;
        return (ctx.prep.options[id] || []).some(function (o) { return o.to === out.from; });
    });
    if (!fixable) return repriceMoney(ctx, base);

    /* Pennies a minute, and load-bearing. minCostAtWindow breaks ties on the
     * earliest window start, so widening alone "fixed" the New York case by
     * moving the whole group's flight home from half twelve to 06:46 -- it had
     * no reason not to. This gives it one. At $3 an hour it is outvoted by the
     * airport shadow after eight hours, so it can only order plans that
     * already cost the same. */
    var drifted = function (o, id) {
        var b = base.picks[id] && base.picks[id].option;
        var d = b ? Math.abs(o.clusterMin - b.clusterMin) : 0;
        return shadow(o, id) + RETURN_DRIFT_PER_MIN * d;
    };
    var breaksIn = function (r) {
        var n = 0;
        ctx.ids.forEach(function (id) {
            var out = OUT_PICKS[id] && OUT_PICKS[id].option;
            var got = r.picks[id] && r.picks[id].option;
            if (out && got && got.to && out.from && got.to !== out.from) n++;
        });
        return n;
    };
    var baseBreaks = breaksIn(base), best = base, bestBreaks = baseBreaks;
    var seen = {};
    for (var w = 0; w < COHERENCE_WIDTHS.length; w++) {
        var wide = th + COHERENCE_WIDTHS[w];
        if (wide > th + COHERENCE_SLACK || seen[wide]) continue;
        seen[wide] = 1;
        var cand = solveAt(ctx, wide, drifted);
        if (!cand) continue;
        /* Free, in every currency the reader can check. */
        if (cand.cost > base.cost) continue;
        if (cand.spread > base.spread + COHERENCE_SLACK) continue;
        if ((cand.included || ctx.ids).length < (base.included || ctx.ids).length) continue;
        if (!worthItHome(regretOf(ctx, cand.picks))) continue;
        var nb = breaksIn(cand);
        if (nb < bestBreaks) { best = cand; bestBreaks = nb; }
        if (!bestBreaks) break;
    }
    return repriceMoney(ctx, best);
}

/* What the people this plan could not seat are still paying.
 *
 * A subset plan has no pick for the party it left out, but that party is still
 * flying -- legBreakdown() prices them from soloOpen and sums them into the
 * breakdown under the chooser. So the card above it has to count them too.
 * While it did not, every subset card quoted the seated parties' outbound plus
 * EVERYBODY's return: measured wrong on 262 of 262 subset cards, by as much as
 * 77% ($1,601 shown against a $2,834 plan). Nothing flagged it, because the
 * return side was already summing everyone and so the totals looked complete.
 *
 * This is the one definition. legBreakdown's own loop below must keep matching
 * it, or the number on the card and the number beneath it drift apart again. */
function strandedCost(ctx, plan) {
    if (!ctx || !plan || !plan.picks) return 0;
    return ctx.ids.reduce(function (n, id) {
        if (plan.picks[id]) return n;
        return n + (ctx.soloOpen[id] ? ctx.soloOpen[id].cost : 0);
    }, 0);
}

function legBreakdown(leg) {
    var ctx = compute(leg);
    if (!ctx) return null;
    /* The return decides its own window -- see returnWays. It is set here rather
     * than read from state so the per-person cards and the headline total can
     * never be priced at two different windows, which is exactly what happened
     * while the trip-level choice strip was also writing to this key. */
    if (leg === 'return') state.th['return'] = returnThOf(ctx);
    /* The selected match IS the outbound plan, not a window to re-solve inside.
     * A window alone cannot express the difference between "Cheapest" and
     * "Easiest flights": both can be feasible at 20 minutes, and what tells them
     * apart is which option each person was given inside it. Re-deriving from
     * state.th here threw that away -- every profile collapsed back onto the
     * money argmin, which is why the four names kept resolving to one plan. */
    var th = state.th[leg] != null ? state.th[leg] : recommendedIn(ctx);
    var plan = (leg === 'outbound' && PICKED_PLAN)
        || (leg === 'return' && coherentReturn(ctx, th))
        || planOf(ctx, th);
    if (!plan) return null;
    /* Stashed for the return's shadow above. Cleared with the other per-pass
     * memos in render(), so a stale outbound can never steer a return. */
    if (leg === 'outbound') OUT_PICKS = plan.picks;

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
/* The same judgement for the way home, where time is worth less. An extra hour
 * and a half on the way out costs a day of the trip; on the way home it costs an
 * evening already being spent travelling. The connection half does not move --
 * buying closeness with somebody's connection is the complaint this guard was
 * written for. */
function worthItHome(r) { return r.stops <= 0 && r.mins <= 150; }

/* ------------------------------------------------- when the group lands
 *
 * Nothing in this file knew what time of day it was. Measured on live data:
 * a Thanksgiving search returned a plan landing three people at 00:06, 00:31
 * and 01:00 the following morning and labelled it "Balanced", while the app's
 * own ladder held a plan landing 10:57-11:08 -- eleven minutes apart -- for
 * $69 a head more. Every number the old objective could see said the first
 * plan was better: it was cheaper, and it was close together. Landing at one
 * in the morning costs a night and most of the next day, and the model had no
 * way to say so.
 *
 * Shadow dollars per seat, never money. Measured past the end of the useful
 * day on the date the leg was asked for, so an arrival after midnight scores
 * as the deep overrun it is without needing a rule about midnight -- 00:31 is
 * 451 minutes past 17:00, and reads that way by arithmetic.
 *
 * Cheaper on the way home for the reason worthItHome already gives: an evening
 * spent travelling home was being spent travelling either way. Capped because
 * past about 2am the difference between bad and worse stops being a decision
 * anybody is making. */
/* Two slopes, because the loss is not linear and a linear ramp priced it
 * wrong in both directions. Measured: at a flat $0.08/min the objective paid
 * $5 to move a BZN group from 114 minutes apart landing 12:24 to landing
 * together at 22:50 -- a perfect window, at ten to eleven at night, which is
 * nobody's idea of a better trip. Raising the single rate until that stopped
 * made a 6pm arrival cost more than a 6pm arrival costs.
 *
 * So: the evening is cheap and the night is dear. Landing at 18:30 loses you
 * dinner and is priced like it. Landing after about nine loses the night --
 * the day is gone, the desk may be shut, and you are checking in rather than
 * arriving -- and the slope goes up more than sevenfold to say so. */
var DAY_ENDS = 17 * 60;          /* 17:00: later than this starts eating the evening */
var NIGHT_FROM = 21 * 60;        /* 21:00: later than this the day is gone */
var LATE_PER_MIN = 0.06;         /* per seat per minute, evening */
var NIGHT_PER_MIN = 0.45;        /* per seat per minute, past NIGHT_FROM */
var LATE_HOME_FACTOR = 0.4;      /* the same, on the way home, where it costs less */
var LATE_CAP = 150;              /* per seat: past ~2am, worse stops being a decision */

/* Epoch minutes of DAY_ENDS on a YYYY-MM-DD, matching optimizer.toMinutes,
 * which builds arriveMin with Date.UTC and therefore carries the date. */
function dayEndsOn(date) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date || '');
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 60000 + DAY_ENDS;
}

/* What a plan's arrival times cost the group, in shadow dollars. Summed over
 * seats and parties rather than taken at the worst traveller: two people
 * landing at 1am is twice the problem one is, and unlike spread -- which is a
 * property of the group -- lateness is suffered individually. */
function latenessOf(ctx, picks, leg) {
    var ref = dayEndsOn(leg === 'return' ? state.q.ret : state.q.dep);
    if (ref == null || !picks) return 0;
    var scale = leg === 'return' ? LATE_HOME_FACTOR : 1;
    var night = ref + (NIGHT_FROM - DAY_ENDS);
    var sum = 0;
    ctx.ids.forEach(function (id) {
        var p = picks[id];
        if (!p || !p.option || p.option.arriveMin == null) return;
        var at = p.option.arriveMin;
        var evening = Math.max(0, Math.min(at, night) - ref);
        var overnight = Math.max(0, at - night);
        var per = Math.min(LATE_CAP, LATE_PER_MIN * evening + NIGHT_PER_MIN * overnight);
        sum += seatsFor(ctx, id) * scale * per;
    });
    return sum;
}

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
        var reg = { stops: 0, mins: 0, who: null }, conn = {}, mins = 0, late = 0;
        /* The outbound of this row, so the return can be chosen against it.
         * ctxs is outbound-then-return, so it is always set by the time the
         * return is reached. */
        var rowOut = null;
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
            var r;
            if (ownWindow) {
                /* Through the SAME function the cards use, keyed on this row's
                 * own outbound -- see coherentReturn. Pricing the return here
                 * with the plain money cost while the cards price it with the
                 * coherence shadow is the drift this comment warns about,
                 * arriving by a new door. */
                var keep = OUT_PICKS;
                OUT_PICKS = rowOut ? rowOut.picks : null;
                r = coherentReturn(c, returnThOf(c))
                    || FWF.minCostAtWindow(c.prep, returnThOf(c), c.costFn);
                OUT_PICKS = keep;
            } else {
                r = FWF.minCostAtWindow(c.prep, T, c.costFn);
                rowOut = r;
            }
            if (!r) { ok = false; return; }
            total += r.cost;
            late += latenessOf(c, r.picks, c.leg);
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
                    mins: mins, conn: Object.keys(conn), late: late,
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
/* Shadow dollars a group pays for one minute of landing closer together. The
 * one number here that is a judgement rather than a measurement: $1.50/min is
 * about $90 an hour of the first arriver sitting in an arrivals hall, which is
 * the thing the window actually buys. Swept over 269 real group instances --
 * below $0.50 it loosens too readily, above $3 it starts buying tightness at
 * the wrong end of the day. */
var SPREAD_PER_MIN = 1.5;

/* What the group gives up to take this row, in one currency.
 *
 * This replaced two rules that had no units between them, and the pair of them
 * cost real money on live searches. A hard veto deleted any row where the
 * worst-off traveller gained a connection or 90 air-minutes -- while the same
 * file priced a connection at EASE_PER_STOP, so a connection was worth $120
 * here and infinity there. Then a local argmax over $/minute took the first
 * refund step and declined every later one however good, because it was
 * written as an argmax and read as a stopping rule.
 *
 * Measured on a live 4-party BZN search: the app recommended $1,086 at 6
 * minutes apart with a $699 plan 51 minutes apart sitting vetoed in its own
 * ladder -- $387 to buy 45 minutes, on a product whose users check it against
 * Google. Scoring instead of vetoing fixes that case and 40 others, and it
 * fixes them in both directions: it also stops the app declining a $5 step
 * that lands everybody on the same minute, which the old rule could not take
 * because with two rows any refund at all sent it to the looser one.
 *
 * total is real money; the rest are shadow dollars and never reach a screen. */
function tripScore(r) {
    var reg = r.regret || { stops: 0, mins: 0 };
    return r.total
        + SPREAD_PER_MIN * r.worst
        + EASE_PER_STOP * Math.max(0, reg.stops)
        + EASE_PER_MIN * Math.max(0, reg.mins)
        + (r.late || 0);
}

function tripBest(l) {
    if (!l || !l.length) return null;
    var best = l[0], bestScore = tripScore(l[0]);
    for (var i = 1; i < l.length; i++) {
        var sc = tripScore(l[i]);
        /* Strictly better, so a tie goes to the tighter row: l runs
         * tightest-first and closeness is what the app is for. */
        if (sc < bestScore) { bestScore = sc; best = l[i]; }
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
    /* m.sig is planSig(): the exact itinerary every party was given. m.plan is
     * the plan OBJECT the card renders from, so it must never be stringified
     * here -- "[object Object]" is the same signature for every row, which
     * collapses the whole chooser to one option. */
    if (m.sig != null) return String(m.sig);
    if (typeof m.plan === 'string') return m.plan;
    if (m.picks) {
        return Object.keys(m.picks).sort().map(function (id) {
            var p = m.picks[id], o = (p && p.option) || p;
            return id + ':' + (o ? [o.from, o.to, o.depart, o.arrive, o.price].join('/') : '-');
        }).join('|');
    }
    return 'th' + m.th;
}

/* Shadow pricing: how a trade-off becomes expressible.
 *
 * minCostAtWindow minimises a SUM of whatever costFn returns, and does not care
 * what the numbers mean -- so a trade-off can be scored by adding it to money.
 * It cannot be added to the REAL cost function: about twenty display sites read
 * picks[id].cost as dollars, and a penalty baked into that number is a lie on a
 * price tag and a group total that does not match what anybody pays. So a
 * profile SELECTS under a shadow cost and the winning options are re-priced in
 * money before anything downstream sees them. The option sets, the window
 * algorithm and the arrival times are untouched; only the argmin moves. */

/* Shadow dollars per seat. Calibrated against worthIt(), which already says a
 * connection nobody needed is unacceptable and 90 extra minutes is the ceiling:
 * at these rates one connection is worth about 2h40 of extra flying, which is
 * roughly what a connection actually costs you once you count deplaning,
 * walking, waiting, boarding and the chance of losing the second leg. */
var EASE_PER_STOP = 120, EASE_PER_MIN = 0.75;

function seatsFor(ctx, id) {
    var t = (ctx.travelers || []).filter(function (z) { return z.id === id; })[0];
    return Math.max(1, (t && t.seats) || 1);
}

function shadowOf(ctx, kind) {
    if (kind !== 'ease') return ctx.costFn;
    var seats = {}, base = ctx.ownBest || {};
    ctx.ids.forEach(function (id) { seats[id] = seatsFor(ctx, id); });
    return function (o, id) {
        var b = base[id] || {};
        /* Measured against this party's OWN best, not in absolute terms: a
         * six-hour flight is not a hardship for somebody crossing a continent,
         * and penalising it as one would hand every tight window to the party
         * who lives nearest. A per-party constant cannot change the argmin
         * anyway -- feasibility requires every party in every candidate window,
         * so the offset falls out of the comparison. */
        var moreStops = Math.max(0, (o.stops == null ? 99 : o.stops)
                                  - (b.stops == null ? 0 : b.stops));
        var moreMins = (o.duration_minutes != null && b.mins != null)
            ? Math.max(0, o.duration_minutes - b.mins) : 0;
        return ctx.costFn(o, id)
            + seats[id] * (EASE_PER_STOP * moreStops + EASE_PER_MIN * moreMins);
    };
}

/* Restates a plan chosen under a shadow cost in money, in the exact shape
 * planOf() returns, so every consumer downstream is unaffected. Times and
 * spread come from clusterMin and are not touched by the re-pricing. */
/* One window solve, whether or not everybody can make the window.
 *
 * minCostAtWindow returns null unless EVERY party has an option, and the
 * profiles were built on it alone -- so the moment a filter left anybody out,
 * matchProfiles returned null, tripMatches returned [], and the whole chooser
 * was hidden. Narrowing the landing band does that to 43% of groups on
 * "Afternoon" and 88% on "Evening": the reader tapped a filter and the three
 * options they came for disappeared, leaving a plan with nothing above it.
 * "if i adjust the search it doesnt show the updated cheapest balanced and
 * closest landing info".
 *
 * bestSubset answers the same question over whoever can make it, and it takes a
 * costFn, so a profile can still select under its own shadow cost. The screen
 * below already renders a subset plan and already names who is outside it --
 * only the chooser was standing aside. */
function solveAt(ctx, th, costFn) {
    if (ctx.prep.complete) return FWF.minCostAtWindow(ctx.prep, th, costFn);
    var r = FWF.bestSubset(ctx.prep, th, costFn);
    if (!r || !r.included.length) return null;
    return { picks: r.picks, cost: r.cost, spread: r.summary.spread,
             included: r.included, excluded: r.excluded };
}

/* The most people any window can seat at all. The ceiling every profile is
 * measured against: a plan that drops somebody to save money is not a cheaper
 * answer to the same question, and comparing two plans on money alone without
 * this would let one quietly do that. */
function reachOf(ctx) {
    if (ctx.prep.complete) return ctx.ids.length;
    var r = FWF.bestSubset(ctx.prep, FWF.INF, ctx.costFn);
    return r ? r.included.length : 0;
}

function repriceMoney(ctx, res) {
    if (!res || !res.picks) return null;
    /* Over whoever the solve seated, not over everybody: a subset plan has no
     * pick for the party it left out, and requiring one turned every subset
     * answer into a null. */
    var ids = res.included || ctx.ids;
    if (!ids.length) return null;
    var picks = {}, total = 0, times = [];
    for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var o = res.picks[id] && res.picks[id].option;
        if (!o) return null;
        var c = ctx.costFn(o, id);
        picks[id] = { option: o, cost: c };
        total += c;
        times.push(o.clusterMin);
    }
    var lo = Math.min.apply(null, times), hi = Math.max.apply(null, times);
    return { picks: picks, included: ids.slice(), excluded: res.excluded || [],
             spread: hi - lo, cost: total, subset: !!(res.excluded && res.excluded.length) };
}

/* The tightest window that costs nothing on a given objective. Closeness you
 * are not paying for should never be left on the table -- this is the rule the
 * return leg already used, generalised so every profile can use it. */
function freeTighten(ctx, shadow) {
    var floor = solveAt(ctx, FWF.INF, shadow);
    if (!floor) return FWF.INF;
    var reach = (floor.included || ctx.ids).length;
    for (var i = 0; i < FWF.DEFAULT_THRESHOLDS.length; i++) {
        var T = FWF.DEFAULT_THRESHOLDS[i];
        if (T === FWF.INF) continue;
        var r = solveAt(ctx, T, shadow);
        /* Free means free of money AND free of people. Without the headcount
         * test a tighter window that drops somebody looks cheaper and gets
         * taken, which is the one way "closeness that costs nothing" could cost
         * somebody their seat on the trip. */
        if (r && (r.included || ctx.ids).length >= reach && r.cost <= floor.cost) return T;
    }
    return FWF.INF;
}

/* The tightest window that still seats as many people as any window can. What
 * ctx.tight is for a complete group, for a group that is not.
 *
 * Not the ladder rung: stopping there left "Closest landing" quoting 5h 17m
 * next to an "Easiest flights" card at 5h 9m, both seating four of five, and
 * the one named for closeness was the looser of the two. Nor contracting to the
 * spread the plan inside the rung achieves -- that stalls, because minimising
 * money inside a window does not tighten it. At seed 134 the cheapest
 * four-person plan inside 317 minutes spreads exactly 317, while four people
 * also fit inside 309 for $59 more; contraction sees a fixed point and stops
 * eight minutes short.
 *
 * Feasibility is monotone in the window -- a headcount that fits inside W fits
 * inside anything wider -- so the smallest W that still seats them is a binary
 * search. About eleven solves, and only on the path where the group cannot be
 * fully covered. */
function subsetTightest(ctx) {
    var reach = reachOf(ctx);
    if (!reach) return FWF.INF;
    /* A finite upper bound: the spread actually achieved at the first rung that
     * seats them, which is at most the rung and often well under it. */
    var hi = null;
    for (var i = 0; i < FWF.DEFAULT_THRESHOLDS.length; i++) {
        var r = solveAt(ctx, FWF.DEFAULT_THRESHOLDS[i], ctx.costFn);
        if (r && (r.included || ctx.ids).length >= reach) { hi = r.spread; break; }
    }
    if (hi == null) return FWF.INF;
    var lo = 0;
    while (lo < hi) {
        var mid = Math.floor((lo + hi) / 2);
        var m = solveAt(ctx, mid, ctx.costFn);
        if (m && (m.included || ctx.ids).length >= reach) hi = mid; else lo = mid + 1;
    }
    return hi;
}

/* What a plan is asking of one party, in one number: the money they pay over
 * their own cheapest option PLUS the flying they are doing over their own best
 * option, per seat. Both halves matter and neither is the whole story -- a $12
 * premium on a two-stop that adds five hours is not a cheap plan, and the
 * person it lands on is the person who vetoes the trip.
 *
 * This is the ease shadow measured from each party's own floor, so it is zero
 * for anybody getting their own best flight at their own best price, whatever
 * that flight happens to look like. Somebody flying out of Bozeman has no
 * nonstop at all; her burden for taking a connection is zero, because nobody is
 * asking her for anything. That relative reading is the whole point -- an
 * absolute one would declare the person who lives furthest away permanently
 * hard done by and then optimise on their behalf forever. */
function burdenFn(ctx) {
    var shadow = shadowOf(ctx, 'ease');
    var floor = {};
    ctx.ids.forEach(function (id) {
        var best = null;
        (ctx.prep.options[id] || []).forEach(function (o) {
            var v = shadow(o, id);
            if (best === null || v < best) best = v;
        });
        floor[id] = best;
    });
    return function (o, id) {
        if (floor[id] == null) return 0;
        return Math.max(0, (shadow(o, id) - floor[id]) / seatsFor(ctx, id));
    };
}

/* There was a fifth profile here, "Evenly shared": minimise the WORST party's
 * burden rather than the group's total, decided by scanning a burden cap upward
 * and asking at each step whether a plan still exists -- the maxPremium pruning
 * trick on a value solved for instead of guessed. It is deleted on evidence,
 * and the evidence is worth keeping so it does not get re-added.
 *
 * Pinned to the balanced window it collapsed into another profile's plan in 63%
 * of 599 generated groups, and -- fatally -- in the other 37% it was still
 * weakly BEATEN on its own axis every single time, by a median of $111: the
 * Easiest-flights plan, which free-tightens on the ease objective, lands nearer
 * to zero burden than a fairness profile held at a tighter window ever can. A
 * card promising "nobody carries the worst of it" while the card beside it
 * carries less of it is not a match, it is a mistake with a name on it.
 *
 * Unpinned -- minimum burden, then tightest, then cheapest -- it stops being
 * beaten, but then it and Easiest flights are one question asked twice, and the
 * min-sum version is the one that trades against money properly rather than
 * buying a $900 fare to save twenty minutes.
 *
 * What survives is the measurement, not the profile: burden is reported per
 * party on EVERY match (roll-up below), which is where a property of a plan
 * belongs. whoPays() already has the screen real estate for it. */

/* The per-leg window each profile asks for. Split out because the way home is
 * not the same decision as the way out: unless the group has said otherwise it
 * is not being clustered at all, so a profile's window rule applies to the leg
 * that is actually being coordinated and the return takes whatever closeness is
 * free on that profile's own objective. */
function legWindowFor(profileId, ctx, balancedTh) {
    var loose = ctx.leg === 'return' && !state.q.clusterReturn;
    if (profileId === 'closest') {
        if (loose) return freeTighten(ctx, ctx.costFn);
        /* ctx.tight is the tightest window covering EVERY party, so compute
         * leaves it null when somebody cannot be covered at all. The honest
         * reading of "closest landing" there is the tightest window that still
         * seats as many people as any window can -- not INF, which is the
         * loosest window there is and the opposite of what the name says. */
        if (ctx.tight) return ctx.tight.spread;
        return ctx.prep.complete ? FWF.INF : subsetTightest(ctx);
    }
    if (profileId === 'easiest') return freeTighten(ctx, shadowOf(ctx, 'ease'));
    if (profileId === 'cheapest') return freeTighten(ctx, ctx.costFn);
    if (loose) return freeTighten(ctx, ctx.costFn);
    return balancedTh != null ? balancedTh : freeTighten(ctx, ctx.costFn);
}

function legPlanFor(profileId, ctx, balancedTh) {
    var th = legWindowFor(profileId, ctx, balancedTh);
    var shadow = shadowOf(ctx, profileId === 'easiest' ? 'ease' : 'money');
    var r = solveAt(ctx, th, shadow);
    if (!r) return null;
    return { plan: repriceMoney(ctx, r), th: th };
}

/* The same roll-up tripLadder() does for a threshold row, for a set of per-leg
 * plans. Kept identical on purpose: the numbers a profile card shows have to be
 * the numbers the plan underneath it sums to. */
function rollup(ctxs, legs, plans) {
    var total = 0, worst = 0, mins = 0, per = {}, conn = {}, bur = {};
    var reg = { stops: 0, mins: 0, who: null };
    for (var i = 0; i < legs.length; i++) {
        var leg = legs[i], ctx = ctxs[leg], p = plans[leg];
        if (!p) return null;
        var loose = leg === 'return' && !state.q.clusterReturn;
        var burden = burdenFn(ctx);
        total += p.cost;
        if (!loose) worst = Math.max(worst, p.spread);
        var g = regretOf(ctx, p.picks);
        if (g.stops > reg.stops) { reg.stops = g.stops; reg.who = g.who; }
        if (g.mins > reg.mins) { reg.mins = g.mins; if (!reg.who) reg.who = g.who; }
        /* p.included, not ctx.ids: a subset plan has no pick for the party it
         * left out, and summing over everybody threw on the first one. */
        p.included.forEach(function (id) {
            per[id] = (per[id] || 0) + p.picks[id].cost;
            /* Summed across legs: being handed the long way round twice is
             * twice the burden, and the person it happens to knows that. */
            bur[id] = (bur[id] || 0) + burden(p.picks[id].option, id);
            var dm = p.picks[id].option.duration_minutes;
            if (dm != null) mins += dm;
            if ((p.picks[id].option.stops || 0) > 0) conn[id] = true;
        });
    }
    var topPer = 0, topId = null;
    for (var id2 in per) {
        var seats = seatsFor(ctxs[legs[0]], id2);
        var each = seats > 1 ? per[id2] / seats : per[id2];
        if (each > topPer) { topPer = each; topId = id2; }
    }
    /* Every profile reports the worst burden it imposes -- "Balanced puts $359
     * of this on Omar, Easiest flights gets it to nothing" is the comparison a
     * group actually needs, and it cannot be made from one side. */
    var worstBurden = 0, burdenWho = null;
    for (var id3 in bur) {
        if (bur[id3] > worstBurden) { worstBurden = bur[id3]; burdenWho = id3; }
    }
    var seatsBy = {};
    for (var id4 in per) seatsBy[id4] = seatsFor(ctxs[legs[0]], id4);
    return { total: total, worst: worst, mins: mins, per: per, regret: reg,
             seats: seatsBy,
             conn: Object.keys(conn), topPer: Math.round(topPer), topId: topId,
             burden: bur, worstBurden: Math.round(worstBurden), worstBurdenWho: burdenWho };
}

/* Two profiles returning the same flights is not two matches. Identity is the
 * exact itinerary every party was given, on every leg -- not the window width,
 * because two different widths routinely resolve to the same tickets. */
function planSig(plans, legs) {
    return legs.map(function (leg) {
        var p = plans[leg];
        if (!p) return '-';
        return Object.keys(p.picks).sort().map(function (id) {
            var o = p.picks[id].option;
            return id + ':' + o.from + '>' + o.to + '@' + o.depart + '>' + o.arrive
                 + '#' + (o.airlines || []).join('+') + '$' + o.price;
        }).join('|');
    }).join('//');
}

/* Ordered because the order decides which name a collapsed pair keeps, and the
 * reader should be left holding the claim the app is most willing to defend. */
var MATCH_PROFILES = [
    { id: 'balanced', label: 'Balanced',
      asks: 'the point where another dollar stops buying much closeness' },
    { id: 'cheapest', label: 'Cheapest',
      asks: 'the least this trip can cost, and as close as that gets for free' },
    { id: 'closest',  label: 'Closest landing',
      asks: 'the tightest the group can physically land, and what that costs' },
    /* "Route optimization", in the owner's words. Deliberately NOT promised as
     * "least time in the air": it trades flying against money, so on about one
     * group in ten some other profile comes out marginally shorter. The card
     * reports the hours; it does not claim the minimum. */
    { id: 'easiest',  label: 'Easiest flights',
      asks: 'fewest connections and least flying, with money still counted' }
];



/* Several genuinely different good matches from one search. */
/* Outbound only, deliberately. legBreakdown() hard-sets the return's window
 * from returnThOf() -- the leave-together rule measured over 5,184 groups -- so
 * a profile's return plan was always discarded before anything rendered it, and
 * a card scored on a return nobody would fly quoted a total the itineraries
 * underneath could not sum to. "Cheapest" advertised 11h 10m apart while the
 * plan below it landed the group 20 minutes apart on the way home, because the
 * card was priced on one return and the screen printed another.
 *
 * A match is therefore a choice about the way OUT, which is the leg the window
 * is coordinating, and the way home is the same on all of them. */
function matchProfiles() {
    var legs = ['outbound'];
    var ctxs = {};
    for (var i = 0; i < legs.length; i++) {
        var c = compute(legs[i]);
        /* An incomplete group is no longer a reason to stand aside -- see
         * solveAt. What is still a reason is nobody being seatable at all,
         * which is a search with no answer rather than a choice between
         * answers. */
        if (!c || !c.prep) return null;
        if (!c.prep.complete && !reachOf(c)) return null;
        ctxs[legs[i]] = c;
    }

    /* Balanced is defined as exactly what the app recommended before any of
     * this existed, so the default screen does not move and the other three are
     * described against a baseline somebody has already looked at. Asserted
     * over 300 generated groups in test-matches.js, not assumed. */
    var tl = tripLadder();
    var tb = tl && tripBest(tl);
    var balancedTh = tb ? tb.th : null;

    var ids0 = ctxs[legs[0]].ids;
    var out = [], bySig = {};
    MATCH_PROFILES.forEach(function (def) {
        var plans = {}, ths = {}, ok = true;
        legs.forEach(function (leg) {
            if (!ok) return;
            var lp = legPlanFor(def.id, ctxs[leg], balancedTh);
            if (!lp) { ok = false; return; }
            plans[leg] = lp.plan; ths[leg] = lp.th;
        });
        if (!ok) { out.push({ id: def.id, label: def.label, asks: def.asks, feasible: false }); return; }

        var roll = rollup(ctxs, legs, plans);
        if (!roll) { out.push({ id: def.id, label: def.label, asks: def.asks, feasible: false }); return; }

        var sig = planSig(plans, legs);
        /* The fewest people any leg of this plan seats, and the most any plan
         * could. Reported rather than derived downstream so a card can say "4
         * of 5" without re-solving, and so dominance can compare on it. */
        var seated = Math.min.apply(null, legs.map(function (leg) {
            return plans[leg].included.length;
        }));
        /* Measured in seats against the whole group, not against what any
         * window could achieve. Those differ when somebody has no flight at
         * all: reach-against-reach says "2 of 2" and reads as complete, while
         * the group is three people and the card quotes a total for two of
         * them. Seats rather than cards for the reason the roster line already
         * counts them that way -- the title says "5 people" and one card can be
         * two of them. */
        var seatsBy2 = {}, seatedSeats = 0, allSeats = 0;
        ctxs[legs[0]].ids.forEach(function (id) {
            seatsBy2[id] = seatsFor(ctxs[legs[0]], id);
            allSeats += seatsBy2[id];
        });
        var leastLeg = legs.filter(function (leg) {
            return plans[leg].included.length === seated;
        })[0];
        plans[leastLeg].included.forEach(function (id) { seatedSeats += seatsBy2[id]; });
        var entry = {
            seated: seatedSeats, reach: allSeats, parties: seated,
            id: def.id, label: def.label, asks: def.asks, feasible: true,
            plans: plans, th: ths, sig: sig,
            total: roll.total, worst: roll.worst, mins: roll.mins, per: roll.per,
            regret: roll.regret, conn: roll.conn, topPer: roll.topPer, topId: roll.topId,
            seats: roll.seats,
            burden: roll.burden, worstBurden: roll.worstBurden,
            worstBurdenWho: roll.worstBurdenWho,
            dupeOf: bySig[sig] || null
        };
        if (!bySig[sig]) bySig[sig] = def.id;
        out.push(entry);
    });

    /* Dedupe catches two profiles returning the SAME flights. It does not catch
     * a profile returning different flights that are worse in every way a card
     * reports -- which is just as bad to put in front of somebody, because the
     * only honest caption for it is "here is a plan with nothing to recommend
     * it". A profile is dominated when another live profile is at least as good
     * on money, closeness, time in the air and the worst person's burden, and
     * strictly better on one of them.
     *
     * Balanced is exempt: it is the default and the baseline everything else is
     * described against, so hiding it would leave the screen with no anchor and
     * the selection with nothing to fall back to. */
    /* Seating fewer people is not a cheaper answer to the same question, it is
     * an answer to a different one -- so headcount is compared first and as a
     * veto, not as one axis among four. Without it the cheapest plan on a
     * narrowed band is routinely the one that quietly leaves somebody behind,
     * and it would hide every plan that brings them. */
    /* Not worstBurden. It was a fourth axis, and it is the only one of the four
     * that appears nowhere on screen -- so a plan worse than its neighbour on
     * price, closeness, connections AND time in the air survived on a number
     * the reader cannot check against anything. Measured: 20 such rows across
     * 800 band-filtered groups, every one of them "Easiest flights" sitting
     * above a cheaper, tighter plan with no visible reason to exist. Dominance
     * now compares exactly what a card can state. Burden is still computed and
     * still reported on the entry; it just no longer keeps a card alive on its
     * own. */
    /* With tolerances, because the comparison was on raw integers and a card
     * only has to be better by ONE of something to survive. Measured on live
     * data: 135 cards held up by a thirty-minute air-time lead or less, the
     * worst of them $588 against $588, NINE HOURS further apart, kept on
     * screen by four air-minutes summed across four people. Nobody reads four
     * minutes off a card and nobody would choose on it.
     *
     * So a rival has to be better by a margin a reader would act on before it
     * counts as better, and worse by one before it counts as worse. The
     * numbers are what the cards actually print: dollars to the nearest ten,
     * landing spread to the nearest ten minutes, and air time -- summed over
     * the whole group and shown rounded to hours -- to the nearest three
     * quarters of an hour. */
    var cmp = ['total', 'worst', 'mins'];
    var TOL = { total: 10, worst: 10, mins: 45 };
    var feas = out.filter(function (e) { return e.feasible && !e.dupeOf; });
    feas.forEach(function (e) {
        if (e.id === 'balanced') return;
        e.dominatedBy = null;
        /* Compared against every feasible profile rather than the surviving
         * ones, so the answer does not depend on the order of the sweep.
         * Dominance is a strict partial order, so this cannot loop: if A is
         * hidden by B and B by C, C is the one left standing. */
        for (var i = 0; i < feas.length; i++) {
            var o = feas[i];
            if (o === e) continue;
            if (o.seated < e.seated) continue;
            var weak = true, strict = o.seated > e.seated;
            for (var k = 0; k < cmp.length; k++) {
                var t = TOL[cmp[k]] || 0;
                if (o[cmp[k]] > e[cmp[k]] + t) { weak = false; break; }
                if (o[cmp[k]] < e[cmp[k]] - t) strict = true;
            }
            if (weak && strict) { e.dominatedBy = o.id; return; }
        }
    });

    /* Tolerances create a third case the strict comparison could not: a row
     * that is neither beaten nor beating, because every difference between it
     * and the row above is smaller than a reader would act on. Those used to
     * be kept alive by whichever difference happened to be non-zero, and then
     * the caption had to find something to say about a plan that was
     * genuinely the same trip -- "38h 23m in the air" sitting under "38h",
     * which is the card admitting it is worse while occupying a row.
     *
     * A profile that lands the same people at the same time for the same
     * money IS the one above it, whatever flights it picked, so it is folded
     * in as an alias exactly like an identical signature. The surviving row is
     * the earlier one, and MATCH_PROFILES runs balanced-first, so what the
     * reader keeps is the recommendation rather than an arbitrary twin. */
    var surv = out.filter(function (e) {
        return e.feasible && !e.dupeOf && !e.dominatedBy;
    });
    surv.forEach(function (e, i) {
        if (e.id === 'balanced') return;
        for (var j = 0; j < i; j++) {
            var o = surv[j];
            if (o.dupeOf || o.seated !== e.seated) continue;
            var same = cmp.every(function (k) {
                return Math.abs(o[k] - e[k]) <= (TOL[k] || 0);
            });
            if (same) { e.dupeOf = o.id; return; }
        }
    });

    var live = out.filter(function (e) {
        return e.feasible && !e.dupeOf && !e.dominatedBy;
    });
    if (!live.length) return null;

    /* Relative facts, so a card can say what choosing it costs without the UI
     * having to re-derive it. Measured against the best any profile achieved on
     * that axis, which is the comparison a reader is actually making. */
    var minTotal = Math.min.apply(null, live.map(function (e) { return e.total; }));
    var minWorst = Math.min.apply(null, live.map(function (e) { return e.worst; }));
    var minMins = Math.min.apply(null, live.map(function (e) { return e.mins; }));
    var minBurden = Math.min.apply(null, live.map(function (e) { return e.worstBurden; }));
    out.forEach(function (e) {
        if (!e.feasible) return;
        e.vsCheapest = Math.round(e.total - minTotal);
        e.vsClosest = e.worst - minWorst;
        e.vsLeastFlying = e.mins - minMins;
        e.vsLeastBurden = Math.round(e.worstBurden - minBurden);
        /* Per-leg aliases let a card name the collapse instead of vanishing. */
        e.aliases = out.filter(function (x) { return x.dupeOf === e.id; })
                       .map(function (x) { return x.label; });
    });

    out.trivial = ids0.length < 2;
    out.legs = legs;
    out.ctxs = ctxs;
    /* The same rawFloor disclosure, trip-wide: what the app's own two rules
     * cost the group relative to the lowest fares on the page. */
    var raw = 0, haveRaw = true;
    legs.forEach(function (leg) {
        if (ctxs[leg].rawFloor == null) haveRaw = false; else raw += ctxs[leg].rawFloor;
    });
    out.rawFloor = haveRaw ? raw : null;
    return out;
}

/* Why this one, in facts the reader can check against the rows below it. */

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

/* The seam between the two halves of this feature. matchProfiles() decides what
 * each named match IS -- which flight every person takes, not merely which
 * window -- and matchList() decides how several of them are shown. The stub that
 * used to live here derived four names from four rows of one ladder, so every
 * profile differed only by window width: when the ladder collapsed to a single
 * feasible row, as it does for a small group on a thin route, all four became
 * the same plan and the screen said "one plan covers it". That is why there were
 * no options to tap.
 *
 * A profile now selects under its own shadow cost and the winning options are
 * re-priced in real money before anything downstream sees them, so "Easiest
 * flights" can take somebody off a connection that "Cheapest" put them on at the
 * same window. Measured over 300 generated groups: balanced distinct 100% of the
 * time, closest 99%, easiest 98%, and easiest removes a connection balanced
 * imposed in 91% of groups for a median $202. */
function tripMatches() {
    if (MATCHES) return MATCHES;
    var ps = matchProfiles();
    if (!ps) { MATCHES = []; return MATCHES; }
    var live = ps.filter(function (e) {
        return e.feasible && !e.dupeOf && !e.dominatedBy;
    });

    /* The way home, once. Every match flies the same return -- see
     * matchProfiles -- so it is a constant added to each card, which leaves the
     * ordering of the cards untouched and makes the price on a card the price of
     * the whole trip. Quoting the outbound alone would be the third version of
     * the same bug: a number on the chooser that the plan below it does not
     * sum to. */
    var back = hasReturn() ? legBreakdown('return') : null;
    var backTotal = back ? back.total : 0;
    /* The outbound context, for the fares of anyone a subset plan leaves out.
     * The return total above already covers everybody, so without this the two
     * halves of a card's price are summed over different sets of people. */
    var outCtx = compute('outbound');

    MATCHES = matchList(live.map(function (e) {
        var per = {}, topPer = 0;
        Object.keys(e.per).forEach(function (id) {
            var b = back && back.rows[id] ? back.rows[id].cost : 0;
            per[id] = e.per[id] + b;
            var seats = e.seats && e.seats[id] > 1 ? e.seats[id] : 1;
            topPer = Math.max(topPer, per[id] / seats);
        });
        return {
            key: e.id, name: e.label,
            total: e.total + strandedCost(outCtx, e.plans.outbound) + backTotal,
            topPer: Math.round(topPer),
            seated: e.seated, reach: e.reach,
            /* The outbound spread, which is what "apart" means on this screen:
             * the number under "Landing together" in the plan the card opens. */
            spread: e.worst, mins: e.mins, conn: e.conn,
            picks: e.plans.outbound.picks, plan: e.plans.outbound,
            th: e.th.outbound != null ? e.th.outbound : null,
            sig: e.sig
        };
    }));
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
/* "4 of 5", in seats, or nothing. The one fact about a match that is never a
 * tie-breaker: a plan that leaves somebody behind is a different trip, and a
 * price quoted without it is a price for a trip the reader did not ask for. */
function shortfallOf(m) {
    if (m.seated == null || m.reach == null || m.seated >= m.reach) return '';
    return m.seated + ' of ' + m.reach;
}

function whyBits(m, list) {
    var varies = function (f) {
        var v = String(f(m));
        return list.some(function (o) { return String(f(o)) !== v; });
    };
    var bits = [];
    /* First, and unconditionally when it is true: who this plan leaves behind
     * is not a tie-breaker between otherwise equal options, it is the thing
     * that decides whether the option is acceptable at all. A $200 saving on a
     * row that reads "4 of 5" is a different trip, and a reader who taps it
     * without being told is being misled by the price. */
    if (shortfallOf(m)) bits.push(shortfallOf(m));
    if (m.spread != null && varies(function (o) { return o.spread; })) {
        bits.push(FWF.fmtGap(m.spread) + ' apart');
    }
    if (varies(function (o) { return (o.conn || []).slice().sort().join(','); })) {
        var n = (m.conn || []).length;
        bits.push(!n ? 'everyone nonstop'
            : n === 1 ? name(m.conn[0]) + ' changes planes'
            : n + ' people change planes');
    }
    return bits;
}

function matchWhy(m, ms) {
    if (m.why) return m.why;
    var list = (ms && ms.length) ? ms : [m];
    var bits = whyBits(m, list);
    /* A caption another row on the same screen also carries has told nobody
     * anything -- it has put two rows at different prices under one sentence,
     * which reads as an unexplained surcharge. It happened on 9% of screens,
     * always the same way: "Easiest flights" lands the group exactly as far
     * apart as "Balanced" and costs a few dollars more, and what it bought was
     * hours out of the air, which the spread cannot show. So when a caption
     * collides, the colliding rows state their flying time and the reader
     * compares two numbers instead of reading one sentence twice. */
    var mine = bits.join(' · ');
    var clash = list.some(function (o) {
        return o !== m && whyBits(o, list).join(' · ') === mine;
    });
    /* Or worse than a clash: a caption showing nothing better than another
     * row's, at a price no lower. "13h 59m apart $4,377" above "10h 2m apart
     * $4,303" gives a reader no reason to tap the first and every reason to
     * distrust the screen for offering it. It happened on 40% of multi-row
     * screens, and in four out of five of them the row genuinely was better --
     * at time in the air, which the caption had no reason to print until now.
     * The fifth was worse at everything and is now dominated away. */
    var beaten = list.some(function (o) {
        return o !== m && o.total <= m.total
            && (o.seated == null || m.seated == null || o.seated >= m.seated)
            && o.spread <= m.spread
            && (o.conn || []).length <= (m.conn || []).length
            && (o.total < m.total || o.spread < m.spread);
    });
    /* Nothing varied at all is the same problem with one row left: say it in
     * time in the air. Something always differs -- two matches that differ in
     * nothing were collapsed into one. */
    if ((clash || beaten || !bits.length) && m.mins != null) {
        bits.push(FWF.fmtGap(m.mins) + ' in the air');
    }
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
    var sub = function (m) {
        return many ? matchWhy(m, ms) : shortfallOf(m);
    };

    /* Boxed only when there is something to choose between. The four rows
     * read as four facts about the trip rather than four buttons -- reported
     * from a phone: "if I'm a first time user I might not even capture that I
     * click cheapest balanced closest landing". Each row did say "Choose" on
     * the right, which is apparently not enough when the group has no edge
     * and runs straight into the plan below it.
     *
     * One container, not one per row. The boxes were stripped off this screen
     * once already and the note on .mrow explains why a 2x2 grid of cards was
     * the wrong answer; this is the opposite move, a single frame that says
     * "these four belong together and you pick one". */
    host.className = 'choices' + (many ? ' boxed' : '');
    host.innerHTML = (many ? '<div class="choices-head">Pick one</div>' : '')
        + '<div class="match"'
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
                + '<span class="m-n">' + esc(many ? m.name : 'The trip') + '</span>'
                /* With one row there is nothing to tell apart, so the sub-line
                 * has one job left: say if this plan leaves somebody behind.
                 * It used to read "One plan covers it -- cheapest, closest and
                 * least flying are the same flights", which was a sentence
                 * explaining why the screen looked the way it did, and
                 * narrowing the band makes that the common case rather than the
                 * rare one. Nothing to flag, nothing printed. */
                + (sub(m) ? '<span class="m-s">' + esc(sub(m)) + '</span>' : '')
                + '</span><span class="m-right">'
                + '<span class="m-v mono">' + money(m.total) + '</span>'
                /* Only under the selected total. It is a can-everyone-afford-
                 * this check on the trip being shown, not a fifth number to
                 * rank the others by -- it tracks the total anyway. */
                + (on ? '<span class="m-e mono">' + money(m.topPer) + ' each at most</span>'
                      : many ? '<span class="m-pick">Choose</span>' : '')
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

/* --brand-h, measured rather than guessed.
 *
 * The results header sticks UNDER the masthead, and the masthead's height
 * depends on env(safe-area-inset-top) -- 59px on a Dynamic Island phone, 47
 * on a notch, 0 in a browser tab. A hardcoded offset leaves a gap on one
 * device and an overlap on another.
 *
 * Also flags the header as stuck, so its underline only appears once it has
 * actually left its place in the flow. */
function trackStick() {
    var brand = document.querySelector('.brand');
    if (!brand) return;
    var set = function () {
        var h = Math.round(brand.getBoundingClientRect().height);
        document.documentElement.style.setProperty('--brand-h', h + 'px');
    };
    set();
    if (typeof ResizeObserver === 'function') new ResizeObserver(set).observe(brand);
    window.addEventListener('orientationchange', function () { setTimeout(set, 250); });

    var head = document.querySelector('.res-head');
    if (!head) return;
    window.addEventListener('scroll', function () {
        var top = head.getBoundingClientRect().top;
        var at = Math.round(brand.getBoundingClientRect().height);
        head.classList.toggle('stuck', top <= at + 1);
    }, { passive: true });
}

/* ------------------------------------------------------------- recents

 * Trips you looked at before.
 *
 * Booking a group trip is not one sitting. People search, send it round, and
 * come back over several days while everyone makes up their mind -- and until
 * now the app forgot everything the moment the tab closed, so the way back in
 * was a link in somebody's messages or nothing at all.
 *
 * Only the id and a one-line summary are kept. Every search is already saved
 * server-side the moment it finishes, so re-opening costs one cached read and
 * no search at all; storing the 150KB document here as well would buy offline
 * access and cost the quota it takes to blow out localStorage.
 *
 * Thirty days because that is the server's TTL on a trip. Past it the id is
 * gone and the row would be a button that goes nowhere, so it is dropped on
 * read rather than left to fail in front of somebody. */
var RECENT_LS = 'fwf_recent', RECENT_MAX = 4, RECENT_DAYS = 30;

function recentList() {
    var a = [];
    try { a = JSON.parse(localStorage.getItem(RECENT_LS) || '[]'); } catch (e) { return []; }
    if (!Array.isArray(a)) return [];
    var cut = Date.now() - RECENT_DAYS * 86400000;
    return a.filter(function (r) {
        return r && typeof r.id === 'string' && r.id && typeof r.at === 'number' && r.at > cut;
    }).sort(function (x, y) { return y.at - x.at; }).slice(0, RECENT_MAX);
}

function rememberTrip() {
    if (!TRIP_ID || !DATA || DATA.sample || !state.q || !state.q.dest) return;
    var a = AIRPORTS.get(state.q.dest);
    var row = {
        id: TRIP_ID, at: Date.now(),
        dest: a ? a.code : String(state.q.dest).slice(0, 3).toUpperCase(),
        dep: state.q.dep, ret: state.q.ret || null,
        n: (state.q.parties || []).length
    };
    var list = recentList().filter(function (r) { return r.id !== row.id; });
    list.unshift(row);
    /* setItem throws when the origin is full. Dropping the oldest and trying
     * again loses the least useful row instead of the whole history. */
    list = list.slice(0, RECENT_MAX);
    while (list.length) {
        try { localStorage.setItem(RECENT_LS, JSON.stringify(list)); return; } catch (e) { list.pop(); }
    }
    try { localStorage.removeItem(RECENT_LS); } catch (e) {}
}

/* Deliberately vague past a week. "17 days ago" is a number nobody needs and
 * the fares are long stale by then anyway -- what the row has to answer is
 * "is this the one I was looking at", not "exactly when". */
function agoText(ts) {
    var d = Math.floor((Date.now() - ts) / 86400000);
    if (d <= 0) return 'today';
    if (d === 1) return 'yesterday';
    if (d < 7) return d + ' days ago';
    if (d < 14) return 'last week';
    return Math.floor(d / 7) + ' weeks ago';
}

function renderRecent() {
    var host = el('recent');
    if (!host) return;
    var list = state.step === 1 ? recentList() : [];
    if (!list.length) { host.classList.add('hidden'); host.innerHTML = ''; return; }
    host.classList.remove('hidden');
    host.innerHTML = '<div class="recent-k">Recent</div>'
        + list.map(function (r) {
            return '<a class="recent-row" href="' + esc(basePath() + '?t=' + r.id) + '">'
                + '<span class="recent-what">' + esc(r.dest) + ' &middot; '
                + esc(prettyRange(r.dep, r.ret)) + '</span>'
                + '<span class="recent-when">' + esc(agoText(r.at)) + '</span></a>';
        }).join('');
}

function render() {
    /* Cleared every pass: the memo is keyed by leg and party, but the option
     * sets it summarises change whenever a filter does. */
    returnTh = {};
    PICKED_PLAN = null;
    OUT_PICKS = null;
    COHERENT_MEMO = {};
    /* Cleared with the rest of the per-pass memos. It was not, so the matches
     * were computed once on load and never again: "Fly home separately, save
     * $20" moved the plan and the itineraries underneath it, and the three
     * totals above them went on quoting the trip with the old way home. Every
     * filter on the screen had the same problem -- stops, airlines, the band,
     * a seat count -- because every one of them changes what a match costs. */
    MATCHES = null;
    C = compute();
    renderNotices();
    renderGear();
    el('go').textContent = state.busy ? 'Searching…' : 'Land them together';
    el('go').setAttribute('aria-disabled', state.busy ? 'true' : 'false');
    el('go').setAttribute('aria-busy', state.busy ? 'true' : 'false');
    el('go').classList.toggle('busy', state.busy);
    renderFooter();
    renderRecent();
    if (state.step !== 4) return;
    if (!C) { showStep(3); return; }
    /* The selected match is what the plan is printed from, so its quoted total
     * and the itineraries underneath it are the same trip. Resolved before
     * tripTotal() because tripTotal() reads state.th. Falls back to the per-leg
     * recommendation when no match can be built at all -- which happens when
     * one leg has somebody with no options. */
    var sel0 = matchOf(tripMatches());
    PICKED_PLAN = sel0 ? sel0.plan : null;
    if (sel0) {
        state.match = sel0.key;
        /* Still set, for the window strip and for anything downstream that asks
         * what window this trip is at -- but it is no longer what the plan is
         * built from. PICKED_PLAN above is. */
        if (sel0.th != null) thBoth(sel0.th);
    } else if (thGet() === null && C.ladder) thSet(recommendedIn(C));
    renderResHead();
    /* Above the TRIP check: a trip whose plan is short still has a roster and
     * still has fares that have aged, and those are exactly the facts somebody
     * re-opening a half-broken trip needs. */
    renderTripState();
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

    /* The stale-fares notice used to live here: a red bar at ten days saying
     * "search again before anyone books". It moved into #tripState, above the
     * plan, for three reasons. Ten days was far too generous -- fares move in
     * days, not fortnights. "Search again" was the wrong offer: it costs the
     * group eight searches off a 230-a-month allowance and produces a NEW trip
     * id, silently abandoning the document the group has been ticking itself
     * off on, when Book already opens the live price for free. And a re-opened
     * trip has two things to report, not one, so they belong in one sentence
     * rather than in a notice and a status line saying adjacent things. */

    /* The standing allowance notice below says this already, and in better
     * words than the provider's own 429 body. Two red bars saying one thing is
     * how a reader stops reading either. */
    var dupQuota = !!(state.error && BUDGET && BUDGET.exhausted
        && /allowance|flight-data/i.test(state.error));
    var e = el('nErr');
    if (state.error && !dupQuota) { e.className = 'notice bad'; e.innerHTML = esc(state.error); }
    else e.className = 'notice bad hidden';

    /* A running count of searches left was on screen until the owner cut it:
     * "remove anything about how many searches are left". It asked the reader
     * to ration something they are not billed for and cannot top up, and the
     * provider's own dashboard already says the number. What survives is the
     * one case the reader has to act on -- the allowance is gone and their
     * search will not run -- because without it the app just fails quietly. */
    var q = el('nQuota');
    if (BUDGET && BUDGET.exhausted) {
        /* The date arrived as 2026-11-01 and went to the screen that way. ISO
         * belongs in the data; every other date in the app is "Nov 1". */
        q.className = 'notice bad';
        q.innerHTML = '<b>Out of searches until ' + esc(prettyDate(BUDGET.resetsAt) || 'next month')
            + '.</b> Shared links still open, and so does anything already searched.';
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
            /* "your filters" named a thing that appears nowhere on screen.
             * "below" was right when the controls lived under the plan and
             * wrong since "Adjust the search" moved to the top, so it now names
             * the control instead of a direction -- which survives the panel
             * moving again. */
            bits.push('<b>' + (blocked.length === C.ids.length
                    ? 'Nobody can fly any of these.'
                    : esc(nameList(blocked)) + ' can’t fly any of these.')
                + '</b> There are flights, just none that ' + esc(filterText())
                + '. Loosen it under Adjust the search.');
        }
        if (none.length) {
            bits.push('<b>No flights for ' + esc(nameList(none)) + ' on the way '
                + (state.leg === 'outbound' ? 'out' : 'home') + '.</b> '
                + 'Try other dates, or another airport.');
        }
        /* There IS a total now, and it is on screen: the chooser used to be
         * hidden whenever the group was short, so this line was true -- and it
         * went on being printed directly above "$1,410 / 3 of 5" once the
         * matches started answering over the subset. Two statements of the
         * money, one of them denying the other. The row says who the total
         * covers, so this line has nothing left to add. */
        /* Guarded now that the closing line is gone: every missing party is
         * either blocked or has nothing at all, so bits is never empty in
         * practice -- but an empty red box with nothing in it is the failure
         * this used to be structurally incapable of. */
        if (bits.length) { sh.className = 'notice bad'; sh.innerHTML = bits.join('<br><br>'); }
        else { sh.className = 'notice bad hidden'; sh.innerHTML = ''; }
    } else sh.className = 'notice bad hidden';
}

function name(id) {
    var t = (C && C.travelers || []).filter(function (x) { return x.id === id; })[0];
    /* C.travelers is only the people who are flying, so somebody who already
     * lives at the destination is not in it -- and printing their party id in
     * a sentence is worse than the sentence not existing. */
    if (!t && state.q) {
        t = allParties().filter(function (x) { return x.id === id; })[0];
    }
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
    /* allParties, not travelers: the person who already lives there is on the
     * trip. The title counts the group, not the flights. */
    var seats = allParties().reduce(function (n, t) { return n + t.seats; }, 0);
    var city = a ? a.city : q.dest;
    /* The city is the control, not a label. It drops back to plain text when a
     * new search could not run anyway -- one is already in flight, or the
     * month's allowance is gone and the notice above already says so -- because
     * a tap that leads nowhere is worse than no tap at all. */
    el('resT').innerHTML = (canRetarget()
            ? '<button class="dest-btn" id="destBtn" aria-label="Change destination, currently '
                + esc(city) + '">' + esc(city)
                /* The word, because the dotted rule did not carry it. "no one
                 * will know how to work this or what they re lookign at first
                 * run" -- and a dotted underline is an idiom you have to
                 * already know. Inside the button, so the label and the thing
                 * it labels are one target rather than a hint next to a
                 * mystery. aria-hidden: the button's own label already says
                 * "Change destination", and a screen reader reading "Cancun
                 * Edit, Change destination, currently Cancun" is the same
                 * instruction three times. */
                + '<span class="dest-edit" aria-hidden="true">Edit</span></button>'
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
    /* Past two days the hour count stops being a figure and starts being a
     * puzzle: "fares 144h old" is six days, and nobody divides by 24 to find
     * that out. The chip is the one place the age is stated, so it has to be
     * stated in the unit the reader thinks in. */
    var word = state.busy ? 'searching…'
        : DATA.sample ? 'example data'
        : hrs == null ? 'age unknown' : hrs < 1 ? 'fares just now'
        : hrs < 48 ? 'fares ' + hrs + 'h old'
        : 'fares ' + Math.round(hrs / 24) + ' days old';
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
/* Loosest first, which is the order the landing band above it already runs in
 * and the order the default sits at the head of. Nonstop-first put the
 * selected pill third and ran the group tightest-to-loosest while the group
 * directly above it ran the other way -- two rows of pills, read top to bottom,
 * disagreeing about which end "everything" belongs at. */
var STOP_PILLS = [{ v: null, l: 'Any' }, { v: 1, l: 'Up to 1 stop' }, { v: 0, l: 'Nonstop' }];

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
    var o = STOP_PILLS;
    host.innerHTML = o.map(function (x) {
        var on = state.q.maxStops === x.v;
        return '<button class="pill' + (on ? ' on' : '') + '" role="radio" aria-checked="' + on
            + '" data-stops="' + (x.v === null ? '' : x.v) + '">' + x.l + '</button>';
    }).join('');
}

function renderStopPills() {
    renderAirlinePills();
    renderBandPresets();
    var o = STOP_PILLS;
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
        /* The only other control this needs is the way back. Three "Only Star
         * Alliance / Only SkyTeam / Only oneworld" bubbles used to sit here,
         * each with a "?" that opened a membership list -- six targets and three
         * popovers for a question nobody on this screen was asking. Taking out
         * one airline you will not fly is the request people actually have, and
         * the pills above already are that: one tap, by name, with the number
         * of options it costs printed on it.
         *
         * ALLIANCES and allianceOf() stay. The membership is curated and
         * asserted in test-airlines.js -- SAS moved to SkyTeam in September
         * 2024, Alaska is oneworld -- and test-pruning.js slices app.js on it.
         * Deleting verified data to remove a control is how the control comes
         * back later with wrong answers in it. */
        + (avoiding ? '<div class="air-row">'
            + '<button class="pill clear" data-air-clear="1">Allow all</button></div>' : '');
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
    /* Last resort, and it cannot fail: prep.complete means every party has an
     * option, so the unconstrained window always has a plan. Reaching here means
     * the caller asked for a window nothing fits -- or asked with null, which
     * recommendedIn returns when no ladder row is feasible. Showing the group
     * their flights with no window is right; showing them an empty screen is
     * not. */
    if (!res) res = FWF.minCostAtWindow(ctx.prep, FWF.INF, ctx.costFn);
    if (!res) return null;
    return { picks: res.picks, included: ctx.ids.slice(), excluded: [],
             spread: res.spread, cost: res.cost, subset: false };
}
function selectedPlan() { return planOf(C, thGet()); }

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
    /* "Tightest" is an explicit request, so it is honoured as asked. */
    if (state.recommend === 'tightest') return f[0].threshold;
    if (state.recommend === 'target') {
        var at = f.filter(function (r) { return r.threshold <= SET.target; });
        return (at.length ? at[at.length - 1] : f[0]).threshold;
    }

    /* The same priced comparison tripBest() makes, on the per-leg ladder's row
     * shape. It used to be the same two unit-free rules as well -- a worthIt
     * veto and a max-refund-rate argmax -- plus a third quirk this drops: when
     * no target window was set it returned fair[0] outright, so two groups a
     * minute apart in feasibility got recommendations produced by different
     * philosophies. One rule now, whether or not the target is reachable.
     *
     * Spread here is the achieved spread, not the threshold. The old loop
     * measured refunds against the threshold, which is the window the row was
     * SOLVED at rather than how far apart anybody actually landed -- so a row
     * labelled 240 whose plan came in 30 minutes apart was charged for 240. */
    var best = null, bestScore = Infinity;
    f.forEach(function (r) {
        if (!r.result || !r.result.picks) return;
        var sc = r.result.cost
            + SPREAD_PER_MIN * (r.result.spread || 0)
            + latenessOf(ctx, r.result.picks, ctx.leg);
        var reg = regretOf(ctx, r.result.picks);
        var fairness = ctx.leg === 'return' ? worthItHome : worthIt;
        sc += EASE_PER_STOP * Math.max(0, reg.stops) + EASE_PER_MIN * Math.max(0, reg.mins);
        /* The veto is gone, but the judgement it encoded is not: a plan that
         * puts somebody on a connection they did not need is still worth more
         * than the shadow alone says, because the regret figure is the WORST
         * traveller's and cannot see that two people took one. */
        if (!fairness(reg)) sc += EASE_PER_STOP;
        if (sc < bestScore) { bestScore = sc; best = r; }
    });
    return (best || f[0]).threshold;
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

/* Google will only resolve a pinned ROUND TRIP against a round trip it can
 * actually sell. Each person's trip here is assembled from two independent
 * one-way searches, so the two legs are frequently on different airlines --
 * and a pinned round trip across two carriers dead-ends on "the itinerary you
 * selected is no longer available" even though both legs exist and each books
 * perfectly on its own.
 *
 * Measured across 29 live Google Flights loads on two route/date pairs: 9 of 9
 * same-carrier round trips resolve, 6 of 6 single legs resolve, and 9 of 11
 * mixed-carrier round trips dead-end -- including two oneworld partners. The
 * two survivors only resolved as separate tickets through an OTA.
 *
 * Southwest was the obvious suspect and is innocent: WN books through a pinned
 * link one-way, with a connection, overnight, and round trip both ways. It
 * only ever failed paired with a different carrier, exactly as AA+DL and
 * DL+AA did. */
function oneCarrierThroughout(options) {
    var seen = null;
    return options.every(function (o) {
        return (o.segs || []).every(function (sg) {
            if (!sg || !sg.carrier) return false;
            if (seen === null) seen = sg.carrier;
            return sg.carrier === seen;
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
/* One link when one link works, two when the trip is honestly two tickets.
 *
 * Returns a list so the card can render what is actually true. A trip whose
 * legs are on different airlines cannot be ticketed as one round trip by
 * Google, and the old single button pinned it as one anyway and dead-ended --
 * which is the worst outcome available, because the reader has no way to tell
 * a sold-out fare from a link the app built wrong. */
function tripBookLinks(origin, dest, dep, ret, seats, options, name) {
    var opts = options || [];
    if (opts.length && (opts.length === 1 || oneCarrierThroughout(opts))) {
        var one = deepLink(opts, seats);
        if (one) return [{ label: 'Book ' + name + '\u2019s trip', url: one }];
    }
    /* Different airlines out and back. Two pinned one-ways would each land on
     * a real booking screen and were tried -- "please remove book the way out
     * and the book the way home it needs to be one link to to the flight make
     * it super easy for one". So it is one link, and the only ONE link that
     * cannot dead-end here is the search: a round trip pinned across two
     * carriers is exactly the thing Google refuses. It opens on the route and
     * the dates with both flights in the list. */
    return [{ label: 'Find ' + name + '\u2019s trip',
              url: tripSearchUrl(origin, dest, dep, ret, seats) }];
}

function tripSearchUrl(origin, dest, dep, ret, seats) {
    var q = 'Flights from ' + origin + ' to ' + dest + ' on ' + dep
        + (ret ? ' returning ' + ret : '')
        + (seats > 1 ? ' ' + seats + ' passengers' : '');
    return 'https://www.google.com/travel/flights?q=' + encodeURIComponent(q);
}

/* Kept for anything still asking for a single url. */
function tripBookUrl(origin, dest, dep, ret, seats, options) {
    return tripBookLinks(origin, dest, dep, ret, seats, options, 'this').url
        || tripBookLinks(origin, dest, dep, ret, seats, options, 'this')[0].url;
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



/* The one sentence the trip is about. Used as the first line of anything that
 * leaves the app and as the subject of an email, because in an inbox "Fort
 * Lauderdale, Jan 15" is a calendar entry and "everyone lands within 14
 * minutes" is the reason to open it. */
function tripHeadline() {
    if (!TRIP || !C) return 'Flights';
    var out = TRIP.legOut;
    if (!out) return 'Flights';
    var absent = C.ids.filter(function (id) { return !out.rows[id]; });
    var apart = (out.plan && out.plan.excluded ? out.plan.excluded.length : 0) + absent.length;
    if (apart) {
        return seatsOf(out.plan.included) + ' of ' + seatsAll()
            + ' land within ' + gapWords(out.spread);
    }
    return landsWithin(out.spread);
}

/* Email, because a trip is addressed to people rather than left on a clipboard.
 *
 * Two rewrites are recorded in what it does NOT contain.
 *
 * It carried a Google Flights deep link per person. Each of those is a
 * four-hundred-character tfs= token, so a three-person trip arrived as three
 * walls of base64 that wrapped across six lines each and buried the total --
 * "the email lands like this so i have no real link nor do i have the price
 * anymore". The deep links still exist where they work: on the Book button, in
 * the app, one tap from the trip link.
 *
 * It also carried a fare per person, until "the email to everyone should
 * provide the links and jus tottal price not the break outs" was read properly.
 * A per-person fare is a break-out of the total. Each line now carries the one
 * thing only this app can tell them: when they land.
 *
 * mailto has no agreed length limit and clients truncate silently somewhere
 * around two thousand characters, so the per-person lines are trimmed before
 * anything else and the trip link is the last thing that can ever go. */
var MAILTO_MAX = 1800;

/* One flyer, one block: name, price, the two flights, and the link that
 * books them.
 *
 * Shared by the email and by whatever the native sheet sends, because they
 * are the same message. Reported twice from real use -- "I shared the trip
 * and chose email to send to my friends but it didn't have the flight links
 * so it becomes useless", and then "seeing a whole bunch of words and not
 * just flight, price, time, links for each flyer".
 *
 * The second half of that matters more than it sounds: a recipient who
 * cannot book from the message has to run the search again, which spends
 * THIS owner's metered allowance to recover an answer already paid for.
 *
 * This reverses an earlier instruction -- "the email should provide the
 * links and just total price not the break outs" -- which took per-person
 * fares and deep links out because three 400-character tokens buried the
 * total. The links are back because without them the message does not do its
 * job; what keeps them readable is that there is now one per person rather
 * than one per flight, and almost no prose around them. */
function flyerBlocks() {
    if (!TRIP || !C) return [];
    var out = [];
    C.ids.forEach(function (id) {
        var t = C.travelers.filter(function (x) { return x.id === id; })[0];
        var o = TRIP.legOut && TRIP.legOut.rows[id];
        var b = TRIP.legBack && TRIP.legBack.rows[id];
        if (!t || !o || !o.option) return;
        var pp = TRIP.perPerson[id];
        var origin = o.option.from;
        var chosen = [];
        if (o.option) chosen.push(o.option);
        if (b && b.option) chosen.push(b.option);

        var lines = [t.name + (pp ? '  ' + money(pp.total) : '')];
        lines.push('  ' + o.option.from + '\u2192' + o.option.to + '  '
            + clock(o.option.departMin) + '\u2013' + clock(o.option.arriveMin)
            + '  ' + (o.option.airlines || []).join('/'));
        if (b && b.option) {
            lines.push('  ' + b.option.from + '\u2192' + b.option.to + '  '
                + clock(b.option.departMin) + '\u2013' + clock(b.option.arriveMin)
                + '  ' + (b.option.airlines || []).join('/'));
        }
        /* Flush left, alone on the line, and nothing after it.
         *
         * The flight lines above are indented to group them under the name,
         * and the url was indented to match -- which cost it the thing it is
         * for. Mail and messaging clients auto-link by scanning for a line
         * that STARTS with the scheme; leading whitespace, or any trailing
         * text, and several of them render it as plain text. Reported as
         * "the link isn't a click, I had to copy it and paste it into the
         * browser".
         *
         * Losing the indent costs a little grouping. Not being clickable
         * costs the whole message, which exists to be clicked. */
        tripBookLinks(origin, state.q.dest, state.q.dep, state.q.ret || null,
                      t.seats, chosen, t.name).forEach(function (lk) {
            lines.push(lk.url);
        });
        /* Trimmed per line. A carrier field can come back empty, which left
         * "7:53pm-7:53pm  " with trailing spaces -- invisible in the editor
         * and, in some clients, enough to stop the next line being treated
         * as the start of a url. */
        out.push(lines.map(function (l) { return l.replace(/\s+$/, ''); }).join('\n'));
    });
    return out;
}

function emailUrl() {
    var a = AIRPORTS.get(state.q.dest);
    var where = a ? a.city : state.q.dest;
    var subject = where + ', ' + prettyRange(state.q.dep, state.q.ret)
        + ' \u2014 ' + tripHeadline().toLowerCase();

    var head = [
        where + ' \u00b7 ' + prettyRange(state.q.dep, state.q.ret)
            + ' \u00b7 ' + money(TRIP.total) + ' for ' + seatsAll(),
        ''
    ];
    /* One short line each, and it is the landing time -- not the fare. The
     * owner asked for "the links and just total price not the break outs", and
     * a per-person fare is a break-out of the total: it invites the arithmetic
     * ("why is mine $40 more than yours") that the one tap into the trip
     * answers properly, with the actual flights next to the actual numbers.
     * What the email is for is the claim: here is when you land. */
    var who = flyerBlocks();
    var tail = ['', shareUrl()];

    /* mailto has no agreed length limit and clients truncate silently around
     * two thousand characters. Whole flyers are dropped from the end rather
     * than links from everybody, so the people who are left still have a
     * bookable message -- and the trip link, which covers all of them, is
     * never what gets cut. */
    var join = function (list, mark) {
        return head.concat(list.join('\n\n'), mark || []).concat(tail).join('\n');
    };
    var body = join(who);
    while (body.length > MAILTO_MAX && who.length > 1) {
        who = who.slice(0, -1);
        body = join(who, ['', '\u2026']);
    }
    if (body.length > MAILTO_MAX) body = head.concat(tail).join('\n');
    return 'mailto:?subject=' + encodeURIComponent(subject)
        + '&body=' + encodeURIComponent(body);
}

function chatBlock() {
    if (!TRIP || !C) return '';
    /* The same message the email sends. It used to be a different, much
     * longer one -- a headline, two labelled leg sections, a WHAT EACH
     * PERSON PAYS block, a fares-as-of line -- and it went into a group
     * chat, where it read as "a whole bunch of words". Nothing in it was
     * wrong; almost none of it was what a recipient needed, which is their
     * own flight and the link that books it. */
    var a = AIRPORTS.get(state.q.dest);
    var head = (a ? a.city : state.q.dest) + ' \u00b7 '
        + prettyRange(state.q.dep, state.q.ret)
        + ' \u00b7 ' + money(TRIP.total) + ' for ' + seatsAll();
    return [head, ''].concat(flyerBlocks().join('\n\n'), ['', shareUrl()]).join('\n');
}


/* The way home offers the other answer, priced. Nothing else.
 *
 * It used to say it in a sentence first -- "Costs $20 more than flying home
 * separately, which would spread the group over 15 hours 49 minutes." -- and
 * then repeat the number on the button underneath. Two statements of one fact,
 * and the longer one came first: "i want least amount of words as possible".
 * Every number that sentence carried is either on the button or in the heading
 * directly above the dots, so the sentence was the only part that could go
 * without taking a fact with it.
 *
 * Returns the control only. */
function returnNote(b, allIn) {
    /* With somebody outside the window the honest thing on screen is the line
     * about who cannot make it, which the strip prints directly below this. */
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
        return btn('0', extra > 0 ? 'Fly home separately, save ' + money(extra)
                                  : 'Fly home separately');
    }

    /* Both remaining cases are flying home separately, and both have to carry
     * the price of the other way rather than imply there is not one. */
    var reach = w.together !== FWF.INF ? { th: w.together } : w.reach;
    /* No window gets the group out together without putting somebody on a
     * materially worse flight than they would take alone. There is no
     * alternative to offer, so there is no control -- and the heading above the
     * dots already states how far apart the group leaves. */
    if (!reach) return '';
    var tog = FWF.minCostAtWindow(b.ctx.prep, reach.th, b.ctx.costFn);
    if (!tog) return '';
    var cost = Math.round(tog.cost - b.inWindowTotal);
    return btn(ch.how === 'priced-out' ? 'any' : '1',
               cost > 0 ? 'Leave together for ' + money(cost) : 'Leave together');
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
    /* The number, not a sentence containing it.
     *
     * This was "everyone within 1 hour 13 minutes of each other" set at display
     * size, which wrapped onto two lines and read as a claim rather than as a
     * figure -- "its hard to find the time it takes to land everyone together
     * like the problem we are trying to solve just looks like a statement".
     * It is the one number the whole product exists to produce, and it was the
     * hardest thing on the screen to pick out.
     *
     * fmtGap, not gapWords: "1h 13m" is the form the chooser rows directly
     * above already use, so the screen states the gap one way rather than two,
     * and a short string at --t-6 lands on one line. The sentence survives
     * where a sentence belongs -- legLines, for pasting into a group chat.
     *
     * "of each other" is carried by the dots underneath: two marks on a line
     * with a span drawn between them is what "apart" means. */
    var measure = (allIn ? '' : seatsOf(included) + ' of ' + seatsAll() + ' \u00b7 ')
        + FWF.fmtGap(b.spread) + ' apart';
    /* "N paid $92 more than flying whenever they liked" used to sit here, under
     * the hero, as its caption. It was the sentence no other product could
     * write -- and it was still a sentence, under a headline, above a timeline,
     * above a priced control: "i want least amount of words as possible". The
     * premium it reported is on the person's own card, beside their fare, as
     * "incl. $92 to land together", which is where somebody checking their own
     * number is already looking. */
    var html = '<div class="win">'
        + (hero
            ? '<div class="win-head hero"><div class="t">' + esc(label) + '</div>'
              /* Only the join between a number and its unit is non-breaking.
               * Replacing every space made the whole phrase one unbreakable
               * word: 536px at 393px wide, which gave the page 159px of
               * horizontal scroll. Measured, not guessed. */
              + '<div class="r">' + esc(measure).replace(/(\d) /g, '$1\u00a0') + '</div>'
              + '</div>'
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
    /* Both ends of the flight, not just the clustered one.
     *
     * Reported after real use: "when I look at lands it leaves me confused
     * because what time am I taking off". The app clusters on ARRIVAL for the
     * outbound and on DEPARTURE for the way home, so it printed only the end
     * it was optimising -- which is the end the app cares about, not the end
     * you set an alarm for. The other one was never on screen anywhere.
     *
     * The clustered time keeps the emphasis, because it is the thing the whole
     * page is arguing about; the other sits under it in the muted sub-line.
     * It also makes an overnight legible for the first time: "leaves 8:10pm /
     * lands 12:50am" reads as a red-eye, where "lands 12:50am" alone does not
     * say which night. */
    var showMin = leg === 'outbound' ? o.arriveMin : o.departMin;
    var otherMin = leg === 'outbound' ? o.departMin : o.arriveMin;
    /* "departs"/"arrives", not "leaves"/"lands". Reported as "can you be
     * normal and use departure and arrival" -- the short words were chosen
     * to sound unfussy and landed as baby talk on a screen people are about
     * to spend hundreds of dollars from. */
    var otherWord = leg === 'outbound' ? 'departs ' : 'arrives ';
    return '<div class="hop"><span class="hop-dir">' + dir + '</span>' + logo
        + '<div class="hop-main"><div class="hop-route">' + esc(o.from) + ' &rarr; ' + esc(o.to)
        + '</div><div class="hop-meta">' + esc((o.airlines || []).join(', ')) + ' · '
        + stopsText(o.stops) + ' · ' + FWF.fmtGap(o.duration_minutes)
        + (r.inWindow ? '' : ' · <span style="color:var(--bad)">outside the window</span>') + '</div>'
        + priceLevel(leg, id) + '</div>'
        + '<div class="hop-right"><div class="hop-time mono">'
        + (leg === 'outbound' ? 'arrives ' : 'departs ') + clock(showMin) + '</div>'
        + (otherMin != null
            ? '<div class="hop-other mono">' + otherWord + clock(otherMin) + '</div>' : '')
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

    /* "I'm booked" is gone from the card. It asked somebody to tell the app
     * something it could not then do anything useful with -- the only place it
     * surfaced was a line above the plan, on a screen they were already
     * looking at. The owner's call: "its weird and awkward". */
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
        /* One button, or two when the trip is two tickets. See tripBookLinks:
         * a round trip pinned across two airlines dead-ends on Google, so a
         * mixed-carrier trip gets the two links that actually resolve. */
        + '<div class="trav-book">'
        + tripBookLinks(origin, state.q.dest, state.q.dep, state.q.ret || null,
                        t.seats, chosen, t.name).map(function (lk) {
            /* .btn, not .btn primary. This link has been styled back down to
             * a secondary control in CSS for a while -- transparent fill,
             * hairline border, ink label -- but it still claimed the primary
             * class, so every rule that wanted to reach it had to out-specify
             * .btn.primary, and the two comments in index.html apologising for
             * that are both about this string. It is secondary; it says so
             * now, and it picks up the secondary type rank for free. */
            return '<a class="btn" style="display:block;text-align:center;'
                + 'text-decoration:none" href="' + esc(lk.url)
                + '" target="_blank" rel="noopener">' + esc(lk.label) + ' &rarr;</a>';
        }).join('')
        + '</div></div></div>';
}

/* Somebody who already lives at the destination. One line, no price, no
 * flights, no Book button -- there is nothing to book. They were rendered as a
 * traveller with no options, which is the error state: a red dashed border,
 * "not with the group", and $0 all in. Being at the meeting point already is
 * the opposite of not making it. */
function localCard(t) {
    var a = AIRPORTS.get(state.q.dest);
    var i = state.q.parties.map(function (p) { return p.id; }).indexOf(t.id);
    return '<div class="trav local">'
        + '<div class="trav-top">'
        + '<div class="ava" aria-hidden="true" style="background:' + partyColor(i < 0 ? 0 : i) + '">'
        + esc(partyInitials(state.q.parties[i] || { name: t.name }, i < 0 ? 0 : i)) + '</div>'
        + '<div><div class="trav-name">' + esc(t.name)
        + (t.seats > 1 ? ' <span class="badge seats">' + t.seats + ' seats</span>' : '')
        + '</div>'
        + '<div class="trav-local">Already in ' + esc(a ? a.city : state.q.dest) + '</div>'
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

    /* The map is NOT on the results page.
     *
     * It was, for about twenty minutes. It is a good picture -- true bearings,
     * real coordinates, no words on it longer than an airport code -- and on
     * a phone it is 238px, which grew this page by 12%. The owner's reaction
     * to seeing it live: "now its so big it kinda ruins the results page".
     *
     * He was right, and the reason is that every fact on it is already on
     * this screen in words. The timeline above says when people land and how
     * far apart; the traveller cards below name each person's airport. The
     * map restates both, larger, as the biggest and least dense card on a
     * screen whose whole design rule is that there should be less on it.
     *
     * flightMap() is kept and tested because the picture earns its space
     * somewhere nothing else is competing for it -- the waiting screen, where
     * the alternative is a spinner. Do not re-add this line without an answer
     * to what it displaces. */

    html += C.ids.map(travellerCard).join('');
    /* And the people who are already there, after the ones who are flying,
     * because that is the order the group thinks in. */
    html += locals().map(localCard).join('');

    host.innerHTML = html;
    fmAnimate(host);
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

/* The four things a group actually says when a price is close.
 *
 * It was two: the whole trip a day earlier, and the whole trip a day later.
 * Those answer "is the week cheaper", which is a real question, but neither is
 * "leave next day and save" or "stay for extra day and save" -- and those are
 * the two somebody says out loud, because they move one end of the trip rather
 * than all of it.
 *
 * They are also the cheap ones to ask. The worker caches per leg, so a
 * candidate that moves only the departure re-searches only the outbound: the
 * return is the same route on the same date and comes back free. */
function shiftCandidates() {
    if (!state.q || !state.q.dep) return [];
    var dep = state.q.dep, ret = state.q.ret;
    var out = [
        { k: 'all-', label: 'The whole trip a day earlier',
          dep: shiftDays(dep, -1), ret: ret ? shiftDays(ret, -1) : null },
        { k: 'all+', label: 'The whole trip a day later',
          dep: shiftDays(dep, 1), ret: ret ? shiftDays(ret, 1) : null }
    ];
    if (ret) {
        out.push({ k: 'dep+', label: 'Leave a day later', dep: shiftDays(dep, 1), ret: ret });
        out.push({ k: 'ret+', label: 'Stay an extra day', dep: dep, ret: shiftDays(ret, 1) });
    }
    /* A departure in the past cannot be searched, and a return on or before the
     * departure is not a trip. */
    return out.filter(function (c) {
        return c.dep >= todayISO() && (!c.ret || c.ret > c.dep);
    });
}

/* Which legs a candidate actually changes, and therefore pays for. Quoting
 * parties x legs for all four over-charged the single-ended ones by double --
 * and this button's whole job is to state a cost before somebody spends it. */
function shiftLegs(c) {
    return (c.dep !== state.q.dep ? 1 : 0)
         + (state.q.ret && c.ret !== state.q.ret ? 1 : 0);
}

function shiftKey(c) { return c.dep + '|' + (c.ret || ''); }

/* How many searches the worker will actually be charged, which is not how many
 * people are going. Travellers who share an origin set collapse to one search
 * upstream -- four friends all leaving from SFO is one search per leg, not four
 * -- so quoting parties x legs over-charges this button by exactly the amount
 * the dedupe already saves. Built from the same list runShiftScan sends, closed
 * airports and all, so the quote and the request cannot drift apart.
 *
 * It is still an upper bound: a leg another group already paid for this week is
 * a cache hit and free. The number can only come in lower, never higher, which
 * is the right direction for a number somebody is about to tap. */
function shiftRoutes() {
    var seen = {};
    travelers().forEach(function (t) {
        var o = t.origins.filter(function (x) {
            var a = AIRPORTS.get(x); return a && !a.closed;
        }).map(function (x) { return String(x).toUpperCase(); });
        o = o.filter(function (x, i) { return o.indexOf(x) === i; }).sort();
        if (o.length) seen[o.join(',')] = 1;
    });
    return Object.keys(seen).length;
}

function shiftCost() {
    var routes = shiftRoutes();
    return shiftCandidates().filter(function (c) { return !SHIFTS[shiftKey(c)]; })
        .reduce(function (n, c) { return n + shiftLegs(c) * routes; }, 0);
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


function renderShifts() {
    var host = el('shifts');
    if (!TRIP || !state.q || DATA.sample) { host.className = 'shifts hidden'; return; }

    var cands = shiftCandidates();
    if (!cands.length) { host.className = 'shifts hidden'; return; }
    /* Nobody with an airport we can search means the scan would send nothing
     * and quote zero -- a button offering a free check that cannot check
     * anything. The notice above already names whoever has no flights. */
    if (!shiftRoutes()) { host.className = 'shifts hidden'; return; }
    host.className = 'shifts';

    var done = cands.filter(function (c) { return SHIFTS[shiftKey(c)]; });
    if (!done.length) {
        var n = shiftCost();
        /* The allowance is a hard stop -- the provider refuses, it does not
         * bill over -- so a button quoting 30 searches with 12 left is a button
         * that fails halfway through and leaves two of the four dates priced.
         * canRetarget() already refuses a new destination on the same grounds;
         * this is the same rule for the other thing that spends. */
        var left = BUDGET ? Math.max(0, BUDGET.limit - BUDGET.used) : null;
        if (left != null && left < n) {
            host.innerHTML = '<div class="share-note">Out of searches for this month.</div>';
            return;
        }
        /* "of your remaining searches" was wrong twice over: the allowance is
         * shared, not yours, and "there is no way to see nearby dates for free"
         * is the app explaining its own billing to somebody about to tap a
         * button. The number is the only part that changes a decision. */
        host.innerHTML = '<button class="btn wide" id="shiftBtn"' + (shiftBusy ? ' disabled' : '') + '>'
            + (shiftBusy ? 'Checking…' : 'Flexible dates') + '</button>'
            /* This quoted its own cost -- "uses up to 8 of this month's
             * searches" -- until the owner cut the allowance from the screen
             * entirely. Asking somebody to weigh a number they are not billed
             * for, against a button whose whole promise is a cheaper trip, only
             * ever talked them out of tapping it. The guard above still refuses
             * when the month really is gone; the reader does not do that sum. */
            + (shiftErr ? '<div class="share-note"><span style="color:var(--bad)">'
                + esc(shiftErr) + '</span></div>' : '');
        return;
    }

    var rows = [{ label: 'Your dates', range: prettyRange(state.q.dep, state.q.ret),
                  total: TRIP.total, here: true }];
    cands.forEach(function (c) {
        var got = SHIFTS[shiftKey(c)];
        if (!got) return;
        rows.push({ label: c.label, range: prettyRange(c.dep, c.ret),
                    total: got.priced ? got.priced.total : null, here: false });
    });
    /* Cheapest first, for the reason the match rows run that way: a column of
     * prices in order is read as a ranking at a glance rather than four prices
     * read one at a time. Rows with no plan sink to the bottom -- they have no
     * price to compare and they are not an option. */
    rows.sort(function (x, y) {
        if (x.total == null) return 1;
        if (y.total == null) return -1;
        return x.total - y.total;
    });

    var priced = rows.filter(function (r) { return r.total != null; });
    var best = priced.length ? priced[0] : null;

    /* Only the days that save money, cheapest first, and the dates on the row
     * rather than in a sentence underneath it.
     *
     * It was five rows plus a closing line: every alternative whether it saved
     * anything or not, two of them at an identical price, "Your dates" again
     * at the bottom, and then a sentence repeating whichever row was best. Six
     * things to read to answer one question -- "is there a cheaper day" --
     * which is a yes or a no and a number.
     *
     * A day that costs MORE is not an option anybody wants; it is the answer
     * to a question nobody asked, and it was taking a row each. The baseline
     * goes too: the trip's own total is the big number further up this screen.
     * What is left is the days worth moving to, and if there are none the
     * section says so in four words. */
    var saving = rows.filter(function (r) {
        return !r.here && r.total != null && r.total < TRIP.total;
    });
    if (!saving.length) {
        host.innerHTML = '<span class="k">Other dates</span>'
            + '<div class="share-note">Your dates are the cheapest.</div>';
        return;
    }
    host.innerHTML = '<span class="k">Other dates</span>'
        + saving.map(function (r) {
            return '<div class="shift' + (r === saving[0] ? ' best' : '') + '">'
                + '<span class="s-d">' + esc(r.label)
                + '<em>' + esc(r.range) + '</em></span>'
                + '<span class="s-p mono">' + money(r.total)
                + '<em>\u2212' + money(TRIP.total - r.total) + '</em>'
                + '</span></div>';
        }).join('');
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
    /* One button. On a phone the native sheet already holds Messages, WhatsApp
     * and Mail, so a separate email button beside it offered the same choice
     * twice. Where there is no sheet -- every laptop -- the two routes appear
     * under the button instead, which is the only place they are needed. */
    var canShare = typeof navigator.share === 'function';
    host.innerHTML = '<button class="btn primary wide" id="shareBtn">Share</button>'
        + '<div class="share-alt" id="shareAlt"></div>'
        + '<div class="share-note" id="copyNote"></div>';

    if (!canShare) showShareOptions();

    el('shareBtn').addEventListener('click', function () {
        /* NOT revealed up front any more. Where there is a native sheet it
         * opens over the page with Messages, Mail and WhatsApp already in it,
         * so a Copy and an Email button underneath are two dead controls
         * behind a modal -- reported exactly that way. They still appear if
         * the sheet is refused or fails, which is the case they exist for,
         * and they are shown from the start on anything without a sheet. */
        if (!canShare) { showShareOptions(); doCopy(); return; }
        el('copyNote').textContent = 'Getting the link\u2026';
        el('copyNote').className = 'share-note';
        /* Saved before the sheet opens: an unsaved link is the self-contained
         * form, and opening one runs a fresh paid search on each recipient's
         * device. WebKit keeps the user activation alive long enough for one
         * write to our own worker. */
        saveTrip().then(function () {
            navigator.share({ text: chatBlock() }).then(function () {
                el('copyNote').textContent = '';
            }).catch(function (err) {
                /* Dismissing the sheet is a decision, not a failure. */
                if (err && err.name === 'AbortError') { el('copyNote').textContent = ''; return; }
                showShareOptions();
                doCopy();
            });
        });
    });

    function showShareOptions() {
        var alt = el('shareAlt');
        if (!alt || alt.innerHTML) return;
        alt.innerHTML = '<button id="copyBtn">Copy</button>'
            + '<button id="emailBtn">Email</button>';
        el('copyBtn').addEventListener('click', doCopy);
        el('emailBtn').addEventListener('click', emailIt);
    }

    function emailIt() {
        el('copyNote').textContent = 'Getting the link\u2026';
        el('copyNote').className = 'share-note';
        /* Saved first for the same reason as the sheet: an unsaved link is the
         * self-contained form, and opening one runs a fresh paid search on each
         * recipient's machine. An email goes to the whole group at once, so this
         * is the route where that matters most. */
        saveTrip().then(function () {
            el('copyNote').textContent = '';
            location.href = emailUrl();
        }, function () {
            el('copyNote').textContent = 'Could not get a link just now. Try again in a moment.';
            el('copyNote').className = 'share-note';
        });
    }

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

/* What landing together cost the one person it cost most. This is the second
 * fact on the screen, and the first one no flight site can state at all: a
 * search engine knows what a flight costs, it does not know what somebody paid
 * to be on the ground at the same time as four other people.
 *
 * WHY THE WORST PERSON AND NOT THE GROUP. Four readings of the same premium
 * were measured against grade/fixtures and the ?demo=1 set:
 *   - the group's total. Over 24 real plans it never once beat what the screen
 *     already says: the match rows price every plan the app will offer, so
 *     "cheaper by $48" is already up there, one row above, to be read off.
 *   - what the group saved against booking separately. Not a number: the
 *     baseline is a per-party minimum over the SAME option set the picks come
 *     from, so every party's premium is >= 0 by construction and the group
 *     total can never come in under the sum of the baselines. There is no
 *     saving to report, on any plan, ever.
 *   - time given up rather than money. worthIt() already refuses any plan that
 *     asks for an extra stop or more than 90 minutes, so on the plans that
 *     reach the screen this is 0 to 10 minutes. A fact that cannot vary cannot
 *     be the headline; who changes planes is already in the itineraries.
 *   - the worst person's, per seat. Carries 33%-100% of the whole (median
 *     51%), runs $0-$129 a seat on the same plans, and appears nowhere else on
 *     the screen. It is also the only one of the four that names somebody, and
 *     the reason a group stops is that one person quietly decides it is not
 *     worth it.
 *
 * PER SEAT, NOT PER BOOKING, for the same reason tripLadder's topPer divides:
 * a two-seat booking paying $110 is two people paying $55, and a claim about a
 * person has to be per person. The two rankings disagree on 2 of 24 plans and
 * both times the per-booking answer names a pair who are each paying less than
 * somebody travelling alone.
 *
 * HONESTY. C.solo is that party's own cheapest option taken from the SAME
 * prepared set the plan is drawn from -- their own rules, the group's refused
 * carriers, the landing time, the budget-fare and connection prunes all apply
 * identically to both sides. So the only thing that differs between the
 * baseline and the pick is the hour the group needed them on the ground, which
 * is exactly what "more than flying whenever they liked" claims, and it is NOT
 * a claim about the cheapest flight in existence. Where the app's own pruning
 * has lifted a baseline above the genuinely cheapest option in the data (3 of
 * 22 party-legs, $20-$50 a seat, every one of them a budget carrier or a
 * six-hour connection), the error can only SHRINK this figure -- a higher
 * baseline is a smaller premium -- so the line understates and never oversells.
 * Across 47 speaking plans, 5 fixtures x 5 settings, the named traveller never
 * once had a pruned baseline, because pruning moves a party away from being
 * the worst-off rather than towards it. */

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

/* --- BEGIN timeline scale ------------------------------------------- */
/* Everything between this marker and the END one below is pure arithmetic
 * over minutes and pixels, and test-dates.js lifts it into a vm by those two
 * strings. Nothing in here may touch the DOM at call time. */

/* Where in the day this is.
 *
 * The axis USED to be the cluster plus 45% padding, so a 55-minute landing
 * window and a 5h38m one were drawn at exactly the same width. The line said
 * nothing: two marks near the middle could be five minutes or five hours
 * apart, and nothing on the card told you which, or whether any of it was the
 * middle of the night. A ruler of hour ticks underneath did not fix it --
 * at cluster zoom the ticks landed on the same times as the people, so the
 * card printed two near-identical rows of times and was rejected for it.
 *
 * The axis is now the whole day, midnight to midnight. Position on the line IS
 * time of day, so every card in the app shares one scale and the landing card
 * and the leaving card can be read against each other without doing arithmetic
 * in your head. The ticks become 6am / 12pm / 6pm, which no arrival time can
 * duplicate, and they are evenly spaced -- regular spacing is what makes a
 * reader take a row of times as a scale rather than as more data.
 *
 * Three things follow from day scale, and each has a function below:
 * a day is long, so the ends need an inset or an 11:58pm avatar is sliced in
 * half by the clip (PLOT_LO, edgeShift); a day is long, so 11:10am and 11:15am
 * are a pixel apart and have to become one mark (mergeMarks, rangeLabel); and
 * a leg can cross midnight, so the window is a whole number of days
 * (dayWindow). */

var DAY = 1440;

/* The plot, as a percentage of the card's timeline box. 6/94 rather than
 * 0/100 because a mark is a 34px avatar with a time under it and the box
 * clips its overflow. 6% is 19px on a 390px phone and 15px on a 320px one,
 * against a 17px half-avatar -- so the inset carries a lone avatar nearly on
 * its own, and edgeShift only has to catch stacked faces and long labels.
 * Emitted to CSS as --inset so the rule, its end stops and this arithmetic
 * cannot drift apart. */
var PLOT_LO = 6, PLOT_HI = 100 - PLOT_LO;

/* Vertical layout, in px, shared with the .tl-* rules in index.html -- which
 * is asserted in test-dates.js, because two copies of a number is one copy too
 * many and the one that rots is the one nothing reads.
 *
 * The box is sized from the rows the card actually uses rather than from the
 * deepest case, so the common card -- one row of times -- is 88px instead of
 * the 132px it was. */
var MARK_TOP = 8, AVATAR_PX = 34, DOT_LAP = 10;
var LABEL_LEAD = 4, LABEL_LINE = 11, ROW_PITCH = 14;
var AXIS_GAP = 10, RULER_H = 17, BOTTOM_PAD = 3;

/* Mark times are a size up from the ruler: "4:28pm" measures 40.7px at 11px
 * and "11:50am-12:10pm" measures 100.1px, so a shade under 7px a character.
 * Rounded up, because over-estimating a label only costs a row and
 * under-estimating prints one on top of another. Ticks are 10px and carry
 * letters ("Wed" is 21.4px), so they get a little more. */
var LABEL_CH = 7, TICK_CH = 7.5, LABEL_GAP_PX = 6;

/* The window: whole days, starting at the midnight before the earliest mark.
 *
 * Whole days are the whole point -- a window that began at the first arrival
 * would put every card back on its own scale. A return that leaves at 9pm and
 * lands after midnight gets a second day rather than a wrapped line. */
function dayWindow(times) {
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < times.length; i++) {
        if (times[i] < lo) lo = times[i];
        if (times[i] > hi) hi = times[i];
    }
    if (!isFinite(lo)) return null;
    var from = Math.floor(lo / DAY) * DAY, to = from + DAY;
    /* Strictly past, not "at". A mark on the stroke of midnight is the right
     * hand end of the day it closes; giving it a second day would draw
     * twenty-four hours of nothing in order to say the same thing. */
    while (hi > to) to += DAY;
    return { from: from, to: to, days: (to - from) / DAY };
}

/* Time of day to a position on the line. The one function every card has to
 * agree on, so the inset lives in it rather than at each call site. */
function plotPct(m, from, to) {
    return PLOT_LO + (m - from) / ((to - from) || 1) * (PLOT_HI - PLOT_LO);
}

/* An avatar is 34px. Two marks closer together than that are two faces in the
 * same place, and at day scale that is the normal case rather than the edge
 * one: 34px of a 285px plot is about 170 minutes, so an entire landing cluster
 * collapses to a single mark. That is the true picture -- the group did land
 * in one sliver of the day, and the span rule on the axis still draws exactly
 * how wide that sliver is.
 *
 * The distance is measured from the FIRST member of the group, not the
 * previous one, so a straggle of marks 30px apart cannot chain into one pile
 * covering half the day. A merged mark never represents more of the clock than
 * one avatar covers. */
var MERGE_PX = AVATAR_PX;

function mergeMarks(keys, from, to, axisPx) {
    var pxPerMin = (PLOT_HI - PLOT_LO) / 100 * axisPx / ((to - from) || 1);
    var out = [];
    for (var i = 0; i < keys.length; i++) {
        var g = out[out.length - 1];
        if (g && (keys[i] - g.lo) * pxPerMin < MERGE_PX) { g.hi = keys[i]; g.keys.push(keys[i]); }
        else out.push({ lo: keys[i], hi: keys[i], keys: [keys[i]] });
    }
    for (var j = 0; j < out.length; j++) {
        /* Drawn at the middle of what it covers. The pile is one avatar wide
         * and so is the range under it, so the middle is the only placement
         * that does not systematically lie about one end. */
        out[j].m = (out[j].lo + out[j].hi) / 2;
    }
    return out;
}

/* "4:28-5:05pm", not "4:28pm - 5:05pm". The suffix is shared whenever both
 * ends share it, which is almost always, because this is a caption under a
 * face and every character of it competes with the face. A single time keeps
 * its plain label; 24-hour mode has no suffix to share. */
function rangeLabel(lo, hi) {
    var a = clock(lo);
    if (lo === hi) return a;
    var b = clock(hi);
    if (SET.time24) return a + '-' + b;
    return (a.slice(-2) === b.slice(-2) ? a.slice(0, -2) : a) + '-' + b;
}

/* On the hour the minutes are noise: "6am" reads faster than "6:00am". */
function tickLabel(m) {
    var d = new Date(m * 60000), h = d.getUTCHours(), mm = d.getUTCMinutes();
    if (SET.time24) return (h < 10 ? '0' + h : h) + ':' + (mm < 10 ? '0' + mm : mm);
    if (mm !== 0) return clock(m);
    return (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? 'am' : 'pm');
}

/* The only word the timeline is allowed, and only once the window is longer
 * than a day -- at which point which side of the break a mark sits on is the
 * entire question. */
var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function dayLabel(m) { return WEEKDAYS[new Date(m * 60000).getUTCDay()]; }

/* 6am / 12pm / 6pm on a single day. They are not there to be read off -- they
 * are there so the eye can see that the line is a day and that the faces sit
 * in the afternoon of it. Three of them, evenly spaced, and none of them a
 * time any flight on the card could also be.
 *
 * Longer windows thin to noon, and past three days to the midnights alone,
 * because a tick every six hours across four days is a texture rather than a
 * scale. The window's own two midnights are not ticks: they are the end stops
 * on the rule, drawn in CSS, and labelling both ends "12am" would spend two
 * words saying what the shape already says. */
function dayTicks(from, to) {
    if (!(to > from)) return [];
    var days = Math.round((to - from) / DAY);
    var step = days <= 1 ? 360 : days <= 3 ? 720 : DAY;
    var ticks = [];
    for (var m = from + step; m < to; m += step) {
        var isDay = m % DAY === 0;
        ticks.push({ m: m, day: isDay, label: isDay ? dayLabel(m) : tickLabel(m) });
    }
    return ticks;
}

/* Nudges a drawing back inside the box, and reports how far it had to move.
 * The inset carries a lone avatar; this catches the two cases it cannot -- a
 * stack of three faces at 11pm, and a range label, which at 100px is wider
 * than the inset at either end.
 *
 * Only the drawing moves. The mark stays anchored at its own left:%, and the
 * dots and the label are shifted within it, which is worth saying out loud
 * because it is the one place on this card where the ink and the clock
 * disagree. A face sliced in half by the clip is the worse of the two. */
/* Whole pixels, and always rounded the way that moves the drawing further
 * in. Rounding to nearest left a stack of eight faces with half a pixel of
 * clearance on a 320px phone, which is a guarantee only until the next
 * sub-pixel layout change. */
var EDGE_PAD = 2;
function edgeShift(centrePx, halfPx, axisPx) {
    if (centrePx - halfPx < EDGE_PAD) return Math.ceil(EDGE_PAD - centrePx + halfPx);
    if (centrePx + halfPx > axisPx - EDGE_PAD) return -Math.ceil(centrePx + halfPx - axisPx + EDGE_PAD);
    return 0;
}

/* How wide a stack of n faces is drawn, from the CSS: 34px each, lapped 10px.
 * Eight of them is 202px, which is most of the plot -- see the note in
 * timeline() about what that costs. */
function pileWidth(n) { return AVATAR_PX + (n - 1) * (AVATAR_PX - DOT_LAP); }

/* Which row each time label sits in, or -1 for "do not print it".
 *
 * Greedy, first row that fits, measured against each label's own width and
 * against the position it will actually be drawn at -- packing the unshifted
 * boxes would let two labels that have both been pulled in off the same edge
 * land on the same row and print over each other.
 *
 * Three rows is still the ceiling, but merging means the common card needs
 * one. Rows now sit above the axis, so an unused row costs nothing: the box
 * is sized from the rows that were used. */
var LABEL_ROWS = 3;

function labelRows(marks, axisPx) {
    var rowRight = [];
    return marks.map(function (mk) {
        var half = String(mk.label).length * LABEL_CH / 2;
        var centre = mk.pct / 100 * axisPx;
        centre += edgeShift(centre, half, axisPx);
        var row = 0;
        while (row < rowRight.length && centre - half < rowRight[row] + LABEL_GAP_PX) row++;
        if (row >= LABEL_ROWS) return -1;
        rowRight[row] = centre + half;
        return row;
    });
}

/* The height of the box and the height of the rule inside it, from the number
 * of label rows actually printed. Returned together because the ruler hangs
 * off the axis and the clip is set from the ruler. */
function timelineBox(rows) {
    var deepest = MARK_TOP + AVATAR_PX
        + (rows > 0 ? LABEL_LEAD + (rows - 1) * ROW_PITCH + LABEL_LINE : 0);
    var axis = deepest + AXIS_GAP;
    return { axis: axis, height: axis + 1 + RULER_H + BOTTOM_PAD };
}

/* Measured, not assumed. The card is 254px wide on a 320px phone, 324px on a
 * 390px one and 566px on a desktop, and an edge clamp worked out against the
 * wrong one either leaves a face clipped or shoves a label a third of the way
 * across the card. main's padding is the only thing that changes with the
 * breakpoint; .win's 1px border and 16px padding do not.
 *
 * Declared inside the sliced region and never called from it, which is why
 * test-dates.js can lift this file into a vm with no document. */
function timelineBoxPx() {
    var m = typeof document !== 'undefined' && document.querySelector('main');
    if (!m || !m.clientWidth) return 324;
    var cs = window.getComputedStyle(m);
    var inner = m.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    return Math.max(inner - 34, 160);
}
/* How wide to draw the group's window.
 *
 * Drawn honestly against a whole day, a five-minute window is about one pixel
 * on a one-pixel rule. That does not read as a tight group, it reads as a
 * rendering fault -- a smudge, or something that failed to paint. Rendered
 * both ways side by side, the fix is a floor equal to the bar's own height:
 * at the floor it bottoms out as a round dot, visibly a point somebody placed
 * rather than a dash, and the pill radius does the rest.
 *
 * What that costs is the distinction between five minutes and thirty-seven,
 * which is a distinction this card already prints in words directly above. */
var SPAN_H_PX = 6;

function spanWidthPct(leftPct, rightPct, axisPx) {
    if (!(axisPx > 0)) return 0;
    var floorPct = SPAN_H_PX / axisPx * 100;
    return Math.max(rightPct - leftPct, floorPct);
}

/* --- END timeline scale --------------------------------------------- */

/* --- BEGIN map geometry --------------------------------------------- */
/* Everything between this marker and the END one below is spherical
 * trigonometry over latitude, longitude and a unit box, and test-geo.js lifts
 * it into a vm by those two strings. Nothing in here may touch the DOM at call
 * time, and nothing in here reads airports-geo.js -- it is handed points.
 *
 * This exists because a map of a group converging on one city is the easiest
 * thing in the app to draw beautifully and wrongly. The mockup it replaces
 * carried the caption "Conceptual visualization", which is an honest label on
 * a dishonest picture, and the rule here is the same rule as everywhere else:
 * if it is on the screen it is true. Three things have to be true for that.
 *
 * One: the line between two cities is a great circle, not a straight line in
 * latitude and longitude. JFK to LHR drawn straight passes south of Ireland;
 * the flight actually crosses Newfoundland and the southern tip of Greenland,
 * about 600km north of the straight line at the middle. Oslo to Anchorage is
 * worse -- the straight line sits at 60 degrees north the whole way and the
 * real route goes over 83, which is not a refinement, it is a different
 * continent.
 *
 * Two: the projection. See fitProjection.
 *
 * Three: the antimeridian. Tokyo is at 140 east and Los Angeles at 118 west,
 * and the difference of those two numbers is 258 degrees going the wrong way
 * round the planet. Subtract them naively and the map draws a line from Japan
 * west across Asia, Europe, the Atlantic and the whole United States to reach
 * an airport that is 101 degrees away over an empty ocean. Every function
 * below that touches longitude goes through wrapLon or lonCenter for exactly
 * this reason, and the table has real airports on both sides of the line:
 * TVU in Fiji is at 179.88 west and MFJ, 200km from it, is at 179.95 east. */

var D2R = Math.PI / 180, R2D = 180 / Math.PI;

/* Mean Earth radius, IUGG. The app quotes no distance to better than a
 * kilometre, so the difference between this and a WGS84 ellipsoid -- about
 * 0.3% worst case, under 20km on a transatlantic -- is below anything it
 * prints or draws. Stated rather than assumed, because the one way a distance
 * function fails silently is by being right in the wrong units. */
var EARTH_KM = 6371.0088;

/* Mercator goes to infinity at the poles, so it is cut where every web map
 * cuts it. This never bites on real data: the northernmost airport in the
 * table is LYR at 78.25 and the southernmost is USH at -54.84. It is here so
 * that a caller who passes a pole gets a finite number instead of a NaN that
 * reaches an SVG attribute and silently deletes the shape. */
var MERC_MAX_LAT = 85.0511287798066;

/* Longitude folded into [-180, 180). The modulo is written twice because
 * JavaScript's % keeps the sign of the left operand, so (-200) % 360 is -200
 * and not 160. */
function wrapLon(deg) {
    var x = (deg + 180) % 360;
    if (x < 0) x += 360;
    return x - 180;
}

/* Latitude and longitude to a point on the unit sphere, and back. Everything
 * that is hard about this problem -- the shortest path, the antimeridian, the
 * poles -- stops being hard in three dimensions, where a great circle is just
 * a rotation and there is no seam anywhere on the sphere to cross. The seam is
 * a property of the map, not of the Earth, so it is dealt with once, in the
 * projection, instead of in every piece of geometry. */
function toVec(p) {
    var la = p.lat * D2R, lo = p.lon * D2R, c = Math.cos(la);
    return [c * Math.cos(lo), c * Math.sin(lo), Math.sin(la)];
}

function fromVec(v) {
    return { lat: Math.atan2(v[2], Math.sqrt(v[0] * v[0] + v[1] * v[1])) * R2D,
             lon: Math.atan2(v[1], v[0]) * R2D };
}

/* The true shortest path between two points, as n points along it.
 *
 * Slerp on the unit sphere: the arc from a to b is swept at constant angular
 * speed, which is the same thing as saying the points come out evenly spaced
 * in kilometers rather than evenly spaced in longitude. Evenly spaced in
 * longitude is what an interpolation in lat/lon gives you, and it is wrong in
 * both position and spacing -- it bunches the samples up at the ends of a
 * polar route, which is exactly where the curve needs them.
 *
 * Longitudes come back folded to [-180, 180), so a Pacific path really does
 * step from 179.6 to -179.8. That is the honest value for the point and it is
 * the projection's job to draw it continuously; see fit.path below. Callers
 * walking the points for anything other than drawing should expect it. */
function greatCircle(a, b, n) {
    var steps = Math.max(2, Math.round(n) || 0);
    var u = toVec(a), v = toVec(b), out = [], i, t;
    var dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    if (dot > 1) dot = 1; else if (dot < -1) dot = -1;
    var w = Math.acos(dot);

    if (w < 1e-9) {
        /* Same airport, or two codes at one field once rounded. There is no
         * arc; repeating the point keeps the caller's array length promise. */
        for (i = 0; i < steps; i++) out.push({ lat: a.lat, lon: a.lon });
        return out;
    }

    if (Math.PI - w < 1e-9) {
        /* Antipodal. Every great circle through a passes through b, so the
         * shortest path is not unique and slerp divides by sin(pi) = 0. Pick
         * one plane deliberately rather than returning NaN: cross a with
         * whichever axis it is least parallel to. No pair in the table is
         * antipodal, so this branch is a guard, not a feature. */
        var k = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        var p = [u[1] * k[2] - u[2] * k[1],
                 u[2] * k[0] - u[0] * k[2],
                 u[0] * k[1] - u[1] * k[0]];
        var m = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
        for (i = 0; i < steps; i++) {
            t = i / (steps - 1) * Math.PI;
            var cs = Math.cos(t), sn = Math.sin(t) / m;
            out.push(fromVec([cs * u[0] + sn * p[0],
                              cs * u[1] + sn * p[1],
                              cs * u[2] + sn * p[2]]));
        }
    } else {
        var s = Math.sin(w);
        for (i = 0; i < steps; i++) {
            t = i / (steps - 1);
            var ca = Math.sin((1 - t) * w) / s, cb = Math.sin(t * w) / s;
            out.push(fromVec([ca * u[0] + cb * v[0],
                              ca * u[1] + cb * v[1],
                              ca * u[2] + cb * v[2]]));
        }
    }

    /* The ends are snapped back to the inputs. Round-tripping through the
     * sphere loses about 1e-13 of a degree, which is nothing on a map and is
     * not nothing when the end of a path and the marker that sits on it are
     * drawn from two numbers that no longer match. */
    out[0] = { lat: a.lat, lon: a.lon };
    out[steps - 1] = { lat: b.lat, lon: b.lon };
    return out;
}

/* Great-circle distance in kilometers, by the haversine formula.
 *
 * Haversine rather than the spherical law of cosines because the law of
 * cosines loses precision on short arcs -- an acos of something very close to
 * 1 -- and short arcs are the common case here: a group converging from three
 * cities in one country. It needs no antimeridian handling of its own, since
 * it only ever uses sin of half the longitude difference and that is the same
 * number whether you went 0.17 degrees east or 359.83 west. */
function gcDistanceKm(a, b) {
    var p1 = a.lat * D2R, p2 = b.lat * D2R;
    var dp = (b.lat - a.lat) * D2R, dl = (b.lon - a.lon) * D2R;
    var sp = Math.sin(dp / 2), sl = Math.sin(dl / 2);
    var h = sp * sp + Math.cos(p1) * Math.cos(p2) * sl * sl;
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/* The one longitude the map should be centered on, as the middle of the
 * SHORTEST arc of the globe that contains every airport in play.
 *
 * Found by its complement: sort the longitudes round the circle, take the
 * widest empty gap between neighbours, and the airports live in everything
 * that gap is not. For a US group the widest gap is the Pacific and Eurasia
 * together and the answer is the middle of North America. For Tokyo and Los
 * Angeles the widest gap is the 258 degrees running west from Japan, so the
 * arc that holds them is the 101 degrees of Pacific between them and the
 * centre is 169 west -- which is what stops the map drawing them apart.
 *
 * Mean longitude would not do this. The mean of 140 and -118 is 11 east,
 * somewhere in Libya, with the two airports at opposite edges of the world. */
function lonCenter(lons) {
    var s = [], i;
    for (i = 0; i < lons.length; i++) s.push(wrapLon(lons[i]));
    s.sort(function (x, y) { return x - y; });
    if (!s.length) return 0;
    if (s.length === 1) return s[0];

    var gap = -1, at = 0;
    for (i = 0; i < s.length; i++) {
        var next = (i === s.length - 1) ? s[0] + 360 : s[i + 1];
        if (next - s[i] > gap) { gap = next - s[i]; at = i; }
    }
    var lo = s[(at + 1) % s.length], hi = s[at];
    if (hi < lo) hi += 360;
    return wrapLon((lo + hi) / 2);
}

/* Mercator's vertical axis, in the same radians as its horizontal one. */
function mercY(lat) {
    var p = Math.max(-MERC_MAX_LAT, Math.min(MERC_MAX_LAT, lat)) * D2R;
    return Math.log(Math.tan(Math.PI / 4 + p / 2));
}

/* A projection fitted to exactly the airports in play, into a box that is a
 * unit square unless the caller asks for pixels.
 *
 * MERCATOR, and the reason is that it is conformal: it gets ANGLES right
 * everywhere, so a cluster of cities keeps the shape it has on the ground and
 * a reader who knows what their part of the world looks like recognizes it.
 *
 * The simpler option is equirectangular -- x is longitude, y is latitude, two
 * lines of code. It is wrong by a factor of 1/cos(latitude) in the horizontal,
 * and that is not a subtlety at the latitudes this app serves. At 51 north a
 * degree of longitude is 63% of a degree of latitude on the ground and London
 * comes out 1.6 times too wide. At 60 north, which is Oslo, Stockholm,
 * Helsinki and Anchorage, it is exactly double. At 78, which is LYR, it is 4.8
 * times, and the Svalbard archipelago is drawn as a smear. A group in the
 * Nordics would get a map that is visibly the wrong shape, and the only way to
 * know would be to already know.
 *
 * What Mercator costs, stated plainly, is area: it is the projection that
 * makes Greenland the size of Africa. That costs nothing here because this
 * draws points and arcs and never fills a region, so nothing on it is read as
 * an area in the first place. It costs one thing that is NOT free, and the
 * component that draws this has to honor it: any basemap underneath must be
 * Mercator too. Drop a plate-carree world SVG behind these coordinates and
 * every airport sits in the wrong country, worst at the latitudes where
 * Mercator was chosen to help.
 *
 * The third candidate was azimuthal equidistant centered on the destination,
 * where every route is a straight radial line and every distance from the
 * destination is true to scale -- genuinely the right projection for "everyone
 * converging on one city". It was not taken because it needs a destination to
 * exist before it can be drawn, and because the picture it makes is not one
 * anybody recognizes as a map. Worth reconsidering if the map ever becomes
 * a figure about distance rather than a picture of a trip.
 *
 * The fit is UNIFORM in both axes and centered in the box. Normalizing x and y
 * independently to fill the box would stretch the picture and throw away the
 * one property Mercator was chosen for, so a wide group leaves space above and
 * below and a tall one leaves space either side. The caller gets aspect back
 * and can pick a box that wastes less of it.
 *
 * FIT ON WHAT YOU ARE GOING TO DRAW, which means the route samples and not
 * only the airports. It is one extra concat and it is the difference between
 * a picture that fits and one that does not, because a route can leave the
 * box that its own two endpoints fitted into. Tokyo and Los Angeles meeting
 * in London is the case: the tight arc through those three airports runs east
 * from Tokyo across the Pacific and the Atlantic, 219 degrees of it, and
 * leaves Asia out -- but the Tokyo to London flight goes over Asia, so it
 * exits the frame. Hand the sampled points to the fit as well and the box
 * becomes the 258 degrees that actually has everything in it, Tokyo at one
 * edge, Los Angeles at the other, London in between and both routes inside.
 *
 *     var legs = origins.map(function (o) { return greatCircle(o, dest, 48); });
 *     var fit  = fitProjection([].concat.apply(origins.concat([dest]), legs),
 *                              { width: 300, height: 180, pad: 14 });
 *
 * points: [{lat, lon}, ...]  -- everything the picture has to contain
 * opts:   { width: 1, height: 1, pad: 0 }  -- box size and inset, same units
 */
function fitProjection(points, opts) {
    var o = opts || {};
    var W = o.width > 0 ? o.width : 1;
    var H = o.height > 0 ? o.height : 1;
    var pad = o.pad > 0 ? o.pad : 0;

    var pts = [], i, p;
    for (i = 0; i < (points || []).length; i++) {
        p = points[i];
        if (p && isFinite(p.lat) && isFinite(p.lon)) pts.push(p);
    }

    var lons = [];
    for (i = 0; i < pts.length; i++) lons.push(pts[i].lon);
    var lon0 = lonCenter(lons);

    /* Every longitude pulled into the half-turn centered on lon0, so the set is
     * contiguous in x before anything is measured. Without this the bounding
     * box of Tokyo and Los Angeles is 258 degrees wide and the fit zooms out
     * to show a planet nobody is flying over. */
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    var n0 = Infinity, n1 = -Infinity;
    for (i = 0; i < pts.length; i++) {
        var ux = (lon0 + wrapLon(pts[i].lon - lon0)) * D2R, uy = mercY(pts[i].lat);
        if (ux < x0) x0 = ux; if (ux > x1) x1 = ux;
        if (uy < y0) y0 = uy; if (uy > y1) y1 = uy;
        if (pts[i].lat < n0) n0 = pts[i].lat;
        if (pts[i].lat > n1) n1 = pts[i].lat;
    }
    if (!pts.length) { x0 = x1 = y0 = y1 = 0; n0 = n1 = 0; }

    var spanX = x1 - x0, spanY = y1 - y0;
    var availW = Math.max(0, W - 2 * pad), availH = Math.max(0, H - 2 * pad);

    /* One scale for both axes, set by whichever one runs out of box first. */
    var k = Infinity;
    if (spanX > 0) k = Math.min(k, availW / spanX);
    if (spanY > 0) k = Math.min(k, availH / spanY);
    /* Nobody, or everybody at one airport. There is no scale that means
     * anything, so the scale is zero and the single point lands dead centre --
     * a dot in the middle of the box, which is the true picture of a group who
     * are all already in the same city. */
    if (!isFinite(k)) k = 0;

    var ox = (W - k * spanX) / 2 - k * x0;
    var oy = (H - k * spanY) / 2 + k * y1;

    function at(lonDeg, lat) {
        return { x: k * lonDeg * D2R + ox, y: oy - k * mercY(lat) };
    }

    /* A single point: a marker. Folded into the window round lon0, so an
     * airport the fit never saw still lands somewhere sensible relative to the
     * ones it did. */
    function project(p) {
        return at(lon0 + wrapLon(p.lon - lon0), p.lat);
    }

    /* A polyline: a route. Each longitude is unwrapped against the PREVIOUS
     * one rather than against lon0, taking whichever of east or west is the
     * shorter step. That is what keeps a Pacific path in one piece: the
     * samples step 179.6, -179.8, -179.2, and folding each one into a fixed
     * window would send the third of those the whole way back across the map
     * and draw a horizontal line through everything.
     *
     * The consequence to know about: a path is drawn continuously even where
     * that takes it outside the box, which is the honest answer -- a route
     * that leaves the frame should leave it, not teleport across it. Fitting
     * on the route samples as well as the airports, as the note above says to,
     * is what stops that arising. */
    function path(list) {
        var out = [], prev = null, j;
        for (j = 0; j < (list || []).length; j++) {
            var ul = prev === null ? lon0 + wrapLon(list[j].lon - lon0)
                                   : prev + wrapLon(list[j].lon - prev);
            prev = ul;
            out.push(at(ul, list[j].lat));
        }
        return out;
    }

    return {
        project: project,
        path: path,
        /* Everything below is for sizing the box and for tests; drawing only
         * needs project and path. */
        lon0: lon0,
        scale: k,
        spanX: spanX,
        spanY: spanY,
        aspect: spanY > 0 ? spanX / spanY : null,
        /* west and east are UNWRAPPED, so west is always less than east and
         * either may fall outside [-180, 180]. Tokyo and Los Angeles come
         * back as -219.61 to -118.41, a 101 degree box, rather than as the
         * 258 degree one that reading them as plain longitudes would give. */
        bounds: { north: n1, south: n0,
                  west: x0 * R2D, east: x1 * R2D },
        width: W, height: H, pad: pad
    };
}
/* --- END map geometry ----------------------------------------------- */

/* band=false on a leg that is not a shared departure. The span rule says
 * "everyone is inside this"; drawn across an unclustered return it turned a
 * deliberate choice into what looks like a failed match spanning eleven hours.
 * Where the way home IS one departure -- asked for, or free -- the rule is
 * drawn, because then it is telling the truth and the leg should read like the
 * outbound. The faces always tell the truth about the times.
 *
 * What this picture gives up, stated plainly: a stack of eight faces is 202px
 * wide and the half-hour it stands for is 6px, so on a full group the faces
 * overstate their own width on the clock by a long way. The span rule under
 * them is the correction -- it is drawn from the first arrival to the last and
 * nothing else, so the stack says who and the rule says when. */
function timeline(picks, included, excluded, band) {
    var idxOf = function (id) { return state.q.parties.map(function (p) { return p.id; }).indexOf(id); };

    var groups = {}, times = [];
    included.forEach(function (id) {
        var m = picks[id].option.clusterMin;
        times.push(m);
        (groups[m] = groups[m] || []).push({ id: id, dim: false });
    });
    /* A leg nobody can make still has people on it, and a card with a heading
     * and no picture under it reads as a rendering fault. The day is taken
     * from where they would have landed. */
    var spanTimes = times.slice();
    if (!times.length) {
        (excluded || []).forEach(function (x) { if (x.nearest) times.push(x.nearest.clusterMin); });
    }
    var win = dayWindow(times);
    if (!win) return '';

    (excluded || []).forEach(function (x) {
        if (!x.nearest) return;
        var m = x.nearest.clusterMin;
        if (m < win.from || m > win.to) return;
        if (!groups[m]) groups[m] = [];
        if (!groups[m].some(function (g) { return g.id === x.id; })) groups[m].push({ id: x.id, dim: true });
    });

    var axisPx = timelineBoxPx();
    var keys = Object.keys(groups).map(Number).sort(function (a, b) { return a - b; });
    var marks = mergeMarks(keys, win.from, win.to, axisPx).map(function (g) {
        var people = [];
        g.keys.forEach(function (k) { people = people.concat(groups[k]); });
        return { pct: plotPct(g.m, win.from, win.to), label: rangeLabel(g.lo, g.hi), people: people };
    });

    var rows = labelRows(marks, axisPx);
    var used = rows.reduce(function (n, r) { return r + 1 > n ? r + 1 : n; }, 0);
    var box = timelineBox(used);

    var html = '<div class="timeline" style="height:' + box.height + 'px;--axis:' + box.axis
        + 'px;--inset:' + PLOT_LO + '%">'
        + '<div class="tl-axis"></div>';

    if (band !== false && spanTimes.length) {
        var l = plotPct(Math.min.apply(null, spanTimes), win.from, win.to);
        var r = plotPct(Math.max.apply(null, spanTimes), win.from, win.to);
        html += '<div class="tl-span" style="left:' + l + '%;width:'
            + spanWidthPct(l, r, axisPx) + '%"></div>';
    }

    marks.forEach(function (mk, mi) {
        var centre = mk.pct / 100 * axisPx;
        var dShift = edgeShift(centre, pileWidth(mk.people.length) / 2, axisPx);
        var tShift = edgeShift(centre, mk.label.length * LABEL_CH / 2, axisPx);
        var dots = mk.people.map(function (g) {
            var i = idxOf(g.id);
            var style = g.dim ? 'background:var(--edge);color:var(--muted)' : 'background:' + partyColor(i < 0 ? 0 : i);
            return '<div class="tl-dot" style="' + style + '">'
                + esc(partyInitials(state.q.parties[i] || { name: name(g.id) }, i < 0 ? 0 : i)) + '</div>';
        }).join('');
        html += '<div class="tl-mark" style="left:' + mk.pct + '%">'
            + '<div class="tl-dots"' + (dShift ? ' style="transform:translateX(' + dShift + 'px)"' : '')
            + '>' + dots + '</div>'
            + (rows[mi] >= 0
                ? '<div class="tl-t mono r' + rows[mi] + '"'
                  + (tShift ? ' style="transform:translateX(' + tShift + 'px)"' : '')
                  + '>' + esc(mk.label) + '</div>'
                : '')
            + '</div>';
    });

    var ticks = dayTicks(win.from, win.to);
    if (ticks.length) {
        html += '<div class="tl-ruler" aria-hidden="true">'
            + ticks.map(function (t) {
                var p = plotPct(t.m, win.from, win.to);
                var sh = edgeShift(p / 100 * axisPx, String(t.label).length * TICK_CH / 2, axisPx);
                return '<div class="tl-rt' + (t.day ? ' day' : '') + '" style="left:' + p + '%">'
                    + '<i></i><span' + (sh ? ' style="transform:translateX(' + sh + 'px)"' : '') + '>'
                    + esc(t.label) + '</span></div>';
            }).join('')
            + '</div>';
    }

    return html + '</div>';
}

/* --- BEGIN flight map ------------------------------------------------ */
/* The picture of the thesis: several origins, one destination, one point.
 *
 * Everything between this marker and the END one below is pure arithmetic
 * over degrees and viewBox units, and test-map.js lifts it into a vm by those
 * two strings. Nothing in here may touch the DOM, the clock, or state.
 *
 * THE PROJECTION, AND WHY IT IS THIS ONE
 *
 * Azimuthal equidistant, centered on the destination. Two properties, and both
 * of them are the product:
 *
 *   - the destination is the origin of the coordinate system, so the thing
 *     everybody converges on is literally the center of the picture;
 *   - from that center bearing is true and radius is true great-circle
 *     distance, so a straight line out of the hub IS the great circle, drawn
 *     to scale, with no seam and no pole to route around.
 *
 * Which means the honest route from any origin to this destination is a
 * straight radial line. The curve drawn below is therefore a stated drawing
 * convention and not a claim about the route -- FM_BOW is one number, applied
 * identically to every traveler, in one rotational sense. Set it to 0 and
 * every path is an exact great circle; nothing else in the layout changes.
 *
 * WHAT IS NOT CLAIMED
 *
 * No coastline, no graticule, no basemap, and no scale bar: the fit rescales
 * each card to its own group, so distances are true against each other and
 * mean nothing against another card. This is a diagram of relative position,
 * not a map of the world. Position is true; the absence of land is not a
 * missing feature.
 */

/* The viewBox. Fixed units rather than pixels, so the collision maths below is
 * resolution-independent and the whole picture scales with the card. 327 is
 * the inner width of a .win card on a 393pt phone, so on the common device one
 * unit is one pixel and the type lands exactly on the 11px step. */
var FM_W = 327;

/* The height is the group's own shape, not a constant.
 *
 * A fixed box fits the cloud to whichever axis runs out first and gives the
 * other one back as white space -- three cities strung across the United
 * States were drawn across the full width of a card that was then half empty
 * top and bottom, which is the single loudest way for a picture to look like
 * it was dropped in rather than designed. The card is as tall as the group is,
 * between a floor that keeps a wide group from becoming a letterbox and a
 * ceiling that stops a north-south group from eating the screen. */
var FM_H_MIN = 132, FM_H_MAX = 208;

/* Markers. An origin is a .tl-dot somewhere else -- same circle, same party
 * color, same white initials, same 2px card-colored ring -- stepped down
 * from 34 because eight of them have to share one small box. The hub is bigger
 * because it is the one thing every path is about, and because the clearance
 * it opens around itself is what keeps eight arriving paths apart. */
var FM_DOT = 28, FM_HUB = 36;

/* Clearance from a marker edge: where a path stops, and how far a label sits
 * off the circle it belongs to. */
var FM_PAD = 4;

/* The shortest run of visible line a route is allowed.
 *
 * True distance alone does not survive a real group. Chicago is 975km from
 * Atlanta and San Francisco is 3,100, so on a card scaled to San Francisco
 * the Chicago route is 33 units long before two markers and their clearance
 * eat 40 of them -- and the route that is the whole point of the picture
 * comes out as a six-pixel dash, or as nothing at all.
 *
 * So there is a floor, and it is a stated one: every origin is at least this
 * far outside the hub, and above the floor distance is true. The floor is in
 * screen units and the fit is rescaled to the group, which means it only ever
 * bites when a group has a wide spread of distances -- a group who are all
 * three hours out gets scaled up until nobody is near it, and the picture
 * stays honest end to end. */
var FM_MIN_LINE = 20;

/* How many times the floor is applied and the fit redone. See fmLayout. */
var FM_FLOOR_PASSES = 8;

/* The label box. Measured, not guessed, and deliberately a shade generous:
 * over-estimating a label costs it a nudge, under-estimating prints it
 * through a face.
 *
 * The timeline's 7px a character does not carry here. That figure was taken
 * on "4:28pm", and these labels are capitals -- ORD measures 8.04 a character
 * at 11px, against 6.89 for MIA. 8.5 covers the widest of them. The interpunct
 * between two codes in one place is barely half a character and is counted as
 * such, because a seven-character label over-estimated by a fifth gives up
 * placements it did not need to.
 *
 * FM_LBL_HALO is the knockout stroke in .fm-code, which is painted outside
 * the glyphs and is part of what has to clear everything else. */
var FM_LBL_H = 16, FM_LBL_CH = 8.5, FM_LBL_HALO = 3, FM_LBL_THIN = 0.55;

function fmLabelW(text) {
    var s = String(text), n = 0;
    for (var i = 0; i < s.length; i++) n += s.charAt(i) === '·' ? FM_LBL_THIN : 1;
    return n * FM_LBL_CH + FM_LBL_HALO;
}

/* Extra room the fit keeps beyond the markers, for the codes hung off them.
 * More above and below than at the sides, because the card is wide and short:
 * a label pushed off the top has nowhere to go, one pushed off the side has
 * the slack the fit leaves when a roughly square group is fitted into a wide
 * box. The vertical figure is a whole label; the horizontal one only has to
 * stop a code starting hard against the edge. */
var FM_PAD_SIDE = 6;

/* Twelve candidate directions, 30 degrees apart, offered in order of how far
 * they are from the one the geometry wants. */
var FM_LBL_DIRS = 12;

/* Sideways bow, as a fraction of the straight-line length. A drawing
 * convention, not data -- see the header. 0 draws exact great circles. */
var FM_BOW = 0.10;

/* What a route is allowed to do about somebody standing in it.
 *
 * Three origins on nearly the same bearing out of the destination -- Seattle,
 * San Francisco and Denver into Atlanta is the ordinary case, not a contrived
 * one -- put one person's marker squarely on another person's route. Drawn
 * straight, San Francisco's line disappears behind Denver and comes out the
 * other side, and the picture now says Denver is a connection on the way.
 * That is a sentence about the itinerary and it is false.
 *
 * The bow is therefore allowed to escalate until the route clears every
 * marker that is not its own. The ladder is tried in order and the first
 * clearance wins, so the house convention is kept wherever it can be: the
 * standard bow, then wider in the same direction, then -- only when nothing
 * on that side works -- the other way round. */
var FM_BOW_LADDER = [1, 1.7, 2.5, 0.45, -1, -1.7, -2.5];

/* A dart, nose at +x, about 11 units long. A drawn airplane silhouette at
 * this size is four gray pixels and a rumour; a dart is the shape every
 * departure board in the world already uses for "going that way", and it
 * stays crisp when the card scales. */
var FM_PLANE = 'M6 0L-5 4.4L-2.6 0L-5-4.4Z';

/* Three passes, then the planes stop. A loop with no end is a loop that is
 * still running in somebody's pocket twenty minutes later.
 *
 * The stagger is per path and deliberately small: the group leaves together
 * on the first pass, which is the thing being said, and drifts apart over
 * the next two, which stops three passes reading as one long one. */
var FM_DUR = 2.4, FM_REPEAT = 3, FM_STAGGER = 0.18;

/* Earth, in km. Only ratios survive the fit, but a real radius keeps the
 * projected numbers readable when something has to be debugged. */
var FM_R = 6371;

var FM_RAD = Math.PI / 180;

/* Azimuthal equidistant about (lat0, lon0).
 *
 * Returns km east and km SOUTH -- y is flipped here rather than at every call
 * site, because the only consumer is a screen where y grows downwards, and a
 * north-up map that flips its own y somewhere else is a map that will one day
 * be upside down.
 *
 * The antipode is the entire outer circle at once and has no single answer; it
 * is placed due north, which is as wrong as any other choice and at least is
 * not NaN. Nobody is flying to the antipode.
 *
 * This is the one piece of spherical geometry in the file and it is the seam:
 * when the shared geo module lands, bearing and central angle come from there
 * and the two lines below go. */
function fmProject(lat, lon, lat0, lon0) {
    var p = lat * FM_RAD, p0 = lat0 * FM_RAD, dl = (lon - lon0) * FM_RAD;
    var cosc = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(dl);
    if (cosc > 1) cosc = 1; else if (cosc < -1) cosc = -1;
    var c = Math.acos(cosc);
    if (c === 0) return { x: 0, y: 0 };
    if (Math.PI - c < 1e-9) return { x: 0, y: -Math.PI * FM_R };
    var br = Math.atan2(Math.cos(p) * Math.sin(dl),
                        Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(dl));
    var r = c * FM_R;
    return { x: r * Math.sin(br), y: -r * Math.cos(br) };
}

/* Fit a point cloud into w by h with padX and padY kept clear on every side.
 *
 * One scale for both axes, because two would stretch the geography, and a
 * stretched azimuthal projection is no longer equidistant in any direction --
 * the one property it was chosen for.
 *
 * An axis with no extent contributes no constraint rather than an infinite
 * one, so three airports in a line still fill the box, and a group all leaving
 * from the same airport lands in the middle at scale 1 instead of dividing by
 * zero. */
function fmFit(pts, w, h, padX, padY) {
    if (padY == null) padY = padX;
    var loX = Infinity, loY = Infinity, hiX = -Infinity, hiY = -Infinity;
    for (var i = 0; i < pts.length; i++) {
        if (pts[i].x < loX) loX = pts[i].x;
        if (pts[i].x > hiX) hiX = pts[i].x;
        if (pts[i].y < loY) loY = pts[i].y;
        if (pts[i].y > hiY) hiY = pts[i].y;
    }
    if (!isFinite(loX)) return { k: 1, ox: w / 2, oy: h / 2 };
    var sx = hiX - loX, sy = hiY - loY;
    var iw = w - 2 * padX, ih = h - 2 * padY;
    var k = Math.min(sx > 0 ? iw / sx : Infinity, sy > 0 ? ih / sy : Infinity);
    if (!isFinite(k) || k <= 0) k = 1;
    return { k: k,
             ox: padX + (iw - sx * k) / 2 - loX * k,
             oy: padY + (ih - sy * k) / 2 - loY * k };
}

function fmAt(fit, p) { return { x: p.x * fit.k + fit.ox, y: p.y * fit.k + fit.oy }; }

/* How tall this group's card should be: the height at which the cloud fills
 * the width exactly, clamped.
 *
 * Below the floor a wide group becomes a letterbox with markers larger than
 * the picture they sit in; above the ceiling a group strung north to south
 * takes more of the screen than any one card on this screen is worth. Inside
 * those two, the card has no dead space in either direction, because the
 * scale that fits the width is also the scale that fits the height. */
function fmHeight(pts, w, padX, padY) {
    var loX = Infinity, loY = Infinity, hiX = -Infinity, hiY = -Infinity;
    for (var i = 0; i < pts.length; i++) {
        if (pts[i].x < loX) loX = pts[i].x;
        if (pts[i].x > hiX) hiX = pts[i].x;
        if (pts[i].y < loY) loY = pts[i].y;
        if (pts[i].y > hiY) hiY = pts[i].y;
    }
    var sx = hiX - loX, sy = hiY - loY;
    if (!isFinite(sx) || sx <= 0) return FM_H_MIN;
    var ih = (w - 2 * padX) * (sy / sx);
    return Math.max(FM_H_MIN, Math.min(FM_H_MAX, Math.round(ih + 2 * padY)));
}

/* Origins landing within one marker of each other are one marker.
 *
 * Straight out of mergeMarks, for the same reason: SFO, OAK and SJC are the
 * same pixel at country scale, and three rings drawn on top of each other are
 * not three people, they are a smudge. They become one node carrying a
 * facepile, exactly the way the timeline draws a landing cluster.
 *
 * Distance is measured from the FIRST member of a group and never from the
 * last, so a straggle of airports cannot chain into one node spanning half the
 * picture. Nearest the hub first, so the crowded middle settles before the
 * outskirts and the answer does not depend on the order people were typed in.
 */
/* ...but only where they really are the same place.
 * 
 * The screen test alone is not enough once the floor is in play. Dublin is
 * 460km from London and Sydney is 17,000; the floor pushes Dublin out to a
 * third of the radius, where it lands on New York, and the card prints one
 * marker reading "JFK\u00b7DUB" -- a shared origin that does not exist. Two
 * airports become one marker only if they are a taxi apart on the ground as
 * well as a pixel apart on the card. 400km covers a metro and its overflow
 * fields -- Oakland with San Francisco, LaGuardia with Boston -- and nothing
 * that is really two different trips. */
var FM_MERGE_KM = 400;

function fmCluster(pts, minDist, maxKm) {
    var order = pts.slice().sort(function (a, b) { return (a.d - b.d) || (a.i - b.i); });
    var out = [];
    for (var i = 0; i < order.length; i++) {
        var p = order[i], hit = null;
        for (var j = 0; j < out.length; j++) {
            var dx = p.x - out[j].seed.x, dy = p.y - out[j].seed.y;
            if (Math.sqrt(dx * dx + dy * dy) >= minDist) continue;
            if (maxKm && p.kx != null && out[j].seed.kx != null) {
                var gx = p.kx - out[j].seed.kx, gy = p.ky - out[j].seed.ky;
                if (Math.sqrt(gx * gx + gy * gy) > maxKm) continue;
            }
            hit = out[j]; break;
        }
        if (hit) hit.members.push(p);
        else out.push({ seed: p, members: [p] });
    }
    for (var m = 0; m < out.length; m++) {
        var g = out[m], sx = 0, sy = 0;
        for (var n = 0; n < g.members.length; n++) { sx += g.members[n].x; sy += g.members[n].y; }
        g.x = sx / g.members.length;
        g.y = sy / g.members.length;
        /* Members are handed back in the order they were given in, not the
         * order they were clustered in, so a facepile reads left to right the
         * way the party list does. */
        g.members.sort(function (a, b) { return a.i - b.i; });
    }
    return out;
}

/* A quadratic Bezier from a to b, bowed sideways by bow of its own length.
 *
 * The normal is taken in one fixed rotational sense for every path, so the
 * whole picture turns the same way instead of each curve picking a side. bow 0
 * is the straight chord, which on this projection is the great circle. */
function fmQuad(a, b, bow) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var len = Math.sqrt(dx * dx + dy * dy);
    var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if (!len) return { p0: { x: a.x, y: a.y }, p1: { x: mx, y: my }, p2: { x: b.x, y: b.y } };
    return { p0: { x: a.x, y: a.y },
             p1: { x: mx + (dy / len) * bow * len, y: my - (dx / len) * bow * len },
             p2: { x: b.x, y: b.y } };
}

function fmQuadAt(q, t) {
    var u = 1 - t;
    return { x: u * u * q.p0.x + 2 * u * t * q.p1.x + t * t * q.p2.x,
             y: u * u * q.p0.y + 2 * u * t * q.p1.y + t * t * q.p2.y };
}

/* Tangent direction in degrees, which is what SVG rotate() wants. The
 * derivative only vanishes on a degenerate curve; there it falls back to the
 * chord rather than returning NaN. */
function fmQuadAngle(q, t) {
    var u = 1 - t;
    var dx = 2 * (u * (q.p1.x - q.p0.x) + t * (q.p2.x - q.p1.x));
    var dy = 2 * (u * (q.p1.y - q.p0.y) + t * (q.p2.y - q.p1.y));
    if (!dx && !dy) { dx = q.p2.x - q.p0.x; dy = q.p2.y - q.p0.y; }
    return Math.atan2(dy, dx) / FM_RAD;
}

/* de Casteljau, twice: the left half at t1, then the right half of that at the
 * rescaled t0. Splitting rather than resampling, so a trimmed path is still
 * one exact curve and the plane runs along the geometry that was drawn rather
 * than along a polyline approximation of it. */
function fmSplitQuad(q, t0, t1) {
    if (!(t1 > t0)) return { p0: q.p0, p1: q.p0, p2: q.p0 };
    var left = function (qq, t) {
        var a = { x: qq.p0.x + (qq.p1.x - qq.p0.x) * t, y: qq.p0.y + (qq.p1.y - qq.p0.y) * t };
        var b = { x: qq.p1.x + (qq.p2.x - qq.p1.x) * t, y: qq.p1.y + (qq.p2.y - qq.p1.y) * t };
        return { p0: qq.p0, p1: a, p2: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t } };
    };
    var right = function (qq, t) {
        var a = { x: qq.p0.x + (qq.p1.x - qq.p0.x) * t, y: qq.p0.y + (qq.p1.y - qq.p0.y) * t };
        var b = { x: qq.p1.x + (qq.p2.x - qq.p1.x) * t, y: qq.p1.y + (qq.p2.y - qq.p1.y) * t };
        return { p0: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, p1: b, p2: qq.p2 };
    };
    return right(left(q, t1), t0 / t1);
}

var FM_SAMPLES = 48;

/* Arc length, and the parameter at a given arc length, from one sampling pass.
 * 48 chords on a curve this shallow is accurate to well under a unit, and the
 * table is built once per path rather than once per query. */
function fmArcTable(q) {
    var pts = [fmQuadAt(q, 0)], cum = [0], prev = pts[0];
    for (var i = 1; i <= FM_SAMPLES; i++) {
        var p = fmQuadAt(q, i / FM_SAMPLES);
        var dx = p.x - prev.x, dy = p.y - prev.y;
        cum.push(cum[i - 1] + Math.sqrt(dx * dx + dy * dy));
        pts.push(p); prev = p;
    }
    return { pts: pts, cum: cum, len: cum[FM_SAMPLES] };
}

function fmTAtLen(tab, want) {
    if (!(want > 0)) return 0;
    if (want >= tab.len) return 1;
    for (var i = 1; i <= FM_SAMPLES; i++) {
        if (tab.cum[i] >= want) {
            var span = tab.cum[i] - tab.cum[i - 1];
            var f = span > 0 ? (want - tab.cum[i - 1]) / span : 0;
            return (i - 1 + f) / FM_SAMPLES;
        }
    }
    return 1;
}

/* Cut dStart off the front and dEnd off the back, so a path leaves the edge of
 * its own avatar and stops at the edge of the hub rather than running
 * underneath both. The clearance at the hub is the whole reason eight paths
 * can meet there and still read as eight paths.
 *
 * A route shorter than the two markers put together has nothing left to draw.
 * It returns null, and the caller draws no line rather than a backwards one. */
function fmTrimQuad(q, dStart, dEnd) {
    var tab = fmArcTable(q);
    if (tab.len <= dStart + dEnd + 1) return null;
    var t0 = fmTAtLen(tab, dStart), t1 = fmTAtLen(tab, tab.len - dEnd);
    if (!(t1 > t0)) return null;
    return fmSplitQuad(q, t0, t1);
}

function fmPathD(q) {
    var r = function (n) { return Math.round(n * 10) / 10; };
    return 'M' + r(q.p0.x) + ' ' + r(q.p0.y)
         + 'Q' + r(q.p1.x) + ' ' + r(q.p1.y) + ' ' + r(q.p2.x) + ' ' + r(q.p2.y);
}

/* ---- collision primitives ---- */

/* Overlapping area of two boxes. Area rather than a boolean, because the
 * scoring below has to prefer a label that clips a corner over one that sits
 * squarely on another label, and a boolean cannot tell those apart. */
function fmOverlap(a, b) {
    var w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    var h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    return (w > 0 && h > 0) ? w * h : 0;
}

function fmBoxArea(b) { return Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0); }

/* How much of a box is off the card. */
function fmOutside(b, w, h) {
    return fmBoxArea(b) - fmOverlap(b, { x0: 0, y0: 0, x1: w, y1: h });
}

/* Does a segment touch a box. Liang-Barsky, so a segment that passes clean
 * through with neither end inside still counts -- which is exactly the bug in
 * the mockup, where a label sat in clear space and its own flight path went
 * straight through the middle of it. */
function fmSegBox(ax, ay, bx, by, box) {
    var t0 = 0, t1 = 1, dx = bx - ax, dy = by - ay;
    var p = [-dx, dx, -dy, dy];
    var qv = [ax - box.x0, box.x1 - ax, ay - box.y0, box.y1 - ay];
    for (var i = 0; i < 4; i++) {
        if (p[i] === 0) { if (qv[i] < 0) return false; continue; }
        var r = qv[i] / p[i];
        if (p[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
        else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
    return true;
}

/* How far a point is from a box, and from a segment. The two halves of the
 * next one. */
function fmPtBoxDist(px, py, b) {
    var dx = Math.max(b.x0 - px, 0, px - b.x1);
    var dy = Math.max(b.y0 - py, 0, py - b.y1);
    return Math.sqrt(dx * dx + dy * dy);
}

function fmPtSegDist(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    var t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    var qx = ax + t * dx, qy = ay + t * dy;
    return Math.sqrt(Math.pow(px - qx, 2) + Math.pow(py - qy, 2));
}

/* The gap between a marker and a box, where the marker is the capsule it is
 * actually painted as rather than the square drawn round it.
 *
 * The square is what the first version tested, and it cost real placements:
 * a code tucked into the empty corner outside a round face was scored as
 * sitting on top of it, and the label went somewhere worse. Negative is an
 * overlap, and the number is how deep. */
function fmMarkerBoxGap(node, box) {
    var ex = Math.max(0, (node.hitR || node.r) - node.r);
    var d = (fmSegBox(node.x - ex, node.y, node.x + ex, node.y, box))
        ? 0
        : Math.min(fmPtBoxDist(node.x - ex, node.y, box), fmPtBoxDist(node.x + ex, node.y, box),
                   fmPtSegDist(box.x0, box.y0, node.x - ex, node.y, node.x + ex, node.y),
                   fmPtSegDist(box.x1, box.y0, node.x - ex, node.y, node.x + ex, node.y),
                   fmPtSegDist(box.x1, box.y1, node.x - ex, node.y, node.x + ex, node.y),
                   fmPtSegDist(box.x0, box.y1, node.x - ex, node.y, node.x + ex, node.y));
    return d - node.r;
}

/* ---- label placement ---- */

/* Candidate directions for one label, in order of preference.
 *
 * The first is radially outward from the hub, and that one placement is why a
 * label cannot be struck through by its own flight path: the path reaches the
 * marker from the hub side, so the far side of the marker is the one side the
 * path is never on. Every other candidate is a concession, offered
 * nearest-first, so a label only ever moves as far as it has to. */
function fmLabelDirs(node, hub) {
    var dx = node.x - hub.x, dy = node.y - hub.y;
    var a0 = (dx || dy) ? Math.atan2(dy, dx) : -Math.PI / 2;
    var step = 2 * Math.PI / FM_LBL_DIRS, out = [a0];
    for (var s = 1; s <= FM_LBL_DIRS / 2; s++) {
        out.push(a0 + s * step);
        if (s < FM_LBL_DIRS / 2) out.push(a0 - s * step);
    }
    return out;
}

/* The box for a label at angle a off a marker of radius r.
 *
 * Offset by the radius plus the box's own support width in that direction,
 * which is the exact distance at which an axis-aligned box of this size first
 * clears a circle of that radius. A label set diagonally therefore sits as
 * close as one set square, and neither one touches the ring. */
function fmLabelBox(node, a, text, push) {
    var w = fmLabelW(text), h = FM_LBL_H;
    /* A node carrying a facepile is a capsule, not a circle: its support in a
     * direction picks up the half-length of the pile as well as the radius.
     * Without this, the label for a two-person marker was placed off the
     * middle of the pile and landed on the second face. */
    var ex = Math.max(0, (node.hitR || node.r) - node.r);
    var off = node.r + Math.abs(Math.cos(a)) * ex + FM_PAD + (push || 0)
            + (Math.abs(Math.cos(a)) * w + Math.abs(Math.sin(a)) * h) / 2;
    var cx = node.x + Math.cos(a) * off, cy = node.y + Math.sin(a) * off;
    return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2,
             cx: cx, cy: cy, a: a, push: push || 0 };
}

/* What a candidate costs, normalized by the label's own area so a long code
 * and a short one are scored on the same scale.
 *
 * The weights are an ordering, not a tuning. Being cut off by the edge of the
 * card is worse than sitting on another label, which is worse than sitting on
 * somebody's face, which is worse than being crossed by a line, which is worse
 * than pointing the wrong way. Each step is a clear multiple of the next so
 * the order cannot be reversed by a rounding difference. */
var FM_PEN_EDGE = 80, FM_PEN_LBL = 40, FM_PEN_DOT = 20, FM_PEN_PATH = 10, FM_PEN_TURN = 4;

/* Twelve directions at one distance is not always twelve openings. A marker
 * with people on three sides of it and a route on the fourth has nowhere to
 * put its code at arm's length, and the least-bad answer at that distance
 * was a label painted underneath somebody's face -- invisible, which is
 * worse than the collision it was avoiding.
 *
 * So each direction is also offered further out. Reaching costs a little,
 * so a label still sits close when close is clear, and a leader line is not
 * needed because the furthest rung is barely a marker's width away -- past
 * that the label stops belonging to anything. */
var FM_LBL_PUSH = [0, 10, 20], FM_PEN_PUSH = 0.12;

/* When even the furthest rung is this bad, the code is dropped. The face is
 * still there, it is still that party's color and initials, and the city
 * is written out in words on that person's own card below. A label nobody
 * can read is not information, it is a defect that costs ink. */
var FM_LBL_GIVE_UP = 6;

function fmLabelCost(box, ctx) {
    var area = fmBoxArea(box) || 1, pen = 0, i;
    pen += FM_PEN_EDGE * fmOutside(box, ctx.w, ctx.h) / area;
    for (i = 0; i < ctx.labels.length; i++) pen += FM_PEN_LBL * fmOverlap(box, ctx.labels[i]) / area;
    for (i = 0; i < ctx.dots.length; i++) {
        /* Its own marker is skipped: fmLabelBox has already offset the box
         * clear of it, and charging it for its own circle would only pick
         * between directions on rounding noise. */
        if (i === ctx.self) continue;
        var gap = fmMarkerBoxGap(ctx.dots[i], box);
        if (gap < 0) pen += FM_PEN_DOT * Math.min(1, -gap / ctx.dots[i].r);
    }
    for (i = 0; i < ctx.segs.length; i++) {
        var s = ctx.segs[i];
        if (fmSegBox(s[0], s[1], s[2], s[3], box)) { pen += FM_PEN_PATH; break; }
    }
    var turn = Math.abs(((box.a - ctx.ideal + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
    pen += FM_PEN_TURN * turn / Math.PI;
    pen += FM_PEN_PUSH * (box.push || 0);
    return pen;
}

/* Place every label. Nodes nearest the hub go first: they have the fewest
 * directions that are not already somebody's path or somebody's face, so they
 * get to choose while there is still something to choose from. */
function fmPlaceLabels(nodes, hub, segs, w, h) {
    /* The things a label must not be painted over, as the capsules they are
     * drawn as. The hub is one of them: it is round, it is in the middle,
     * and it is the last thing on the card that should be covered. */
    var dots = nodes.map(function (n) {
        return { x: n.x, y: n.y, r: n.r, hitR: n.hitR || n.r };
    });
    dots.push({ x: hub.x, y: hub.y, r: hub.r, hitR: hub.r });

    var order = nodes.map(function (n, i) { return i; }).sort(function (a, b) {
        var da = Math.pow(nodes[a].x - hub.x, 2) + Math.pow(nodes[a].y - hub.y, 2);
        var db = Math.pow(nodes[b].x - hub.x, 2) + Math.pow(nodes[b].y - hub.y, 2);
        return (da - db) || (a - b);
    });

    var placed = [], out = new Array(nodes.length);
    for (var oi = 0; oi < order.length; oi++) {
        var i = order[oi], n = nodes[i];
        var dirs = fmLabelDirs(n, hub);
        var ctx = { w: w, h: h, labels: placed, dots: dots, segs: segs, ideal: dirs[0], self: i };
        var best = null, bestCost = Infinity;
        for (var d = 0; d < dirs.length; d++) {
            for (var u = 0; u < FM_LBL_PUSH.length; u++) {
                var box = fmLabelBox(n, dirs[d], n.label, FM_LBL_PUSH[u]);
                var c = fmLabelCost(box, ctx);
                if (c < bestCost - 1e-9) { bestCost = c; best = box; }
            }
        }
        /* The last millimeter, and only the last millimeter. FM_PEN_EDGE
         * has already made a clipped label expensive, so anything that
         * reaches here is off the card by a fraction of a unit -- the half
         * a unit of knockout stroke on the first letter of a code, which
         * reads as a nicked glyph. It is slid back on rather than left
         * nicked, because the alternative placements were all worse for
         * reasons that have not gone away. */
        if (best) {
            var sx = Math.max(0, -best.x0) - Math.max(0, best.x1 - w);
            var sy = Math.max(0, -best.y0) - Math.max(0, best.y1 - h);
            if (sx || sy) {
                best.x0 += sx; best.x1 += sx; best.cx += sx;
                best.y0 += sy; best.y1 += sy; best.cy += sy;
            }
        }
        var drop = bestCost > FM_LBL_GIVE_UP;
        /* A dropped label is not reserved space: the next node may use it. */
        if (!drop) placed.push(best);
        out[i] = { x: best.cx, y: best.cy, cost: bestCost, box: best, drop: drop };
    }
    return out;
}

/* How wide a marker really is once the people on it are drawn.
 *
 * One person is the circle. Two or three are a facepile, laid out the way
 * .tl-dots lays one out -- overlapped by FM_LAP of a diameter, centered on the
 * node -- so the thing a route has to miss is a capsule, and its half-length
 * is what counts as the radius for clearance. */
var FM_LAP = 0.3, FM_PILE_MAX = 3;

function fmPileR(count, r) {
    var m = Math.min(count, FM_PILE_MAX);
    return r + (m - 1) * (2 * r) * (1 - FM_LAP) / 2;
}

/* The closest a curve comes to a point, sampled. Sampling rather than solving:
 * the exact minimum distance from a point to a quadratic is a cubic root
 * find, the answer is only ever compared against a threshold, and 24 samples
 * on a curve this shallow are wrong by well under the 4 units of clearance
 * being tested for. */
var FM_CLEAR_SAMPLES = 24;

function fmClearance(q, px, py) {
    var best = Infinity;
    for (var i = 0; i <= FM_CLEAR_SAMPLES; i++) {
        var p = fmQuadAt(q, i / FM_CLEAR_SAMPLES);
        var d = Math.sqrt(Math.pow(p.x - px, 2) + Math.pow(p.y - py, 2));
        if (d < best) best = d;
    }
    return best;
}

/* Pick the bow for one route: the first rung of the ladder that clears every
 * other marker, or failing that the rung that comes closest to clearing.
 *
 * "Clears" is measured against the pile radius plus the standard clearance,
 * so a route passes outside a face rather than grazing its ring. The node's
 * own marker and the hub are not in the test -- the route is supposed to
 * touch those two, that is what a route is. */
function fmPickBow(node, ni, nodes, hub, base) {
    if (!base) return 0;
    var best = null, bestSlack = -Infinity;
    for (var li = 0; li < FM_BOW_LADDER.length; li++) {
        var q = fmQuad(node, hub, base * FM_BOW_LADDER[li]);
        var slack = Infinity;
        for (var j = 0; j < nodes.length; j++) {
            if (j === ni) continue;
            var need = nodes[j].hitR + FM_PAD;
            var s = fmClearance(q, nodes[j].x, nodes[j].y) - need;
            if (s < slack) slack = s;
        }
        if (slack >= 0) return base * FM_BOW_LADDER[li];
        if (slack > bestSlack) { bestSlack = slack; best = base * FM_BOW_LADDER[li]; }
    }
    return best;
}

/* How far out a marker can go in its own direction and still fit the card. */
function fmReachR(node, hub, w, h, padX, padY) {
    var ux = node.x - hub.x, uy = node.y - hub.y;
    var len = Math.sqrt(ux * ux + uy * uy);
    if (!len) return 0;
    ux /= len; uy /= len;
    var lim = Infinity, t;
    if (ux > 1e-9) { t = (w - padX - hub.x) / ux; if (t < lim) lim = t; }
    if (ux < -1e-9) { t = (padX - hub.x) / ux; if (t < lim) lim = t; }
    if (uy > 1e-9) { t = (h - padY - hub.y) / uy; if (t < lim) lim = t; }
    if (uy < -1e-9) { t = (padY - hub.y) / uy; if (t < lim) lim = t; }
    return Math.max(0, lim);
}

/* Markers that are not the same place must not sit on top of each other.
 *
 * Two origins on the same bearing at different distances is the case the
 * floor makes worse rather than better: Dublin lifted to the floor lands
 * where New York already is, and the card shows one face half-hidden behind
 * another with no way to tell there are two.
 *
 * Separation is bought from distance and never from bearing. Which way a
 * person is coming from is the one thing this picture gets exactly right, and
 * it is the one thing that is never traded; how far out they sit has already
 * been compromised by the floor, so it is the axis that gives. The inner
 * marker moves in, the outer moves out, each along its own radius, and
 * neither goes inside the floor or off the card. Where both ends are pinned
 * the overlap stands, because the alternative is a picture that lies about
 * which direction somebody is flying in from. */
var FM_SPREAD_PASSES = 8, FM_SPREAD_EPS = 0.05;

function fmSpread(nodes, hub, floorR, reach) {
    function rad(n) { return Math.sqrt(Math.pow(n.x - hub.x, 2) + Math.pow(n.y - hub.y, 2)); }
    function setRad(n, r) {
        var cur = rad(n);
        if (!cur) return;
        n.x = hub.x + (n.x - hub.x) / cur * r;
        n.y = hub.y + (n.y - hub.y) / cur * r;
    }
    for (var pass = 0; pass < FM_SPREAD_PASSES; pass++) {
        var moved = false;
        for (var i = 0; i < nodes.length; i++) {
            for (var j = i + 1; j < nodes.length; j++) {
                var a = nodes[i], b = nodes[j];
                var need = a.hitR + b.hitR + FM_PAD;
                var d = Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
                /* Each push is shared between two markers moving along two
                 * different radii, so the separation gained is less than
                 * the distance moved and the pair converges on the target
                 * rather than reaching it. Stop a twentieth of a unit
                 * short, which is a fifth of a device pixel, instead of
                 * spending every pass chasing it. */
                if (d >= need - FM_SPREAD_EPS) continue;
                var ra = rad(a), rb = rad(b);
                /* Which one goes inward is settled on the ground, not on
                 * the card. Once the floor has lifted two origins to the
                 * same radius, moving whichever happens to be drawn a
                 * fraction nearer can put the long-haul traveler inside
                 * the short-haul one -- the card then states an order that
                 * is the reverse of the truth. */
                var aIn = (a.km != null && b.km != null && a.km !== b.km)
                    ? a.km < b.km : ra <= rb;
                var inner = aIn ? a : b, outer = aIn ? b : a;
                var ri = rad(inner), ro = rad(outer);
                /* Split the deficit, but only between the two that can
                 * actually move. With a strict half each, a marker already
                 * sitting on the floor pinned half of every correction to
                 * nothing and the pair crept towards clearance without ever
                 * arriving -- eight passes still left them a third of a unit
                 * short. Whatever one end cannot take, the other does. */
                var deficit = need - d;
                var roomIn = Math.max(0, ri - floorR);
                var roomOut = Math.max(0, reach(outer) - ro);
                var gotIn = Math.min(deficit / 2, roomIn);
                var gotOut = Math.min(deficit - gotIn, roomOut);
                gotIn = Math.min(deficit - gotOut, roomIn);
                if (gotIn <= 0.01 && gotOut <= 0.01) continue;
                setRad(inner, ri - gotIn);
                setRad(outer, ro + gotOut);
                moved = true;
            }
        }
        if (!moved) break;
    }
}

/* ---- the whole layout ---- */

/* dest is {code, lat, lon}; origins are {id, code, lat, lon, color, initials}.
 *
 * Returns plain data and nothing else. Nothing in here knows what an SVG is,
 * which is what lets the suite assert that no label leaves the card and no
 * path crosses a label without rendering a single element. */
function fmLayout(dest, origins, opts) {
    opts = opts || {};
    var w = opts.w || FM_W, h = opts.h || 0;
    var bow = opts.bow == null ? FM_BOW : opts.bow;
    var dotR = (opts.dot || FM_DOT) / 2, hubR = (opts.hub || FM_HUB) / 2;

    if (!dest || !isFinite(dest.lat) || !isFinite(dest.lon)) return null;
    var usable = (origins || []).filter(function (o) {
        return o && isFinite(o.lat) && isFinite(o.lon)
            && String(o.code).toUpperCase() !== String(dest.code).toUpperCase();
    });
    /* One origin is a line, not a convergence, and there is nothing in it a
     * reader does not already have on that person's own card. */
    if (usable.length < 2) return null;

    var raw = usable.map(function (o, i) {
        var p = fmProject(o.lat, o.lon, dest.lat, dest.lon);
        return { i: i, x: p.x, y: p.y, d: Math.sqrt(p.x * p.x + p.y * p.y), o: o };
    });

    /* Room for a marker and the code hung off it. See FM_PAD_SIDE. */
    var padX = Math.max(dotR, hubR) + FM_PAD + FM_PAD_SIDE;
    var padY = Math.max(dotR, hubR) + FM_PAD + FM_LBL_H;

    /* The hub joins the cloud being fitted, always: a group all on one side of
     * the destination would otherwise fit itself neatly and push the
     * destination off the card. */
    var cloud = raw.concat([{ x: 0, y: 0 }]);
    if (!h) h = fmHeight(cloud, w, padX, padY);

    /* The floor, applied in the projection and then refitted, because the
     * floor is a number of screen units and the scale is a consequence of the
     * cloud the floor just changed. Pushing an origin out shrinks the scale,
     * which lowers the projected distance the floor is worth, which can push
     * it out again -- so it is iterated rather than solved. It converges
     * geometrically: one pass leaves the nearest marker six units inside its
     * own floor, eight leaves it a hundredth of one. The count is a
     * convergence budget and not a guess.
     *
     * The last thing done is a lift and not a fit. Lift-then-fit always ends
     * one step behind itself -- the points were lifted against the scale
     * before the one that is about to be used -- and the card came out with
     * its nearest marker a quarter of a unit inside its own floor no matter
     * how many passes it was given. The final lift moves points outward by a
     * fraction of a unit into padding that is twenty wide, so nothing can
     * leave the card by doing it. */
    var floorScreen = dotR + hubR + 2 * FM_PAD + FM_MIN_LINE;
    var kept = raw.map(function (p) { return { i: p.i, x: p.x, y: p.y, d: p.d, o: p.o }; });
    var lift = function (k) {
        var floorProj = floorScreen / k, moved = false;
        for (var ri = 0; ri < kept.length; ri++) {
            var p0 = raw[ri];
            if (p0.d > 0 && p0.d < floorProj) {
                kept[ri].x = p0.x / p0.d * floorProj;
                kept[ri].y = p0.y / p0.d * floorProj;
                kept[ri].d = floorProj;
                moved = true;
            }
        }
        return moved;
    };
    var fit = fmFit(cloud, w, h, padX, padY);
    for (var pass = 0; pass < FM_FLOOR_PASSES; pass++) {
        if (!lift(fit.k)) break;
        var lifted = kept.concat([{ x: 0, y: 0 }]);
        if (!opts.h) h = fmHeight(lifted, w, padX, padY);
        fit = fmFit(lifted, w, h, padX, padY);
    }
    lift(fit.k);

    var hub = fmAt(fit, { x: 0, y: 0 });
    hub.r = hubR;
    hub.code = String(dest.code || '').toUpperCase();

    var screen = kept.map(function (p, ki) {
        var s = fmAt(fit, p);
        /* The projection in km travels with the point, because whether two
         * markers are one place is a question about the ground and not about
         * where the floor happened to put them. */
        return { i: p.i, x: s.x, y: s.y, o: p.o, kx: raw[ki].x, ky: raw[ki].y,
                 d: Math.sqrt(Math.pow(s.x - hub.x, 2) + Math.pow(s.y - hub.y, 2)) };
    });

    var nodes = fmCluster(screen, dotR * 2, FM_MERGE_KM).map(function (g) {
        var codes = [], seen = {};
        g.members.forEach(function (m) {
            var c = String(m.o.code).toUpperCase();
            if (!seen[c]) { seen[c] = 1; codes.push(c); }
        });
        var km = Infinity;
        g.members.forEach(function (m) {
            var t = Math.sqrt(m.kx * m.kx + m.ky * m.ky);
            if (t < km) km = t;
        });
        return { x: g.x, y: g.y, r: dotR, km: km,
                 people: g.members.map(function (m) { return m.o; }),
                 codes: codes,
                 /* Two airports in one place are still two airports and the
                  * reader is owed both -- but only the first two, because a
                  * third turns the shortest label on the card into the
                  * longest. */
                 label: codes.slice(0, 2).join('·') + (codes.length > 2 ? '+' : '') };
    });

    /* Everybody leaving from one place is one marker, and one marker is not a
     * convergence. The traveler cards below already say where each of them
     * is starting from, and they say it in words. */
    if (nodes.length < 2) return null;

    /* How much room a node actually takes. A facepile is wider than the
     * circle at its center, and a route that clears the center circle can
     * still go straight through the second face. */
    nodes.forEach(function (n) { n.hitR = fmPileR(n.people.length, n.r); });

    fmSpread(nodes, hub, floorScreen, function (n) {
        return fmReachR(n, hub, w, h, padX, padY);
    });

    var paths = [], segs = [];
    nodes.forEach(function (n, ni) {
        var q = fmTrimQuad(fmQuad(n, hub, fmPickBow(n, ni, nodes, hub, bow)),
                           n.r + FM_PAD, hub.r + FM_PAD);
        n.path = null;
        if (!q) return;
        var mid = fmQuadAt(q, 0.5);
        paths.push({ node: ni, q: q, d: fmPathD(q),
                     /* One color per path, and it is the color of the only
                      * person on it. A shared marker is several people leaving
                      * one place on one airplane-shaped line, so that line is
                      * drawn in ink rather than in one of their colors. */
                     color: n.people.length === 1 ? n.people[0].color : null,
                     mid: { x: mid.x, y: mid.y, a: fmQuadAngle(q, 0.5) } });
        var tab = fmArcTable(q);
        for (var s = 0; s < FM_SAMPLES; s += 4) {
            segs.push([tab.pts[s].x, tab.pts[s].y, tab.pts[s + 4].x, tab.pts[s + 4].y]);
        }
        n.path = paths.length - 1;
    });

    var labels = fmPlaceLabels(nodes, hub, segs, w, h);
    nodes.forEach(function (n, i) {
        n.lx = labels[i].x; n.ly = labels[i].y;
        n.lbox = labels[i].box; n.lcost = labels[i].cost; n.ldrop = labels[i].drop;
    });

    return { w: w, h: h, hub: hub, nodes: nodes, paths: paths, segs: segs };
}

/* The layout, as markup. Still pure: a string in, a string out, no DOM and
 * no state, so the suite can assert what the card does and does not contain
 * -- most usefully that a reduced-motion render carries no animation at all
 * rather than an animation somebody has to remember to switch off.
 *
 * Paint order is the argument of the picture: routes, then planes, then
 * codes, then faces, then the destination. Everything is drawn over the
 * thing it is about, and a face is never the thing that gets covered. */
function fmSvg(lay, opts) {
    opts = opts || {};
    var reduce = !!opts.reduce;
    var svg = '<svg class="fmap" viewBox="0 0 ' + lay.w + ' ' + lay.h + '" '
        + 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        + 'role="img" aria-label="' + esc(opts.aria || '') + '">';

    /* Routes first, so everything else is drawn over them. */
    lay.paths.forEach(function (p, i) {
        svg += '<path id="fmr' + i + '" class="fm-route" d="' + p.d + '"'
            + (p.color ? ' style="stroke:' + esc(p.color) + '"' : '') + '/>';
    });

    lay.paths.forEach(function (p, i) {
        var rest = 'translate(' + p.mid.x.toFixed(1) + ' ' + p.mid.y.toFixed(1)
            + ') rotate(' + p.mid.a.toFixed(1) + ')';
        var fill = p.color ? ' style="fill:' + esc(p.color) + '"' : '';
        if (reduce) {
            svg += '<g class="fm-plane" transform="' + rest + '">'
                + '<path d="' + FM_PLANE + '"' + fill + '/></g>';
        } else {
            /* No authored transform while the motion is running, because
             * animateMotion adds its transform to the element's own and the
             * plane would be offset twice. The resting place is parked in a
             * data attribute and put on only when the animation is taken off.
             *
             * begin is 0 for the same reason: with a delay the plane would
             * render at the SVG's origin, in the top left corner, until the
             * animation started. The durations differ slightly so the group
             * leaves together on the first pass and drifts apart after, which
             * is both prettier and what actually happens.
             *
             * .fm-wait hides it until fmAnimate lets the clock run. A paused
             * SMIL animation is a transform that has not been sampled yet, so
             * a plane on a card below the fold sat visibly in the corner of
             * the picture until the reader scrolled to it. */
            svg += '<g class="fm-plane fm-wait" data-rest="' + rest + '">'
                + '<path d="' + FM_PLANE + '"' + fill + '/>'
                + '<animateMotion dur="' + (FM_DUR + i * FM_STAGGER).toFixed(2) + 's" begin="0s"'
                + ' repeatCount="' + FM_REPEAT + '" rotate="auto" calcMode="linear">'
                + '<mpath href="#fmr' + i + '" xlink:href="#fmr' + i + '"/>'
                + '</animateMotion></g>';
        }
    });

    /* Codes over the routes, with a card-colored halo under the glyphs:
     * fmPlaceLabels has already moved every label off every path, and this is
     * what makes the one case it cannot solve legible instead of struck
     * through. */
    lay.nodes.forEach(function (n) {
        if (n.ldrop) return;
        svg += '<text class="fm-code" x="' + n.lx.toFixed(1) + '" y="' + n.ly.toFixed(1)
            + '" dy=".35em">' + esc(n.label) + '</text>';
    });

    /* People on top, because a face is never the thing that should be
     * covered. A node carrying more than one person is a facepile, overlapped
     * the way .tl-dots overlaps, earliest on top. */
    lay.nodes.forEach(function (n) {
        var ppl = n.people.slice(0, FM_PILE_MAX);
        var span = (ppl.length - 1) * (n.r * 2) * (1 - FM_LAP);
        svg += '<g class="fm-dots">';
        for (var k = ppl.length - 1; k >= 0; k--) {
            var cx = n.x - span / 2 + k * (n.r * 2) * (1 - FM_LAP);
            svg += '<circle class="fm-dot" cx="' + cx.toFixed(1) + '" cy="' + n.y.toFixed(1)
                + '" r="' + n.r + '" style="fill:' + esc(ppl[k].color) + '"/>'
                + '<text class="fm-ini" x="' + cx.toFixed(1) + '" y="' + n.y.toFixed(1)
                + '" dy=".35em">' + esc(ppl[k].initials) + '</text>';
        }
        svg += '</g>';
    });

    svg += '<circle class="fm-hub" cx="' + lay.hub.x.toFixed(1) + '" cy="' + lay.hub.y.toFixed(1)
        + '" r="' + lay.hub.r + '"/>'
        + '<text class="fm-hub-t" x="' + lay.hub.x.toFixed(1) + '" y="' + lay.hub.y.toFixed(1)
        + '" dy=".35em">' + esc(lay.hub.code) + '</text>';

    return svg + '</svg>';
}

/* --- END flight map -------------------------------------------------- */

/* ------------------------------------------------------------ flight map */
/* The impure half: where the origins come from, and what the planes do.
 * Everything that is arithmetic is above, between the landmark comments. */

/* Who is on the map, and where they are leaving from.
 *
 * An airport the coordinate table has never heard of drops that person off
 * the picture and off it only -- their own card below still carries their
 * flights, their fare and their Book button. A map that omits one person is a
 * worse map; a map that puts them at latitude NaN is a broken card, and a
 * broken card loses the other seven as well. */
function fmOrigins(leg) {
    var rows = (leg && leg.rows) || {};
    return C.ids.map(function (id) {
        var t = C.travelers.filter(function (x) { return x.id === id; })[0];
        if (!t) return null;
        var i = state.q.parties.map(function (p) { return p.id; }).indexOf(id);
        var r = rows[id];
        /* The airport they were actually given, not the first one they typed:
         * somebody who offered SFO, OAK and SJC is flying out of exactly one
         * of them and the picture should say which. */
        var code = (r && r.option && r.option.from) || t.origins[0] || '';
        if (!code) return null;
        var g = AIRPORTS_GEO.get(code);
        if (!g) return null;
        return { id: id, code: String(code).toUpperCase(), lat: g.lat, lon: g.lon,
                 color: partyColor(i < 0 ? 0 : i),
                 initials: partyInitials(state.q.parties[i] || { name: t.name }, i < 0 ? 0 : i) };
    }).filter(Boolean);
}

/* The card. Returns '' rather than an empty frame whenever there is nothing
 * to converge -- no geo table, one origin, or a destination nobody has
 * coordinates for. A map with one line on it is not this product. */
function flightMap(leg) {
    if (typeof AIRPORTS_GEO === 'undefined' || !AIRPORTS_GEO || !AIRPORTS_GEO.get) return '';
    if (!state.q || !state.q.dest || !C) return '';
    var dg = AIRPORTS_GEO.get(state.q.dest);
    if (!dg) return '';

    var lay = fmLayout({ code: state.q.dest, lat: dg.lat, lon: dg.lon }, fmOrigins(leg));
    if (!lay) return '';

    var dest = AIRPORTS.get(state.q.dest);
    return '<div class="win fmap-win">' + fmSvg(lay, {
        /* The one sentence on this card, and it is only ever heard. */
        aria: lay.nodes.map(function (n) { return n.codes.join(' and '); }).join(', ')
            + ' to ' + (dest ? dest.city : lay.hub.code),
        reduce: !!(window.matchMedia
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    }) + '</div>';
}

/* Which leg the picture is of. Outbound: the product is the arrival, and the
 * arrival is the leg everybody is converging ON. The way home is the same
 * picture with the arrows reversed, which is a second card saying the first
 * one backwards. */
function flightMapCard() {
    return flightMap(TRIP && TRIP.legOut);
}

/* Start paused, run while the card is on screen, stop for good after
 * FM_REPEAT passes. Three separate claims, because "does not burn battery"
 * fails in three separate ways: animating below the fold, animating in a
 * backgrounded tab, and animating until the page is closed. */
function fmAnimate(host) {
    var svg = host && host.querySelector && host.querySelector('svg.fmap');
    if (!svg) return;
    var anims = svg.querySelectorAll('animateMotion');
    if (!anims.length) return;

    var io = null, done = false;
    /* One place that lets the clock run, so "paused" and "hidden" can
     * never disagree: the planes are invisible until the first frame has
     * actually been sampled. */
    function run() {
        svg.unpauseAnimations();
        var w = svg.querySelectorAll(".fm-wait");
        for (var i = 0; i < w.length; i++) w[i].classList.remove("fm-wait");
    }
    function settle() {
        if (done) return;
        done = true;
        for (var i = 0; i < anims.length; i++) {
            var g = anims[i].parentNode;
            if (!g) continue;
            g.setAttribute('transform', g.getAttribute('data-rest') || '');
            g.removeChild(anims[i]);
        }
        run();
        if (io) io.disconnect();
        document.removeEventListener('visibilitychange', onHide);
    }
    function onHide() {
        if (done) return;
        if (document.hidden) svg.pauseAnimations();
        else if (svg.getAttribute('data-seen') === '1') run();
    }

    var left = anims.length;
    for (var i = 0; i < anims.length; i++) {
        anims[i].addEventListener('endEvent', function () { if (--left <= 0) settle(); });
    }
    /* A backstop, because endEvent is the one thing here that is a browser
     * promise rather than our own arithmetic. Generous enough that it never
     * cuts a real run short, including a run that spent time paused. */
    setTimeout(settle, (FM_DUR + anims.length * FM_STAGGER) * FM_REPEAT * 1000 + 20000);

    svg.pauseAnimations();
    document.addEventListener('visibilitychange', onHide);
    if (window.IntersectionObserver) {
        io = new IntersectionObserver(function (es) {
            es.forEach(function (e) {
                svg.setAttribute('data-seen', e.isIntersecting ? '1' : '0');
                if (done) return;
                if (e.isIntersecting && !document.hidden) run();
                else svg.pauseAnimations();
            });
        }, { threshold: 0.25 });
        io.observe(svg);
    } else {
        svg.setAttribute('data-seen', '1');
        run();
    }
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

        /* The banner is polite -- second visit onward, and silent for a
         * fortnight once dismissed -- which is right, and means somebody who
         * waved it away and later wanted it has nowhere to go. Here is where
         * they look. Hidden once the app is installed, because then it is an
         * instruction for something already done. */
        + (installable()
            ? '<div class="grp"><span class="k">On your phone</span><div class="pills">'
              + '<button class="pill" data-showinstall="1">Add to Home Screen</button>'
              + '</div><div class="tip">Opens full screen, with no address bar, and keeps '
              + 'your group between trips.</div></div>'
            : '')

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
    if (tgt.closest('#gearBtn')) { settingsSheet(); return; }
    /* Both read their party id back out of the markup, so both are validated
     * against the roster rather than trusted -- data-* attributes are the one
     * place a rendering bug turns into a request for somebody else's row. */

    var me = tgt.closest && tgt.closest('[data-me]');
    if (me) {
        var pick = me.getAttribute('data-me');
        if (partyIds().indexOf(pick) > -1) { SET.meId = pick; saveSet(); renderGear(); render(); }
        return;
    }
    if (tgt.closest('[data-showinstall]')) { closeSheet(); showInstall(); return; }
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
        + '[data-rmparty],[data-addair],[data-rmair],[data-air],'
        + '[data-air-clear]');
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
    } else if (t.hasAttribute('data-air-clear')) {
        state.q.avoid = [];
        thReset(); writeHash(); render();
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

    /* Two states, not three, and neither is a restatement: which END you are
     * picking is the one thing this footer knows that nothing else on the
     * screen does. The third state used to repeat the range the trigger button
     * directly above already shows, which at 393px spilled onto three lines and
     * pushed the footer taller than the row of actions. */
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
        /* Secondary. Done dismisses a picker; the primary action on step 2 is
         * the button that moves the flow on, and that one sits about fifteen
         * pixels below this one. Two filled buttons that close together means
         * neither is the primary -- the same complaint .cal-clear above was
         * already rewritten for, one level up. */
        + '<button class="btn" data-cal="done">Done</button></span></div>';
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
    /* An action, not the heading restated. "When?" is directly above it. */
    if (!state.q.dep) { b.className = 'datefield empty'; l.textContent = 'Add dates'; return; }
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
    TRIP_ID = null;
    /* basePath, not pathname: leaving /t/<id> in the address bar would mean a
     * reload re-opened the trip somebody had just closed. */
    history.replaceState(null, '', basePath());
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

/* ----------------------------------------------------------------- boot */

SET = loadSet();

var sharedId = tripIdFromUrl();
var shared = readHash();
/* A shared link carries its own cast and always wins -- opening somebody else's
 * trip must show their group, not yours. Failing that, the group from last time
 * if there is one, and only then three empty cards. */
/* sanitizeQuery, for the same reason the #t= path below calls it: an #s= hash is
 * a document written by whoever made the link, several of its fields land in
 * innerHTML, and this origin is about to be handed round a group chat. The two
 * paths carry the identical payload shape, so there was no reason for only one
 * of them to be coerced. */
state.q = migrateQuery((shared && shared.q && shared.q.parties)
    ? sanitizeQuery(shared.q) : blankQuery());
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
        el('destHint').textContent = placeOf(a) + ' — ' + a.name;
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
trackStick();

/* The app is built to live on a home screen -- that is where the launch screen,
 * the status bar handling and the full-height layout come from -- so someone who
 * only ever opens it in Safari is using a worse version of it without knowing
 * there is a better one. This is the only thing that tells them.
 *
 * It is deliberately quiet: not on the first visit, dismissible, and silent for
 * a fortnight afterwards. An install prompt that argues is worse than none. */
/* Two handles out of the prompt below, so Settings can offer the steps to
 * somebody who dismissed the banner and later wanted it back. Declared here
 * rather than returned, because the prompt runs once at startup and Settings
 * is opened long afterwards. */
var installable = function () { return false; };
var showInstall = function () {};

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
    /* window-controls-overlay is an INSTALLED window that has taken the title
     * bar, and it does not also report standalone -- so testing standalone
     * alone offered to install the app inside the installed app. */
    var standalone = window.navigator.standalone
        || (window.matchMedia
            && (window.matchMedia('(display-mode: standalone)').matches
                || window.matchMedia('(display-mode: window-controls-overlay)').matches
                || window.matchMedia('(display-mode: minimal-ui)').matches));

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

    /* Already on a home screen means there is nothing to offer. Everything
     * else can be shown the steps, including a browser that will never fire
     * beforeinstallprompt -- the steps are the whole point on iOS. */
    installable = function () { return !standalone; };
    /* Ignores the fortnight mute and the visit count on purpose: this one is
     * asked for rather than offered. */
    showInstall = function () {
        if (standalone) return;
        card.classList.remove('hidden', 'out');
    };

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
        /* A link can now carry both: #t= for the results and &s= for the view.
         * When it does, the hash is the fresher statement of what the sender was
         * looking at -- the stored payload was written when the trip was first
         * saved, before they adjusted anything. The saved DATA is still used for
         * the results; only the reading of them comes from the hash. */
        var pay = res.body.payload || {};
        var hashHasView = !!(shared && shared.q && shared.q.parties);
        if (pay.q && pay.q.parties && !hashHasView) state.q = migrateQuery(sanitizeQuery(pay.q));
        if (pay.v && !(shared && shared.v)) {
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
        rememberTrip();
        /* A second, tiny request. The document is large and immutable so it is
         * cached hard at the edge; the roster is small and changes, so it is
         * never cached. Asking for them together would force one of those two to
         * be wrong -- either a 150KB re-download every time somebody checks
         * whether Ray booked, or a five-minute-old answer to the question. */
    }).catch(function (e) {
        if (window.console) console.error('shared trip failed', e);
        state.error = 'Could not open that trip. Check your connection, or start a new trip.';
        TRIP_ID = null; render();
    });
} else if (shared && shared.q && shared.q.parties && validate() === null) {
    doSearch();
}

})();
