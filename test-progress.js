/* Tests for the searching screen's progress logic.
 *
 * The worker reports each traveler's legs as they resolve, over server-sent
 * events, and this file covers the two pure pieces that sit between the wire
 * and the screen: pulling frames out of a byte stream that is split wherever
 * TCP felt like splitting it, and folding the events into one state per
 * person.
 *
 * Both are worth a suite because both fail quietly. A frame parser that drops
 * a partial chunk loses one row's animation and nothing else -- the search
 * still works, the screen just stops telling the truth about one person. A
 * fold that is not idempotent over-counts "4 of 6" on a redraw, which is the
 * exact class of claim this screen exists not to make.
 *
 * No DOM and no network: the block is sliced into a vm with neither defined,
 * so a candidate that reached for either would throw rather than pass.
 */
var fs = require('fs'), vm = require('vm');
var src = fs.readFileSync(__dirname + '/app.js', 'utf8');

var pass = 0, fail = 0;
function check(n, c, extra) {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (extra ? '\n          ' + extra : '')); }
}
function eq(n, got, want) {
    check(n, got === want, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));
}
function deep(n, got, want) {
    check(n, JSON.stringify(got) === JSON.stringify(want),
          'got ' + JSON.stringify(got) + '\n          wanted ' + JSON.stringify(want));
}

function cut(a, b, label) {
    var i = src.indexOf(a), j = src.indexOf(b);
    if (i < 0 || j < 0 || j < i) {
        console.error('FAIL: could not locate ' + label + ' in app.js');
        process.exit(1);
    }
    return src.slice(i, j);
}

var ctx = { console: console };
/* prettyRange lives outside the fenced block and belongs to test-dates.js.
 * Stubbed to the one property this screen depends on: that it already says
 * "one way" itself, which is the thing the screen used to say twice. */
ctx.prettyRange = function (a, b) {
    if (!a) return '';
    return b ? (a + ' – ' + b) : (a + ' · one way');
};
vm.createContext(ctx);
/* Sliced by the landmark comments wrapped round the block rather than by the
 * name of the first function in it -- a suite that slices on something a
 * refactor can rewrite exits 1 for a day with nobody noticing. cut() exits
 * non-zero when it cannot find either end. */
vm.runInContext(cut('/* --- BEGIN search progress', '/* --- END search progress',
                    'the search progress block'), ctx);

/* ------------------------------------------------------------------------ */
console.log('\n1. Frames out of a byte stream');

var one = 'event: leg\ndata: {"id":"a","leg":"outbound","found":4,"error":null}\n\n';

(function () {
    var r = ctx.sxFrames(one);
    eq('one whole frame yields one frame', r.frames.length, 1);
    eq('...named by its event field', r.frames[0].event, 'leg');
    eq('...carrying its data verbatim', r.frames[0].data,
       '{"id":"a","leg":"outbound","found":4,"error":null}');
    eq('...and leaves nothing behind', r.rest, '');
}());

(function () {
    var r = ctx.sxFrames(one + one + one);
    eq('three frames in one chunk yield three', r.frames.length, 3);
    eq('...with nothing left over', r.rest, '');
}());

/* The case the whole function exists for. A reader gets whatever arrived, and
 * what arrived is routinely half a JSON payload. */
(function () {
    var whole = one + one;
    var seen = [], rest = '';
    for (var at = 0; at < whole.length; at += 7) {
        var r = ctx.sxFrames(rest + whole.slice(at, at + 7));
        rest = r.rest;
        seen = seen.concat(r.frames);
    }
    eq('a stream cut into 7-byte chunks still yields both frames', seen.length, 2);
    eq('...and nothing is stranded at the end', rest, '');
    eq('...with the payload intact', seen[1].data,
       '{"id":"a","leg":"outbound","found":4,"error":null}');
}());

(function () {
    /* Byte 1 of 2 in a multi-byte character has no business being parsed, but
     * it is the DECODER's job to hold it, not this function's -- here the
     * concern is only that a frame boundary is never guessed at. */
    var r = ctx.sxFrames('event: leg\ndata: {"id":"a"');
    eq('an incomplete frame yields nothing', r.frames.length, 0);
    eq('...and is held whole for the next chunk', r.rest, 'event: leg\ndata: {"id":"a"');
}());

(function () {
    var r = ctx.sxFrames(one + 'event: leg\ndata: {"id":"b"');
    eq('a whole frame followed by a partial yields one', r.frames.length, 1);
    eq('...and holds the partial', r.rest, 'event: leg\ndata: {"id":"b"');
}());

