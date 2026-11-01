/* Tests for the airport table, and specifically for the region field.
 *
 * The region exists to answer one question a three-letter code cannot: "am I
 * sure I clicked the right airport". ONT is Ontario, California. PDX is
 * Portland, Oregon, and there is a Portland in Maine. SJC and SJO are both San
 * Jose. So the field's whole value is being right -- a wrong state is worse
 * than no state, because it reassures somebody into the wrong booking.
 *
 * Ninety-nine of them were typed by hand. What a test can check mechanically is
 * that every one names a place that exists, that nothing outside the US and
 * Canada claims a state, and that no city this table knows twice is left
 * without one. It cannot check that PHX is in Arizona rather than Nevada; the
 * spelling list below is what catches the class of error that looks right.
 */
var fs = require('fs'), vm = require('vm');
var AIRPORTS = require(__dirname + '/airports.js');

/* placeOf decides what a reader actually sees, so the data and the display rule
 * are tested together -- a correct table rendered badly is still the wrong
 * airport on screen. Sliced out of app.js, which is an IIFE with no globals. */
var src = fs.readFileSync(__dirname + '/app.js', 'utf8');
var a0 = src.indexOf('function placeOf(a) {');
var b0 = src.indexOf('function titleCase(str) {');
if (a0 < 0 || b0 < a0) { console.error('FAIL: could not locate placeOf in app.js'); process.exit(1); }
var box = {};
vm.createContext(box);
vm.runInContext(src.slice(a0, b0), box);
var placeOf = box.placeOf;

var pass = 0, fail = 0;
function check(n, c, extra) {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (extra ? '\n          ' + extra : '')); }
}
function eq(n, got, want) {
    check(n, got === want, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));
}

var STATES = ('Alabama Alaska Arizona Arkansas California Colorado Connecticut Delaware Florida '
  + 'Georgia Hawaii Idaho Illinois Indiana Iowa Kansas Kentucky Louisiana Maine Maryland '
  + 'Massachusetts Michigan Minnesota Mississippi Missouri Montana Nebraska Nevada Ohio '
  + 'Oklahoma Oregon Pennsylvania Tennessee Texas Utah Vermont Virginia Washington Wisconsin '
  + 'Wyoming').split(' ').concat([
  'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota',
  'Rhode Island', 'South Carolina', 'South Dakota', 'West Virginia', 'D.C.', 'Puerto Rico'
]);
/* Ten provinces and three territories. The territories were missing and the
 * generated table reaches all three -- Iqaluit, Yellowknife and Whitehorse all
 * have scheduled service. */
var PROVINCES = ['Alberta', 'British Columbia', 'Manitoba', 'New Brunswick',
  'Newfoundland and Labrador', 'Nova Scotia', 'Ontario', 'Prince Edward Island',
  'Quebec', 'Saskatchewan',
  'Northwest Territories', 'Nunavut', 'Yukon'];
/* Deliberate: a country, not a state, because what tells SJO from SJC is the
 * country. See the note on the REGION map. */
var EXCEPTIONS = { SJO: 'Costa Rica' };
/* Every country name the generated table can produce. Read from the generated
 * file rather than retyped, because the point of checking a region against a
 * list is that the list is not the same keystrokes that produced the value. */
var COUNTRIES = (function () {
    var names = require(__dirname + '/airports-extra.js').COUNTRY_NAMES || {};
    return Object.keys(names).map(function (k) { return names[k]; });
}());

var AIR = AIRPORTS.LIST.filter(function (a) { return !a.metro; });

