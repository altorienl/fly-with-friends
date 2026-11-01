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
var src = fs.readFileSync(__dirname + '/app.js', 'utf8');

var pass = 0, fail = 0;
function ck(n, c, extra) {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (extra ? '\n          ' + extra : '')); }
}

function makeCtx(nPeople) {
    var ids = [], travelers = [], outRows = {}, backRows = {}, perPerson = {};
    for (var i = 0; i < nPeople; i++) {
        var id = 'p' + i;
        ids.push(id);
        travelers.push({ id: id, name: 'Traveller' + i, seats: 1, origins: ['LGA'] });
        outRows[id] = { option: { from: 'LGA', to: 'FLL', depart: '2027-01-15 09:00', stops: 0, segs: null, arriveMin: 1193 } };
        perPerson[id] = { total: 340 };
        backRows[id] = { option: { from: 'FLL', to: 'LGA', depart: '2027-01-18 17:00', stops: 0, segs: null } };
    }
    var ctx = {
        encodeURIComponent: encodeURIComponent,
        AIRPORTS: { get: function () { return { city: 'Fort Lauderdale', code: 'FLL' }; } },
        state: { q: { dest: 'FLL', dep: '2027-01-15', ret: '2027-01-18' } },
        TRIP: { total: 1028, legOut: { rows: outRows }, legBack: { rows: backRows },
                perPerson: perPerson },
        C: { ids: ids, travelers: travelers },
        money: function (n) { return '$' + n.toLocaleString('en-US'); },
        prettyRange: function () { return 'Jan 15 – Jan 18'; },
        hasReturn: function () { return true; },
        seatsAll: function () { return nPeople; },
        tripHeadline: function () { return 'Everyone lands within 14 minutes'; },
        shareUrl: function () { return 'https://fly-with-friends.altorien.workers.dev/#t=abc123'; },
        clock: function (m) { return '7:53pm'; },
        tripBookUrl: function (origin) {
            return 'https://www.google.com/travel/flights/booking?tfs=TOKEN' + origin;
        },
        /* The real one returns a pinned deep link when the trip is one
         * carrier and a search link when it is not. Both are stubbed at a
         * realistic LENGTH, because length is what this file is really
         * testing: a pinned tfs token runs about 400 characters and a search
         * url about 115, and the truncation below has to hold for both. */
        tripBookLinks: function (origin, dest, dep, ret, seats, options, name) {
            return [{ label: 'Book ' + name + '\u2019s trip',
                      url: 'https://www.google.com/travel/flights/booking?tfs='
                           + 'T'.repeat(360) + origin }];
        },
        money: function (n) { return '$' + Math.round(n).toLocaleString('en-US'); }
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
/* The headline came out of the body with the rest of the prose -- it is
 * already the SUBJECT line, and repeating it as the first line of a message
 * whose job is now flight, price, time and link was the clearest of the
 * "whole bunch of words". What opens the body is the trip itself. */
ck('body opens with where and when and what it costs',
   t.indexOf('Fort Lauderdale \u00b7 Jan 15 \u2013 Jan 18 \u00b7 $1,028 for 3') === 0,
   t.split('\n')[0]);
ck('the total is there once', (t.match(/\$1,028/g) || []).length === 1);
/* No per-person deep links: each is a 400-character tfs= token, and three of
 * them arrived as walls of base64 that buried the total and could not be used
 * as links. The Book buttons live in the app, one tap from the trip link. */
/* REVERSED on 2026-10-31, and the old assertion is kept in this comment so
 * the reversal is legible: it used to be `no tfs= in the body` and `exactly
 * one link, and it is the trip`.
 *
 * Those came from "the email should provide the links and jus tottal price
 * not the break outs", when three 400-character tokens arrived as walls of
 * base64 that buried the total. The owner has since watched someone use it:
 * "I shared the trip and chose email to send to my friends but it didn't
 * have the flight links so it becomes useless unless they also use the tool
 * to find those flights as well."
 *
 * And it costs him money. A recipient who cannot book from the message runs
 * the search again, spending the owner's metered allowance to recover an
 * answer he already paid for. The links go back in; what keeps the message
 * readable is that the prose came out, so there is now one link per person
 * rather than paragraphs around them. */
ck('every flyer gets a bookable link', (t.match(/https?:\/\//g) || []).length === 4,
   (t.match(/https?:\/\//g) || []).length + ' links for 3 people + the trip');
ck('the trip link is still last', t.trim().split('\n').pop().indexOf('#t=abc123') > -1,
   t.trim().split('\n').pop());
ck('every traveller is named', (t.match(/Traveller/g) || []).length === 3);
ck('the trip link is there', t.indexOf('#t=abc123') > -1);

console.log('\n-- no per-person fare breakdown --');
/* Asserted the opposite until the owner's line was read properly: "the email to
 * everyone should provide the links and jus tottal price not the break outs".
 * A per-person fare IS a break-out of the total, and three of them in a row
 * invite the arithmetic the trip link answers properly. The only dollar figure
 * in the body is now the group total -- checked above at exactly one $1,028. */
/* Also reversed, and for the same reason. "What each person pays" was cut
 * as a break-out that invites "why is mine $40 more than yours"; the owner
 * now wants "flight, price, time, links for each flyer" because a recipient
 * is about to pay for exactly one of these and needs to know which number
 * is theirs. */
ck('each flyer sees their own fare', (t.match(/\$340/g) || []).length === 3,
   (t.match(/\$340/g) || []).length + ' of 3');
ck('and the group total is there once', (t.match(/\$1,028/g) || []).length === 1);
/* ...and the landing time is what each line carries instead, because that is
 * the claim the app is making. */
ck('every flyer is named', (t.match(/Traveller/g) || []).length === 3);
/* A landing time per person is allowed and useful -- it is how somebody checks
 * their own line. What must stay out is the itinerary: carriers, routes, stop
 * counts and per-leg fares. That is what the trip link is for. */
/* The itinerary is now the point, not the thing to keep out: a recipient
 * has to recognise their own flight before they will click a link to pay
 * for it. What stays out is prose. */
ck('each flyer sees their route', (t.match(/LGA\u2192FLL/g) || []).length === 3);
ck('and no sentences wrapped around it',
   t.indexOf('Open the trip') === -1 && t.indexOf('one tap') === -1
   && t.indexOf('all in') === -1, t.slice(0, 120));
ck('no WHAT EACH PERSON PAYS block', t.indexOf('EACH PERSON') === -1);

console.log('\n-- a large group drops links, never the trip link --');
var big = body(makeCtx(60).emailUrl());
ck('body stays under the cap', big.length <= 1800, 'length ' + big.length);
ck('the trip link survives', big.indexOf('#t=abc123') > -1);
ck('the total survives', big.indexOf('$1,028') > -1);
ck('the header survives', big.indexOf('Fort Lauderdale') === 0, big.split('\n')[0]);
ck('the cut is marked', big.indexOf('…') > -1);

console.log('\n-- an absurd group still degrades to result, total and link --');
var huge = body(makeCtx(400).emailUrl());
ck('still bounded', huge.length <= 1800, 'length ' + huge.length);
ck('trip link survives even then', huge.indexOf('#t=abc123') > -1);

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASSED'));
process.exitCode = fail ? 1 : 0;
