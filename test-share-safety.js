/* Shared trips are documents written by strangers. These assert that the four
 * fields which reach innerHTML cannot carry markup through a share link.
 * The hole was confirmed end-to-end against the live deployment before this
 * existed: a trip POSTed with seats set to an <img onerror> round-tripped
 * verbatim and rendered as live markup. */
var fs = require('fs'), vm = require('vm'), path = require('path');
/* __dirname, not an absolute path. Hard-coded, this file read a DIFFERENT
 * app.js from the one beside it, so it went green against the main checkout
 * while the tree under test was never looked at. */
var src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
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

/* sanitizeMarks was asserted here, hard: the roster was the newest thing
 * arriving from a stored trip and it reached innerHTML through a badge, a
 * sentence naming people and a data-mark attribute. All three are gone with
 * the "I'm booked" control, and so is the function -- the client never reads
 * /marks now. The worker still has the endpoint and worker/test-worker.js
 * still covers its own sanitising, which is the copy that matters while it
 * exists. Nothing in the browser parses a roster any more, so there is no
 * client-side surface left to test. */


/* The trip id read off the URL is concatenated straight into a fetch path, so
 * the regex that extracts it is load-bearing: anything it lets through becomes
 * part of a request this app makes on its own origin's behalf. All three forms
 * are checked, because all three are read -- ?t= is what the app writes, /t/ is
 * read so links keep working if the app ever moves behind a host that rewrites
 * unknown paths, and #t= is read forever because those links are already in
 * people's group chats. */
console.log('\n-- the trip id comes off the URL, so it is a parser, not a lookup --');
var u0 = src.indexOf('function tripIdFromUrl');
var u1 = src.indexOf('function appUrl');
vm.runInContext(src.slice(u0, src.indexOf('\n}', u1) + 2), ctx);

function at(search, pathname, hash) {
    ctx.location = { search: search || '', pathname: pathname || '/', hash: hash || '', origin: 'https://x' };
    return ctx.tripIdFromUrl();
}
ck('?t= is read', at('?t=abc234') === 'abc234');
ck('?t= among other params is read', at('?demo=1&t=abc234') === 'abc234');
ck('/t/<id> is read', at('', '/t/abc234') === 'abc234');
ck('#t= still opens every link already pasted into a chat', at('', '/', '#t=abc234') === 'abc234');
ck('no id anywhere is null', at('?demo=1', '/', '#s=eyJx') === null);
ck('a path traversal is not an id', at('?t=../../etc/passwd') === null);
ck('an uppercase or punctuated id is not an id',
   at('?t=ABC234') === null && at('?t=abc-234') === null && at('?t=abc.234') === null);
/* 0 and 1 are not in the alphabet the worker mints ids from, because they are
 * the two characters a person retypes wrongly from a screen. */
ck('a digit outside the id alphabet rejects the whole id', at('?t=abc01x') === null);
/* The trailing anchor is what does this: without it a 40-character payload
 * would match its first 16 and be accepted as an id. */
ck('an over-long id is not silently truncated', at('?t=abcdefghijklmnopqrst') === null);

var baseAt = function (pathname) { at('', pathname); return ctx.basePath(); };
ck('basePath drops the trip it was reading', baseAt('/t/abc234') === '/');
ck('basePath keeps a subdirectory deploy', baseAt('/app/t/abc234') === '/app/');
ck('basePath leaves an ordinary path alone', baseAt('/index.html') === '/index.html');

console.log('\n-- a genuine link is untouched --');
var real = ctx.sanitizeQuery({ dest: 'PIT', dep: '2027-02-12', ret: '2027-02-15', maxStops: 1,
    maxDetour: 180, avoid: [], clusterReturn: false,
    parties: [{ id: 'alex', name: 'Alex', seats: 2, airports: ['SFO', 'OAK'] }] });
ck('real payload survives verbatim',
   real.dest === 'PIT' && real.parties[0].name === 'Alex' && real.parties[0].seats === 2
   && JSON.stringify(real.parties[0].airports) === '["SFO","OAK"]' && real.maxStops === 1);

/* --------------------------------------------------------- link economics
 *
 * A #s= link is a self-contained search: opening one runs a fresh paid search
 * on the opener's device, sixteen of the month's 250 for an eight-person round
 * trip, once per recipient, every time the leg cache has gone cold. A #t= link
 * is one KV read, forever. So the only question that matters about a link is
 * which of the two it is -- and the link people actually copy is the one in the
 * address bar, which is what writeHash puts there. */
console.log('\n-- which kind of link is in the address bar --');
var h0 = src.indexOf('function tripIdFromUrl');
var h1 = src.indexOf('function shareUrl');
ctx.location = { hash: '' };
ctx.escape = escape; ctx.unescape = unescape;
ctx.atob = function (s) { return Buffer.from(s, 'base64').toString('binary'); };
vm.runInContext(src.slice(h0, h1), ctx);

var enc = Buffer.from(unescape(encodeURIComponent(JSON.stringify(
    { q: { dest: 'PIT', parties: [{ id: 'alex', name: 'Alex', seats: 1, airports: ['SFO'] }] },
      v: { leg: 'outbound' } }))), 'binary').toString('base64').replace(/=+$/, '');

function readAt(hash) {
    ctx.location.hash = hash;
    return { id: ctx.tripIdFromUrl(), view: ctx.readHash() };
}
var bare = readAt('#s=' + enc);
ck('a bare #s= link carries no trip id -- it is the expensive form',
   bare.id === null && !!bare.view);
var saved = readAt('#t=abc234');
ck('a plain #t= link carries a trip id and no view',
   saved.id === 'abc234' && saved.view === null);
/* This is the form writeHash now emits once the trip is saved, and the whole
 * point of it: the results come out of storage for free, the sender's current
 * reading of them still travels. Both regexes match on [#&], so order is not
 * load-bearing -- but if either stops matching, the link silently reverts to
 * replaying a paid search, which is exactly the failure worth a test. */
var both = readAt('#t=abc234&s=' + enc);
ck('#t= and &s= together: free results AND the sender\'s view',
   both.id === 'abc234' && !!both.view && both.view.q.dest === 'PIT');
ck('the view survives the round trip intact',
   both.view.q.parties[0].name === 'Alex' && both.view.v.leg === 'outbound');
ck('a trip id is still found when the view comes first',
   readAt('#s=' + enc + '&t=abc234').id === 'abc234');
ck('a malformed view does not take the trip id down with it',
   readAt('#t=abc234&s=!!!not-base64!!!').id === 'abc234');

/* What "is another day cheaper?" costs used to be asserted here, against the
 * two-candidate model. It moved to test-dates.js when the candidate set grew to
 * four: the quote is now summed per candidate from the legs that candidate
 * actually changes, and one copy of that arithmetic in the suite that owns the
 * feature beats two copies in two suites, one of which is about share links. */

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASSED'));
process.exitCode = fail ? 1 : 0;
