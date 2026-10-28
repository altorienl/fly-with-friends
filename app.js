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

var DATA = null, SET = null, BUDGET = null, C = null;
var state = {
    step: 1, leg: 'outbound', threshold: null, recommend: 'tightest',
    q: null, busy: false, error: null
};

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
    if (meta) meta.setAttribute('content', m === 'light' ? '#fbfbfc' : '#0a0a0b');
}

/* ---------------------------------------------------------- query model */

function newParty(i) {
    return { id: 'p' + i + Math.random().toString(36).slice(2, 5), name: '', seats: 1, airports: [] };
}
function blankQuery() {
    return {
        dest: '', dep: '', ret: '',
        band: { outbound: { from: '', to: '' }, return: { from: '', to: '' } },
        maxStops: null,
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
function currentBand() { return (state.q.band || {})[state.leg] || { from: '', to: '' }; }
function bandMinutes() {
    var b = currentBand();
    var f = FWF.parseTimeOfDay(b.from), t = FWF.parseTimeOfDay(b.to);
    return (f != null && t != null) ? { from: f, to: t } : null;
}

/* ------------------------------------------------------------- compute */

function compute() {
    if (!DATA || !state.q) return null;
    var legData = ((DATA.trips || {}).query || {})[state.leg] || {};
    var tv = travelers();
    var ids = tv.map(function (t) { return t.id; });
    var field = state.leg === 'outbound' ? 'arrive' : 'depart';
    var band = bandMinutes(), maxStops = state.q.maxStops;

    var prep = FWF.prepare(legData, ids, field, { band: band, maxStops: maxStops });
    var costFn = FWF.makeCostFn(tv, {
        assumedCheckedBagFee: APP.bagFee, assumedCarryOnFee: APP.carryOnFee,
        priceDisplay: SET.priceDisplay
    });

    var out = { travelers: tv, ids: ids, prep: prep, costFn: costFn, band: band,
                maxStops: maxStops, tight: null, ladder: null, target: null,
                subset: null, anyTime: null };

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
function attachAc(input, drop, onPick, opts) {
    var matches = [], idx = -1;
    opts = opts || {};

    function close() { drop.classList.add('hidden'); idx = -1; }

    function paint() {
        if (!matches.length) { close(); return; }
        drop.innerHTML = matches.map(function (a, i) {
            return '<button class="ac-item' + (i === idx ? ' active' : '')
                + (a.closed ? ' closed' : '') + '" data-ac="' + i + '">'
                + '<span class="ac-code">' + esc(a.code) + '</span>'
                + '<span class="ac-body"><span class="ac-city">' + esc(a.city)
                + (a.closed ? ' — closed' : '') + '</span>'
                + '<span class="ac-sub">' + esc(a.name) + '</span></span>'
                + '<span class="ac-flag">' + esc(a.country) + '</span></button>';
        }).join('');
        drop.classList.remove('hidden');
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
    drop.addEventListener('mousedown', function (ev) {
        var t = ev.target.closest('[data-ac]');
        if (!t) return;
        ev.preventDefault();
        commit(+t.getAttribute('data-ac'));
    });

    return { close: close };
}

/* ------------------------------------------------------------- steps */

var STEPS = ['Where', 'When', 'Who', 'Flights'];

function showStep(n) {
    state.step = n;
    [1, 2, 3, 4].forEach(function (i) { el('s' + i).classList.toggle('hidden', i !== n); });
    var rail = el('rail');
    rail.classList.toggle('hidden', n === 4);
    if (n !== 4) {
        rail.innerHTML = STEPS.slice(0, 3).map(function (_, i) {
            return '<span class="seg' + (i < n ? ' done' : '') + '"></span>';
        }).join('') + '<span class="lbl">' + STEPS[n - 1] + ' · ' + n + ' of 3</span>';
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
            + '<div class="ava" style="background:' + partyColor(i) + '">' + esc(partyInitials(p, i)) + '</div>'
            + '<input class="inp sans" data-f="name" placeholder="Name (optional)" value="' + esc(p.name) + '" maxlength="22">'
            + '<div class="stepper">'
            + '<button data-seats="-1" aria-label="Fewer"' + (p.seats <= 1 ? ' disabled' : '') + '>&minus;</button>'
            + '<span class="n">' + p.seats + '</span>'
            + '<button data-seats="1" aria-label="More"' + (p.seats >= APP.maxSeats ? ' disabled' : '') + '>+</button>'
            + '</div>'
            + (state.q.parties.length > 2 ? '<button class="party-x" data-rmparty aria-label="Remove">&times;</button>' : '')
            + '</div>'
            + '<span class="k">Flying from</span>'
            + '<div class="chips" style="margin-top:8px">' + chips
            + '<button class="add-air" data-addair>' + (p.airports.length ? '+ another airport' : '+ pick airport') + '</button>'
            + '</div>'
            + '<div class="field hidden" data-airfield style="margin:10px 0 0">'
            + '<input class="inp" data-airinput placeholder="Airport or city" autocapitalize="characters" autocomplete="off">'
            + '<div class="ac hidden" data-airac></div></div>'
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
    state.q.parties = state.q.parties.filter(function (p) { return p.airports.length; });
    if (state.q.parties.length < 2) state.q.parties = state.q.parties.concat([newParty(9)]);

    var bad = validate();
    if (bad) { state.error = bad; render(); return; }

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
        state.threshold = null; state.leg = 'outbound';
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
            state.error = null; state.threshold = null; state.leg = 'outbound';
            fillForm(); renderParties(); showStep(4); render();
        })
        .catch(function (e) { state.error = 'Could not load the example: ' + e.message; render(); });
}

/* ---------------------------------------------------------------- hash */

function writeHash() {
    try {
        var enc = btoa(unescape(encodeURIComponent(JSON.stringify(state.q)))).replace(/=+$/, '');
        history.replaceState(null, '', '#s=' + enc);
    } catch (e) {}
}
function readHash() {
    var m = /[#&]s=([^&]+)/.exec(location.hash || '');
    if (!m) return null;
    try { return JSON.parse(decodeURIComponent(escape(atob(m[1])))); } catch (e) { return null; }
}

/* -------------------------------------------------------------- render */

function render() {
    C = compute();
    renderNotices();
    renderGear();
    el('go').textContent = state.busy ? 'Searching…' : 'Find flights';
    el('go').disabled = state.busy;
    if (state.step !== 4) return;
    if (!C) { showStep(3); return; }
    renderResHead();
    renderTabs();
    renderStopPills();
    renderVerdict();
    renderRecPills();
    renderBoard();
    renderPlan();
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
        bits.push('A total covering ' + (C.ids.length - C.prep.missing.length) + ' of '
            + C.ids.length + ' would be a wrong number, not a partial one.');
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
    return bits.join(' and ');
}

function renderResHead() {
    var q = state.q, a = AIRPORTS.get(q.dest);
    var seats = travelers().reduce(function (n, t) { return n + t.seats; }, 0);
    el('resT').textContent = (a ? a.city : q.dest) + ' · ' + seats + ' travelling';
    var gen = DATA.generated_at ? new Date(DATA.generated_at) : null;
    var hrs = gen ? Math.round((Date.now() - gen.getTime()) / 3600000) : null;
    var cls = hrs == null ? 'fresh-mid' : hrs < 6 ? 'fresh-ok' : hrs < 24 ? 'fresh-mid' : 'fresh-old';
    var word = DATA.sample ? 'example data'
        : hrs == null ? 'unknown age' : hrs < 1 ? 'fares just now' : 'fares ' + hrs + 'h old';
    el('resS').innerHTML = esc(q.dep + (q.ret ? ' → ' + q.ret : ' · one way'))
        + ' &nbsp;<span class="fresh"><span class="dot ' + cls + '"></span>' + esc(word) + '</span>';
}

function renderTabs() {
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
        b.classList.toggle('on', b.getAttribute('data-leg') === state.leg);
        if (b.getAttribute('data-leg') === 'return') b.classList.toggle('hidden', !hasReturn());
    });
    el('bandLbl').textContent = state.leg === 'outbound' ? 'Land between' : 'Leave between';
    var f = el('freeNote');
    if (DATA && !DATA.sample) {
        f.className = 'free';
        f.textContent = 'Filtering is free — it narrows flights already fetched, never a new search.';
    } else f.className = 'free hidden';
}

function renderStopPills() {
    var o = [{ v: 0, l: 'Nonstop' }, { v: 1, l: 'Up to 1 stop' }, { v: null, l: 'Any' }];
    el('stopPills').innerHTML = '<span class="k">Stops</span>' + o.map(function (x) {
        return '<button class="pill' + (state.q.maxStops === x.v ? ' on' : '') + '" data-stops="'
            + (x.v === null ? '' : x.v) + '">' + x.l + '</button>';
    }).join('');
}

function renderRecPills() {
    var o = [{ k: 'tightest', l: 'Closest times' }, { k: 'target', l: 'Cheapest at ' + SET.target + 'm' },
             { k: 'value', l: 'Best value' }];
    el('recPills').innerHTML = '<span class="k">Show</span>' + o.map(function (x) {
        return '<button class="pill' + (state.recommend === x.k ? ' on' : '') + '" data-rec="' + x.k + '">'
            + esc(x.l) + '</button>';
    }).join('');
}

function renderVerdict() {
    var v = el('verdict');
    if (!C.prep.complete) {
        var s = C.subset;
        if (s && s.included.length) {
            v.innerHTML = '<span class="k">Best achievable</span>'
                + '<div class="verdict-big mono">' + s.included.length + '<span class="u">of ' + C.ids.length + '</span></div>'
                + '<span class="tag bad">Not everyone fits</span>'
                + '<div class="note">' + esc(s.included.map(name).join(', ')) + ' can ' + legVerb()
                + ' within ' + FWF.fmtGap(s.summary.spread) + ' for <strong>' + money(s.cost)
                + '</strong>. ' + esc(s.excluded.map(name).join(', ')) + ' cannot, on these filters.</div>';
        } else v.innerHTML = '<div class="note">No plan to show for this leg.</div>';
        return;
    }

    var t = C.tight, meets = t.spread <= SET.target;
    var html = '<span class="k">Tightest ' + (state.leg === 'outbound' ? 'landing' : 'departure') + ' window possible</span>'
        + '<div class="verdict-big mono">' + FWF.fmtGap(t.spread) + '<span class="u">apart</span></div>'
        + '<span class="tag ' + (meets ? 'good' : 'bad') + '">'
        + (meets ? 'Meets your ' + SET.target + '-minute target' : 'Misses your ' + SET.target + '-minute target')
        + '</span>';

    if (C.band || C.maxStops != null) {
        var dropped = C.ids.reduce(function (n, id) { return n + ((C.prep.dropped || {})[id] || 0); }, 0);
        html += '<div class="note">Showing only flights that ' + filterText()
            + (dropped ? ', setting aside ' + dropped + ' other option' + (dropped === 1 ? '' : 's') : '') + '.</div>';
    }

    if (C.target) {
        var base = C.ladder.baseline, prem = C.target.cost - base;
        html += '<div class="note">Everyone can ' + legVerb() + ' within <strong>' + SET.target
            + ' minutes</strong> for <strong>' + money(C.target.cost) + '</strong>. The cheapest scattered option is '
            + money(base) + ', so ' + (prem > 0
                ? 'travelling together costs <strong>' + money(prem) + '</strong> more.'
                : 'travelling together costs nothing extra.') + '</div>'
            + '<div class="split">'
            + '<div><span class="k">Together</span><div class="v mono">' + money(C.target.cost) + '</div></div>'
            + '<div><span class="k">Scattered</span><div class="v mono">' + money(base) + '</div></div>'
            + '<div><span class="k">Cost of together</span><div class="v mono" style="color:var(--accent)">'
            + (prem > 0 ? '+' + money(prem) : money(0)) + '</div></div>'
            + (C.anyTime != null
                ? '<div><span class="k">Cost of your filters</span><div class="v mono" style="color:var(--accent)">'
                  + (base - C.anyTime > 0 ? '+' + money(base - C.anyTime) : money(0)) + '</div></div>' : '')
            + '</div>';
    } else if (C.subset) {
        var sub = C.subset;
        html += '<div class="note"><strong>No combination gets all ' + C.ids.length + ' within '
            + SET.target + ' minutes.</strong> Best achievable is <strong>' + sub.included.length
            + ' of ' + C.ids.length + '</strong> within ' + FWF.fmtGap(sub.summary.spread)
            + ' for ' + money(sub.cost) + '. Outside: ' + esc(sub.excluded.map(function (x) {
                return name(x.id) + ' (+' + FWF.fmtGap(x.gapMinutes) + ')';
            }).join(', ')) + '.</div>';
    }
    v.innerHTML = html;
}

function recommended() {
    var f = C.ladder.rows.filter(function (r) { return r.feasible; });
    if (!C.target && C.subset) return 'subset';
    if (!f.length) return null;
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

function renderBoard() {
    var host = el('brows');
    if (!C.prep.complete || !C.ladder) { host.innerHTML = ''; return; }
    var rec = recommended();
    if (state.threshold === null) state.threshold = rec;

    var html = '';
    if (!C.target && C.subset) {
        var s = C.subset;
        html += '<button class="brow' + (state.threshold === 'subset' ? ' on' : '') + '" data-threshold="subset">'
            + '<span><span class="w">' + s.included.length + ' of ' + C.ids.length + ' within ' + SET.target + 'm</span>'
            + (rec === 'subset' ? '<span class="rec">recommended</span>' : '') + '</span>'
            + '<span class="c mono">' + money(s.cost) + '</span>'
            + '<span class="a mono">' + FWF.fmtGap(s.summary.spread) + '</span>'
            + '<span class="d mono" style="color:var(--faint)">n/a</span></button>';
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
        return '<button class="brow' + (r.threshold === state.threshold ? ' on' : '')
            + '" data-threshold="' + r.threshold + '">'
            + '<span><span class="w">' + label + '</span>'
            + (r.threshold === rec ? '<span class="rec">recommended</span>' : '') + '</span>'
            + '<span class="c mono">' + money(r.result.cost) + '</span>'
            + '<span class="a mono">' + FWF.fmtGap(r.result.spread) + '</span>'
            + '<span class="d mono ' + (r.delta > 0 ? 'up' : '') + '">'
            + (r.delta > 0 ? '+' + money(r.delta) : '—') + '</span></button>';
    }).join('');

    host.innerHTML = html;
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

function renderPlan() {
    var host = el('plan');
    if (!C.prep.complete && !(C.subset && C.subset.included.length)) { host.innerHTML = ''; return; }
    if (!C.prep.complete) state.threshold = 'subset';

    var row = (state.threshold === 'subset' || !C.ladder) ? null
        : C.ladder.rows.filter(function (r) { return r.feasible && r.threshold === state.threshold; })[0];

    var picks, included, excluded = [], spread, cost;
    if (row) { picks = row.result.picks; included = C.ids.slice(); spread = row.result.spread; cost = row.result.cost; }
    else if (C.subset) { picks = C.subset.picks; included = C.subset.included; excluded = C.subset.excluded;
                         spread = C.subset.summary.spread; cost = C.subset.cost; }
    else { host.innerHTML = ''; return; }

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

    html += '<div class="total"><span class="k">Group total'
        + (SET.priceDisplay === 'fare' ? ' · fares only' : ' · incl. bags') + '</span>'
        + '<span class="v mono">' + money(cost) + '</span></div>';
    host.innerHTML = html;
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

    return '<div class="pax' + (out ? ' out' : '') + '">'
        + '<div class="ava" style="background:' + partyColor(i < 0 ? 0 : i) + '">'
        + esc(partyInitials(state.q.parties[i] || { name: t.name }, i < 0 ? 0 : i)) + '</div>'
        + logo
        + '<div class="pax-main"><div class="pax-name">' + esc(t.name) + badges + '</div>'
        + '<div class="pax-meta">' + esc(o.from) + ' &rarr; ' + esc(o.to) + ' · '
        + esc((o.airlines || []).join(', ')) + ' · ' + (o.stops === 0 ? 'nonstop' : o.stops + ' stop')
        + ' · ' + FWF.fmtGap(o.duration_minutes) + '</div>'
        + '<a class="book" href="' + bookUrl(o, t.seats) + '" target="_blank" rel="noopener">Book on Google Flights &rarr;</a>'
        + '</div><div class="pax-right"><div class="pax-time mono">' + clock(show) + '</div>'
        + '<div class="pax-price mono">' + price + '</div>'
        + '<div class="pax-price mono" style="opacity:0.6">'
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

function openSheet(html) {
    el('sheet').innerHTML = '<div class="grip"></div>' + html
        + '<button class="btn primary wide" id="sheetClose" style="margin-top:8px">Done</button>';
    el('sheet').classList.remove('hidden');
    el('scrim').classList.remove('hidden');
}
function closeSheet() { el('sheet').classList.add('hidden'); el('scrim').classList.add('hidden'); }

function settingsSheet() {
    var people = state.q ? travelers() : [];
    var pill = function (on, set, val, label) {
        return '<button class="pill' + (on ? ' on' : '') + '" data-set="' + set + '" data-val="' + val + '">'
            + esc(label) + '</button>';
    };
    var gen = DATA && DATA.generated_at ? new Date(DATA.generated_at) : null;

    openSheet('<h2>Settings</h2><div class="sub">Kept on this device. No account, no sign-in.</div>'
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
    openSheet('<h2>About</h2><div class="sub">Fly with Friends</div><div class="about-body">'
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

    var t = tgt.closest && tgt.closest('[data-threshold],[data-rec],[data-leg],[data-set],[data-bag],'
        + '[data-stops],[data-seats],[data-rmparty],[data-addair],[data-rmair]');
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
    } else if (t.hasAttribute('data-stops')) {
        var raw = t.getAttribute('data-stops');
        state.q.maxStops = raw === '' ? null : +raw;
        state.threshold = null; writeHash(); render();
    } else if (t.hasAttribute('data-threshold')) {
        var v = t.getAttribute('data-threshold');
        state.threshold = v === 'subset' ? 'subset' : (v === 'Infinity' ? FWF.INF : +v);
        render();
    } else if (t.hasAttribute('data-rec')) {
        state.recommend = t.getAttribute('data-rec'); state.threshold = null; render();
    } else if (t.hasAttribute('data-leg')) {
        state.leg = t.getAttribute('data-leg'); state.threshold = null;
        fillBand(); render();
    } else if (t.hasAttribute('data-set')) {
        var key = t.getAttribute('data-set'), val = t.getAttribute('data-val');
        if (key === 'target') val = +val;
        else if (key === 'time24') val = val === '24';
        else if (key === 'meId' && val === '') val = null;
        SET[key] = val; saveSet();
        if (key === 'theme') applyTheme();
        state.threshold = null;
        settingsSheet(); render();
    } else if (t.hasAttribute('data-bag')) {
        var w = t.getAttribute('data-bag');
        var b = { carry_on: SET.bags.carry_on || 0, checked: SET.bags.checked || 0 };
        b[w] = b[w] > 0 ? 0 : 1;
        SET.bags = b; saveSet(); state.threshold = null;
        settingsSheet(); render();
    }
});

function fillBand() {
    var b = currentBand();
    el('bFrom').value = b.from || '';
    el('bTo').value = b.to || '';
}
function fillForm() {
    var a = AIRPORTS.get(state.q.dest);
    el('dest').value = a ? a.code + ' — ' + a.city : (state.q.dest || '');
    el('dep').value = state.q.dep || '';
    el('ret').value = state.q.ret || '';
    fillBand();
}

function applyBand() {
    state.q.band[state.leg] = { from: el('bFrom').value, to: el('bTo').value };
    state.threshold = null; writeHash(); render();
}

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
el('go').addEventListener('click', doSearch);
el('demo').addEventListener('click', loadDemo);
el('newBtn').addEventListener('click', function () {
    state.q = blankQuery(); DATA = null; state.error = null; state.threshold = null;
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
el('bFrom').addEventListener('change', applyBand);
el('bTo').addEventListener('change', applyBand);
el('bClear').addEventListener('click', function () {
    el('bFrom').value = ''; el('bTo').value = ''; applyBand();
});
el('ret').addEventListener('change', function () { state.q.ret = el('ret').value; });

if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () {
        if (SET.theme === 'system') applyTheme();
    });
}

/* ----------------------------------------------------------------- boot */

SET = loadSet();
applyTheme();

var shared = readHash();
state.q = shared && shared.parties ? shared : blankQuery();

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

if (shared && shared.parties && validate() === null) doSearch();

})();
