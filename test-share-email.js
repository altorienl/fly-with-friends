/* The email route: links and one price, nothing else.
 *
 * "the email to everyone should provide the links and jus tottal price not the
 * break outs" -- a per-person fare table is something you read, and nobody reads
 * an email about a trip they have not agreed to. What a recipient needs is the
 * number the group is deciding on and the link that books their own seat.
 *
 * mailto has no agreed length limit and clients truncate silently around two
 * thousand characters, so these assert that the per-person links are dropped
 * before the trip link, which can never go -- the trip link is the whole plan. */
var fs = require('fs'), vm = require('vm');
var src = fs.readFileSync('/Users/alockwood/fly-with-friends/app.js', 'utf8');

var pass = 0, fail = 0;
function ck(n, c, extra) {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (extra ? '\n          ' + extra : '')); }
}

function makeCtx(nPeople) {
    var ids = [], travelers = [], outRows = {}, backRows = {};
    for (var i = 0; i < nPeople; i++) {
        var id = 'p' + i;
        ids.push(id);
        travelers.push({ id: id, name: 'Traveller' + i, seats: 1, origins: ['LGA'] });
        outRows[id] = { option: { from: 'LGA', to: 'FLL', depart: '2027-01-15 09:00', stops: 0, segs: null } };
        backRows[id] = { option: { from: 'FLL', to: 'LGA', depart: '2027-01-18 17:00', stops: 0, segs: null } };
    }
    var ctx = {
        encodeURIComponent: encodeURIComponent,
        AIRPORTS: { get: function () { return { city: 'Fort Lauderdale', code: 'FLL' }; } },
        state: { q: { dest: 'FLL', dep: '2027-01-15', ret: '2027-01-18' } },
        TRIP: { total: 1028, legOut: { rows: outRows }, legBack: { rows: backRows } },
        C: { ids: ids, travelers: travelers },
        money: function (n) { return '$' + n.toLocaleString('en-US'); },
        prettyRange: function () { return 'Jan 15 – Jan 18'; },
        hasReturn: function () { return true; },
        seatsAll: function () { return nPeople; },
        tripHeadline: function () { return 'Everyone lands within 14 minutes'; },
        shareUrl: function () { return 'https://fly-with-friends.altorien.workers.dev/#t=abc123'; },
        tripBookUrl: function (origin) {
            return 'https://www.google.com/travel/flights/booking?tfs=TOKEN' + origin;
        }
    };
    vm.createContext(ctx);
    var a = src.indexOf('var MAILTO_MAX');
    var b = src.indexOf('function chatBlock()');
    vm.runInContext(src.slice(a, b), ctx);
    return ctx;
}
function body(url) {
    return decodeURIComponent((url.split('&body=')[1] || '').replace(/\+/g, ' '));
}

console.log('\n-- a small group: the total and a link each --');
var c = makeCtx(3), url = c.emailUrl(), t = body(url);
ck('it is a mailto', url.indexOf('mailto:?subject=') === 0);
ck('subject leads with the result',
   decodeURIComponent(url.split('&body=')[0].replace('mailto:?subject=', ''))
     .indexOf('everyone lands within 14 minutes') > -1);
ck('body opens with the result', t.indexOf('Everyone lands within 14 minutes.') === 0);
ck('the total is there once', (t.match(/\$1,028/g) || []).length === 1);
ck('one booking link per person', (t.match(/booking\?tfs=/g) || []).length === 3);
ck('every traveller is named', (t.match(/Traveller/g) || []).length === 3);
ck('the trip link is there', t.indexOf('#t=abc123') > -1);

console.log('\n-- no per-person fare breakdown --');
ck('no per-person fares', !/\$\d+\s*$/m.test(t.replace(/\$1,028.*/, '')));
/* Not a search for "lands ": the headline itself is "Everyone lands within 14
 * minutes". What must be absent is per-flight detail. */
ck('no leg-by-leg detail',
   t.indexOf('nonstop') === -1 && t.indexOf('\u2192') === -1 && !/\d{1,2}:\d{2}(am|pm)/.test(t));
ck('no WHAT EACH PERSON PAYS block', t.indexOf('EACH PERSON') === -1);

console.log('\n-- a large group drops links, never the trip link --');
var big = body(makeCtx(60).emailUrl());
ck('body stays under the cap', big.length <= 1800, 'length ' + big.length);
ck('the trip link survives', big.indexOf('#t=abc123') > -1);
ck('the total survives', big.indexOf('$1,028') > -1);
ck('the result survives', big.indexOf('Everyone lands within 14 minutes.') === 0);
ck('the cut is marked', big.indexOf('…') > -1);

console.log('\n-- an absurd group still degrades to result, total and link --');
var huge = body(makeCtx(400).emailUrl());
ck('still bounded', huge.length <= 1800, 'length ' + huge.length);
ck('trip link survives even then', huge.indexOf('#t=abc123') > -1);

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASSED'));
process.exitCode = fail ? 1 : 0;
