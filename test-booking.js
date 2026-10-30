/* Tests for the Google Flights deep link.
 *
 * This is an UNDOCUMENTED wire format, so these tests exist to tell us the day
 * Google changes it rather than to prove it is correct forever. The golden
 * vector below was verified against live Google: pinning both legs returns a
 * page titled "Round trip to Houston", while the same request without pinned
 * flights returns "Denver to Houston" (plain search). That one string is the
 * difference between landing on a booking screen and landing on a search.
 *
 * Run with --live to re-check the titles against Google. Offline by default, so
 * the suite never depends on the network. */

var fs = require('fs'), vm = require('vm');
var src = fs.readFileSync(__dirname + '/app.js', 'utf8');

/* app.js expects a DOM. Slice out the booking helpers and run them bare. */
var from = src.indexOf('function tfsEncode');
var to = src.indexOf('/* A block you can paste into the group chat');
if (from < 0 || to < 0) { console.error('FAIL: could not locate booking helpers in app.js'); process.exit(1); }
var ctx = {
    btoa: function (s) { return Buffer.from(s, 'binary').toString('base64'); },
    encodeURIComponent: encodeURIComponent,
    DATA: { currency: 'USD' },
    /* Stubs for the search-link fallback, which does not matter to these tests. */
    AIRLINE_SITES: {}, esc: function (s) { return s; }
};
vm.createContext(ctx);
vm.runInContext(src.slice(from, to), ctx);

var pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name); }
}
function eq(name, got, want) {
    if (got === want) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + '\n          got:  ' + got + '\n          want: ' + want); }
}

var UA1241 = { from: 'DEN', to: 'IAH', date: '2027-02-04', carrier: 'UA', number: '1241' };
var UA1691 = { from: 'IAH', to: 'DEN', date: '2027-02-08', carrier: 'UA', number: '1691' };

console.log('\n-- the golden vector (verified live against Google) --');
eq('round trip, both legs pinned, 1 adult, economy',
   ctx.tfsEncode([{ from: 'DEN', to: 'IAH', date: '2027-02-04', segs: [UA1241] },
                  { from: 'IAH', to: 'DEN', date: '2027-02-08', segs: [UA1691] }], 1, 1),
   'GkASCjIwMjctMDItMDQiIAoDREVOEgoyMDI3LTAyLTA0GgNJQUgqAlVBMgQxMjQxagcIARIDREVOcgcIARIDSUFIGkASCjIwMjctMDItMDgiIAoDSUFIEgoyMDI3LTAyLTA4GgNERU4qAlVBMgQxNjkxagcIARIDSUFIcgcIARIDREVOQAFIAZgBAQ');

console.log('\n-- trip type and passengers are encoded, not assumed --');
var ow = ctx.tfsEncode([{ from: 'DEN', to: 'IAH', date: '2027-02-04', segs: [UA1241] }], 1, 1);
var rt = ctx.tfsEncode([{ from: 'DEN', to: 'IAH', date: '2027-02-04', segs: [UA1241] },
                        { from: 'IAH', to: 'DEN', date: '2027-02-08', segs: [UA1691] }], 1, 1);
check('one way differs from round trip', ow !== rt);
check('seat count changes the token',
      ctx.tfsEncode([{ from: 'DEN', to: 'IAH', date: '2027-02-04', segs: [UA1241] }], 3, 1) !== ow);

console.log('\n-- pinnable: a wrong flight number is worse than no link at all --');
/* Google accepts bogus numbers silently and shows an empty booking screen, so
 * anything less than complete live data must fall back to a search. */
var good = { from: 'DEN', to: 'IAH', depart: '2027-02-04 10:01', stops: 0, segs: [UA1241] };
check('complete nonstop is pinnable', ctx.pinnable([good]));
check('no segs at all is not pinnable',
      !ctx.pinnable([{ from: 'DEN', to: 'IAH', depart: '2027-02-04 10:01', stops: 0 }]));
check('empty segs is not pinnable',
      !ctx.pinnable([{ from: 'DEN', to: 'IAH', depart: '2027-02-04 10:01', stops: 0, segs: [] }]));