eq('CRLF framing is read the same as LF',
   ctx.sxFrames('event: leg\r\ndata: 1\r\n\r\n').frames.length, 1);
eq('...with the data unharmed',
   ctx.sxFrames('event: leg\r\ndata: 1\r\n\r\n').frames[0].data, '1');

/* Proxies and CDNs inject comment lines as keep-alives. Reading one as data
 * would put a JSON.parse failure in the middle of a working stream. */
(function () {
    var r = ctx.sxFrames(': keep-alive\n\n' + one);
    eq('a keep-alive comment is not a frame', r.frames.length, 1);
    eq('...and does not swallow the frame after it', r.frames[0].event, 'leg');
}());

eq('a field with no space after the colon still parses',
   ctx.sxFrames('event:leg\ndata:{"x":1}\n\n').frames[0].data, '{"x":1}');
eq('exactly one leading space is framing, a second is data',
   ctx.sxFrames('data:  two spaces\n\n').frames[0].data, ' two spaces');
eq('a frame with no event field is named message',
   ctx.sxFrames('data: 1\n\n').frames[0].event, 'message');
eq('multiple data lines join with a newline',
   ctx.sxFrames('event: x\ndata: a\ndata: b\n\n').frames[0].data, 'a\nb');
eq('an empty buffer yields no frames', ctx.sxFrames('').frames.length, 0);
eq('a null buffer does not throw', ctx.sxFrames(null).rest, '');
eq('a frame with no data line is not a frame',
   ctx.sxFrames('event: ping\n\n').frames.length, 0);
/* The whole point of returning `rest`: a chunk that ends exactly on a frame
 * boundary must not leave a phantom empty frame behind for the next call. */
eq('a buffer ending on the boundary leaves an empty rest', ctx.sxFrames(one).rest, '');

/* ------------------------------------------------------------------------ */
console.log('\n2. Folding events into one state per traveler');

var IDS = ['a', 'b', 'c'];
function ev(id, leg, found, error) {
    return { id: id, leg: leg, found: found, error: error || null };
}
function states(evs, ids, legs) {
    return ctx.sxRoll(evs, ids || IDS, legs || 2).rows.map(function (r) { return r.state; });
}

deep('nothing received: everyone pending', states([]), ['pending', 'pending', 'pending']);
deep('one leg of three travelers round trip',
     states([ev('a', 'outbound', 4)]), ['partial', 'pending', 'pending']);
deep('both legs in: found',
     states([ev('a', 'outbound', 4), ev('a', 'return', 3)]),
     ['found', 'pending', 'pending']);
deep('one way: a single leg is the whole traveler',
     states([ev('a', 'outbound', 4)], IDS, 1), ['found', 'pending', 'pending']);

eq('the count is legs finished, not people finished',
   ctx.sxRoll([ev('a', 'outbound', 4), ev('b', 'return', 2)], IDS, 2).done, 2);
eq('...against a total of people times legs',
   ctx.sxRoll([], IDS, 2).total, 6);
eq('one way halves the total', ctx.sxRoll([], IDS, 1).total, 3);

/* Idempotence. A redraw replays the whole list, and so does a worker that
 * repeats itself; neither may push the counter past its own total. */
(function () {
    var dup = [ev('a', 'outbound', 4), ev('a', 'outbound', 4), ev('a', 'outbound', 4)];
    eq('the same leg twice counts once', ctx.sxRoll(dup, IDS, 2).done, 1);
    deep('...and does not promote the row to found', states(dup), ['partial', 'pending', 'pending']);
}());

(function () {
    var all = [];
    IDS.forEach(function (id) {
        all.push(ev(id, 'outbound', 4));
        all.push(ev(id, 'return', 4));
    });
    eq('every leg in: the count equals the total', ctx.sxRoll(all, IDS, 2).done, 6);
    eq('...and cannot exceed it when replayed', ctx.sxRoll(all.concat(all), IDS, 2).done, 6);
}());

/* An event for somebody who was removed between pressing search and the
 * answer landing. Counting it would print "7 of 6". */
eq('an event for an unknown traveler is ignored',
   ctx.sxRoll([ev('zz', 'outbound', 4)], IDS, 2).done, 0);
deep('...and changes nobody else', states([ev('zz', 'outbound', 4)]),
     ['pending', 'pending', 'pending']);

console.log('\n3. The two ways a leg can come back empty are not the same');

