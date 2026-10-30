/* Shared trips are documents written by strangers. These assert that the four
 * fields which reach innerHTML cannot carry markup through a share link.
 * The hole was confirmed end-to-end against the live deployment before this
 * existed: a trip POSTed with seats set to an <img onerror> round-tripped
 * verbatim and rendered as live markup. */
var fs = require('fs'), vm = require('vm');
var src = fs.readFileSync('/Users/alockwood/fly-with-friends/app.js', 'utf8');
var ctx = { APP: { maxSeats: 9 } };
vm.createContext(ctx);
var a = src.indexOf('function sanitizeQuery');
var b = src.indexOf('function blankQuery');
vm.runInContext(src.slice(a, b), ctx);
var e0 = src.indexOf('function esc(');
vm.runInContext(src.slice(e0, src.indexOf('\n}', e0) + 2), ctx);

var pass = 0, fail = 0;
function ck(n, c) { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); } }

var PAYLOAD = '<img src=x onerror=alert(document.domain)>';

console.log('\n-- sanitizeQuery coerces every field that reaches innerHTML --');
var q = ctx.sanitizeQuery({
    dest: PAYLOAD, dep: PAYLOAD, ret: PAYLOAD,
    maxStops: PAYLOAD, maxPremium: PAYLOAD, maxDetour: PAYLOAD,
    avoid: [PAYLOAD], clusterReturn: PAYLOAD,
    parties: [{ id: PAYLOAD, name: PAYLOAD, seats: PAYLOAD, airports: [PAYLOAD, 'sfo', 'TOOLONG'] }]
});
ck('seats becomes a number', typeof q.parties[0].seats === 'number' && q.parties[0].seats >= 1);
ck('maxStops is a number or null', q.maxStops === null || typeof q.maxStops === 'number');
ck('maxDetour is a number', typeof q.maxDetour === 'number');
ck('dest is at most 3 chars', q.dest.length <= 3);
ck('airports keep only real 3-letter codes', JSON.stringify(q.parties[0].airports) === '["SFO"]');
ck('name is truncated, not executed', q.parties[0].name.length <= 22);
ck('no field still equals the payload',
   JSON.stringify(q).indexOf('onerror') === -1 || q.avoid.concat([q.parties[0].name]).every(function (v) {
       return String(v).length <= 40;
   }));

console.log('\n-- stopsText cannot emit markup --');
ck('markup in stops renders as nonstop', ctx.stopsText(PAYLOAD) === 'nonstop');
ck('negative stops clamp', ctx.stopsText(-5) === 'nonstop');
ck('plural still correct', ctx.stopsText(2) === '2 stops' && ctx.stopsText(1) === '1 stop');

console.log('\n-- esc covers the remaining interpolations --');
ck('esc neutralises angle brackets', ctx.esc(PAYLOAD).indexOf('<') === -1);

console.log('\n-- a genuine link is untouched --');
var real = ctx.sanitizeQuery({ dest: 'PIT', dep: '2027-02-12', ret: '2027-02-15', maxStops: 1,
    maxDetour: 180, avoid: [], clusterReturn: false,
    parties: [{ id: 'alex', name: 'Alex', seats: 2, airports: ['SFO', 'OAK'] }] });
ck('real payload survives verbatim',
   real.dest === 'PIT' && real.parties[0].name === 'Alex' && real.parties[0].seats === 2
   && JSON.stringify(real.parties[0].airports) === '["SFO","OAK"]' && real.maxStops === 1);

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASSED'));
process.exitCode = fail ? 1 : 0;