check('missing flight number is not pinnable',
      !ctx.pinnable([{ from: 'DEN', to: 'IAH', depart: '2027-02-04 10:01', stops: 0,
                       segs: [{ from: 'DEN', to: 'IAH', date: '2027-02-04', carrier: 'UA', number: null }] }]));
check('missing carrier is not pinnable',
      !ctx.pinnable([{ from: 'DEN', to: 'IAH', depart: '2027-02-04 10:01', stops: 0,
                       segs: [{ from: 'DEN', to: 'IAH', date: '2027-02-04', carrier: null, number: '1241' }] }]));
/* A 1-stop itinerary carrying one segment means we only know half the journey;
 * pinning it would send somebody to a booking screen for a different flight. */
check('segment count must match the stop count',
      !ctx.pinnable([{ from: 'SFO', to: 'PIT', depart: '2027-02-04 08:00', stops: 1, segs: [UA1241] }]));
check('one bad leg poisons the whole trip', !ctx.pinnable([good, { from: 'IAH', to: 'DEN', stops: 0 }]));

console.log('\n-- deepLink: builds or returns null, never a broken link --');
var link = ctx.deepLink([good], 1);
check('pinnable input produces a booking URL',
      typeof link === 'string' && link.indexOf('https://www.google.com/travel/flights/booking?tfs=') === 0);
check('URL carries currency', link.indexOf('curr=USD') > 0);
eq('unpinnable input returns null',
   ctx.deepLink([{ from: 'DEN', to: 'IAH', depart: '2027-02-04 10:01', stops: 0 }], 1), null);
eq('empty input returns null', ctx.deepLink([], 1), null);

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASSED'));

if (process.argv.indexOf('--live') > -1) {
    /* The canary: asserts Google still routes a pinned request to a booking
     * screen. If this starts reporting a "<City> to <City>" title, the field
     * numbers moved and every Book button has quietly become a plain search. */
    console.log('\n-- live canary --');
    var https = require('https'), zlib = require('zlib');
    [['pinned round trip', rt, 'Round trip to'], ['pinned one way', ow, 'One way to'],
     ['unpinned control', ctx.tfsEncode([{ from: 'DEN', to: 'IAH', date: '2027-02-04', segs: [] }], 1, 1), 'Denver to']
    ].forEach(function (c) {
        https.get('https://www.google.com/travel/flights/booking?tfs=' + c[1] + '&hl=en&gl=us&curr=USD',
            { headers: { 'accept-encoding': 'gzip',
                /* Without a browser User-Agent Google 302s to
                 * /travel/flights/unsupported, which has no title and would be
                 * indistinguishable from the wire format having changed. */
                'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
                    + ' (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' } }, function (res) {
                if (res.statusCode !== 200) {
                    console.log('  FAIL  ' + c[0] + ': HTTP ' + res.statusCode
                        + ' -> ' + (res.headers.location || '(no location)'));
                    res.resume(); return;
                }
                /* Google gzips this regardless of what we ask for, and a
                 * compressed body silently matches no title at all -- which
                 * would look exactly like the format having changed. */
                var enc = (res.headers['content-encoding'] || '').toLowerCase();
                var stream = enc === 'gzip' ? res.pipe(zlib.createGunzip())
                    : enc === 'br' ? res.pipe(zlib.createBrotliDecompress())
                    : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
                var body = '';
                stream.on('data', function (d) { body += d; });
                stream.on('error', function (e) { console.log('  SKIP  ' + c[0] + ': ' + e.message); });
                stream.on('end', function () {
                    var m = body.match(/<title>([^<]*)</);
                    var title = m ? m[1] : '(none)';
                    console.log((title.indexOf(c[2]) === 0 ? '  PASS  ' : '  FAIL  ') + c[0] + ': ' + title);
                });
            }).on('error', function (e) { console.log('  SKIP  ' + c[0] + ': ' + e.message); });
    });
}
process.exitCode = fail ? 1 : 0;
