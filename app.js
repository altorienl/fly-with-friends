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
var state = {
    step: 1, leg: 'outbound', recommend: 'value',
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
function blankQuery() {
    return {
        dest: '', dep: '', ret: '',
        band: { outbound: { from: '', to: '' }, return: { from: '', to: '' } },
        maxStops: null, maxPremium: null,
        parties: [newParty(0), newParty(1), newParty(2)]
    };
}
function partyLabel(p, i) { return (p.name || '').trim() || ('Flight ' + (i + 1)); }

/* Initials where a name was given, the party number where it was not -- so the
 * avatar is always something, and becomes meaningful the moment you type. */
function partyInitials(p, i) {
    var n = (p.name || '').trim();
    if (!n) return String(i + 1);
    return n.split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
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
    return (f != null && t != null) ? { from: f, to: t } : null;
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

    var prep = FWF.prepare(legData, ids, field, { band: band, maxStops: maxStops });

    /* What each party would pay flying whenever they liked, inside the same
     * filters. This is the baseline the premium is measured from, and it is the
     * number that turns one group total into "who is actually absorbing it". */
    var solo = {};
    var loner = FWF.minCostAtWindow(prep, FWF.INF, costFn);
    if (loner) ids.forEach(function (id) { solo[id] = loner.picks[id].cost; });

    /* The fairness cap prunes each party's options to those within their own
     * baseline plus the cap, then re-prepares. Done as a filter on the option
     * set rather than inside the optimiser, so the window algorithms stay
     * exactly as verified. */
    var cap = state.q.maxPremium;
    if (cap != null && loner) {
        var pruned = {};
        ids.forEach(function (id) {
            pruned[id] = (legData[id] || []).filter(function (o) {
                return costFn(o, id) <= solo[id] + cap;
            });
        });
        prep = FWF.prepare(pruned, ids, field, { band: band, maxStops: maxStops });
    }

    var soloOpen = {};
    var openPrep = FWF.prepare(legData, ids, field);
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
                maxStops: maxStops, cap: cap, solo: solo, soloOpen: soloOpen,
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
                + (a.closed ? ' closed' : '') + '" data-ac="' + i + '" role="option" tabindex="-1"'
                + ' id="' + uid + '-' + i + '" aria-selected="' + (i === idx) + '">'
                + '<span class="ac-code">' + esc(a.code) + '</span>'
                + '<span class="ac-body"><span class="ac-city">' + esc(a.city)
                + (a.closed ? ' — no service' : '') + '</span>'
                + '<span class="ac-sub">' + esc(a.name) + '</span></span>'
                + '<span class="ac-flag">' + esc(a.country) + '</span></button>';
        }).join('');
        drop.classList.add('open');
        input.setAttribute('aria-expanded', 'true');
        if (idx >= 0) input.setAttribute('aria-activedescendant', uid + '-' + idx);
    }

    function refresh() {
        matches = AIRPORTS.search(input.value, 7);
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
            + (p.seats > 1 ? '<div class="party-note">' + p.seats + ' seats booked together from one airport.</div>' : '')
            + '</div>';
    }).join('');

    /* Autocomplete is attached per card after each rebuild. */
    Array.prototype.forEach.call(document.querySelectorAll('.party'), function (card) {
        var pid = card.getAttribute('data-pid');
        var input = card.querySelector('[data-airinput]');
        var drop = card.querySelector('[data-airac]');
        attachAc(input, drop, function (a) {
            var p = party(pid);
            if (p && p.airports.indexOf(a.code) === -1) p.airports.push(a.code);
            renderParties();
            var next = document.querySelector('.party[data-pid="' + pid + '"] [data-addair]');
            if (next) next.focus();
        });
    });
}

