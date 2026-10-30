/* Fly with Friends — application logic.
 *
 * Split out of index.html so the markup stays readable and the maths stays
 * testable. optimizer.js holds the window/cost algorithms; airports.js holds the
 * lookup; this file is the glue, the steps, and the rendering.
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

/* Assigned in order so each party keeps its colour across the timeline, the
 * avatar and the plan rows. */
var COLORS = ['#ffb300', '#4ade80', '#38bdf8', '#c084fc', '#fb923c', '#f472b6', '#2dd4bf', '#facc15'];

var DATA = null, SET = null, BUDGET = null, C = null, TRIP = null;
/* Alternative dates, keyed "dep|ret". Each entry is a whole searched trip. */
var SHIFTS = {}, shiftBusy = false, shiftErr = null;
/* Short id for the saved trip, once it has been shared. */
var TRIP_ID = null, savingTrip = false;
var state = {
    step: 1, leg: 'outbound', recommend: 'value',
    /* Whether the exact landing-time pickers have been revealed. */
    bandExact: false,
    /* One chosen row per leg: a round trip is two decisions, and pricing the
     * whole trip means holding both at once. */
    th: { outbound: null, return: null },
    q: null, busy: false, error: null
};
function otherLeg() { return state.leg === 'outbound' ? 'return' : 'outbound'; }
function thGet() { return state.th[state.leg]; }
function thSet(v) { state.th[state.leg] = v; }
function thReset() { state.th.outbound = null; state.th.return = null; }

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

function applyTheme() {
    var m = SET.theme;
    if (m === 'system') {
        m = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    document.documentElement.setAttribute('data-theme', m);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', m === 'light' ? '#f7f4ee' : '#0b0a08');
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
    return q;
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
        /* Landing together is the point of this. Leaving together only means
         * sharing a ride to the airport, and forcing the return into a window
         * makes the optimiser pick absurd flights home to hit a departure time.
         * Off by default; the group can turn it on. */
        clusterReturn: false,
        /* Relative, because nobody knows the right absolute number. "No more
         * than three hours longer than the quickest way to do this route" is
         * always meaningful; "no more than 8 hours" is not. */
        maxDetour: 180,
        parties: [newParty(0), newParty(1), newParty(2)]
    };
}
function partyLabel(p, i) { return (p.name || '').trim() || ('Flight ' + (i + 1)); }

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

/* Initials where a name was given, the party number where it was not -- so the
 * avatar is always something, and becomes meaningful the moment you type. */