console.log('\n-- every airport says where it is --');
(function () {
    var blank = AIR.filter(function (a) { return !a.region; });
    /* A region is a state or province inside the US and Canada and a country
     * everywhere else, so there is no airport left that cannot say where it
     * is. A blank one means a country code with no name behind it, which shows
     * up as a bare city in the picker. */
    check('no airport is left without a region', blank.length === 0,
          blank.slice(0, 8).map(function (a) { return a.code + '/' + a.country; }).join(', '));

    var bad = [];
    AIR.forEach(function (a) {
        if (!a.region) return;
        if (a.country === 'US' || a.country === 'PR' || a.country === 'GU') {
            if (STATES.indexOf(a.region) === -1 && COUNTRIES.indexOf(a.region) === -1) {
                bad.push(a.code + ' -> "' + a.region + '" (US)');
            }
        } else if (a.country === 'CA') {
            if (PROVINCES.indexOf(a.region) === -1 && COUNTRIES.indexOf(a.region) === -1) {
                bad.push(a.code + ' -> "' + a.region + '" (CA)');
            }
        } else if (COUNTRIES.indexOf(a.region) === -1 && !EXCEPTIONS[a.code]) {
            /* Anywhere else it must be a country NAME, not a state: "Aarhus,
             * Denmark" is the answer, "Aarhus, Texas" is the bug this catches. */
            bad.push(a.code + ' -> "' + a.region + '" (' + a.country + ')');
        }
    });
    check('no misspelled, invented or misplaced region', bad.length === 0,
          bad.slice(0, 8).join('\n          '));

    /* The states are spelled out from two-letter ISO codes, and a typo in that
     * map would read as a real place. Every US airport in the generated set
     * resolves through it. */
    var usRegions = {};
    AIR.forEach(function (a) { if (a.country === 'US' && a.region) usRegions[a.region] = 1; });
    var unknown = Object.keys(usRegions).filter(function (r) {
        return STATES.indexOf(r) === -1 && COUNTRIES.indexOf(r) === -1;
    });
    check('every US region resolves to a real state', unknown.length === 0, unknown.join(', '));
})();

console.log('\n-- the curated names win --');
(function () {
    /* The whole reason the generated table is merged rather than pasted in: a
     * refresh of 3,642 rows must never rename an airport somebody chose a short
     * familiar name for. */
    eq('PHX is Sky Harbor, not Phoenix Sky Harbor Intl', AIRPORTS.get('PHX').name, 'Sky Harbor');
    eq('ORD is O\u2019Hare', AIRPORTS.get('ORD').name, 'O\u2019Hare');
    eq('LHR is Heathrow', AIRPORTS.get('LHR').name, 'Heathrow');
    eq('JFK is John F. Kennedy', AIRPORTS.get('JFK').name, 'John F. Kennedy');
    check('and the generated rows are still there',
          AIR.length > 3000, AIR.length + ' airports');
})();

console.log('\n-- the airport that started this --');
(function () {
    /* "im next to CEN airport but that didnt come up". It was not in the table,
     * and typing CEN returned Istanbul -- matched through "Sabiha Gokcen",
     * because a three-letter query was being tested against airport NAMES. */
    var cen = AIRPORTS.get('CEN');
    check('CEN exists', !!cen);
    eq('...in Ciudad Obreg\u00f3n', cen && cen.city, 'Ciudad Obreg\u00f3n');
    eq('...in Mexico', cen && cen.country, 'MX');
    eq('...and searching for it finds it first',
       AIRPORTS.search('CEN', 5)[0].code, 'CEN');

    /* The ranking fix, which stands on its own: a three-letter query is a code,
     * and matching it inside an airport NAME is noise -- "INT" is in every
     * "Intl", "HAR" is in Hartsfield and O'Hare and Harry Reid. */
    var nameOnly = [];
    for (var i = 0; i < 26; i++) {
        for (var j = 0; j < 26; j++) {
            for (var k = 0; k < 26; k++) {
                var q = String.fromCharCode(65 + i, 65 + j, 65 + k);
                if (AIRPORTS.get(q)) continue;
                var r = AIRPORTS.search(q, 3);
                r.forEach(function (x) {
                    if (x.metro) return;
                    var city = x.city.toUpperCase();
                    if (x.code.indexOf(q) === 0 || city.indexOf(q) > -1) return;
                    nameOnly.push(q + ' -> ' + x.code);
                });
            }
        }
    }
    check('no three-letter query is answered by an airport name alone',
          nameOnly.length === 0, nameOnly.slice(0, 8).join(', '));
    /* From four characters it is a name again. */
    eq('Heathrow still finds LHR', AIRPORTS.search('Heathrow', 3)[0].code, 'LHR');
    eq('Gatwick still finds LGW', AIRPORTS.search('Gatwick', 3)[0].code, 'LGW');
})();

