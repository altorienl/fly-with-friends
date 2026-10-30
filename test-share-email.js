/* The email route. A trip is addressed to people, so this is the path that has
 * to survive a large group without silently losing the plan: mailto has no
 * agreed length limit and clients truncate somewhere around 2,000 characters
 * with no warning, so the body is built shortest-first and the link is the last
 * thing that can ever be dropped. */
var fs = require('fs'), vm = require('vm');
var src = fs.readFileSync('/Users/alockwood/fly-with-friends/app.js', 'utf8');

var pass = 0, fail = 0;
function ck(n, c, extra) {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (extra ? '\n          ' + extra : '')); }
}

/* Slice the two builders out and drive them against stubbed trip state. */
var a = src.indexOf('var MAILTO_MAX');
var b = src.indexOf('function chatBlock()');
var ctx = {
    encodeURIComponent: encodeURIComponent,
    AIRPORTS: { get: function () { return { city: 'Fort Lauderdale', code: 'FLL' }; } },
    state: { q: { dest: 'FLL', dep: '2027-01-15', ret: '2027-01-18' } },
    TRIP: { total: 1028 },
    money: function (n) { return '$' + n.toLocaleString('en-US'); },
    prettyRange: function () { return 'Jan 15 – Jan 18'; },
    hasReturn: function () { return true; },
    seatsAll: function () { return 3; },
    tripHeadline: function () { return 'Everyone lands within 14 minutes'; },
    shareUrl: function () { return 'https://fly-with-friends.altorien.workers.dev/#t=abc123'; },
    chatBlock: function () { return ctx.__block; }
};
vm.createContext(ctx);
vm.runInContext(src.slice(a, b), ctx);

function block(nPeople) {
    var L = ['Everyone lands within 14 minutes', 'Fort Lauderdale (FLL) · Jan 15 – Jan 18', ''];
    for (var i = 0; i < nPeople; i++) {
        L.push('  • Traveller ' + i + ' — LGA to FLL, lands 7:53pm, JetBlue, nonstop, $179');
    }
    L.push('https://fly-with-friends.altorien.workers.dev/#t=abc123');
    return L.join('\n');
}
function body(url) {
    return decodeURIComponent((url.split('&body=')[1] || '').replace(/\+/g, ' '));
}

console.log('\n-- a small group keeps the whole plan --');
ctx.__block = block(3);
var small = ctx.emailUrl();
ck('it is a mailto', small.indexOf('mailto:?subject=') === 0);
ck('subject leads with the result',
   decodeURIComponent(small.split('&body=')[0].replace('mailto:?subject=', ''))
     .indexOf('everyone lands within 14 minutes') > -1);
ck('body opens with the result', body(small).indexOf('Everyone lands within 14 minutes.') === 0);
ck('body carries the link', body(small).indexOf('#t=abc123') > -1);
ck('body carries every traveller', (body(small).match(/Traveller/g) || []).length === 3);
ck('the trip total is in the opening lines', body(small).indexOf('$1,028') > -1);

console.log('\n-- a large group drops detail, never the link --');
ctx.__block = block(60);
var big = ctx.emailUrl();
ck('stays inside the truncation limit', big.length < 4000, 'url length ' + big.length);
ck('body stays under the cap', body(big).length <= 1800, 'body length ' + body(big).length);
ck('the link still survives', body(big).indexOf('#t=abc123') > -1);
ck('the result still survives', body(big).indexOf('Everyone lands within 14 minutes.') === 0);
ck('it says detail was cut', body(big).indexOf('…') > -1);

console.log('\n-- an absurd group falls back to result plus link --');
ctx.__block = block(400);
var huge = ctx.emailUrl();
ck('body still bounded', body(huge).length <= 1800, 'body length ' + body(huge).length);
ck('link survives even then', body(huge).indexOf('#t=abc123') > -1);

console.log('\n-- the block never leaks its own duplicate link or heading --');
ctx.__block = block(3);
var t = body(ctx.emailUrl());
ck('the link appears exactly once', (t.match(/#t=abc123/g) || []).length === 1);
ck('the headline appears exactly once',
   (t.match(/Everyone lands within 14 minutes/g) || []).length === 1);

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASSED'));
process.exitCode = fail ? 1 : 0;