function partyInitials(p, i) {
    var n = (p.name || '').trim();
    if (!n) return String(i + 1);
    /* One booking often covers two people, so names arrive as "Jim / Gary" or
     * "Mum & Dad". Taking the first character of every whitespace-separated
     * token made the separator an initial and drew avatars reading "J/".
     * Splitting on the separators themselves keeps this right for any script,
     * which a letters-only character class would not. */
    var toks = n.split(/[\s/,&+·|\-–—.]+/).filter(function (w) { return w.length; });
    if (!toks.length) return String(i + 1);
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
    var byParty = {};
    ids.forEach(function (id) {
        var all = legData[id] || [];
        var kept = all;
        var rule = rulesFor(id);

        if (rule.maxStops != null) {
            var strict = all.filter(function (o) { return (o.stops || 0) <= rule.maxStops; });
            if (strict.length) kept = strict;
            else if (rule.own.maxStops) {
                /* Their own rule: block and ask, never relax silently. */
                blocked.push({ id: id, rule: 'stops', best: all });
                kept = [];
            } else if (all.length) relaxed.push(id);
        }

        /* Carriers the group refuses. Unlike the stops preference this is never
         * relaxed on anybody's behalf: quietly booking somebody onto the airline
         * they just told us to avoid is the single worst thing this screen could
         * do. If it empties a party we say so and let them choose. */
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

        /* A budget fare has to actually be a bargain. If Frontier is $8 under
         * Delta it is not cheaper, it is the same price without a bag, a seat
         * or a rebooking -- and picking it is how the app ends up recommending
         * the flight people dread. So a budget option must beat the best
         * mainline option by a real margin or it is dropped. Only applied when
         * a mainline option exists: on routes only a budget carrier flies, the
         * choice is that or nothing. */
        if (kept.length) {
            var mainline = kept.filter(function (o) { return !isUlcc(o); });
            if (mainline.length) {
                var bestMain = null;
                mainline.forEach(function (o) {
                    var c = costFn(o, id);
                    if (bestMain === null || c < bestMain) bestMain = c;
                });
                var seatsOfParty = Math.max(1, (tv.filter(function (z) { return z.id === id; })[0] || {}).seats || 1);
                var margin = Math.max(40 * seatsOfParty, bestMain * 0.18);
                var worthIt = kept.filter(function (o) {
                    return !isUlcc(o) || costFn(o, id) <= bestMain - margin;
                });
                if (worthIt.length) kept = worthIt;
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
                var sane = kept.filter(function (o) {
                    return o.duration_minutes == null || o.duration_minutes <= quickest + cap;
                });
                if (sane.length) {
                    if (sane.length < kept.length) detoured.push(id);
                    kept = sane;
                }
            }
        }

        byParty[id] = kept;

        /* The flight this party would pick if the group did not exist: quickest,
         * fewest stops. Not the cheapest -- this is the yardstick for what the
         * group is ASKING them to give up, and nobody experiences a connection
         * as a saving. */
        var bm = null, bs = null;
        kept.forEach(function (o) {
            if (o.duration_minutes != null && (bm == null || o.duration_minutes < bm)) bm = o.duration_minutes;
            var st = o.stops == null ? 99 : o.stops;
            if (bs == null || st < bs) bs = st;
        });
        ownBest[id] = { mins: bm, stops: bs };
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
    if (cap != null && loner) {
        var pruned = {};
        ids.forEach(function (id) {
            pruned[id] = (byParty[id] || []).filter(function (o) {
                return costFn(o, id) <= solo[id] + cap;
            });
        });
        prep = FWF.prepare(pruned, ids, field, { band: band });
    }

    var soloOpen = {};
    var openPrep = FWF.prepare(legData, ids, field);
    void openPrep;
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
        if (!matches.length) { close(); return; }
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

    function refresh() {
        matches = AIRPORTS.search(input.value, 7);
        if (opts.noMetros) matches = matches.filter(function (a) { return !a.metro; });
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
    state.step = n;
    [1, 2, 3, 4].forEach(function (i) { el('s' + i).classList.toggle('hidden', i !== n); });
    el('s' + n).focus({ preventScroll: true });
    var rail = el('rail');
    rail.classList.toggle('hidden', n === 4);
    if (n !== 4) {
        rail.innerHTML = STEPS.slice(0, 3).map(function (_, i) {
            return '<span class="seg' + (i < n ? ' done' : '') + '"></span>';
        }).join('') + '<span class="lbl">' + STEPS[n - 1] + '</span>';
    }
    window.scrollTo(0, 0);
}

/* ------------------------------------------------------------ parties */

function renderParties() {
    /* Re-rendering throws away whatever is typed in the inputs, and there are
     * eleven call sites -- expecting each to remember to save first is how a
     * name silently disappears the moment you pick an airport. Save here, once,
     * so no caller can lose it. readNames only writes to parties that still
     * exist, so replacing the query wholesale is unaffected. */
    readNames();

    el('parties').innerHTML = state.q.parties.map(function (p, i) {
        var chips = p.airports.map(function (code) {
            var a = AIRPORTS.get(code);
            return '<span class="chip' + (a && a.closed ? ' closed' : '') + '">' + esc(code)
                + '<span class="city">' + esc(a ? a.city : 'unknown') + '</span>'
                + '<button data-rmair="' + esc(code) + '" aria-label="Remove ' + esc(code) + '">&times;</button></span>';
        }).join('');

        var closedNote = p.airports.map(function (code) {
            var a = AIRPORTS.get(code);
            if (!a || !a.closed) return '';
            return '<div class="party-note" style="color:var(--bad)">' + esc(a.note)
                + (a.alternates.length ? ' People fly from ' + esc(a.alternates.join(', ')) + ' instead.' : '')
                + '</div>';
        }).join('');

        return '<div class="party" data-pid="' + esc(p.id) + '">'
            + '<div class="party-top">'
            + '<div class="ava" aria-hidden="true" style="background:' + partyColor(i) + '">' + esc(partyInitials(p, i)) + '</div>'
            + '<input class="inp sans" data-f="name" placeholder="Name (optional)" value="' + esc(p.name)
            + '" maxlength="22" aria-label="Name for departure city ' + (i + 1) + '">'
            + '<div class="stepper" role="group" aria-label="Seats for ' + esc(partyLabel(p, i)) + '">'
            + '<button data-seats="-1" aria-label="One fewer seat for ' + esc(partyLabel(p, i)) + '"'
            + (p.seats <= 1 ? ' disabled' : '') + '>&minus;</button>'
            + '<output class="n" aria-live="polite">' + p.seats + '</output>'
            + '<button data-seats="1" aria-label="One more seat for ' + esc(partyLabel(p, i)) + '"'
            + (p.seats >= APP.maxSeats ? ' disabled' : '') + '>+</button>'
            + '</div>'
            + (state.q.parties.length > 2
                ? '<button class="party-x" data-rmparty aria-label="Remove ' + esc(partyLabel(p, i)) + '">&times;</button>' : '')
            + '</div>'
            + '<span class="k">Flying from</span>'
            + '<div class="chips" style="margin-top:8px">' + chips
            + '<button class="add-air" data-addair aria-label="'
            + (p.airports.length ? 'Add another airport for ' : 'Pick an airport for ') + esc(partyLabel(p, i))
            + '">' + (p.airports.length ? '+ another airport' : '+ pick airport') + '</button>'
            + '</div>'
            + '<div class="field hidden" data-airfield style="margin:10px 0 0">'
            + '<input class="inp" data-airinput placeholder="Airport or city" autocapitalize="characters"'
            + ' autocomplete="off" aria-label="Add an airport for ' + esc(partyLabel(p, i)) + '">'
            + '<div class="ac" data-airac></div></div>'
            + closedNote
            + '</div>';
    }).join('');

    /* Autocomplete is attached per card after each rebuild. */
    Array.prototype.forEach.call(document.querySelectorAll('.party'), function (card) {
        var pid = card.getAttribute('data-pid');
        var input = card.querySelector('[data-airinput]');
        var drop = card.querySelector('[data-airac]');
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.dep)) return 'Pick a departure date.';
    if (q.ret && q.ret < q.dep) return 'The return date is before the departure date.';
    var withAir = q.parties.filter(function (p) { return p.airports.length; });
    if (withAir.length < 2) return 'Add departure airports for at least two cities.';
    var dead = [];
    q.parties.forEach(function (p, i) {
        var live = p.airports.filter(function (c) { var a = AIRPORTS.get(c); return a && !a.closed; });
        if (p.airports.length && !live.length) dead.push(partyLabel(p, i));
    });
    if (dead.length) {
        return dead.join(', ') + ' only has closed airports. Add one that is open.';
    }
    return null;
}

/* -------------------------------------------------------------- search */

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
        return;
    }

    /* Only now drop the cards with no airport, so ids, totals and the plan all
     * agree on who is actually travelling. */
    state.q.parties = state.q.parties.filter(function (p) { return p.airports.length; });
    renderParties();

    state.error = null; state.busy = true; render();
    writeHash();

    var tv = travelers().filter(function (t) { return t.origins.length; });
    fetch(API + '/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
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
        return r.json().then(function (j) { return { ok: r.ok, body: j }; });
    }).then(function (res) {
        state.busy = false;
        if (res.body.budget) {
            BUDGET = res.body.budget;
            BUDGET.low = BUDGET.used > BUDGET.limit * 0.8;
            BUDGET.exhausted = BUDGET.used >= BUDGET.limit;
        }
        if (!res.ok) { state.error = res.body.error || 'Search failed.'; render(); return; }
        DATA = res.body;
        SHIFTS = {}; shiftErr = null; TRIP_ID = null;
        thReset(); state.leg = 'outbound';
        showStep(4); render();
    }).catch(function (e) {
        state.busy = false;
        state.error = 'Could not reach the search service: ' + e.message;
        render();
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
            state.error = 'Could not load the example. ' + ((e && e.message) || 'Try reloading the page.');
            render();
        });
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
function legBreakdown(leg) {
    var ctx = compute(leg);
    if (!ctx) return null;
    /* Unless the group has asked to leave together, the way home is simply each
     * person's best flight -- they are going to different cities. */
    if (leg === 'return' && !state.q.clusterReturn) state.th['return'] = FWF.INF;
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
        var reg = { stops: 0, mins: 0, who: null }, conn = {};
        ctxs.forEach(function (c) {
            /* The way home is unclustered by default, and the plan on screen
             * renders it that way -- so pricing it inside the window quoted a
             * trip nobody was being shown. The per-person cards summed to $23
             * less than the headline because of exactly this. Its spread is
             * excluded too: an eleven-hour spread on a leg we are deliberately
             * not clustering would otherwise dominate every row's "apart". */
            var loose = c.leg === 'return' && !state.q.clusterReturn;
            var r = FWF.minCostAtWindow(c.prep, loose ? FWF.INF : T, c.costFn);
            if (!r) { ok = false; return; }
            total += r.cost;
            if (!loose) worst = Math.max(worst, r.spread);
            var g = regretOf(c, r.picks);
            if (g.stops > reg.stops) { reg.stops = g.stops; reg.who = g.who; }
            if (g.mins > reg.mins) { reg.mins = g.mins; if (!reg.who) reg.who = g.who; }
            c.ids.forEach(function (id) {
                per[id] = (per[id] || 0) + r.picks[id].cost;
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
                    conn: Object.keys(conn),
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

/* Why this one, in facts the reader can check against the rows below it. */
function pickReason(row, l) {
    var bits = [];
    var n = (row.conn || []).length;
    if (!n) bits.push('everyone nonstop');
    else bits.push(n === 1 ? name(row.conn[0]) + ' changes planes'
                           : n + ' people change planes');

    var cheapest = l.reduce(function (a, b) { return b.total < a.total ? b : a; });
    var extra = row.total - cheapest.total;
    if (extra > 0) {
        bits.push(money(extra) + ' over the cheapest, which lands them '
            + FWF.fmtGap(cheapest.worst) + ' apart');
    } else bits.push('nothing cheaper on these dates');
    return bits.join(' \u00b7 ');
}

function renderChoices() {
    var host = el('choices');
    var l = tripLadder();
    if (!l || !l.length) { host.className = 'choices hidden'; return; }

    var best = tripBest(l);
    if (!best) { host.className = 'choices hidden'; return; }
    var cur = state.th.outbound;
    var showing = l.filter(function (r) { return r.th === cur; })[0] || best;

    /* Alternatives are the ends of the range, which is what people actually ask
     * for next: the cheapest, and the closest they could possibly get. Only
     * offered when they are genuinely different from what is on screen. */
    var cheapest = l.reduce(function (a, b) { return b.total < a.total ? b : a; });
    var tightest = l.reduce(function (a, b) { return b.worst < a.worst ? b : a; });
    var alts = [];
    if (cheapest.th !== showing.th) {
        alts.push({ th: cheapest.th, l: 'Cheapest', v: money(cheapest.total),
                    s: FWF.fmtGap(cheapest.worst) + ' apart' });
    }
    if (tightest.th !== showing.th && tightest.th !== cheapest.th) {
        alts.push({ th: tightest.th, l: 'As close as possible', v: money(tightest.total),
                    s: FWF.fmtGap(tightest.worst) + ' apart' });
    }
    if (showing.th !== best.th) {
        alts.unshift({ th: best.th, l: 'Best option', v: money(best.total),
                       s: FWF.fmtGap(best.worst) + ' apart' });
    }

    host.className = 'choices';
    host.innerHTML = '<div class="pick">'
        + '<div class="pick-top">'
        + '<div><div class="pick-k">' + (showing.th === best.th ? 'Best option' : 'Showing')
        + '</div>'
        + '<div class="pick-w">Everyone lands within ' + FWF.fmtGap(showing.worst) + '</div></div>'
        + '<div class="pick-tot mono">' + money(showing.total)
        + '<span>' + money(showing.topPer) + ' each at most</span></div>'
        + '</div>'
        + '<div class="pick-why">' + esc(pickReason(showing, l)) + '</div>'
        + (alts.length
            ? '<div class="pick-alt">' + alts.map(function (a) {
                return '<button data-choice="' + (a.th === FWF.INF ? 'Infinity' : a.th) + '">'
                    + '<span>' + esc(a.l) + '</span>'
                    + '<span class="mono">' + a.v + ' &middot; ' + esc(a.s) + '</span></button>';
              }).join('') + '</div>'
            : '')
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
    C = compute();
    renderNotices();
    renderGear();
    el('go').textContent = state.busy ? 'Searching…' : 'Land them together';
    el('go').setAttribute('aria-disabled', state.busy ? 'true' : 'false');
    el('go').setAttribute('aria-busy', state.busy ? 'true' : 'false');
    el('go').classList.toggle('busy', state.busy);
    if (state.step !== 4) return;
    if (!C) { showStep(3); return; }
    /* The trip-level pick is the default, so the headline total always matches
     * the plan printed underneath it. Falls back to the per-leg recommendation
     * when a trip ladder cannot be built -- which happens when one leg has
     * somebody with no options at all. */
    if (thGet() === null) {
        var tl0 = tripLadder();
        var tb0 = tl0 && tripBest(tl0);
        if (tb0) thSet(tb0.th);
        else if (C.ladder) thSet(recommendedIn(C));
    }
    renderResHead();
    /* The plan is rendered from TRIP, so it still has to be computed -- it just
     * no longer prints a panel of its own. */
    TRIP = tripTotal();
    if (!TRIP) { el('planView').innerHTML = ''; return; }
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
            g.innerHTML = '<span class="ini" style="color:' + partyColor(i) + '">'
                + esc(partyInitials(state.q.parties[i], i)) + '</span>';
            return;
        }
    }
    g.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<circle cx="12" cy="12" r="3"/>'
        + '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
}

function renderNotices() {
    var s = el('nSample');
    if (DATA && DATA.sample) {
        s.className = 'notice warn';
        s.innerHTML = '<b>Example data.</b> These fares are invented so you can see how it works. '
            + 'Start a new trip to search for real.';
    } else s.className = 'notice hidden';

    var st = el('nStale'), gen = DATA && DATA.generated_at ? new Date(DATA.generated_at) : null;
    var days = gen ? Math.floor((Date.now() - gen.getTime()) / 86400000) : null;
    if (DATA && !DATA.sample && days != null && days >= 10) {
        st.className = 'notice warn';
        st.innerHTML = '<b>These fares are ' + days + ' days old.</b> Search again before anyone books.';
    } else st.className = 'notice warn hidden';

    var e = el('nErr');
    if (state.error) { e.className = 'notice bad'; e.innerHTML = esc(state.error); }
    else e.className = 'notice bad hidden';

    /* Nobody is rationed per person, so the only thing worth saying is when the
     * shared allowance is nearly gone -- which is the signal to upgrade rather
     * than to start turning people away. */
    var q = el('nQuota');
    if (BUDGET && BUDGET.exhausted) {
        q.className = 'notice bad';
        q.innerHTML = '<b>This month\u2019s flight data is used up.</b> Shared links and recent '
            + 'searches still work. New searches resume on ' + esc(BUDGET.resetsAt) + '.';
    } else if (BUDGET && BUDGET.low) {
        q.className = 'notice warn';
        q.innerHTML = '<b>' + Math.max(BUDGET.limit - BUDGET.used, 0) + ' searches left this month.</b> '
            + 'Shared links are always free to open.';
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
            bits.push('<b>' + esc(blocked.map(name).join(', ')) + ' can’t meet your filters.</b> '
                + 'They have flights, just none that ' + filterText() + '. Loosen one above.');
        }
        if (none.length) {
            bits.push('<b>No flights found</b> for ' + esc(none.map(name).join(', ')) + ' on this leg.');
        }
        bits.push('A total covering ' + seatsOf(C.ids.filter(function (id) {
                return C.prep.missing.indexOf(id) === -1; }))
            + ' of ' + seatsAll() + ' travellers would be a wrong number, not a partial one.');
        sh.className = 'notice bad';
        sh.innerHTML = bits.join('<br><br>');
    } else sh.className = 'notice bad hidden';
}

function name(id) {
    var t = (C && C.travelers || []).filter(function (x) { return x.id === id; })[0];
    return t ? t.name : id;
}
function legVerb() { return state.leg === 'outbound' ? 'land' : 'leave'; }
function bandText() {
    var b = currentBand();
    if (b.from && !b.to) return 'after ' + b.from;
    if (!b.from && b.to) return 'by ' + b.to;
    return b.from + '–' + b.to;
}
function filterText() {
    var bits = [];
    if (C.band) bits.push(legVerb() + ' between ' + bandText());
    if (C.maxStops === 0) bits.push('are nonstop');
    else if (C.maxStops != null) bits.push('have at most ' + C.maxStops + ' stop');
    if (C.cap != null) bits.push('cost them no more than ' + money(C.cap) + ' over their own cheapest');
    if ((state.q.avoid || []).length) bits.push('avoid ' + avoidedNames().join(', '));
    return bits.join(' and ');
}

function renderResHead() {
    var q = state.q, a = AIRPORTS.get(q.dest);
    var seats = travelers().reduce(function (n, t) { return n + t.seats; }, 0);
    el('resT').textContent = (a ? a.city : q.dest) + ' · ' + seats + ' travelling';
    var gen = DATA.generated_at ? new Date(DATA.generated_at) : null;
    var hrs = gen ? Math.round((Date.now() - gen.getTime()) / 3600000) : null;
    var cls = DATA.sample ? 'fresh-sample'
        : hrs == null ? 'fresh-mid' : hrs < 6 ? 'fresh-ok' : hrs < 24 ? 'fresh-mid' : 'fresh-old';
    var word = DATA.sample ? 'example data'
        : hrs == null ? 'unknown age' : hrs < 1 ? 'fares just now' : 'fares ' + hrs + 'h old';
    el('resS').innerHTML = esc(prettyRange(q.dep, q.ret))
        + ' &nbsp;<span class="fresh"><span class="dot ' + cls + '"></span>' + esc(word) + '</span>';
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

function renderBandPresets() {
    var host = el('sBandPre');
    if (!host) return;
    var cur = presetFor(state.q.band.outbound);
    host.innerHTML = BAND_PRESETS.map(function (x) {
        var on = cur === x.k;
        return '<button class="pill' + (on ? ' on' : '') + '" role="radio" aria-checked="' + on
            + '" data-bpre="' + x.k + '">' + esc(x.l) + '</button>';
    }).join('')
        + '<button class="pill' + (cur === 'exact' ? ' on' : '') + '" role="radio"'
        + ' aria-checked="' + (cur === 'exact') + '" data-bpre="exact">Exact times</button>';
    /* Once revealed the pickers stay put, so typing a time never makes the
     * field you are editing disappear under you. */
    var box = el('sBandExact');
    if (box) box.className = (cur === 'exact' || state.bandExact) ? 'row2' : 'row2 hidden';
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
            return '<button class="pill air' + (off ? ' off' : '') + '" data-air="' + esc(c.key)
                + '" aria-pressed="' + off + '"'
                + ' title="' + esc(off ? 'Allow ' + c.name : 'Avoid ' + c.name) + '">'
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
                    + '<div class="qm-f">Bold carriers fly this route. '
                    + 'Picking one alliance avoids everything outside it.</div></div>';
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
    var lines = [heading + ' — ' + (b.plan.excluded && b.plan.excluded.length
        ? seatsOf(b.plan.included) + ' of ' + seatsAll() + ' within ' + FWF.fmtGap(b.spread)
        : 'everyone within ' + FWF.fmtGap(b.spread))];

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
            + (o.stops === 0 ? ', nonstop' : ', ' + o.stops + ' stop')
            + (r.inWindow ? '' : '  (not in the window)'));
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
    lines.push('Everyone, ' + (hasReturn() ? 'round trip' : 'one way') + ': ' + money(TRIP.total)
        + (SET.priceDisplay === 'fare' ? ' (fares only)' : ' including bags'));
    var gen = DATA && DATA.generated_at ? new Date(DATA.generated_at) : null;
    lines.push('Fares as of ' + (gen ? gen.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'unknown')
        + ' — check before paying.');
    lines.push(shareUrl());
    return lines.join('\n');
}

function windowStrip(leg, b, label) {
    if (!b) return '';
    var loose = leg === 'return' && !state.q.clusterReturn;
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
    var allIn = excluded.length === 0;
    var tightestRow = b.ctx.ladder
        ? b.ctx.ladder.rows.filter(function (r) { return r.feasible; })[0] : null;
    var more = (allIn && tightestRow && tightestRow.result)
        ? tightestRow.result.cost - b.inWindowTotal : 0;

    var html = '<div class="win"><div class="win-head">'
        + '<span class="t">' + label + '</span>'
        /* On the unclustered leg the spread is an outcome, not a target, so it
         * is reported without implying we aimed for it. */
        + '<span class="s">' + (loose
            ? FWF.fmtGap(b.spread) + ' apart'
            : allIn
                ? 'all within ' + FWF.fmtGap(b.spread)
                : seatsOf(included) + ' of ' + seatsAll() + ' within ' + FWF.fmtGap(b.spread))
        + '</span></div>'
        + timeline(picks, included, excluded)
        + (loose
            ? '<div class="win-note">Each on their own best flight home. '
              + '<button class="linkish" data-clusterback="1">Leave together instead</button></div>'
            : '')
        /* The choice strip above already prices tighter-vs-cheaper for the whole
         * trip, so repeating it per leg was noise pointing the wrong way. */
        + (b.ctx.relaxed && b.ctx.relaxed.length
            ? '<div class="win-note">' + esc(b.ctx.relaxed.map(function (id) {
                    var t = b.ctx.travelers.filter(function (z) { return z.id === id; })[0];
                    return t ? t.name : id;
                }).join(', '))
              + ' had no ' + (b.ctx.maxStops === 0 ? 'nonstop' : 'short-enough')
              + ' option, so a connection was allowed rather than dropping the plan.</div>'
            : '')
        + (!allIn
            ? '<div class="win-note" style="color:var(--bad)">'
              + esc(excluded.map(function (x) { return name(x.id); }).join(', '))
              + ' cannot make this window. The closest the whole group can get is '
              + (tight ? FWF.fmtGap(tight.spread) : 'not possible on these filters') + '.</div>'
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
        + (o.stops === 0 ? 'nonstop' : o.stops + (o.stops === 1 ? ' stop' : ' stops')) + ' · ' + FWF.fmtGap(o.duration_minutes)
        + (r.inWindow ? '' : ' · <span style="color:var(--bad)">outside the window</span>') + '</div>'
        + priceLevel(leg, id) + '</div>'
        + '<div class="hop-right"><div class="hop-time mono">'
        + (leg === 'outbound' ? 'lands ' : 'leaves ') + clock(showMin) + '</div>'
        + '<div class="hop-cost mono">' + money(r.cost)
        + (seats > 1 ? ' <span class="for-seats">for ' + seats + '</span>' : '')
        + '</div>'
        /* This number was previously a bare orange "+$16" beside the fare, which
         * reads as a fee to add on. It is not: it is already inside the fare.
         * A tester added it to their own total for every traveller. */
        + (r.premium > 0
            ? '<div class="hop-prem">incl. ' + money(r.premium) + ' to land with the group</div>'
            : '')
        + '</div></div>';
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
        + (apart ? ' <span class="badge out">not in the window</span>' : '') + '</div></div>'
        + '<div class="trav-tot mono">' + money(pp.total)
        + '<span>' + (t.seats > 1 ? money(each) + ' each' : 'all in') + '</span></div>'
        + '</div>'
        + hopRow('Out', o, 'outbound', id, t.seats)
        + (b ? hopRow('Back', b, 'return', id, t.seats) : '')
        + '<div class="trav-book">'
        + '<a class="btn primary" style="display:block;text-align:center;text-decoration:none" href="'
        + esc(tripBookUrl(origin, state.q.dest, state.q.dep, state.q.ret || null, t.seats, chosen))
        + '" target="_blank" rel="noopener">Book ' + esc(t.name) + '&rsquo;s trip &rarr;</a>'
        + '</div></div></div>';
}

function renderPlanView() {
    var host = el('planView');
    if (!TRIP || !C) { host.innerHTML = ''; return; }

    /* "Together" is the one word this product exists to say, and it was attached
     * to the wrong fact: it meant "nobody was dropped from the list", so it read
     * "everyone together" above "all within 7h 25m". It now describes the spread. */
    /* Only count a leg that is actually being clustered. The way home is
     * deliberately unclustered by default, so including its spread made the
     * headline read "7h 25m apart" about a 20-minute arrival. */
    var worst = TRIP.legOut ? TRIP.legOut.spread : 0;
    if (TRIP.legBack && state.q.clusterReturn) worst = Math.max(worst, TRIP.legBack.spread);
    /* Only speak up when something is wrong. "everyone together" was a vaguer
     * restatement of the "all within 20m" line directly beneath it, so it was
     * one more thing to read that said less. */
    var verdict = !TRIP.allClustered ? 'not everyone fits'
        : worst > 90 ? 'same day, but ' + FWF.fmtGap(worst) + ' apart'
        : '';
    var html = '<div class="plan-head"><div class="t">The plan</div>'
        + (verdict ? '<div class="s warnish">' + esc(verdict) + '</div>' : '')
        + '</div>';

    html += windowStrip('outbound', TRIP.legOut, 'Landing together');
    /* "Leaving together" over flights eleven hours apart is a lie. The heading
     * follows what the leg is actually doing. */
    if (TRIP.legBack) {
        html += windowStrip('return', TRIP.legBack,
            state.q.clusterReturn ? 'Leaving together' : 'Flying home');
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
            if (x.body && x.body.budget) BUDGET = x.body.budget;
            if (!x.ok) { shiftErr = x.body.error || 'Could not check other dates.'; return; }
            SHIFTS[shiftKey(x.c)] = { c: x.c, priced: priceShift(x.body) };
        });
        renderShifts();
    }).catch(function (e) {
        shiftBusy = false; shiftErr = 'Could not check other dates: ' + e.message; renderShifts();
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
        host.innerHTML = '<button class="btn wide" id="shiftBtn"' + (shiftBusy ? ' disabled' : '') + '>'
            + (shiftBusy ? 'Checking…' : 'Is another day cheaper?') + '</button>'
            + '<div class="share-note">Checks the day before and after. Costs <b>' + n
            + '</b> of your remaining searches — there is no way to see nearby dates for free.'
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
        + (best && !best.here
            ? '<div class="share-note" style="color:var(--good)">Moving the trip to ' + esc(best.label)
              + ' saves <b>' + money(TRIP.total - best.total) + '</b>. Change the dates on the previous screen to use it.</div>'
            : '<div class="share-note">Your dates are the cheapest of the three.</div>');
}

function renderShare() {
    var host = el('shareBox');
    if (!TRIP) { host.innerHTML = ''; return; }
    host.innerHTML = '<button class="btn primary wide" id="copyBtn">Copy the whole trip for the group chat</button>'
        + '<div class="share-note" id="copyNote"></div>';

    el('copyBtn').addEventListener('click', function () {
        el('copyNote').textContent = 'Saving the trip so the link is free to open…';
        saveTrip().then(function () { doCopy(); });
    });

    function doCopy() {
        var text = chatBlock();
        var done = function (ok) {
            el('copyNote').textContent = ok ? 'Copied. Paste it in the group chat.'
                : 'Could not copy automatically — select the plan above instead.';
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
        + esc((o.airlines || []).join(', ')) + ' · ' + (o.stops === 0 ? 'nonstop' : o.stops + (o.stops === 1 ? ' stop' : ' stops'))
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

function timeline(picks, included, excluded) {
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
    var html = '<div class="timeline"><div class="tl-band" style="left:' + Math.max(pct(lo), 0)
        + '%;width:' + Math.max(Math.min(pct(hi), 100) - Math.max(pct(lo), 0), 1.5) + '%"></div><div class="tl-axis"></div>';

    var minGap = (48 / 390) * 100, last = -999, alt = false;
    keys.forEach(function (m) {
        var p = pct(m);
        alt = (p - last < minGap) ? !alt : false;
        last = p;
        var dots = groups[m].map(function (g) {
            var i = idxOf(g.id);
            var style = g.dim ? 'background:var(--edge-2);color:var(--muted)' : 'background:' + partyColor(i < 0 ? 0 : i);
            return '<div class="tl-dot" style="' + style + '">'
                + esc(partyInitials(state.q.parties[i] || { name: name(g.id) }, i < 0 ? 0 : i)) + '</div>';
        }).join('');
        html += '<div class="tl-mark" style="left:' + p + '%"><div class="tl-dots">' + dots + '</div>'
            + '<div class="tl-t mono' + (alt ? ' alt' : '') + '">' + clock(m) + '</div></div>';
    });

    return html + '<div class="tl-edge mono" style="left:11px">' + clock(from) + '</div>'
        + '<div class="tl-edge mono" style="right:11px">' + clock(to) + '</div></div>';
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
    /* The page must not stay tabbable behind the scrim. */
    document.querySelector('main').setAttribute('inert', '');
    document.querySelector('.brand').setAttribute('inert', '');
    sheet.focus();
}

function closeSheet() {
    var sheet = el('sheet'), scrim = el('scrim');
    if (sheet.classList.contains('hidden')) return;
    document.querySelector('main').removeAttribute('inert');
    document.querySelector('.brand').removeAttribute('inert');
    sheet.classList.add('out');
    scrim.classList.add('out');
    setTimeout(function () {
        sheet.classList.add('hidden'); sheet.classList.remove('out');
        scrim.classList.add('hidden'); scrim.classList.remove('out');
    }, 200);
    if (sheetReturn && sheetReturn.focus) sheetReturn.focus();
    sheetReturn = null;
}

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

    openSheet('<h2 id="sheetTitle">Settings</h2><div class="sub">Kept on this device. No account, no sign-in.</div>'
        + '<div class="grp"><span class="k">Which one am I</span><div class="pills">'
        + people.map(function (p, i) { return pill(SET.meId === p.id, 'meId', p.id, p.name); }).join('')
        + pill(!SET.meId, 'meId', '', 'Not set')
        + '</div><div class="tip">Highlights your row everywhere.</div></div>'

        + '<div class="grp"><span class="k">Theme</span><div class="pills">'
        + pill(SET.theme === 'dark', 'theme', 'dark', 'Dark')
        + pill(SET.theme === 'light', 'theme', 'light', 'Light')
        + pill(SET.theme === 'system', 'theme', 'system', 'System')
        + '</div></div>'

        + '<div class="grp"><span class="k">How close is close enough</span><div class="pills">'
        + [15, 30, 45, 60].map(function (n) { return pill(SET.target === n, 'target', n, n + ' min'); }).join('')
        + '</div><div class="tip">The window everyone has to land inside for the trip to count as working.</div></div>'

        + '<div class="grp"><span class="k">What everyone is bringing</span><div class="pills">'
        + '<button class="pill' + (SET.bags.carry_on > 0 ? ' on' : '') + '" data-bag="carry_on">Carry-on</button>'
        + '<button class="pill' + (SET.bags.checked > 0 ? ' on' : '') + '" data-bag="checked">Checked bag</button>'
        + '</div><div class="tip">Applied to everyone so totals stay comparable. Where Google publishes no fee, '
        + money(APP.bagFee) + ' is assumed and the row says so. An unknown fee is never treated as free.</div></div>'

        + '<div class="grp"><span class="k">Prices</span><div class="pills">'
        + pill(SET.priceDisplay === 'allin', 'priceDisplay', 'allin', 'All-in')
        + pill(SET.priceDisplay === 'fare', 'priceDisplay', 'fare', 'Fares only')
        + '</div></div>'

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
        + '<p>This works out the opposite: the set of flights that puts everyone on the ground inside '
        + 'the same short window, and what that costs compared with everyone booking separately.</p>'

        + '<h3>How it decides</h3>'
        + '<p>It finds the tightest window everyone can actually make, then prices the trade — because '
        + '<strong>landing together and landing cheaply pull against each other</strong>. There is rarely '
        + 'one right answer, so it shows the curve and lets the group pick the knee.</p>'
        + '<p>Where a group is big enough that one person wrecks the window, it says so by name rather '
        + 'than quietly widening it for everyone.</p>'

        + '<h3>Why I built this</h3>'
        + '<p>I’m <strong>Altorien Lockwood</strong> — FP&amp;A Analyst and CPA candidate. I kept trying '
        + 'to organise trips with friends spread across the country and doing the arithmetic by hand in a '
        + 'spreadsheet. The maths is not hard, it is just tedious and nobody does it, so groups end up '
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
    if (tgt.closest('#installX')) {
        el('installBanner').classList.add('hidden');
        try { localStorage.setItem('fwf_install', new Date().toISOString().slice(0, 10)); } catch (e) {}
        return;
    }

    var t = tgt.closest && tgt.closest('[data-threshold],[data-set],[data-bag],'
        + '[data-stops],[data-choice],[data-clusterback],[data-seats],'
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
    } else if (t.hasAttribute('data-choice')) {
        /* One tap sets both legs, because the choice is about the trip. */
        var cv = t.getAttribute('data-choice');
        var th = cv === 'Infinity' ? FWF.INF : +cv;
        state.th.outbound = th; state.th['return'] = th;
        writeHash(); render();
        window.scrollTo(0, 0);
    } else if (t.hasAttribute('data-clusterback')) {
        state.q.clusterReturn = !state.q.clusterReturn;
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
    if (el('sFrom')) el('sFrom').value = ob.from || '';
    if (el('sTo')) el('sTo').value = ob.to || '';
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

var calOpen = false, calCursor = null, calPick = null;

function calMonths() {
    return window.matchMedia && window.matchMedia('(min-width: 620px)').matches ? 2 : 1;
}

function monthGrid(y, m) {
    var first = new Date(Date.UTC(y, m, 1));
    var lead = first.getUTCDay();
    var days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    var today = todayISO();
    var dep = state.q.dep, ret = state.q.ret;

    var cells = '';
    for (var i = 0; i < lead; i++) cells += '<span class="cal-cell"></span>';
    for (var d = 1; d <= days; d++) {
        var v = iso(y, m, d);
        var isDep = v === dep, isRet = !!ret && v === ret;
        var inRange = !!(dep && ret && v > dep && v < ret);
        var cls = (isDep ? ' start' : '') + (isRet ? ' end' : '') + (inRange ? ' mid' : '');
        var past = v < today;
        cells += '<span class="cal-cell' + cls + '">'
            + '<button class="cal-d' + (isDep || isRet ? ' on' : '') + (v === today ? ' today' : '')
            + '" data-day="' + v + '"' + (past ? ' disabled' : '')
            + ' aria-label="' + weekdayShort(v) + ' ' + prettyDate(v, true) + '">' + d + '</button></span>';
    }
    return '<div><div class="cal-mon">' + MON[m] + ' ' + y + '</div>'
        + '<div class="cal-dow">' + DOW.map(function (x) { return '<span>' + x + '</span>'; }).join('') + '</div>'
        + '<div class="cal-grid">' + cells + '</div></div>';
}

function renderCal() {
    var host = el('cal');
    if (!calOpen) { host.className = 'cal hidden'; el('dateBtn').setAttribute('aria-expanded', 'false'); return; }
    /* The calendar can be opened from more than one place, so the cursor is
     * established here rather than relying on whoever opened it. */
    if (!calCursor) calCursor = ymd(state.q.dep) || ymd(todayISO());
    host.className = 'cal';
    el('dateBtn').setAttribute('aria-expanded', 'true');

    var n = calMonths();
    var base = calCursor || ymd(state.q.dep) || ymd(todayISO());
    var months = '';
    for (var i = 0; i < n; i++) {
        var mm = base.m + i, yy = base.y + Math.floor(mm / 12);
        months += monthGrid(yy, ((mm % 12) + 12) % 12);
    }

    var tISO = ymd(todayISO());
    var atStart = base.y === tISO.y && base.m === tISO.m;
    var hint = !state.q.dep ? 'Pick the day you fly out'
        : !state.q.ret ? 'Now pick the day you come back, or leave it for a one-way'
        : prettyRange(state.q.dep, state.q.ret);

    host.innerHTML = '<div class="cal-head">'
        + '<button class="cal-nav" data-cal="-1" aria-label="Previous month"' + (atStart ? ' disabled' : '') + '>&#8249;</button>'
        + '<span class="cal-title">' + (n === 2 ? 'Choose your dates' : MON[base.m] + ' ' + base.y) + '</span>'
        + '<button class="cal-nav" data-cal="1" aria-label="Next month">&#8250;</button></div>'
        + '<div class="cal-months' + (n === 2 ? ' two' : '') + '">' + months + '</div>'
        + '<div class="cal-foot"><span class="cal-hint">' + esc(hint) + '</span>'
        + '<span class="cal-acts"><button class="cal-clear" data-cal="clear">Clear</button>'
        + '<button class="btn primary" data-cal="done">Done</button></span></div>';
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
    setDateLabel(); renderCal();
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
        el('destHint').textContent = 'Pick one from the list so we search the right airport';
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
el('newBtn').addEventListener('click', function () {
    state.q = blankQuery(); DATA = null; state.error = null; thReset();
    history.replaceState(null, '', location.pathname);
    fillForm(); renderParties(); showStep(1); render();
});
el('addParty').addEventListener('click', function () {
    if (state.q.parties.length >= APP.maxParties) {
        state.error = 'Maximum ' + APP.maxParties + ' departure cities.'; render(); return;
    }
    readNames();
    state.q.parties.push(newParty(state.q.parties.length));
    renderParties();
});
el('dateBtn').addEventListener('click', function () {
    calOpen = !calOpen;
    calCursor = ymd(state.q.dep) || ymd(todayISO());
    renderCal();
});

el('cal').addEventListener('click', function (ev) {
    var day = ev.target.closest('[data-day]');
    if (day && !day.disabled) { pickDay(day.getAttribute('data-day')); return; }
    var act = ev.target.closest('[data-cal]');
    if (!act) return;
    var v = act.getAttribute('data-cal');
    if (v === 'done') { calOpen = false; renderCal(); el('dateBtn').focus(); }
    else if (v === 'clear') { state.q.dep = ''; state.q.ret = ''; thReset(); syncDateBounds(); renderCal(); }
    else {
        var step = +v;
        var m = calCursor.m + step, y = calCursor.y + Math.floor(m / 12);
        calCursor = { y: y, m: ((m % 12) + 12) % 12, d: 1 };
        renderCal();
    }
});

document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && calOpen) { calOpen = false; renderCal(); el('dateBtn').focus(); }
});

function applyStepBand() {
    state.q.band.outbound = { from: el('sFrom').value, to: el('sTo').value };
    renderBandPresets();
    thReset();
}
document.addEventListener('click', function (ev) {
    var n = ev.target.closest && ev.target.closest('[data-bpre]');
    if (!n) return;
    var k = n.getAttribute('data-bpre');
    if (k === 'exact') {
        state.bandExact = true;
        renderBandPresets();
        if (el('sFrom')) el('sFrom').focus();
        return;
    }
    var pre = BAND_PRESETS.filter(function (x) { return x.k === k; })[0];
    if (!pre) return;
    state.bandExact = false;
    if (el('sFrom')) el('sFrom').value = pre.from;
    if (el('sTo')) el('sTo').value = pre.to;
    applyStepBand();
    renderBandPresets();
});
if (el('sFrom')) el('sFrom').addEventListener('change', applyStepBand);
if (el('sTo')) el('sTo').addEventListener('change', applyStepBand);

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
state.q = migrateQuery((shared && shared.q && shared.q.parties) ? shared.q : blankQuery());
if (shared && shared.v) {
    /* Adopt the sender's reading of the trip so both people see one number. */
    var v = shared.v;
    if (v.target) SET.target = v.target;
    if (v.bags) SET.bags = v.bags;
    if (v.priceDisplay) SET.priceDisplay = v.priceDisplay;
    if (v.leg) state.leg = v.leg;
    if (v.recommend) state.recommend = v.recommend;
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
        el('destHint').textContent = a.note + (a.alternates.length ? ' Try ' + a.alternates.join(', ') + '.' : '');
    } else {
        el('destHint').className = 'hint good';
        el('destHint').textContent = a.city + ' — ' + a.name;
    }
}, { noMetros: true, onEnter: function () { el('to2').click(); } });

el('dest').addEventListener('input', function () {
    if (!AIRPORTS.isKnown(state.q.dest) || el('dest').value.indexOf(state.q.dest) !== 0) state.q.dest = '';
    el('destHint').className = 'hint';
    el('destHint').textContent = 'Airport code or city — try “cabo”';
});

fillForm();
renderParties();
showStep(1);
render();

(function installBanner() {
    var standalone = window.navigator.standalone
        || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    var mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    var seen = null;
    try { seen = localStorage.getItem('fwf_install'); } catch (e) {}
    if (mobile && !standalone && seen !== new Date().toISOString().slice(0, 10)) {
        el('installBanner').classList.remove('hidden');
    }
})();

if (API) {
    fetch(API + '/budget').then(function (r) { return r.json(); })
        .then(function (b) { BUDGET = b; if (state.step === 4) render(); }).catch(function () {});
}

if (sharedId) {
    /* Opening someone else's trip must not cost a search. */
    TRIP_ID = sharedId;
    state.error = null;
    fetch(API + '/trip/' + sharedId).then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, body: j }; });
    }).then(function (res) {
        if (!res.ok || !res.body || !res.body.data) {
            state.error = (res.body && res.body.error) || 'That shared trip could not be loaded.';
            TRIP_ID = null; render(); return;
        }
        var pay = res.body.payload || {};
        if (pay.q && pay.q.parties) state.q = migrateQuery(pay.q);
        if (pay.v) {
            var v = pay.v;
            if (v.target) SET.target = v.target;
            if (v.bags) SET.bags = v.bags;
            if (v.priceDisplay) SET.priceDisplay = v.priceDisplay;
            if (v.recommend) state.recommend = v.recommend;
            if (v.th) {
                state.th.outbound = v.th.outbound === 'inf' ? FWF.INF : v.th.outbound;
                state.th['return'] = v.th['return'] === 'inf' ? FWF.INF : v.th['return'];
            }
        }
        DATA = res.body.data;
        fillForm(); renderParties();
        showStep(4); render();
    }).catch(function (e) {
        state.error = 'Could not load that shared trip: ' + e.message;
        TRIP_ID = null; render();
    });
} else if (shared && shared.q && shared.q.parties && validate() === null) {
    doSearch();
}

})();