console.log('\n-- the ambiguous names are the ones that most need it --');
(function () {
    var byCity = {};
    AIR.forEach(function (a) { (byCity[a.city] = byCity[a.city] || []).push(a); });
    var ambiguous = Object.keys(byCity).filter(function (c) {
        var places = {};
        byCity[c].forEach(function (a) { places[a.country + '/' + a.region] = 1; });
        return Object.keys(places).length > 1;
    });
    var unmarked = [];
    ambiguous.forEach(function (c) {
        byCity[c].forEach(function (a) { if (!a.region) unmarked.push(a.code + ' ' + c); });
    });
    check('every airport in a city this table knows twice carries a region ('
          + ambiguous.length + ' such cities)',
          unmarked.length === 0, unmarked.slice(0, 8).join(', '));

    /* The cases a 309-airport table did not have and a 3,951-airport one does.
     * Each of these is a city name that lands in two countries at once, which
     * is the exact mistake the field exists to prevent. */
    [['LHR', 'London', 'United Kingdom'], ['YXU', 'London', 'Ontario'],
     ['SYD', 'Sydney', 'Australia'], ['YQY', 'Sydney', 'Nova Scotia'],
     ['BHX', 'Birmingham', 'United Kingdom'], ['BHM', 'Birmingham', 'Alabama'],
     ['SJC', 'San Jose', 'California'], ['SJO', 'San Jose', 'Costa Rica'],
     ['ONT', 'Ontario', 'California'], ['PDX', 'Portland', 'Oregon']
    ].forEach(function (t) {
        var a = AIRPORTS.get(t[0]);
        check('  ' + t[0] + ' is ' + t[1] + ', ' + t[2],
              !!a && a.city === t[1] && a.region === t[2],
              a ? a.city + ', ' + a.region : 'missing');
    });
})();

console.log('\n-- a region that repeats the city is not read back twice --');
(function () {
    var same = AIR.filter(function (a) { return a.region === a.city; });
    /* Singapore is in Singapore and New York is in New York. The data is right
     * and still says the word twice, so placeOf suppresses it where it would
     * be read -- "New York, New York" is a lyric, not a disambiguation. */
    check('there are city-states and same-named states in the table', same.length > 0,
          same.length + ': ' + same.slice(0, 6).map(function (a) { return a.code; }).join(','));
    check('and placeOf prints the city once for all of them',
          same.every(function (a) { return placeOf(a) === a.city; }),
          same.filter(function (a) { return placeOf(a) !== a.city; })
              .slice(0, 4).map(function (a) { return placeOf(a); }).join(' | '));
    check('while everything else keeps its region',
          AIR.filter(function (a) { return a.region && a.region !== a.city; })
             .every(function (a) { return placeOf(a) === a.city + ', ' + a.region; }));
})();

console.log('\n-- the table itself --');
(function () {
    var codes = {}, dup = [];
    AIR.forEach(function (a) {
        if (codes[a.code]) dup.push(a.code);
        codes[a.code] = 1;
    });
    check('no duplicate codes', dup.length === 0, dup.join(', '));
    check('every entry has a code, a city and a name',
          AIR.every(function (a) { return a.code && a.city && a.name && a.country; }));
    check('every code is three letters',
          AIR.every(function (a) { return /^[A-Z]{3}$/.test(a.code); }),
          AIR.filter(function (a) { return !/^[A-Z]{3}$/.test(a.code); })
             .map(function (a) { return a.code; }).join(', '));
    /* Metros are resolved against BY_CODE at build time, so a member code that
     * does not exist silently drops the whole metro rather than erroring. */
    check('every metro member resolves to a real airport',
          AIRPORTS.METROS.every(function (m) {
              return m.members.every(function (c) { return !!AIRPORTS.get(c); });
          }));
})();

