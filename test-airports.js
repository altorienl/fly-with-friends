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

var STATES = ('Alabama Alaska Arizona Arkansas California Colorado Connecticut Delaware Florida '
  + 'Georgia Hawaii Idaho Illinois Indiana Iowa Kansas Kentucky Louisiana Maine Maryland '
  + 'Massachusetts Michigan Minnesota Mississippi Missouri Montana Nebraska Nevada Ohio '
  + 'Oklahoma Oregon Pennsylvania Tennessee Texas Utah Vermont Virginia Washington Wisconsin '
  + 'Wyoming').split(' ').concat([
  'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota',
  'Rhode Island', 'South Carolina', 'South Dakota', 'West Virginia', 'D.C.', 'Puerto Rico'
]);
var PROVINCES = ['Alberta', 'British Columbia', 'Manitoba', 'New Brunswick',
  'Newfoundland and Labrador', 'Nova Scotia', 'Ontario', 'Prince Edward Island',
  'Quebec', 'Saskatchewan'];
/* Deliberate: a country, not a state, because what tells SJO from SJC is the
 * country. See the note on the REGION map. */
var EXCEPTIONS = { SJO: 'Costa Rica' };

var AIR = AIRPORTS.LIST.filter(function (a) { return !a.metro; });

console.log('\n-- every region names a place that exists --');
(function () {
    var bad = [];
    AIR.forEach(function (a) {
        if (!a.region) return;
        if (EXCEPTIONS[a.code] === a.region) return;
        var ok = a.country === 'CA' ? PROVINCES.indexOf(a.region) > -1
               : STATES.indexOf(a.region) > -1;
        if (!ok) bad.push(a.code + ' -> "' + a.region + '" (' + a.country + ')');
    });
    check('no misspelled or invented region', bad.length === 0, bad.join('\n          '));

    var wrongCountry = AIR.filter(function (a) {
        return a.region && ['US', 'CA', 'PR'].indexOf(a.country) === -1 && !EXCEPTIONS[a.code];
    });
    check('nothing outside the US and Canada claims a state',
          wrongCountry.length === 0,
          wrongCountry.map(function (a) { return a.code + '/' + a.country; }).join(', '));

    var caWithState = AIR.filter(function (a) {
        return a.country === 'CA' && a.region && PROVINCES.indexOf(a.region) === -1;
    });
    check('every Canadian region is a province, not a state', caWithState.length === 0,
          caWithState.map(function (a) { return a.code + ' -> ' + a.region; }).join(', '));
})();

console.log('\n-- every US and Canadian airport has one --');
(function () {
    var missing = AIR.filter(function (a) {
        return ['US', 'CA', 'PR'].indexOf(a.country) > -1 && !a.region;
    });
    /* A gap is not cosmetic: the field reassures, so one airport without it in a
     * list of near-identical codes is the one somebody picks unsure. */
    check('no US, Canadian or Puerto Rican airport is missing its region',
          missing.length === 0, missing.map(function (a) { return a.code + ' ' + a.city; }).join(', '));

    /* JFK and LGA are in the city of New York in the state of New York, so the
     * data repeats itself and is still correct. What must not repeat is what
     * gets READ: placeOf suppresses it, and this asserts that it does, because
     * "New York, New York" is a lyric rather than a disambiguation. */
    var same = AIR.filter(function (a) { return a.region && a.region === a.city; });
    check('the cities whose state shares their name are known',
          same.map(function (a) { return a.code; }).sort().join(',') === 'JFK,LGA',
          same.map(function (a) { return a.code; }).join(', '));
    check('and placeOf does not read them back twice',
          same.every(function (a) { return placeOf(a) === a.city; }),
          same.map(function (a) { return placeOf(a); }).join(' | '));
    check('while everything else keeps its region',
          AIR.filter(function (a) { return a.region && a.region !== a.city; })
             .every(function (a) { return placeOf(a) === a.city + ', ' + a.region; }));
})();

console.log('\n-- the ambiguous names are the ones that most need it --');
(function () {
    /* Any city name this table holds more than once, in more than one country
     * or in more than one state, is a name that cannot be trusted alone. */
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
    check('every airport in a city this table knows twice carries a region',
          unmarked.length === 0, unmarked.join(', '));
    /* The case the field was added for, asserted by name so a future edit that
     * drops it fails loudly rather than quietly. */
    check('SJC and SJO are told apart',
          AIRPORTS.get('SJC').region === 'California'
          && AIRPORTS.get('SJO').region === 'Costa Rica');
    check('ONT is not in Canada', AIRPORTS.get('ONT').region === 'California');
    check('PDX is not in Maine', AIRPORTS.get('PDX').region === 'Oregon');
    check('the airport the owner was looking at is in Arizona',
          AIRPORTS.get('PHX').region === 'Arizona');
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

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail)
                         : 'ALL ' + pass + ' CHECKS PASSED'));
process.exitCode = fail ? 1 : 0;
