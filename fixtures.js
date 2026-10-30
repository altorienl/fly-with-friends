/* Fixtures for the named-match profiles.
 *
 * Shaped like the provider payload compute() consumes: one list of options per
 * party per leg. The structure is what matters -- a hub party has several
 * nonstops in the usual morning/midday/evening banks plus cheaper connections;
 * a small-city party has no nonstop at all and three sparse arrivals; a budget
 * carrier shows up under the mainline fare without a bag.
 *
 * Deterministic (seeded) so a run is reproducible and a profile that changes
 * answer is a real change, not noise. */

function rng(seed) {
    var s = seed >>> 0;
    return function () {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function stamp(day, minutes) {
    var h = Math.floor(minutes / 60) % 24, m = minutes % 60;
    var d = day + Math.floor(minutes / 1440);
    return '2027-02-' + (d < 10 ? '0' + d : d) + ' '
        + (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m);
}

/* One option. `arrive` is destination wall clock (the only time the optimiser
 * clusters on for the outbound); `depart` is derived and only ever displayed. */
function opt(o) {
    return {
        price: Math.round(o.price),
        depart: stamp(o.day, o.arriveMin - o.dur),
        arrive: stamp(o.day, o.arriveMin),
        duration_minutes: o.dur,
        stops: o.stops,
        airlines: o.airlines,
        from: o.from, to: o.to,
        airline_logo: null, booking_token: null,
        extensions: o.ulcc ? ['Carry-on bag for a fee'] : ['Checked baggage for a fee'],
        bags: o.ulcc
            ? { carry_on_included: false, checked_first_price: 65, confidence: 'parsed' }
            : { carry_on_included: true, checked_first_price: null, confidence: 'fee_unknown' }
    };
}

/* A party's option list for one leg.
 *   nonstopDur  minutes in the air on the nonstop (0 = no nonstop exists)
 *   fare        the going nonstop fare
 *   banks       destination-local arrival minutes for the nonstops
 *   conns       [{ arriveMin, extraDur, discount, stops }]
 */
function partyLeg(spec, r) {
    var list = [];
    (spec.banks || []).forEach(function (b, i) {
        list.push(opt({ day: spec.day, arriveMin: b, dur: spec.nonstopDur,
                        stops: 0, price: spec.fare * (0.9 + 0.25 * r()),
                        airlines: [spec.carrier], from: spec.from, to: spec.to }));
        void i;
    });
    (spec.conns || []).forEach(function (c) {
        list.push(opt({ day: spec.day, arriveMin: c.arriveMin,
                        dur: (spec.nonstopDur || c.baseDur || 240) + c.extraDur,
                        stops: c.stops == null ? 1 : c.stops,
                        price: spec.fare * c.discount,
                        airlines: c.airlines || [spec.carrier],
                        from: spec.from, to: spec.to }));
    });
    (spec.ulcc || []).forEach(function (u) {
        list.push(opt({ day: spec.day, arriveMin: u.arriveMin,
                        dur: (spec.nonstopDur || 240) + (u.extraDur || 0),
                        stops: u.stops == null ? 0 : u.stops,
                        price: spec.fare * u.discount,
                        airlines: [u.carrier || 'Frontier'],
                        from: spec.from, to: spec.to, ulcc: true }));
    });
    return list;
}

/* ------------------------------------------------------------- groups */

/* 1. Three people, two coasts and the middle. Austin for a long weekend.
 *    Every party has nonstops; the question is purely cost vs closeness. */
function threeCoasts() {
    var r = rng(11);
    var out = {
        kay: partyLeg({ day: 12, from: 'SFO', to: 'AUS', nonstopDur: 215, fare: 268,
                        carrier: 'Alaska', banks: [610, 905, 1255],
                        conns: [{ arriveMin: 790, extraDur: 165, discount: 0.74, airlines: ['United'] },
                                { arriveMin: 1095, extraDur: 140, discount: 0.81, airlines: ['American'] }],
                        ulcc: [{ arriveMin: 1310, discount: 0.52, carrier: 'Spirit' }] }, r),
        wes: partyLeg({ day: 12, from: 'BOS', to: 'AUS', nonstopDur: 255, fare: 294,
                        carrier: 'JetBlue', banks: [700, 960, 1290],
                        conns: [{ arriveMin: 860, extraDur: 175, discount: 0.72, airlines: ['Delta'] },
                                { arriveMin: 1145, extraDur: 120, discount: 0.86, airlines: ['American'] }] }, r),
        nia: partyLeg({ day: 12, from: 'ORD', to: 'AUS', nonstopDur: 170, fare: 212,
                        carrier: 'United', banks: [640, 925, 1215],
                        conns: [{ arriveMin: 800, extraDur: 150, discount: 0.70, airlines: ['Delta'] },
                                { arriveMin: 1150, extraDur: 95, discount: 0.88, airlines: ['Southwest'] }] }, r)
    };
    var r2 = rng(12);
    var back = {
        kay: partyLeg({ day: 15, from: 'AUS', to: 'SFO', nonstopDur: 235, fare: 258,
                        carrier: 'Alaska', banks: [480, 790, 1140],
                        conns: [{ arriveMin: 960, extraDur: 170, discount: 0.75, airlines: ['United'] }] }, r2),
        wes: partyLeg({ day: 15, from: 'AUS', to: 'BOS', nonstopDur: 240, fare: 286,
                        carrier: 'JetBlue', banks: [445, 835, 1190],
                        conns: [{ arriveMin: 980, extraDur: 160, discount: 0.73, airlines: ['Delta'] }] }, r2),
        nia: partyLeg({ day: 15, from: 'AUS', to: 'ORD', nonstopDur: 160, fare: 205,
                        carrier: 'United', banks: [520, 880, 1205],
                        conns: [{ arriveMin: 1020, extraDur: 130, discount: 0.71, airlines: ['Delta'] }] }, r2)
    };
    return {
        name: 'Three, two coasts and the middle (SFO / BOS / ORD -> AUS)',
        dest: 'AUS', dep: '2027-02-12', ret: '2027-02-15',
        parties: [{ id: 'kay', name: 'Kay', seats: 1, airports: ['SFO'] },
                  { id: 'wes', name: 'Wes', seats: 1, airports: ['BOS'] },
                  { id: 'nia', name: 'Nia', seats: 1, airports: ['ORD'] }],
        trip: { outbound: out, 'return': back }
    };
}

/* 2. Five, one of them in a small city. A wedding in Nashville. Tess flies out
 *    of Bozeman: no nonstop, three arrivals all day, and whatever the group
 *    does she is the binding constraint. This is the case the whole app exists
 *    for, and the one where "cheapest" and "closest" pull hardest apart. */
function fiveWithSmallCity() {
    var r = rng(21);
    var out = {
        dee: partyLeg({ day: 12, from: 'JFK', to: 'BNA', nonstopDur: 160, fare: 224,
                        carrier: 'Delta', banks: [645, 900, 1170, 1320],
                        conns: [{ arriveMin: 775, extraDur: 145, discount: 0.71, airlines: ['American'] },
                                { arriveMin: 1055, extraDur: 110, discount: 0.84, airlines: ['United'] }] }, r),
        hugo: partyLeg({ day: 12, from: 'LAX', to: 'BNA', nonstopDur: 245, fare: 296,
                         carrier: 'American', banks: [720, 1010, 1300],
                         conns: [{ arriveMin: 865, extraDur: 190, discount: 0.68, airlines: ['United'] },
                                 { arriveMin: 1120, extraDur: 130, discount: 0.82, airlines: ['Delta'] }],
                         ulcc: [{ arriveMin: 1340, discount: 0.55, carrier: 'Spirit' }] }, r),
        pia: partyLeg({ day: 12, from: 'DFW', to: 'BNA', nonstopDur: 115, fare: 178,
                        carrier: 'American', banks: [600, 855, 1105, 1290],
                        conns: [{ arriveMin: 960, extraDur: 125, discount: 0.69, airlines: ['Delta'] }] }, r),
        omar: partyLeg({ day: 12, from: 'MCO', to: 'BNA', nonstopDur: 125, fare: 165,
                         carrier: 'Southwest', banks: [665, 930, 1225],
                         conns: [{ arriveMin: 820, extraDur: 135, discount: 0.70, airlines: ['Delta'] }],
                         ulcc: [{ arriveMin: 1015, discount: 0.58, carrier: 'Frontier' }] }, r),
        /* No nonstop out of Bozeman. Three arrivals, far apart, all connecting.
         * The 09:35 is cheap and early; the 17:10 is dear and lands with the
         * evening bank; the 13:20 is the middle on both. */
        tess: partyLeg({ day: 12, from: 'BZN', to: 'BNA', nonstopDur: 0, fare: 402,
                         carrier: 'United', banks: [],
                         conns: [{ arriveMin: 575, baseDur: 300, extraDur: 65, discount: 0.78, stops: 1, airlines: ['United'] },
                                 { arriveMin: 800, baseDur: 300, extraDur: 125, discount: 0.86, stops: 1, airlines: ['Delta'] },
                                 { arriveMin: 1030, baseDur: 300, extraDur: 40, discount: 1.04, stops: 1, airlines: ['American'] },
                                 { arriveMin: 1245, baseDur: 300, extraDur: 215, discount: 0.81, stops: 2, airlines: ['Delta'] }] }, r)
    };
    var r2 = rng(22);
    var back = {
        dee: partyLeg({ day: 15, from: 'BNA', to: 'JFK', nonstopDur: 150, fare: 218,
                        carrier: 'Delta', banks: [470, 760, 1080],
                        conns: [{ arriveMin: 915, extraDur: 140, discount: 0.72, airlines: ['American'] }] }, r2),
        hugo: partyLeg({ day: 15, from: 'BNA', to: 'LAX', nonstopDur: 265, fare: 288,
                         carrier: 'American', banks: [505, 845, 1150],
                         conns: [{ arriveMin: 995, extraDur: 170, discount: 0.70, airlines: ['United'] }] }, r2),
        pia: partyLeg({ day: 15, from: 'BNA', to: 'DFW', nonstopDur: 120, fare: 172,
                        carrier: 'American', banks: [440, 735, 1035, 1240],
                        conns: [{ arriveMin: 880, extraDur: 130, discount: 0.71, airlines: ['Delta'] }] }, r2),
        omar: partyLeg({ day: 15, from: 'BNA', to: 'MCO', nonstopDur: 130, fare: 160,
                         carrier: 'Southwest', banks: [495, 800, 1125],
                         conns: [{ arriveMin: 940, extraDur: 125, discount: 0.69, airlines: ['Delta'] }] }, r2),
        tess: partyLeg({ day: 15, from: 'BNA', to: 'BZN', nonstopDur: 0, fare: 395,
                         carrier: 'United', banks: [],
                         conns: [{ arriveMin: 530, baseDur: 310, extraDur: 70, discount: 0.80, stops: 1, airlines: ['United'] },
                                 { arriveMin: 915, baseDur: 310, extraDur: 140, discount: 0.88, stops: 1, airlines: ['Delta'] },
                                 { arriveMin: 1180, baseDur: 310, extraDur: 50, discount: 1.02, stops: 1, airlines: ['American'] }] }, r2)
    };
    return {
        name: 'Five, one in a small city (JFK / LAX / DFW / MCO / BZN -> BNA)',
        dest: 'BNA', dep: '2027-02-12', ret: '2027-02-15',
        parties: [{ id: 'dee', name: 'Dee', seats: 1, airports: ['JFK'] },
                  { id: 'hugo', name: 'Hugo', seats: 2, airports: ['LAX'] },
                  { id: 'pia', name: 'Pia', seats: 1, airports: ['DFW'] },
                  { id: 'omar', name: 'Omar', seats: 1, airports: ['MCO'] },
                  { id: 'tess', name: 'Tess', seats: 1, airports: ['BZN'] }],
        trip: { outbound: out, 'return': back }
    };
}

/* 3. Eight parties across time zones, landing in Lisbon. Four from North
 *    America on overnights, three from Europe on short hops, one from Asia with
 *    two connections whatever happens. The arrival banks barely overlap, which
 *    is where "closest" starts costing real money. */
function eightTimeZones() {
    var r = rng(31);
    var out = {
        ana: partyLeg({ day: 12, from: 'LIS', to: 'LIS', nonstopDur: 0, fare: 0, carrier: 'x', banks: [] }, r),
        /* (placeholder replaced below; kept so the shape is obvious) */
    };
    delete out.ana;
    out.bo = partyLeg({ day: 12, from: 'JFK', to: 'LIS', nonstopDur: 400, fare: 486,
                        carrier: 'TAP Air Portugal', banks: [430, 520],
                        conns: [{ arriveMin: 650, extraDur: 190, discount: 0.76, airlines: ['Lufthansa'] },
                                { arriveMin: 905, extraDur: 150, discount: 0.83, airlines: ['British Airways'] }] }, r);
    out.cleo = partyLeg({ day: 12, from: 'SFO', to: 'LIS', nonstopDur: 0, fare: 642,
                          carrier: 'United', banks: [],
                          conns: [{ arriveMin: 605, baseDur: 620, extraDur: 95, discount: 0.88, stops: 1, airlines: ['United'] },
                                  { arriveMin: 820, baseDur: 620, extraDur: 150, discount: 0.79, stops: 1, airlines: ['Air France'] },
                                  { arriveMin: 1075, baseDur: 620, extraDur: 60, discount: 1.06, stops: 1, airlines: ['TAP Air Portugal'] }] }, r);
    out.dmitri = partyLeg({ day: 12, from: 'YYZ', to: 'LIS', nonstopDur: 395, fare: 452,
                            carrier: 'Air Canada', banks: [445, 615],
                            conns: [{ arriveMin: 860, extraDur: 165, discount: 0.74, airlines: ['Lufthansa'] }] }, r);
    out.esme = partyLeg({ day: 12, from: 'ORD', to: 'LIS', nonstopDur: 0, fare: 528,
                           carrier: 'TAP Air Portugal', banks: [],
                           conns: [{ arriveMin: 580, baseDur: 540, extraDur: 80, discount: 0.90, stops: 1, airlines: ['TAP Air Portugal'] },
                                   { arriveMin: 940, baseDur: 540, extraDur: 135, discount: 0.77, stops: 1, airlines: ['Iberia'] }] }, r);
    out.finn = partyLeg({ day: 12, from: 'LHR', to: 'LIS', nonstopDur: 160, fare: 148,
                          carrier: 'British Airways', banks: [620, 790, 1035, 1250],
                          conns: [{ arriveMin: 900, extraDur: 170, discount: 0.72, airlines: ['Iberia'] }],
                          ulcc: [{ arriveMin: 1180, discount: 0.48, carrier: 'Ryanair' }] }, r);
    out.gita = partyLeg({ day: 12, from: 'CDG', to: 'LIS', nonstopDur: 150, fare: 136,
                          carrier: 'Air France', banks: [585, 755, 1010, 1265],
                          conns: [{ arriveMin: 880, extraDur: 155, discount: 0.74, airlines: ['Iberia'] }] }, r);
    out.hana = partyLeg({ day: 12, from: 'BER', to: 'LIS', nonstopDur: 215, fare: 162,
                          carrier: 'Lufthansa', banks: [660, 965, 1225],
                          conns: [{ arriveMin: 835, extraDur: 145, discount: 0.75, airlines: ['Swiss'] }] }, r);
    out.ikaika = partyLeg({ day: 12, from: 'NRT', to: 'LIS', nonstopDur: 0, fare: 918,
                            carrier: 'ANA', banks: [],
                            conns: [{ arriveMin: 690, baseDur: 900, extraDur: 140, discount: 0.93, stops: 2, airlines: ['ANA', 'Lufthansa'] },
                                    { arriveMin: 1010, baseDur: 900, extraDur: 95, discount: 1.00, stops: 1, airlines: ['Turkish Airlines'] },
                                    { arriveMin: 1210, baseDur: 900, extraDur: 230, discount: 0.86, stops: 2, airlines: ['Air France'] }] }, r);

    /* One-way: the point of this fixture is the outbound overlap. */
    return {
        name: 'Eight across time zones (JFK / SFO / YYZ / ORD / LHR / CDG / BER / NRT -> LIS)',
        dest: 'LIS', dep: '2027-02-12', ret: '',
        parties: [{ id: 'bo', name: 'Bo', seats: 1, airports: ['JFK'] },
                  { id: 'cleo', name: 'Cleo', seats: 2, airports: ['SFO'] },
                  { id: 'dmitri', name: 'Dmitri', seats: 1, airports: ['YYZ'] },
                  { id: 'esme', name: 'Esme', seats: 1, airports: ['ORD'] },
                  { id: 'finn', name: 'Finn', seats: 1, airports: ['LHR'] },
                  { id: 'gita', name: 'Gita', seats: 1, airports: ['CDG'] },
                  { id: 'hana', name: 'Hana', seats: 1, airports: ['BER'] },
                  { id: 'ikaika', name: 'Ikaika', seats: 1, airports: ['NRT'] }],
        trip: { outbound: out }
    };
}

/* 4. Two parties. The degenerate end: is there anything to choose between? */
function twoPeople() {
    var g = threeCoasts();
    var out = { kay: g.trip.outbound.kay, wes: g.trip.outbound.wes };
    var back = { kay: g.trip['return'].kay, wes: g.trip['return'].wes };
    return { name: 'Two (SFO / BOS -> AUS)', dest: 'AUS', dep: '2027-02-12', ret: '2027-02-15',
             parties: [{ id: 'kay', name: 'Kay', seats: 1, airports: ['SFO'] },
                       { id: 'wes', name: 'Wes', seats: 1, airports: ['BOS'] }],
             trip: { outbound: out, 'return': back } };
}

/* 5. One party. Nothing to coordinate at all. */
function onePerson() {
    var g = threeCoasts();
    return { name: 'One (SFO -> AUS)', dest: 'AUS', dep: '2027-02-12', ret: '2027-02-15',
             parties: [{ id: 'kay', name: 'Kay', seats: 1, airports: ['SFO'] }],
             trip: { outbound: { kay: g.trip.outbound.kay },
                     'return': { kay: g.trip['return'].kay } } };
}

/* ------------------------------------------- generated groups

 * Five hand-built groups cannot tell you whether a profile is its own answer or
 * somebody else's with a different label. These generate a few hundred
 * plausible ones -- 3 to 8 parties, one in four out of a small city with no
 * nonstop, a budget carrier on about a third of routes -- so the question can
 * be counted instead of argued. */
var CARRIERS = ['Delta', 'United', 'American', 'Alaska', 'JetBlue', 'Southwest', 'Lufthansa'];

function makeGroup(seed) {
    var r = rng(seed);
    var n = 3 + Math.floor(r() * 6);              // 3..8 parties
    var parties = [], out = {}, back = {};
    for (var i = 0; i < n; i++) {
        var id = 'p' + i;
        var seats = r() < 0.2 ? 2 : 1;
        /* One party in four is a small city: no nonstop, sparse arrivals. */
        var small = r() < 0.25;
        var dur = 90 + Math.floor(r() * 400);
        var fare = 120 + Math.floor(r() * 500);
        var carrier = CARRIERS[Math.floor(r() * CARRIERS.length)];
        var banks = [], conns = [];
        if (!small) {
            var nb = 2 + Math.floor(r() * 3);
            for (var b = 0; b < nb; b++) banks.push(360 + Math.floor(r() * 900));
        }
        var nc = (small ? 3 : 1) + Math.floor(r() * 3);
        for (var c = 0; c < nc; c++) {
            conns.push({ arriveMin: 360 + Math.floor(r() * 900),
                         baseDur: small ? dur : 0,
                         extraDur: 40 + Math.floor(r() * 200),
                         discount: 0.65 + r() * 0.45,
                         stops: r() < 0.25 ? 2 : 1,
                         airlines: [CARRIERS[Math.floor(r() * CARRIERS.length)]] });
        }
        var spec = { day: 12, from: 'A' + i, to: 'ZZZ', nonstopDur: small ? 0 : dur,
                     fare: fare, carrier: carrier, banks: banks, conns: conns,
                     ulcc: r() < 0.3 ? [{ arriveMin: 360 + Math.floor(r() * 900),
                                          discount: 0.5 + r() * 0.15 }] : [] };
        out[id] = partyLeg(spec, r);
        var spec2 = JSON.parse(JSON.stringify(spec));
        spec2.day = 15; spec2.from = 'ZZZ'; spec2.to = 'A' + i;
        spec2.banks = spec.banks.map(function () { return 360 + Math.floor(r() * 900); });
        spec2.conns = spec.conns.map(function (x) {
            var y = JSON.parse(JSON.stringify(x));
            y.arriveMin = 360 + Math.floor(r() * 900);
            return y;
        });
        back[id] = partyLeg(spec2, r);
        parties.push({ id: id, name: 'P' + i, seats: seats, airports: ['A' + i] });
    }
    return { name: 'seed ' + seed + ' (' + n + ' parties)', dest: 'ZZZ',
             dep: '2027-02-12', ret: r() < 0.5 ? '2027-02-15' : '',
             parties: parties, trip: { outbound: out, 'return': back } };
}

module.exports = {
    rng: rng, partyLeg: partyLeg, makeGroup: makeGroup,
    groups: [threeCoasts(), fiveWithSmallCity(), eightTimeZones(), twoPeople(), onePerson()]
};