function party(pid) {
    return state.q.parties.filter(function (p) { return p.id === pid; })[0] || null;
}

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
    if (bad) { state.error = bad; render(); return; }

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
        if (res.body.budget) BUDGET = res.body.budget;
        if (!res.ok) { state.error = res.body.error || 'Search failed.'; render(); return; }
        DATA = res.body;
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
            state.q = {
                dest: 'PIT', dep: '2027-02-12', ret: '2027-02-15',
                band: { outbound: { from: '', to: '' }, return: { from: '', to: '' } },
                maxStops: null,
                parties: [
                    { id: 'alex', name: 'Alex', seats: 1, airports: ['SFO', 'OAK', 'SJC'] },
                    { id: 'sam', name: 'Sam', seats: 2, airports: ['ORD'] },
                    { id: 'jo', name: 'Jo', seats: 1, airports: ['ATL'] },
                    { id: 'ray', name: 'Ray', seats: 1, airports: ['DEN'] }
                ]
            };
            DATA = { generated_at: sample.generated_at, currency: sample.currency,
                     sample: true, trips: { query: sample.trips['pit-feb'] }, errors: [] };
            state.error = null; thReset(); state.leg = 'outbound';
            fillForm(); renderParties(); showStep(4); render();
        })
        .catch(function (e) { state.error = 'Could not load the example: ' + e.message; render(); });
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
    try {
        return location.origin + location.pathname + '#s='
            + btoa(unescape(encodeURIComponent(JSON.stringify(hashPayload())))).replace(/=+$/, '');
    } catch (e) { return location.href; }
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
    var plan = planOf(ctx, state.th[leg] != null ? state.th[leg] : recommendedIn(ctx));
    if (!plan) return null;

    var rows = {};
    plan.included.forEach(function (id) {
        rows[id] = { cost: plan.picks[id].cost, option: plan.picks[id].option, inWindow: true };
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

function renderTripTotal() {
    var host = el('tripTotal');
    var t = tripTotal();
    if (!t) { host.className = 'trip hidden'; return; }
    TRIP = t;
    host.className = 'trip';
    host.innerHTML = '<div class="trip-k">Everyone, '
        + (t.back == null ? 'one way' : 'round trip')
        + (SET.priceDisplay === 'fare' ? ' · fares only' : ' · incl. bags') + '</div>'
        + '<div class="trip-v mono">' + money(t.total) + '</div>'
        + (t.back != null
            ? '<div class="trip-split mono">' + money(t.out) + ' out · ' + money(t.back) + ' back</div>'
            : '')
        + (!t.allClustered
            ? '<div class="trip-split" style="color:var(--bad)">Includes everyone, but not everyone is inside the window — see below.</div>'
            : '');
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
    if (thGet() === null && C.ladder) thSet(recommendedIn(C));
    renderResHead();
    renderTripTotal();
    renderFreeNote();
    renderStopPills();
    renderCapPills();
    renderRecPills();
    renderLegs();
    renderPerPerson();
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

    var sh = el('nShort');
    if (state.step === 4 && C && C.prep && !C.prep.complete) {
        var blocked = C.prep.missing.filter(function (id) { return (C.prep.dropped || {})[id] > 0; });
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
function bandText() { var b = currentBand(); return b.from + '–' + b.to; }
function filterText() {
    var bits = [];
    if (C.band) bits.push(legVerb() + ' between ' + bandText());
    if (C.maxStops === 0) bits.push('are nonstop');
    else if (C.maxStops != null) bits.push('have at most ' + C.maxStops + ' stop');
    if (C.cap != null) bits.push('cost them no more than ' + money(C.cap) + ' over their own cheapest');
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
    el('resS').innerHTML = esc(q.dep + (q.ret ? ' → ' + q.ret : ' · one way'))
        + ' &nbsp;<span class="fresh"><span class="dot ' + cls + '"></span>' + esc(word) + '</span>';
}

function renderFreeNote() {
    var f = el('freeNote');
    if (DATA && !DATA.sample) {
        f.className = 'free';
        f.textContent = 'Filtering is free — it narrows flights already fetched, never a new search.';
    } else f.className = 'free hidden';
}

/* Both legs on one page. Flipping tabs to compare your own outbound against your
 * own return is the friction this app exists to remove, so each leg renders its
 * own window, band, ladder and plan, stacked. */
function bandRow(leg) {
    var b = bandFor(leg);
    return '<div class="filters" role="group" aria-label="Time window">'
        + '<span class="k">' + (leg === 'outbound' ? 'Land between' : 'Leave between') + '</span>'
        + '<div class="row2" style="margin-top:8px">'
        + '<input class="inp" type="time" data-bleg="' + leg + '" data-bend="from" value="' + esc(b.from || '')
        + '" aria-label="Earliest ' + (leg === 'outbound' ? 'landing' : 'departure') + ' time">'
        + '<span class="sep">and</span>'
        + '<input class="inp" type="time" data-bleg="' + leg + '" data-bend="to" value="' + esc(b.to || '')
        + '" aria-label="Latest ' + (leg === 'outbound' ? 'landing' : 'departure') + ' time">'
        + '<button class="pill" data-bclear="' + leg + '">any</button>'
        + '</div></div>';
}

function renderLegs() {
    var prevLeg = state.leg, prevC = C;

    [['outbound', 'legOut', 'legOutH'], ['return', 'legBack', 'legBackH']].forEach(function (cfg) {
        var leg = cfg[0], host = el(cfg[1]);
        if (leg === 'return' && !hasReturn()) { host.className = 'leg hidden'; host.innerHTML = ''; return; }

        state.leg = leg;
        C = compute(leg);
        if (!C) { host.className = 'leg hidden'; host.innerHTML = ''; return; }
        if (thGet() === null && C.ladder) thSet(recommendedIn(C));

        var when = leg === 'outbound' ? state.q.dep : state.q.ret;
        host.className = 'leg';
        host.innerHTML = '<div class="leg-head"><h2 id="' + cfg[2] + '">'
            + (leg === 'outbound' ? 'Getting there' : 'Getting home') + '</h2>'
            + '<span class="when">' + esc(when || '') + '</span></div>'
            + verdictHtml() + planHtml()
            + '<details class="opts"><summary>Other windows and what they cost</summary>'
            + bandRow(leg) + boardHtml() + '</details>';
    });

    state.leg = prevLeg;
    C = prevC;
}

function renderStepPrefs() {
    var cap = el('sCap');
    if (cap) {
        cap.innerHTML = [{ v: null, l: 'No cap' }, { v: 50, l: '$50' }, { v: 100, l: '$100' }, { v: 200, l: '$200' }]
            .map(function (x) {
                var on = state.q.maxPremium === x.v;
                return '<button class="pill' + (on ? ' on' : '') + '" role="radio" aria-checked="' + on
                    + '" data-cap="' + (x.v === null ? '' : x.v) + '">' + x.l + '</button>';
            }).join('');
    }
    var rec = el('sRec');
    if (rec) {
        rec.innerHTML = [{ k: 'value', l: 'Best value' }, { k: 'tightest', l: 'Closest possible' },
                         { k: 'target', l: 'Cheapest under ' + SET.target + 'm' }]
            .map(function (x) {
                var on = state.recommend === x.k;
                return '<button class="pill' + (on ? ' on' : '') + '" role="radio" aria-checked="' + on
                    + '" data-rec="' + x.k + '">' + esc(x.l) + '</button>';
            }).join('');
    }
}

function renderStepStops() {
    var host = el('sStops');
    if (!host) return;
    renderStepPrefs();
    var o = [{ v: 0, l: 'Nonstop' }, { v: 1, l: 'Up to 1 stop' }, { v: null, l: 'Any' }];
    host.innerHTML = o.map(function (x) {
        var on = state.q.maxStops === x.v;
        return '<button class="pill' + (on ? ' on' : '') + '" role="radio" aria-checked="' + on
            + '" data-stops="' + (x.v === null ? '' : x.v) + '">' + x.l + '</button>';
    }).join('');
}

function renderStopPills() {
    var o = [{ v: 0, l: 'Nonstop' }, { v: 1, l: 'Up to 1 stop' }, { v: null, l: 'Any' }];
    el('stopPills').setAttribute('role', 'radiogroup');
    el('stopPills').setAttribute('aria-label', 'Maximum stops');
    el('stopPills').innerHTML = '<span class="k">Stops</span>' + o.map(function (x) {
        var on = state.q.maxStops === x.v;
        return '<button class="pill' + (on ? ' on' : '') + '" role="radio" aria-checked="' + on
            + '" data-stops="' + (x.v === null ? '' : x.v) + '">' + x.l + '</button>';
    }).join('');
}

function renderCapPills() {
    var o = [{ v: null, l: 'No cap' }, { v: 50, l: '$50' }, { v: 100, l: '$100' }, { v: 200, l: '$200' }];
    el('capPills').setAttribute('role', 'radiogroup');
    el('capPills').setAttribute('aria-label', 'Cap on what one party absorbs');
    el('capPills').innerHTML = '<span class="k">Nobody absorbs over</span>' + o.map(function (x) {
        var on = state.q.maxPremium === x.v;
        return '<button class="pill' + (on ? ' on' : '') + '" role="radio" aria-checked="' + on
            + '" data-cap="' + (x.v === null ? '' : x.v) + '">' + x.l + '</button>';
    }).join('');
}

function renderRecPills() {
    var o = [{ k: 'value', l: 'Best value' }, { k: 'tightest', l: 'Closest possible' },
             { k: 'target', l: 'Cheapest under ' + SET.target + 'm' }];
    el('recPills').setAttribute('role', 'radiogroup');
    el('recPills').setAttribute('aria-label', 'Which plan to put forward');
    el('recPills').innerHTML = '<span class="k">Optimise for</span>' + o.map(function (x) {
        var on = state.recommend === x.k;
        return '<button class="pill' + (on ? ' on' : '') + '" role="radio" aria-checked="' + on
            + '" data-rec="' + x.k + '">' + esc(x.l) + '</button>';
    }).join('');
}

function verdictHtml() {
    var v = { innerHTML: '' };
    if (!C.prep.complete) {
        var s = C.subset;
        var cut = C.prep.missing.filter(function (id) { return (C.prep.dropped || {})[id] > 0; });
        if (cut.length) {
            v.innerHTML = '<span class="k">These filters cannot work for everyone</span>'
                + '<div class="verdict-big mono">' + esc(cut.map(name).join(', ')) + '</div>'
                + '<span class="tag bad">' + (cut.length === 1 ? 'has' : 'have')
                + ' no flights that ' + filterText() + '</span>'
                + '<div class="note">There is no plan that includes '
                + (cut.length === 1 ? 'them' : 'them all') + ' on these filters. Loosen one above and '
                + 'the whole group comes back.'
                + (s && s.included.length
                    ? ' Without ' + esc(cut.map(name).join(', ')) + ', the rest can '
                      + legVerb() + ' within ' + FWF.fmtGap(s.summary.spread) + ' for ' + money(s.cost) + '.'
                    : '')
                + '</div>';
            return '<div class="panel">' + v.innerHTML + '</div>';
        }
        if (s && s.included.length) {
            v.innerHTML = '<span class="k">Best achievable</span>'
                + '<div class="verdict-big mono">' + seatsOf(s.included)
                + '<span class="u">of ' + seatsAll() + ' travelling</span></div>'
                + '<span class="tag bad">Not everyone fits</span>'
                + '<div class="note">' + esc(s.included.map(name).join(', ')) + ' can ' + legVerb()
                + ' within ' + FWF.fmtGap(s.summary.spread) + ' for <strong>' + money(s.cost)
                + '</strong>. ' + esc(s.excluded.map(function (x) { return name(x.id); }).join(', '))
                + ' cannot, on these filters.</div>';
        } else v.innerHTML = '<div class="note">No plan to show for this leg.</div>';
        return '<div class="panel">' + v.innerHTML + '</div>';
    }

    var t = C.tight;
    var sel0 = selectedPlan();
    var everyone = sel0 && (!sel0.excluded || !sel0.excluded.length);
    var shownSpread = sel0 ? sel0.spread : t.spread;

    /* A subset spread and a whole-group floor are not comparable, so a subset
     * plan is labelled by how many it covers rather than by a window figure
     * that reads tighter than the group's own best. */
    /* The tag used to read as the app second-guessing its own answer -- "20m
     * apart" then "tightest is 8m" with no reason for the gap. State the trade
     * in money, which is the only thing that makes the choice make sense. */
    var tightest = everyone && C.ladder
        ? C.ladder.rows.filter(function (r) { return r.feasible; })[0] : null;
    var tighterCost = tightest && tightest.result ? tightest.result.cost - (sel0 ? sel0.cost : 0) : 0;

    var html = '<span class="k">' + (everyone
            ? (state.leg === 'outbound' ? 'Everyone lands within' : 'Everyone leaves within')
            : 'Only part of the group') + '</span>'
        + '<div class="verdict-big mono">'
        + (everyone
            ? FWF.fmtGap(shownSpread) + '<span class="u">of each other</span>'
            : seatsOf(sel0.included) + '<span class="u">of ' + seatsAll() + ' travelling</span>')
        + '</div>'
        + '<span class="tag ' + (!everyone ? 'bad'
            : shownSpread === t.spread ? 'good' : 'info') + '">'
        + (!everyone
            ? 'Everyone together needs ' + FWF.fmtGap(t.spread)
            : shownSpread === t.spread
                ? 'As close as this group can get'
                : FWF.fmtGap(t.spread) + ' is possible for ' + money(tighterCost) + ' more')
        + '</span>';

    if (C.band || C.maxStops != null) {
        var dropped = C.ids.reduce(function (n, id) { return n + ((C.prep.dropped || {})[id] || 0); }, 0);
        html += '<div class="note">Showing only flights that ' + filterText()
            + (dropped ? ', setting aside ' + dropped + ' other option' + (dropped === 1 ? '' : 's') : '') + '.</div>';
    }

    if (C.target) {
        var base = C.ladder.baseline;
        var sel = selectedPlan();
        var shown = sel ? sel.cost : C.target.cost;
        var prem = shown - base;
        html += '<div class="split">'
            + '<div><span class="k">This plan</span><div class="v mono">' + money(shown) + '</div></div>'
            + '<div><span class="k">Scattered</span><div class="v mono">' + money(base) + '</div></div>'
            + '<div><span class="k">Cost of together</span><div class="v mono" style="color:var(--accent)">'
            + (prem > 0 ? '+' + money(prem) : money(0)) + '</div></div>'
            + (C.anyTime != null
                ? '<div><span class="k">Cost of your filters</span><div class="v mono" style="color:var(--accent)">'
                  + (base - C.anyTime > 0 ? '+' + money(base - C.anyTime) : money(0)) + '</div></div>' : '')
            + '</div>'
            + whoPays(selectedPlan());
    } else if (C.subset) {
        var sub = C.subset;
        html += '<div class="note"><strong>No combination gets all ' + seatsAll() + ' within '
            + SET.target + ' minutes.</strong> Best achievable is <strong>' + seatsOf(sub.included)
            + ' of ' + seatsAll() + '</strong> within ' + FWF.fmtGap(sub.summary.spread)
            + ' for ' + money(sub.cost) + '. Outside: ' + esc(sub.excluded.map(function (x) {
                return name(x.id) + ' (+' + FWF.fmtGap(x.gapMinutes) + ')';
            }).join(', ')) + '.</div>';
    }
    return '<div class="panel">' + html + '</div>';
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
    if (!row) return null;
    return { picks: row.result.picks, included: ctx.ids.slice(), excluded: [],
             spread: row.result.spread, cost: row.result.cost, subset: false };
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
    if (!ctx.target) return f[0].threshold;
    if (state.recommend === 'tightest') return f[0].threshold;
    if (state.recommend === 'target') {
        var at = f.filter(function (r) { return r.threshold <= SET.target; });
        return (at.length ? at[at.length - 1] : f[0]).threshold;
    }
    var best = f[0], rate = -1;
    for (var i = 1; i < f.length; i++) {
        if (f[i].threshold === FWF.INF) continue;
        var add = f[i].threshold - f[i - 1].threshold;
        if (add <= 0) continue;
        var r = (f[i - 1].result.cost - f[i].result.cost) / add;
        if (r > rate) { rate = r; best = f[i]; }
    }
    return best.threshold;
}

function boardHtml() {
    if (!C.prep.complete || !C.ladder) return '';
    var rec = recommendedIn(C);
    if (thGet() === null) thSet(rec);

    var html = '';
    if (!C.target && C.subset) {
        var s = C.subset;
        html += '<button class="brow' + (thGet() === 'subset' ? ' on' : '') + '" data-threshold="subset">'
            + '<span><span class="w">' + seatsOf(s.included) + ' of ' + seatsAll()
            + ' within ' + SET.target + 'm</span>'
            + (rec === 'subset' ? '<span class="rec">recommended</span>' : '') + '</span>'
            + '<span class="c mono">' + money(s.cost) + '</span>'
            + '<span class="a mono">' + FWF.fmtGap(s.summary.spread) + '</span>'
            + '<span class="d mono dim" title="Not comparable: covers fewer people">n/a</span></button>';
    }

    var bad = C.ladder.rows.filter(function (r) { return !r.feasible; });
    if (bad.length) {
        var lo = bad[0].threshold, hi = bad[bad.length - 1].threshold;
        html += '<div class="brow off"><span class="w">'
            + (lo === hi ? 'Within ' + lo + ' min' : 'Within ' + lo + '–' + hi + ' min')
            + '</span><span class="none">nothing covers everyone</span></div>';
    }

    html += C.ladder.rows.filter(function (r) { return r.feasible; }).map(function (r) {
        var label = r.threshold === FWF.INF ? 'Any time' : 'Within ' + r.threshold + ' min';
        var sel = r.threshold === thGet();
        var spoken = label + ', ' + money(r.result.cost) + ' total, '
            + FWF.fmtGap(r.result.spread) + ' apart'
            + (r.delta > 0 ? ', ' + money(r.delta) + ' more than the cheapest' : ', the cheapest option');
        return '<button class="brow' + (sel ? ' on' : '') + '" role="listitem"'
            + (sel ? ' aria-current="true"' : '') + ' aria-label="' + esc(spoken) + '"'
            + ' data-threshold="' + r.threshold + '">'
            + '<span><span class="w">' + label + '</span>'
            + (r.threshold === rec ? '<span class="rec">recommended</span>' : '') + '</span>'
            + '<span class="c mono">' + money(r.result.cost) + '</span>'
            + '<span class="a mono">' + FWF.fmtGap(r.result.spread) + '</span>'
            + '<span class="d mono ' + (r.delta > 0 ? 'up' : '') + '">'
            + (r.delta > 0 ? '+' + money(r.delta) : '—') + '</span></button>';
    }).join('');

    return '<div class="board">'
        + '<div class="bhead"><span class="k">Window</span><span class="k">Group</span>'
        + '<span class="k">Actual</span><span class="k">vs min</span></div>'
        + '<div role="list">' + html + '</div></div>';
}

/* Airline booking entry points. Deliberately NOT prefilled deep links: those
 * formats are undocumented, change without notice, and several carriers block
 * anything that looks automated -- a link that lands on an empty search is
 * worse than one that works. Google Flights stays primary because it is
 * prefilled and its own page carries the airline's book button; this is the
 * second tap for people who would rather buy direct. */
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

function bookUrl(o, seats) {
    /* Route, date and carrier, built at click time. booking_token is not used:
     * live responses carried none at all, and its lifetime is undocumented even
     * when present. This lands on a filtered search, not a checkout. */
    var carrier = (o.airlines || [])[0];
    var q = 'Flights from ' + o.from + ' to ' + o.to + ' on ' + String(o.depart).slice(0, 10)
        + (carrier ? ' ' + carrier : '') + (seats > 1 ? ' ' + seats + ' passengers' : '');
    return 'https://www.google.com/travel/flights?q=' + encodeURIComponent(q);
}

/* "If I'm Fran, what do I pay?" -- the question the group total never answered.
 * One row per party, both legs, including bags, with the seat count applied. */
function renderPerPerson() {
    var host = el('perPerson');
    if (!TRIP || !C) { host.className = 'panel hidden'; return; }

    var rows = C.ids.map(function (id, i) {
        var t = C.travelers.filter(function (x) { return x.id === id; })[0];
        var pp = TRIP.perPerson[id];
        if (!t || !pp || pp.total == null) return '';
        var idx = state.q.parties.map(function (x) { return x.id; }).indexOf(id);
        var apart = !pp.outInWindow || !pp.backInWindow;
        return '<div class="pp' + (apart ? ' apart' : '') + '">'
            + '<div class="ava" aria-hidden="true" style="background:' + partyColor(idx < 0 ? 0 : idx) + '">'
            + esc(partyInitials(state.q.parties[idx] || { name: t.name }, idx < 0 ? 0 : idx)) + '</div>'
            + '<div class="pp-main"><div class="pp-name">' + esc(t.name)
            + (t.seats > 1 ? ' <span class="badge seats">' + t.seats + ' seats</span>' : '')
            + (apart ? ' <span class="badge out">not in the window</span>' : '') + '</div>'
            + '<div class="pp-sub mono">' + (pp.back != null
                ? money(pp.out) + ' out + ' + money(pp.back) + ' back'
                : money(pp.out) + ' one way')
            + (t.seats > 1 ? ' · ' + money(Math.round(pp.total / t.seats)) + ' each' : '') + '</div></div>'
            + '<div class="pp-v mono">' + money(pp.total) + '</div></div>';
    }).join('');

    host.className = 'panel';
    host.innerHTML = '<span class="k">What each person pays</span>'
        + '<div class="pp-list">' + rows + '</div>'
        + '<div class="pp-total"><span class="k">Everyone, '
        + (TRIP.back != null ? 'round trip' : 'one way') + '</span>'
        + '<span class="mono">' + money(TRIP.total) + '</span></div>'
        + '<div class="pp-note">'
        + (TRIP.back != null
            ? 'Priced as two one-ways, which is usually the cheaper way to buy when people '
              + 'are coming from different cities — book each leg separately. '
            : '')
        + 'Bags are an assumption where Google publishes no price. '
        + 'Fares move — confirm on the airline before paying.</div>';
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
        + state.q.dep + (state.q.ret ? ' – ' + state.q.ret : ' one way'));
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

function renderShare() {
    var host = el('shareBox');
    if (!TRIP) { host.innerHTML = ''; return; }
    host.innerHTML = '<button class="btn primary wide" id="copyBtn">Copy the whole trip for the group chat</button>'
        + '<div class="share-note" id="copyNote">Both legs, every person\u2019s flight and what each of them pays, '
        + 'plus a link that opens on these exact choices.</div>';

    el('copyBtn').addEventListener('click', function () {
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
    });
}

function planHtml() {
    if (!C.prep.complete && !(C.subset && C.subset.included.length)) return '';
    if (!C.prep.complete) thSet('subset');

    var plan = selectedPlan();
    if (!plan) return '';
    var picks = plan.picks, included = plan.included, excluded = plan.excluded || [];
    var spread = plan.spread, cost = plan.cost, row = !plan.subset;

    var seats = included.reduce(function (n, id) {
        return n + (C.travelers.filter(function (t) { return t.id === id; })[0] || {}).seats;
    }, 0);

    var html = '<div class="plan-head"><div class="t">' + (row ? 'The plan' : 'Best achievable') + '</div>'
        + '<div class="s">' + seats + ' ' + (state.leg === 'outbound' ? 'on the ground' : 'wheels up')
        + ' within ' + FWF.fmtGap(spread) + '</div></div>';

    html += timeline(picks, included, excluded);

    var known = 0, assumed = 0;
    included.forEach(function (id) {
        var t = C.travelers.filter(function (x) { return x.id === id; })[0];
        var b = FWF.allInCost(picks[id].option, t, { assumedCheckedBagFee: APP.bagFee, assumedCarryOnFee: APP.carryOnFee });
        if (b.bagFee > 0) { if (b.estimated) assumed++; else known++; }
    });
    C.allAssumed = assumed > 0 && known === 0;
    if (C.allAssumed && SET.priceDisplay !== 'fare') {
        html += '<div class="notice warn" style="margin-bottom:10px"><b>No bag prices published.</b> '
            + 'Google returns only “checked baggage for a fee”, so ' + money(APP.bagFee)
            + ' per checked bag is assumed for everyone. Same assumption on every option, so it moves the '
            + 'totals but not which plan wins.</div>';
    }

    included.slice().sort(function (a, b) {
        return picks[a].option.clusterMin - picks[b].option.clusterMin;
    }).forEach(function (id) { html += paxRow(id, picks[id], false); });
    excluded.forEach(function (x) { html += paxRow(x.id, { option: x.nearest }, true, x.gapMinutes); });

    /* Calling this a GROUP total while somebody is excluded is exactly the
     * "wrong number, not a partial one" failure guarded against elsewhere: the
     * excluded party's fare is not in it, so say whose and how much. */
    var partial = excluded.length > 0;
    var seatsIn = included.reduce(function (n, id) {
        return n + (C.travelers.filter(function (t) { return t.id === id; })[0] || {}).seats;
    }, 0);
    var seatsAll = C.travelers.reduce(function (n, t) { return n + t.seats; }, 0);

    /* Scoped deliberately: this is the cost of the people in the window on this
     * leg, not the trip. The trip figure is at the top and covers everybody. */
    html += '<div class="total' + (partial ? ' partial' : '') + '">'
        + '<span class="k">' + (partial
            ? seatsIn + ' of ' + seatsAll + ' in this window'
            : 'Everyone, this leg')
        + (SET.priceDisplay === 'fare' ? ' · fares only' : ' · incl. bags') + '</span>'
        + '<span class="v mono">' + money(cost) + '</span></div>';

    if (partial) {
        html += '<div class="total-note">' + esc(excluded.map(function (x) { return name(x.id); }).join(', '))
            + ' ' + (excluded.length === 1 ? 'is' : 'are') + ' not in that figure. '
            + 'The trip total at the top includes ' + (excluded.length === 1 ? 'them' : 'them all') + '.</div>';
    }

    return html;
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
        + esc((o.airlines || []).join(', ')) + ' · ' + (o.stops === 0 ? 'nonstop' : o.stops + ' stop')
        + ' · ' + FWF.fmtGap(o.duration_minutes) + '</div>'
        + premLine
        + '<div class="links"><a class="book" href="' + bookUrl(o, t.seats) + '" target="_blank" rel="noopener">'
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

        + '<div class="grp"><span class="k">Bags, per person</span><div class="pills">'
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
    if (tgt.closest('#gearBtn')) { settingsSheet(); return; }
    if (tgt.closest('#aboutBtn')) { aboutSheet(); return; }
    if (tgt.id === 'sheetClose' || tgt.id === 'scrim') { closeSheet(); return; }
    if (tgt.closest('#installX')) {
        el('installBanner').classList.add('hidden');
        try { localStorage.setItem('fwf_install', new Date().toISOString().slice(0, 10)); } catch (e) {}
        return;
    }

    var t = tgt.closest && tgt.closest('[data-threshold],[data-rec],[data-set],[data-bag],'
        + '[data-stops],[data-cap],[data-seats],[data-rmparty],[data-addair],[data-rmair]');
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
    } else if (t.hasAttribute('data-cap')) {
        var rawCap = t.getAttribute('data-cap');
        state.q.maxPremium = rawCap === '' ? null : +rawCap;
        thReset(); renderStepStops(); writeHash(); render();
    } else if (t.hasAttribute('data-stops')) {
        var raw = t.getAttribute('data-stops');
        state.q.maxStops = raw === '' ? null : +raw;
        thReset(); renderStepStops(); writeHash(); render();
    } else if (t.hasAttribute('data-threshold')) {
        var v = t.getAttribute('data-threshold');
        var sect = t.closest('.leg');
        var legOf = sect && sect.id === 'legBack' ? 'return' : 'outbound';
        state.th[legOf] = v === 'subset' ? 'subset' : (v === 'Infinity' ? FWF.INF : +v);
        render();
    } else if (t.hasAttribute('data-rec')) {
        state.recommend = t.getAttribute('data-rec'); thReset(); renderStepStops(); render();
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

/* A date input with no value opens at `min`, so pointing the return's min at
 * the departure date is what stops it opening months earlier. */
function syncDateBounds() {
    el('dep').min = todayISO();
    el('ret').min = state.q.dep || todayISO();
    if (state.q.ret && state.q.dep && state.q.ret < state.q.dep) {
        state.q.ret = ''; el('ret').value = '';
    }
}

function fillForm() {
    var a = AIRPORTS.get(state.q.dest);
    el('dest').value = a ? a.code + ' — ' + a.city : (state.q.dest || '');
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
        return;
    }
    showStep(2);
    if (!el('dep').value) setTimeout(function () { el('dep').focus(); }, 80);
});
el('to3').addEventListener('click', function () {
    state.q.dep = el('dep').value; state.q.ret = el('ret').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(state.q.dep)) { state.error = 'Pick a departure date.'; render(); return; }
    if (state.q.ret && state.q.ret < state.q.dep) { state.error = 'The return date is before the departure date.'; render(); return; }
    state.error = null; render(); showStep(3);
});
el('back2').addEventListener('click', function () { showStep(1); });
el('back3').addEventListener('click', function () { showStep(2); });
el('back4').addEventListener('click', function () { showStep(3); });
el('go').addEventListener('click', function () { if (!state.busy) doSearch(); });
el('demo').addEventListener('click', loadDemo);
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
el('dep').addEventListener('change', function () {
    state.q.dep = el('dep').value;
    syncDateBounds();
});
el('ret').addEventListener('change', function () { state.q.ret = el('ret').value; });

function applyStepBand() {
    state.q.band.outbound = { from: el('sFrom').value, to: el('sTo').value };
    thReset();
}
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

var shared = readHash();
state.q = (shared && shared.q && shared.q.parties) ? shared.q : blankQuery();
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
    el('dest').value = a.code + ' — ' + a.city;
    if (a.closed) {
        el('destHint').className = 'hint bad';
        el('destHint').textContent = a.note + (a.alternates.length ? ' Try ' + a.alternates.join(', ') + '.' : '');
    } else {
        el('destHint').className = 'hint good';
        el('destHint').textContent = a.city + ' — ' + a.name;
    }
}, { onEnter: function () { el('to2').click(); } });

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
        .then(function (b) { BUDGET = b; }).catch(function () {});
}

if (shared && shared.q && shared.q.parties && validate() === null) doSearch();

})();