console.log('\n-- somebody who already lives at the destination --');
(function () {
    /* The owner put Matt in Denver and flew the group to Denver. He was
     * rendered as a traveller with no flights: a red dashed card, "not with
     * the group", and $0 all in, beside a Book button for a trip that does not
     * exist. That is the failure state, and already being at the meeting point
     * is the opposite of a failure -- it is usually WHY that city was picked. */
    var vm = require('vm'), fs2 = require('fs');
    var src2 = fs2.readFileSync(__dirname + '/app.js', 'utf8');
    var a = src2.indexOf('function isLocal(t)'), b = src2.indexOf('function hasReturn()');
    var box = { state: { q: { dest: 'DEN', parties: [] } }, SET: { bags: {} },
                partyLabel: function (p, i) { return 'P' + i; },
                partyColor: function () { return '#000'; } };
    vm.createContext(box);
    vm.runInContext(src2.slice(a, b), box);
    var set = function (dest, parties) {
        box.state.q.dest = dest;
        box.state.q.parties = parties.map(function (ap, i) {
            return { id: 'p' + i, airports: ap, seats: 1 };
        });
    };

    set('DEN', [['LGA'], ['DEN'], ['MSP']]);
    eq('the one who lives there is not asked to fly', box.travelers().length, 2);
    eq('...and is still on the trip', box.locals().length, 1);
    eq('...and the group is still three people', box.allParties().length, 3);

    /* Somebody who offered the destination AND another airport has a real
     * choice, so they still fly -- the optimiser can use the other one. */
    set('DEN', [['LGA'], ['DEN', 'COS']]);
    eq('two airports, one of them the destination, still flies', box.travelers().length, 2);

    /* Case is not a reason to treat the same airport as two. */
    set('DEN', [['LGA'], ['den']]);
    eq('lower case is the same airport', box.locals().length, 1);

    /* Before a destination is chosen nobody can be local, or step 1 would
     * start deleting people. */
    set('', [['LGA'], ['DEN']]);
    eq('no destination means nobody is local', box.locals().length, 0);

    /* A party with no airport at all is not local, it is unfinished. */
    set('DEN', [['LGA'], []]);
    eq('an empty party is not local', box.locals().length, 0);
}());

console.log('\n-- airports that exist but cannot be flown from --');
(function () {
    /* A closed airport is not a missing one. People type the code they have in
     * their head, so it has to resolve -- and then say why, and where to go
     * instead. Marking one open is the dangerous failure: compute() filters on
     * .closed, so an airport wrongly listed as open is silently accepted as
     * somebody's origin and then returns nothing, with the blame landing on
     * the search rather than on the airport. */
    var closed = AIRPORTS.LIST.filter(function (a) { return a.closed; });
    check('there are closed airports to check', closed.length > 0);

    closed.forEach(function (a) {
        check(a.code + ' says why it is closed',
              typeof a.note === 'string' && a.note.length > 10, a.note);
        check(a.code + ' names somewhere to fly from instead',
              Array.isArray(a.alternates) && a.alternates.length > 0);
        (a.alternates || []).forEach(function (alt) {
            var o = AIRPORTS.get(alt);
            check(a.code + ' sends people to ' + alt + ', which is real and open',
                  !!o && !o.closed, alt + ' = ' + JSON.stringify(o));
        });
    });

    /* Every code appears once. Moving an airport into the closed list without
     * taking it out of the open one leaves two records and whichever is read
     * last wins, which is how a closed airport reads as open. */
    var seen = {}, dupes = [];
    AIRPORTS.LIST.forEach(function (a) {
        if (seen[a.code]) dupes.push(a.code);
        seen[a.code] = 1;
    });
    check('no airport is listed twice', dupes.length === 0, dupes.join(' '));

    /* Angkor closed in October 2023 and Siem Reap moved to SAI. It was listed
     * as open, so REP was accepted as an origin and quietly found nothing. */
    var rep = AIRPORTS.get('REP');
    check('REP resolves rather than 404ing on somebody', !!rep);
    check('...and is marked closed', !!rep && rep.closed === true);
    check('...and points at SAI', !!rep && (rep.alternates || []).indexOf('SAI') !== -1);
    check('SAI itself is open', !AIRPORTS.get('SAI').closed);
}());

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail)
                         : 'ALL ' + pass + ' CHECKS PASSED'));
process.exitCode = fail ? 1 : 0;