deep('a route with no service says so at once, without waiting for the return',
     states([ev('a', 'outbound', 0, 'none')]), ['none', 'pending', 'pending']);
deep('a leg that could not be asked says so at once',
     states([ev('a', 'outbound', 0, 'failed')]), ['failed', 'pending', 'pending']);
deep('failed outranks none, whichever order they arrive in',
     states([ev('a', 'outbound', 0, 'none'), ev('a', 'return', 0, 'failed')]),
     ['failed', 'pending', 'pending']);
deep('...and in the other order',
     states([ev('a', 'outbound', 0, 'failed'), ev('a', 'return', 0, 'none')]),
     ['failed', 'pending', 'pending']);
/* Flights home are no use to somebody who cannot get there. */
deep('a found return does not rescue a failed departure',
     states([ev('a', 'outbound', 0, 'failed'), ev('a', 'return', 9)]),
     ['failed', 'pending', 'pending']);
deep('a found departure does not hide a dead return',
     states([ev('a', 'outbound', 9), ev('a', 'return', 0, 'none')]),
     ['none', 'pending', 'pending']);
/* A failure is still a finished search: it was paid for and it is not
 * coming back, so the footer must count it. */
eq('a failed leg still counts toward the done figure',
   ctx.sxRoll([ev('a', 'outbound', 0, 'failed')], IDS, 2).done, 1);

(function () {
    var r = ctx.sxRoll([ev('a', 'outbound', 4)], IDS, 2).rows[0];
    eq('the row names which leg arrived', r.outbound, 'ok');
    eq('...and which has not', r.return, null);
    eq('...and how many of its legs are in', r.done, 1);
}());
(function () {
    var r = ctx.sxRoll([ev('a', 'return', 0, 'none')], IDS, 2).rows[0];
    eq('an error code is carried through to the leg, not flattened to ok',
       r.return, 'none');
}());

console.log('\n4. Eight people, sixteen legs, arriving in waves');
(function () {
    /* Cloudflare allows six connections per invocation to be waiting for
     * response headers at a time, so sixteen legs genuinely resolve in three
     * groups rather than all at once. This is the shape the screen has to
     * hold without ever showing more progress than has happened. */
    var ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    var legs = [];
    ids.forEach(function (id) { legs.push(ev(id, 'outbound', 4)); });
    ids.forEach(function (id) { legs.push(ev(id, 'return', 4)); });
    var seen = [], last = 0;
    for (var i = 0; i < legs.length; i++) {
        seen.push(legs[i]);
        var roll = ctx.sxRoll(seen, ids, 2);
        if (roll.done < last) { check('progress never goes backwards', false, 'at ' + i); return; }
        if (roll.done > roll.total) { check('progress never exceeds the total', false, 'at ' + i); return; }
        last = roll.done;
    }
    check('progress never goes backwards and never exceeds the total', true);
    eq('all sixteen legs land', last, 16);
    deep('...and everybody ends found',
         ctx.sxRoll(seen, ids, 2).rows.map(function (r) { return r.state; }),
         ids.map(function () { return 'found'; }));
}());

(function () {
    /* Two people from the same city are ONE search at the provider, fanned
     * back out to both. If the worker ever announced per unique search
     * instead of per job, the second person would wait forever. */
    var ids = ['a', 'b'];
    var roll = ctx.sxRoll([ev('a', 'outbound', 4), ev('b', 'outbound', 4)], ids, 1);
    eq('a shared route resolves both travelers', roll.done, 2);
    deep('...and both read as found', roll.rows.map(function (r) { return r.state; }),
         ['found', 'found']);
}());

console.log('\n5. The dates line');
eq('a round trip reads as a range', ctx.sxWhenLine('2027-03-17', '2027-03-24'),
   '2027-03-17 – 2027-03-24');
/* The bug this function was extracted for: the screen appended " one way" to
 * a string that already ended in it. */
eq('a one way says it once', ctx.sxWhenLine('2027-06-02', ''), '2027-06-02 · one way');
eq('...and once when the return is null', ctx.sxWhenLine('2027-06-02', null),
   '2027-06-02 · one way');
check('a one way never says it twice',
      ctx.sxWhenLine('2027-06-02', '').indexOf('one way')
      === ctx.sxWhenLine('2027-06-02', '').lastIndexOf('one way'),
      ctx.sxWhenLine('2027-06-02', ''));
eq('no departure date yet, no line', ctx.sxWhenLine('', ''), '');

console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASSED' : pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
