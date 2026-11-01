/* Tests for the flight map.
 *
 * The map card is the one picture in the app that makes a claim about the
 * world rather than about the search, so the things worth asserting are not
 * "does it render". They are:
 *
 *   - the projection says what it says. Bearing out of the destination is the
 *     part of this picture that is exactly true, and the one distortion that
 *     exists -- the floor under short routes -- must never reverse who is
 *     further away or invent a shared origin.
 *   - nothing is drawn on top of anything. The mockup this replaces had
 *     "Kyle - 6:35 AM" with a flight path through the middle of it, and a
 *     label struck through by its own route is the specific defect the
 *     placement code exists to make impossible.
 *   - reduced motion means no animation, not a slow one. Turning SMIL off
 *     from CSS is not possible, so the only guarantee is that the markup does
 *     not contain an animation in the first place.
 *
 * No DOM: the whole flight map block is pure, and it is lifted into a vm by
 * the two landmark comments wrapped round it in app.js rather than by the
 * name of anything inside it. cut() exits non-zero when it cannot find either
 * end, because a suite that silently tests nothing is worse than no suite.
 */
var fs = require('fs'), vm = require('vm');
var src = fs.readFileSync(__dirname + '/app.js', 'utf8');

var pass = 0, fail = 0;
function check(n, c, extra) {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (extra ? '\n          ' + extra : '')); }
}
function eq(n, got, want) { check(n, got === want, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want)); }
function near(n, got, want, tol) {
    check(n, Math.abs(got - want) <= (tol == null ? 1e-6 : tol),
          'got ' + got + ', wanted ' + want + ' +/- ' + (tol == null ? 1e-6 : tol));
}

function cut(a, b, label) {
    var i = src.indexOf(a), j = src.indexOf(b);
    if (i < 0 || j < 0 || j < i) {
        console.error('FAIL: could not locate ' + label + ' in app.js');
        process.exit(1);
    }
    return src.slice(i, j);
}

var ctx = { console: console, Math: Math, Infinity: Infinity, isFinite: isFinite, Array: Array,
            String: String, Number: Number, JSON: JSON };
/* esc lives outside the block and is pure. The block is allowed to call it,
 * and nothing else from outside. */
ctx.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
};
vm.createContext(ctx);
vm.runInContext(cut('/* --- BEGIN flight map', '/* --- END flight map', 'the flight map'), ctx);

/* Real coordinates for the handful of airports the cases below use. The table
 * itself is somebody else's file; these are inlined so this suite does not
 * depend on a data file to say whether the geometry is right. */
var AP = {
    ATL: [33.64, -84.43], DEN: [39.86, -104.67], SFO: [37.62, -122.39],
    OAK: [37.72, -122.22], ORD: [41.98, -87.90], BOS: [42.36, -71.01],
    LGA: [40.78, -73.87], MIA: [25.80, -80.29], SEA: [47.45, -122.31],
    AUS: [30.19, -97.67], LHR: [51.47, -0.46], DUB: [53.43, -6.27],
    JFK: [40.64, -73.78], SYD: [-33.95, 151.18], GRU: [-23.44, -46.47],
    COS: [38.81, -104.70], ABQ: [35.04, -106.61]
};
var COLORS = ['#986306', '#177984', '#3c6bc7', '#994cbb', '#bb482c', '#be4066', '#147d45', '#61760a'];
function orig(codes) {
    return codes.map(function (c, i) {
        return { id: 'p' + i, code: c, lat: AP[c][0], lon: AP[c][1],
                 color: COLORS[i % COLORS.length], initials: 'ABCDEFGH'.charAt(i) };
    });
}
function dest(c) { return { code: c, lat: AP[c][0], lon: AP[c][1] }; }
function lay(d, codes, opts) { return ctx.fmLayout(dest(d), orig(codes), opts); }

function dist(a, b) { return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2)); }
function boxOf(n) {
    var w = ctx.fmLabelW(n.label), h = ctx.FM_LBL_H;
    return { x0: n.lx - w / 2, y0: n.ly - h / 2, x1: n.lx + w / 2, y1: n.ly + h / 2 };
}

console.log('\n-- the projection --');
(function () {
    var P = ctx.fmProject;
    var at = P(AP.ATL[0], AP.ATL[1], AP.ATL[0], AP.ATL[1]);
    check('the destination is the origin of the picture', at.x === 0 && at.y === 0);

    /* y grows downwards on a screen, so north has to come out negative. A map
     * that flips its y somewhere else is a map that will one day be upside
     * down. */
    var north = P(40, -84.43, 33.64, -84.43);
    check('due north is straight up', Math.abs(north.x) < 1e-9 && north.y < 0,
          JSON.stringify(north));
    var south = P(20, -84.43, 33.64, -84.43);
    check('due south is straight down', Math.abs(south.x) < 1e-9 && south.y > 0);
    var east = P(0, 10, 0, 0);
    check('due east is to the right', east.x > 0 && Math.abs(east.y) < 1e-9);
    var west = P(0, -10, 0, 0);
    check('due west is to the left', west.x < 0 && Math.abs(west.y) < 1e-9);

    /* Equidistant means the radius IS the great-circle distance. Ten degrees
     * of a great circle is 1111.9km on a 6371km sphere. */
    near('radius is great-circle distance, to scale',
         Math.sqrt(east.x * east.x + east.y * east.y), 10 * Math.PI / 180 * 6371, 0.001);

    /* ORD is roughly north-north-west of ATL and SFO is roughly west of it,
     * which the picture has to agree with or every card is subtly wrong. */
    var ord = P(AP.ORD[0], AP.ORD[1], AP.ATL[0], AP.ATL[1]);
    var sfo = P(AP.SFO[0], AP.SFO[1], AP.ATL[0], AP.ATL[1]);
    check('Chicago is up and a little left of Atlanta', ord.y < 0 && ord.x < 0 && Math.abs(ord.x) < Math.abs(ord.y));
    check('San Francisco is mostly left of it', sfo.x < 0 && Math.abs(sfo.x) > Math.abs(sfo.y));
    check('...and further away than Chicago',
          Math.sqrt(sfo.x * sfo.x + sfo.y * sfo.y) > Math.sqrt(ord.x * ord.x + ord.y * ord.y));

    /* The antipode is the whole outer circle at once. It has no answer; it
     * must not have NaN either, because NaN reaches the stylesheet as a
     * coordinate and silently drops the marker. */
    var anti = P(-33.64, 95.57, 33.64, -84.43);
    check('the antipode is a number, not NaN', isFinite(anti.x) && isFinite(anti.y),
          JSON.stringify(anti));
})();

console.log('\n-- fitting the viewBox --');
(function () {
    var pts = [{ x: -100, y: -50 }, { x: 100, y: 50 }, { x: 0, y: 0 }];
    var f = ctx.fmFit(pts, 300, 200, 20, 30);
    var out = pts.map(function (p) { return ctx.fmAt(f, p); });
    check('every point lands inside the padded box',
          out.every(function (p) { return p.x >= 20 - 1e-9 && p.x <= 280 + 1e-9
                                       && p.y >= 30 - 1e-9 && p.y <= 170 + 1e-9; }),
          JSON.stringify(out));
    /* One scale for both axes. Two would stretch the geography, and a
     * stretched azimuthal projection is not equidistant in any direction --
     * which is the only reason this projection was chosen. */
    var sx = (out[1].x - out[0].x) / 200, sy = (out[1].y - out[0].y) / 100;
    near('x and y are scaled by the same number', sx, sy, 1e-9);
    near('and it is the one that just fits the tighter axis', sx, Math.min(260 / 200, 140 / 100), 1e-9);

    var flat = ctx.fmFit([{ x: -10, y: 0 }, { x: 10, y: 0 }], 300, 200, 20, 20);
    check('three airports in a line still fill the box',
          Math.abs(ctx.fmAt(flat, { x: -10, y: 0 }).x - 20) < 1e-9);
    var same = ctx.fmFit([{ x: 5, y: 5 }, { x: 5, y: 5 }], 300, 200, 20, 20);
    check('everybody in one place does not divide by zero',
          isFinite(same.k) && isFinite(same.ox) && isFinite(same.oy), JSON.stringify(same));
    var none = ctx.fmFit([], 300, 200, 20, 20);
    check('and neither does nobody', isFinite(none.k) && isFinite(none.ox));

    /* Centered, not corner-pinned: a cloud narrower than the box gets the
     * slack split between the two sides. */
    var tall = ctx.fmFit([{ x: 0, y: -10 }, { x: 0, y: 10 }], 300, 200, 20, 20);
    near('spare width is split evenly', ctx.fmAt(tall, { x: 0, y: 0 }).x, 150, 1e-9);
})();

console.log('\n-- the card is as tall as the group --');
(function () {
    var wide = ctx.fmHeight([{ x: -1000, y: -10 }, { x: 1000, y: 10 }], 327, 29, 38);
    eq('a group strung east to west gets the floor', wide, ctx.FM_H_MIN);
    var tall = ctx.fmHeight([{ x: -10, y: -1000 }, { x: 10, y: 1000 }], 327, 29, 38);
    eq('a group strung north to south gets the ceiling', tall, ctx.FM_H_MAX);
    var mid = ctx.fmHeight([{ x: -200, y: -60 }, { x: 200, y: 60 }], 327, 29, 38);
    check('and anything between gets its own shape',
          mid > ctx.FM_H_MIN && mid < ctx.FM_H_MAX, String(mid));
    /* The point of the adaptive height: at that height the fit has no slack
     * left on either axis, so there is no dead band above and below. */
    var f = ctx.fmFit([{ x: -200, y: -60 }, { x: 200, y: 60 }], 327, mid, 29, 38);
    near('at that height the cloud fills the width exactly',
         ctx.fmAt(f, { x: 200, y: 0 }).x, 327 - 29, 0.5);
    near('...and the height within a rounding of a unit',
         ctx.fmAt(f, { x: 0, y: 60 }).y, mid - 38, 1);
    eq('a cloud with no width falls back to the floor',
       ctx.fmHeight([{ x: 3, y: 3 }], 327, 29, 38), ctx.FM_H_MIN);
})();

console.log('\n-- one place is one marker, and two places never are --');
(function () {
    var mk = function (i, x, y, kx, ky) {
        return { i: i, x: x, y: y, kx: kx == null ? x : kx, ky: ky == null ? y : ky,
                 d: Math.sqrt(x * x + y * y) };
    };
    var g = ctx.fmCluster([mk(0, 0, 0), mk(1, 5, 0), mk(2, 100, 0)], 20, 1e9);
    eq('two markers inside the threshold become one', g.length, 2);
    eq('and the merged one carries both', g[0].members.length, 2);
    near('drawn at the middle of what it covers', g[0].x, 2.5, 1e-9);

    /* Measured from the FIRST member and never from the last, so a straggle
     * of airports cannot chain into one node spanning half the picture. */
    var chain = ctx.fmCluster([mk(0, 0, 0), mk(1, 15, 0), mk(2, 30, 0), mk(3, 45, 0)], 20, 1e9);
    eq('a straggle cannot chain into one node', chain.length, 2);
    check('no cluster covers more than the threshold',
          chain.every(function (c) {
              return c.members.every(function (m) { return Math.abs(m.x - c.seed.x) < 20; });
          }));

    /* The screen test alone would print "JFK.DUB" the moment the floor lifted
     * Dublin onto New York. Two airports are one marker only if they are a
     * taxi apart on the ground as well. */
    var far = ctx.fmCluster([mk(0, 0, 0, 0, 0), mk(1, 5, 0, 5000, 0)], 20, ctx.FM_MERGE_KM);
    eq('a pixel apart is not enough if they are 5000km apart', far.length, 2);
    var near2 = ctx.fmCluster([mk(0, 0, 0, 0, 0), mk(1, 5, 0, 17, 0)], 20, ctx.FM_MERGE_KM);
    eq('a taxi apart is', near2.length, 1);

    /* Nearest the hub settles first, so the answer does not depend on the
     * order the party list happened to be typed in. */
    var a = ctx.fmCluster([mk(0, 90, 0), mk(1, 10, 0), mk(2, 15, 0)], 20, 1e9);
    var b = ctx.fmCluster([mk(2, 15, 0), mk(0, 90, 0), mk(1, 10, 0)], 20, 1e9);
    eq('clustering does not depend on input order',
       JSON.stringify(a.map(function (c) { return c.members.map(function (m) { return m.i; }); })),
       JSON.stringify(b.map(function (c) { return c.members.map(function (m) { return m.i; }); })));
    /* ...and a facepile reads left to right the way the party list does. */
    /* The nearer one is clustered first, so without the re-sort the pile
     * would read 3 then 1 -- a facepile in the order the geometry happened
     * to visit, which is not an order anybody on the screen can see. */
    var piled = ctx.fmCluster([mk(1, 9, 0), mk(3, 2, 0)], 20, 1e9);
    eq('a facepile is in party order, not cluster order',
       JSON.stringify(piled[0].members.map(function (m) { return m.i; })), '[1,3]');
})();

console.log('\n-- the curve --');
(function () {
    var a = { x: 0, y: 0 }, b = { x: 100, y: 0 };
    var straight = ctx.fmQuad(a, b, 0);
    near('bow 0 puts the control point on the chord', straight.p1.y, 0);
    near('...which is the exact great circle on this projection',
         ctx.fmQuadAt(straight, 0.5).y, 0);
    eq('a straight run points along itself', ctx.fmQuadAngle(straight, 0.5), 0);

    var bowed = ctx.fmQuad(a, b, 0.1);
    near('a bowed path still starts where it starts', ctx.fmQuadAt(bowed, 0).x, 0);
    near('...and ends where it ends', ctx.fmQuadAt(bowed, 1).x, 100);
    near('the bow is the stated fraction of the length', Math.abs(bowed.p1.y), 10, 1e-9);
    /* One rotational sense for every path, so the picture turns one way
     * rather than each curve choosing a side. */
    var back = ctx.fmQuad(b, a, 0.1);
    check('reversing the path reverses the side it bows to',
          Math.sign(bowed.p1.y) !== Math.sign(back.p1.y));

    /* On a diagonal the bow has to move both coordinates. A version that
     * only moved one still passed every horizontal case, and drew every
     * diagonal route bowing the wrong way. */
    var diag = ctx.fmQuad({ x: 0, y: 0 }, { x: 80, y: 60 }, 0.1);
    var cross = (80 - 0) * (diag.p1.y - 0) - (60 - 0) * (diag.p1.x - 0);
    var crossH = (100 - 0) * (bowed.p1.y - 0) - (0 - 0) * (bowed.p1.x - 0);
    check('a diagonal bows to the same side as a flat one',
          Math.sign(cross) === Math.sign(crossH), cross + ' vs ' + crossH);
    near('and by the same fraction of its own length',
         Math.abs(cross) / Math.pow(100, 2), 0.1, 1e-9);
    /* And on the other diagonal, where the sideways component changes
     * sign. A bow that took the magnitude of it drew every north-east
     * route correctly and every south-east one backwards. */
    var up = ctx.fmQuad({ x: 0, y: 0 }, { x: 80, y: -60 }, 0.1);
    var crossUp = 80 * up.p1.y - (-60) * up.p1.x;
    check('and a route going the other way bows to the same side too',
          Math.sign(crossUp) === Math.sign(crossH), crossUp + ' vs ' + crossH);
    near('the sideways offset keeps its sign', up.p1.x, 40 + (-60 / 100) * 10, 1e-9);

    /* The angle has to be read at the end being asked about. Sampled only
     * at the midpoint, a tangent that swapped its two terms looked right --
     * the midpoint is the one place the swap cancels. */
    /* Asserted as numbers at both ends, not as "they differ". A tangent
     * with its two terms swapped is exactly right at the midpoint and
     * exactly backwards everywhere else, and "they differ" cannot see it. */
    var deg = function (v) { return Math.atan2(v[1], v[0]) / Math.PI * 180; };
    near('a path leaves along its first control leg',
         ctx.fmQuadAngle(diag, 0), deg([diag.p1.x - diag.p0.x, diag.p1.y - diag.p0.y]), 1e-9);
    near('and arrives along its last',
         ctx.fmQuadAngle(diag, 1), deg([diag.p2.x - diag.p1.x, diag.p2.y - diag.p1.y]), 1e-9);
    check('which are not the same angle on a bowed path',
          Math.abs(ctx.fmQuadAngle(diag, 0) - ctx.fmQuadAngle(diag, 1)) > 10);

    var deg = ctx.fmQuad(a, a, 0.1);
    check('a zero-length path does not produce NaN',
          isFinite(ctx.fmQuadAngle(deg, 0.5)) && isFinite(ctx.fmQuadAt(deg, 0.5).x));
})();

console.log('\n-- splitting and trimming --');
(function () {
    var q = ctx.fmQuad({ x: 0, y: 0 }, { x: 100, y: 40 }, 0.12);
    var sub = ctx.fmSplitQuad(q, 0.25, 0.75);
    var p25 = ctx.fmQuadAt(q, 0.25), p75 = ctx.fmQuadAt(q, 0.75);
    near('a split starts exactly on the parent', ctx.fmQuadAt(sub, 0).x, p25.x, 1e-9);
    near('...and ends exactly on it', ctx.fmQuadAt(sub, 1).y, p75.y, 1e-9);
    /* Splitting rather than resampling, so the trimmed path is still the same
     * curve: the plane runs along the geometry that was drawn. */
    var mid = ctx.fmQuadAt(sub, 0.5), parentMid = ctx.fmQuadAt(q, 0.5);
    near('and the middle of the middle is still on the curve', mid.x, parentMid.x, 1e-9);
    near('', mid.y, parentMid.y, 1e-9);

    var line = ctx.fmQuad({ x: 0, y: 0 }, { x: 100, y: 0 }, 0);
    var tab = ctx.fmArcTable(line);
    near('a straight run measures its own length', tab.len, 100, 1e-9);
    near('half the length is half way along', ctx.fmTAtLen(tab, 50), 0.5, 1e-9);
    eq('nothing before the start', ctx.fmTAtLen(tab, -5), 0);
    eq('nothing past the end', ctx.fmTAtLen(tab, 500), 1);

    var trimmed = ctx.fmTrimQuad(line, 20, 30);
    near('trimming takes the stated distance off the front', ctx.fmQuadAt(trimmed, 0).x, 20, 0.05);
    near('...and off the back', ctx.fmQuadAt(trimmed, 1).x, 70, 0.05);
    /* A route shorter than the two markers put together has nothing left to
     * draw, and a backwards line is worse than no line. */
    eq('a route with nothing left to draw draws nothing',
       ctx.fmTrimQuad(line, 60, 60), null);
    /* And a route with almost nothing left draws nothing either. A half-unit
     * of curve under two markers is a rendering artefact, not a flight. */
    eq('...nor does one with half a unit left',
       ctx.fmTrimQuad(line, 49.8, 49.8), null);
    check('but a short route that can still be seen is drawn',
          ctx.fmTrimQuad(line, 44, 44) !== null);
})();

console.log('\n-- what counts as a collision --');
(function () {
    var box = { x0: 0, y0: 0, x1: 10, y1: 10 };
    eq('boxes that miss overlap by nothing', ctx.fmOverlap(box, { x0: 20, y0: 0, x1: 30, y1: 10 }), 0);
    eq('boxes that touch do not count as overlapping', ctx.fmOverlap(box, { x0: 10, y0: 0, x1: 20, y1: 10 }), 0);
    eq('and an overlap is reported as an area', ctx.fmOverlap(box, { x0: 5, y0: 5, x1: 15, y1: 15 }), 25);
    eq('a box wholly on the card is nothing outside it', ctx.fmOutside(box, 100, 100), 0);
    eq('half off the edge is half of it', ctx.fmOutside({ x0: -5, y0: 0, x1: 5, y1: 10 }, 100, 100), 50);

    /* The mockup bug, stated as a test: a label in clear space with a flight
     * path straight through the middle of it. Neither end of the segment is
     * inside the box, so an endpoint test would call this a miss. */
    check('a segment passing clean through a label counts',
          ctx.fmSegBox(-50, 5, 50, 5, box));
    check('a segment alongside it does not', !ctx.fmSegBox(-50, 50, 50, 50, box));
    check('a segment ending inside counts', ctx.fmSegBox(-50, 5, 5, 5, box));
    check('a segment that stops short does not', !ctx.fmSegBox(-50, 5, -20, 5, box));
    check('a diagonal clipping one corner counts', ctx.fmSegBox(-2, 2, 2, -2, box));
})();

console.log('\n-- where a code goes --');
(function () {
    var hub = { x: 100, y: 100, r: 18 };
    var node = { x: 200, y: 100, r: 14, hitR: 14, label: 'SFO' };

    /* The placement that cannot be struck through by its own route: the route
     * arrives from the hub side, so the far side is the one side it is never
     * on. */
    var dirs = ctx.fmLabelDirs(node, hub);
    near('the first choice is radially outward from the hub', dirs[0], 0, 1e-9);
    eq('there is one candidate per direction', dirs.length, ctx.FM_LBL_DIRS);
    var devs = dirs.map(function (a) { return Math.abs(a - dirs[0]); });
    check('and they are offered nearest-first',
          devs.every(function (d, i) { return i === 0 || d >= devs[i - 1] - 1e-9; }),
          JSON.stringify(devs));

    /* A label set diagonally must sit as close as one set square, and neither
     * may touch the ring. */
    var clears = true, closest = Infinity;
    for (var k = 0; k < 24; k++) {
        var a = k / 24 * 2 * Math.PI;
        var b = ctx.fmLabelBox(node, a, 'SFO', 0);
        var dx = Math.max(b.x0 - node.x, node.x - b.x1, 0);
        var dy = Math.max(b.y0 - node.y, node.y - b.y1, 0);
        var gap = Math.sqrt(dx * dx + dy * dy);
        if (gap < node.r) clears = false;
        if (gap < closest) closest = gap;
    }
    check('a label never touches its own marker, at any angle', clears);
    check('...and never floats off it either', closest < node.r + ctx.FM_PAD + 2, String(closest));

    /* A marker carrying a facepile is a capsule, not a circle. Before this,
     * the code for a two-person marker was placed off the middle of the pile
     * and landed on the second face. */
    var pile = { x: 200, y: 100, r: 14, hitR: ctx.fmPileR(2, 14), label: 'SFO·OAK' };
    var side = ctx.fmLabelBox(pile, 0, pile.label, 0);
    check('a label clears the whole facepile, not just its middle',
          side.x0 >= pile.x + pile.hitR, side.x0 + ' vs ' + (pile.x + pile.hitR));

    /* Measured, not guessed: capitals are wider than the timeline's digits,
     * and the knockout stroke is painted outside the glyphs. */
    check('the width estimate covers a three-letter code',
          ctx.fmLabelW('ORD') >= 24.13 + ctx.FM_LBL_HALO);
    check('and an interpunct is counted as the half-character it is',
          ctx.fmLabelW('SFO·OAK') < 7 * ctx.FM_LBL_CH + ctx.FM_LBL_HALO);
})();

console.log('\n-- what a placement costs --');
(function () {
    /* The weights are an ordering, not a tuning, and the ordering is the
     * thing worth asserting: cut off by the edge of the card is worse than
     * sitting on another label, which is worse than sitting on a face,
     * which is worse than being crossed by a line, which is worse than
     * pointing the wrong way. */
    var base = { w: 300, h: 200, labels: [], dots: [], segs: [], ideal: 0, self: -1 };
    var at = function (x, y) { return { x0: x, y0: y, x1: x + 30, y1: y + 16, cx: x + 15, cy: y + 8, a: 0, push: 0 }; };
    var clean = ctx.fmLabelCost(at(100, 100), base);
    eq('a clear placement in the wanted direction costs nothing', clean, 0);

    var clipped = ctx.fmLabelCost(at(-40, 100), base);
    var onLabel = ctx.fmLabelCost(at(100, 100),
        { w: 300, h: 200, labels: [at(100, 100)], dots: [], segs: [], ideal: 0, self: -1 });
    var onFace = ctx.fmLabelCost(at(100, 100),
        { w: 300, h: 200, labels: [], dots: [{ x: 115, y: 108, r: 14, hitR: 14 }], segs: [], ideal: 0, self: -1 });
    var onPath = ctx.fmLabelCost(at(100, 100),
        { w: 300, h: 200, labels: [], dots: [], segs: [[50, 108, 250, 108]], ideal: 0, self: -1 });
    var turned = ctx.fmLabelCost({ x0: 100, y0: 100, x1: 130, y1: 116, cx: 115, cy: 108, a: Math.PI, push: 0 }, base);
    var pushed = ctx.fmLabelCost({ x0: 100, y0: 100, x1: 130, y1: 116, cx: 115, cy: 108, a: 0, push: 20 }, base);

    check('half off the card is the worst thing a label can do',
          clipped > onLabel, clipped + ' vs ' + onLabel);
    check('sitting on another label is worse than sitting on a face',
          onLabel > onFace, onLabel + ' vs ' + onFace);
    check('sitting on a face is worse than being crossed by a line',
          onFace > onPath, onFace + ' vs ' + onPath);
    check('being crossed by a line is worse than pointing the wrong way',
          onPath > turned, onPath + ' vs ' + turned);
    check('and reaching further out costs something, but the least',
          pushed > 0 && pushed < turned, String(pushed));

    /* Measured against the capsule a marker is painted as. A version that
     * returned the distance to the axis instead of to the edge reported no
     * overlap at all, and every end-to-end check that used it agreed with
     * itself. */
    var box = { x0: 100, y0: 100, x1: 130, y1: 116 };
    near('a marker ten units clear of a label reports ten',
         ctx.fmMarkerBoxGap({ x: 76, y: 108, r: 14, hitR: 14 }, box), 10, 1e-9);
    near('a marker overlapping it by four reports minus four',
         ctx.fmMarkerBoxGap({ x: 90, y: 108, r: 14, hitR: 14 }, box), -4, 1e-9);
    near('a facepile is measured from the end of the pile',
         ctx.fmMarkerBoxGap({ x: 70, y: 108, r: 14, hitR: 34 }, box), -4, 1e-9);
    check('a marker whose middle is inside it is well inside',
          ctx.fmMarkerBoxGap({ x: 115, y: 108, r: 14, hitR: 14 }, box) <= -14);
    /* The corner of the square round a round face has nothing painted in
     * it, and a code tucked into one is not on top of anything. */
    check('a code in the empty corner beside a face is not on it',
          ctx.fmMarkerBoxGap({ x: 90, y: 88, r: 14, hitR: 14 },
                             { x0: 100, y0: 100, x1: 130, y1: 116 }) > 0);
    check('...though the square round it would have said otherwise',
          ctx.fmOverlap({ x0: 76, y0: 74, x1: 104, y1: 102 },
                        { x0: 100, y0: 100, x1: 130, y1: 116 }) > 0);
})();

console.log('\n-- a code nobody could read is not drawn --');
(function () {
    /* A card with no room anywhere. Every direction and every ring puts the
     * label off the edge, so the honest answer is no label: the face is
     * still that party's color and initials, and the city is written out
     * in words on that person's own card below. */
    var hub = { x: 20, y: 20, r: 18 };
    var nodes = [{ x: 22, y: 22, r: 14, hitR: 14, label: 'SFO' },
                 { x: 18, y: 18, r: 14, hitR: 14, label: 'ORD' }];
    var got = ctx.fmPlaceLabels(nodes, hub, [], 40, 40);
    check('a code with nowhere to go is dropped', got[0].drop && got[1].drop,
          JSON.stringify(got.map(function (g) { return [g.cost, g.drop]; })));
    check('...and a code with room is not',
          !ctx.fmPlaceLabels([{ x: 160, y: 100, r: 14, hitR: 14, label: 'SFO' }],
                             { x: 60, y: 100, r: 18 }, [], 327, 200)[0].drop);

    /* ...and the markup has to honor it, which is a separate claim. */
    var L = lay('ATL', ['SFO', 'ORD', 'BOS']);
    var all = ctx.fmSvg(L, { aria: '', reduce: true });
    L.nodes[0].ldrop = true;
    var one = ctx.fmSvg(L, { aria: '', reduce: true });
    eq('a dropped code is left out of the picture',
       (one.match(/class="fm-code"/g) || []).length,
       (all.match(/class="fm-code"/g) || []).length - 1);
    check('but the face it belonged to is still drawn',
          (one.match(/class="fm-dot"/g) || []).length === 3);
    L.nodes[0].ldrop = false;
})();

console.log('\n-- separation is bought from distance, never from bearing --');
(function () {
    var hub = { x: 150, y: 100, r: 18 };
    /* Two origins on nearly the same bearing at nearly the same radius: the
     * case the floor creates and the case that used to draw one face half
     * hidden behind another. */
    var nodes = [
        { x: 60, y: 100, r: 14, hitR: 14, km: 5500 },
        { x: 64, y: 104, r: 14, hitR: 14, km: 460 }
    ];
    var before = nodes.map(function (n) { return Math.atan2(n.y - hub.y, n.x - hub.x); });
    ctx.fmSpread(nodes, hub, 50, function () { return 200; });
    var after = nodes.map(function (n) { return Math.atan2(n.y - hub.y, n.x - hub.x); });
    near('the first one keeps its bearing exactly', after[0], before[0], 1e-9);
    near('and so does the second', after[1], before[1], 1e-9);
    check('the two markers no longer overlap',
          dist(nodes[0], nodes[1]) >= nodes[0].hitR + nodes[1].hitR + ctx.FM_PAD - ctx.FM_SPREAD_EPS,
          String(dist(nodes[0], nodes[1])));

    /* Once the floor has lifted two origins to the same radius, moving
     * whichever is drawn a fraction nearer can put the long-haul traveler
     * inside the short-haul one -- an order that is the reverse of the
     * truth. */
    var rNear = dist(nodes[1], hub), rFar = dist(nodes[0], hub);
    check('the nearer city stays the nearer marker', rNear < rFar,
          rNear + ' vs ' + rFar);

    var pinned = [
        { x: 100, y: 100, r: 14, hitR: 14, km: 100 },
        { x: 104, y: 100, r: 14, hitR: 14, km: 200 }
    ];
    ctx.fmSpread(pinned, hub, 50, function () { return 50; });
    check('with both ends pinned the overlap stands rather than the bearing moving',
          Math.abs(dist(pinned[0], hub) - 50) < 1e-6 && Math.abs(dist(pinned[1], hub) - 50) < 1e-6);

    var lone = [{ x: 60, y: 100, r: 14, hitR: 14, km: 1 }];
    var keep = { x: lone[0].x, y: lone[0].y };
    ctx.fmSpread(lone, hub, 10, function () { return 200; });
    check('a marker with nobody near it is left alone',
          lone[0].x === keep.x && lone[0].y === keep.y);

    /* The reach is what keeps a pushed marker on the card. */
    var reach = ctx.fmReachR({ x: 250, y: 100 }, { x: 150, y: 100 }, 327, 184, 30, 40);
    near('a marker heading east can reach the padded edge', reach, 327 - 30 - 150, 1e-9);
    eq('a marker sitting on the hub has nowhere to go',
       ctx.fmReachR({ x: 150, y: 100 }, { x: 150, y: 100 }, 327, 184, 30, 40), 0);
})();

console.log('\n-- a route goes round whoever is standing in it --');
(function () {
    var hub = { x: 300, y: 100 };
    var far = { x: 40, y: 100, r: 14, hitR: 14 };
    /* Nobody in the way: keep the house convention. */
    var alone = [far, { x: 40, y: 20, r: 14, hitR: 14 }];
    eq('a clear route gets the standard bow',
       ctx.fmPickBow(far, 0, alone, hub, 0.1), 0.1 * ctx.FM_BOW_LADDER[0]);

    /* Somebody squarely on the straight line between this origin and the
     * destination -- Denver between San Francisco and Atlanta, which is the
     * ordinary case and not a contrived one. */
    var mid = ctx.fmQuadAt(ctx.fmQuad(far, hub, 0.1), 0.5);
    var blocked = [far, { x: mid.x, y: mid.y, r: 14, hitR: 14 }];
    var picked = ctx.fmPickBow(far, 0, blocked, hub, 0.1);
    check('a blocked route does not keep the standard bow', picked !== 0.1, String(picked));
    var q = ctx.fmQuad(far, hub, picked);
    check('...and the bow it picks actually clears the marker',
          ctx.fmClearance(q, mid.x, mid.y) >= 14 + ctx.FM_PAD - 1e-6,
          String(ctx.fmClearance(q, mid.x, mid.y)));
    check('...in the same rotational sense if that is possible at all', picked > 0,
          String(picked));

    /* A facepile is wider than its middle circle, and a route that clears the
     * circle can still go straight through the second face. */
    eq('one person is one circle', ctx.fmPileR(1, 14), 14);
    check('two are wider than one', ctx.fmPileR(2, 14) > 14);
    near('and the pile laps the way the timeline laps',
         ctx.fmPileR(3, 14), 14 + 2 * 28 * (1 - ctx.FM_LAP) / 2, 1e-9);

    /* With bow switched off there is nothing to escalate, and the great
     * circles are drawn as they are. */
    eq('bow 0 stays bow 0', ctx.fmPickBow(far, 0, blocked, hub, 0), 0);
})();

console.log('\n-- the whole card, on real geography --');
(function () {
    check('a destination nobody has coordinates for draws nothing',
          ctx.fmLayout({ code: 'XXX', lat: NaN, lon: NaN }, orig(['SFO', 'ORD'])) === null);
    check('one origin is a line, not a convergence',
          lay('ATL', ['SFO']) === null);
    check('...and so is everybody leaving from the same airport',
          lay('ATL', ['SFO', 'SFO']) === null);
    check('somebody who already lives there is not on the map',
          lay('ATL', ['SFO', 'ATL']) === null);

    [['ATL', ['SFO', 'ORD']],
     ['ATL', ['SFO', 'ORD', 'BOS', 'MIA']],
     ['ATL', ['SFO', 'ORD', 'BOS', 'MIA', 'DEN', 'SEA']],
     ['ATL', ['SFO', 'ORD', 'BOS', 'MIA', 'DEN', 'SEA', 'OAK', 'LGA']],
     ['DEN', ['SFO', 'AUS', 'ORD']],
     ['LHR', ['JFK', 'DUB', 'SYD', 'GRU']],
     /* The hard shape, and not a rare one: two people a short hop away and
      * two the other side of the world. The floor does its most work here,
      * and everything downstream of the floor is most likely to be wrong. */
     ['DEN', ['COS', 'ABQ', 'SFO', 'SYD']],
     ['ATL', ['ORD', 'MIA', 'BOS', 'SYD']]].forEach(function (c) {
        var L = lay(c[0], c[1]), tag = c[1].length + ' into ' + c[0];
        if (!L) { check(tag + ' draws a card', false); return; }

        check(tag + ': the hub is on the card',
              L.hub.x - L.hub.r >= 0 && L.hub.x + L.hub.r <= L.w
           && L.hub.y - L.hub.r >= 0 && L.hub.y + L.hub.r <= L.h);
        /* Not merely on the card -- clear of its edge. A marker touching
         * the edge has no room for the code hung off it, and it reads as
         * something that has been cropped. */
        check(tag + ': every face keeps clear of the edge',
              L.nodes.every(function (n) {
                  return n.x - n.hitR >= ctx.FM_PAD && n.x + n.hitR <= L.w - ctx.FM_PAD
                      && n.y - n.r >= ctx.FM_PAD && n.y + n.r <= L.h - ctx.FM_PAD;
              }),
              JSON.stringify(L.nodes.map(function (n) {
                  return [n.label, Math.round(Math.min(n.x - n.hitR, n.y - n.r,
                          L.w - n.x - n.hitR, L.h - n.y - n.r))]; })));
        /* The floor is applied against the scale, and the scale is a
         * consequence of the floor, so the last thing fmLayout does is a
         * lift rather than a fit -- which can only be safe if the loop
         * before it has converged. Under-iterate it and the lift pushes
         * markers out of the margin the fit reserved for the codes. */
        var padX = ctx.FM_HUB / 2 + ctx.FM_PAD + ctx.FM_PAD_SIDE;
        var padY = ctx.FM_HUB / 2 + ctx.FM_PAD + ctx.FM_LBL_H;
        check(tag + ': every marker is inside the margin the fit reserved',
              L.nodes.every(function (n) {
                  return n.x >= padX - 1 && n.x <= L.w - padX + 1
                      && n.y >= padY - 1 && n.y <= L.h - padY + 1;
              }),
              'padX ' + padX + ' padY ' + padY + ' '
              + JSON.stringify(L.nodes.map(function (n) {
                  return [n.label, Math.round(n.x), Math.round(n.y)]; })));
        check(tag + ': every face is on the card',
              L.nodes.every(function (n) {
                  return n.x - n.hitR >= -1e-6 && n.x + n.hitR <= L.w + 1e-6
                      && n.y - n.r >= -1e-6 && n.y + n.r <= L.h + 1e-6;
              }), JSON.stringify(L.nodes.map(function (n) { return [Math.round(n.x), Math.round(n.y)]; })));
        check(tag + ': every code that is drawn is on the card',
              L.nodes.every(function (n) {
                  if (n.ldrop) return true;
                  var b = boxOf(n);
                  return b.x0 >= -1e-6 && b.x1 <= L.w + 1e-6 && b.y0 >= -1e-6 && b.y1 <= L.h + 1e-6;
              }));
        /* The defect this card exists not to have. */
        check(tag + ': no code is struck through by its own route',
              L.nodes.every(function (n) {
                  if (n.ldrop || n.path == null) return true;
                  var b = boxOf(n), q = L.paths[n.path].q, hit = false;
                  for (var t = 0; t < 1; t += 1 / 32) {
                      var p0 = ctx.fmQuadAt(q, t), p1 = ctx.fmQuadAt(q, t + 1 / 32);
                      if (ctx.fmSegBox(p0.x, p0.y, p1.x, p1.y, b)) hit = true;
                  }
                  return !hit;
              }));
        check(tag + ': no two codes sit on top of each other',
              L.nodes.every(function (n, i) {
                  if (n.ldrop) return true;
                  return L.nodes.every(function (m, j) {
                      return j <= i || m.ldrop || ctx.fmOverlap(boxOf(n), boxOf(m)) === 0;
                  });
              }));
        /* Measured against the capsule a marker is actually painted as, not
         * the square drawn round it -- the corners outside a round face are
         * empty, and a code tucked into one is not on top of anything.
         * Its own marker is excluded; fmLabelBox has already cleared that. */
        check(tag + ': no code is painted over somebody else\u2019s face',
              L.nodes.every(function (n, i) {
                  if (n.ldrop) return true;
                  var b = boxOf(n);
                  return L.nodes.every(function (m, j) {
                      return j === i || ctx.fmMarkerBoxGap(m, b) >= -1e-6;
                  });
              }) && L.nodes.every(function (n) {
                  return n.ldrop || ctx.fmMarkerBoxGap(
                      { x: L.hub.x, y: L.hub.y, r: L.hub.r, hitR: L.hub.r }, boxOf(n)) >= -1e-6;
              }));
        check(tag + ': every route is long enough to read as a route',
              L.paths.every(function (p) { return ctx.fmArcTable(p.q).len >= 8; }),
              JSON.stringify(L.paths.map(function (p) { return Math.round(ctx.fmArcTable(p.q).len); })));
        check(tag + ': every route reaches the hub',
              L.paths.every(function (p) {
                  var e = ctx.fmQuadAt(p.q, 1);
                  return Math.abs(dist(e, L.hub) - (L.hub.r + ctx.FM_PAD)) < 0.6;
              }));
        check(tag + ': and leaves its own marker',
              L.paths.every(function (p) {
                  var s = ctx.fmQuadAt(p.q, 0), n = L.nodes[p.node];
                  return Math.abs(dist(s, n) - (n.r + ctx.FM_PAD)) < 0.6;
              }));
        check(tag + ': no two markers sit on top of each other',
              L.nodes.every(function (n, i) {
                  return L.nodes.every(function (m, j) {
                      return j <= i
                          || dist(n, m) >= n.hitR + m.hitR + ctx.FM_PAD - ctx.FM_SPREAD_EPS;
                  });
              }),
              JSON.stringify(L.nodes.map(function (n) { return [n.label, Math.round(n.x), Math.round(n.y)]; })));
        check(tag + ': no marker sits on the destination',
              L.nodes.every(function (n) { return dist(n, L.hub) >= n.hitR + L.hub.r; }));
        /* The floor, stated as the invariant it is. It is applied in the
         * projection and then refitted, and refitting changes the scale --
         * so it has to be iterated, and a single pass leaves markers inside
         * their own floor. */
        check(tag + ': nobody is inside the floor',
              L.nodes.every(function (n) {
                  return dist(n, L.hub) >= n.r + L.hub.r + 2 * ctx.FM_PAD + ctx.FM_MIN_LINE - 0.05;
              }),
              JSON.stringify(L.nodes.map(function (n) { return [n.label, Math.round(dist(n, L.hub))]; }))
              + ' floor ' + (ctx.FM_DOT / 2 + ctx.FM_HUB / 2 + 2 * ctx.FM_PAD + ctx.FM_MIN_LINE));
        check(tag + ': every person is on exactly one marker',
              L.nodes.reduce(function (s, n) { return s + n.people.length; }, 0) === c[1].length);
    });

    /* Bearing is the part of this picture that is exactly true, and it is
     * what survives every distortion the layout applies. */
    var L = lay('ATL', ['SFO', 'ORD', 'BOS', 'MIA', 'DEN', 'SEA', 'OAK', 'LGA']);
    var byCode = {};
    L.nodes.forEach(function (n) { n.codes.forEach(function (c) { byCode[c] = n; }); });
    var ang = function (c) { return Math.atan2(byCode[c].y - L.hub.y, byCode[c].x - L.hub.x) / Math.PI * 180; };
    check('Miami is below Atlanta', byCode.MIA.y > L.hub.y);
    check('Seattle is above and to the left', byCode.SEA.y < L.hub.y && byCode.SEA.x < L.hub.x);
    check('Boston is to the right', byCode.BOS.x > L.hub.x);
    check('and San Francisco is further round than Denver',
          Math.abs(ang('SFO')) > Math.abs(ang('DEN')) - 25);

    /* The floor is a floor and not a rescale: above it, further away is
     * further out. */
    var den = lay('DEN', ['SFO', 'AUS', 'ORD']);
    var rr = {};
    den.nodes.forEach(function (n) { rr[n.codes[0]] = dist(n, den.hub); });
    check('the real trip keeps its distance order',
          rr.SFO > rr.ORD && rr.ORD > rr.AUS,
          JSON.stringify(rr));
})();

console.log('\n-- the markup --');
(function () {
    var L = lay('ATL', ['SFO', 'ORD', 'BOS', 'MIA']);
    var moving = ctx.fmSvg(L, { aria: 'four cities to Atlanta', reduce: false });
    var still = ctx.fmSvg(L, { aria: 'four cities to Atlanta', reduce: true });

    eq('one animation per route when motion is allowed',
       (moving.match(/<animateMotion/g) || []).length, L.paths.length);
    /* SMIL cannot be switched off from a stylesheet, so the only guarantee
     * that reduced motion means no motion is that there is nothing to switch
     * off in the markup at all. */
    check('reduced motion emits no animation whatsoever',
          still.indexOf('animateMotion') < 0 && still.indexOf('mpath') < 0);
    check('...and parks the plane mid-route instead',
          /class="fm-plane" transform="translate\(/.test(still));
    check('a moving plane carries its resting place rather than a transform',
          /class="fm-plane fm-wait" data-rest="translate\(/.test(moving));
    /* A paused animation has not sampled its transform yet, so without the
     * wait class a card below the fold draws every plane in the corner. */
    eq('every moving plane starts hidden',
       (moving.match(/fm-wait/g) || []).length, L.paths.length);
    check('the animation is bounded rather than endless',
          new RegExp('repeatCount="' + ctx.FM_REPEAT + '"').test(moving)
          && moving.indexOf('repeatCount="indefinite"') < 0);

    eq('one face per traveler', (moving.match(/class="fm-dot"/g) || []).length, 4);
    eq('one code per marker', (moving.match(/class="fm-code"/g) || []).length, L.nodes.length);
    check('the destination is named on the card', moving.indexOf('>ATL</text>') > -1);
    check('each route is given an id its plane can follow',
          L.paths.every(function (p, i) { return moving.indexOf('id="fmr' + i + '"') > -1; }));
    check('the picture has a spoken description', moving.indexOf('aria-label="four cities to Atlanta"') > -1);
    check('...and is announced as one image, not as a pile of shapes',
          moving.indexOf('role="img"') > -1);
    check('the viewBox is the box the layout measured',
          moving.indexOf('viewBox="0 0 ' + L.w + ' ' + L.h + '"') > -1);

    var nasty = ctx.fmSvg(L, { aria: 'Jo & "Sam" <b>', reduce: true });
    check('a name with markup in it is escaped', nasty.indexOf('<b>') < 0
          && nasty.indexOf('Jo &amp; &quot;Sam&quot;') > -1);

    /* A marker shared by two people is not either of their colors. */
    var shared = lay('ATL', ['SFO', 'OAK', 'ORD', 'BOS']);
    var pile = shared.nodes.filter(function (n) { return n.people.length > 1; })[0];
    check('two people in one place share a marker', !!pile);
    check('...and their shared route is drawn in ink, not in one of their colors',
          shared.paths[pile.path].color === null);
})();

console.log('\n-- the stylesheet and the layout arithmetic agree --');
(function () {
    /* Two copies of a number is one copy too many, and the one that rots is
     * the one nothing reads. The halo is painted outside the glyphs, so the
     * placement maths has to know how wide it is. */
    var css = fs.readFileSync(__dirname + '/index.html', 'utf8');
    var num = function (re, label) {
        var m = re.exec(css);
        if (!m) { check('index.html still has ' + label, false); return NaN; }
        return parseFloat(m[1]);
    };
    eq('the knockout stroke is FM_LBL_HALO wide',
       num(/\.fm-code \{[^}]*stroke-width: ([\d.]+)px/, '.fm-code stroke-width'), ctx.FM_LBL_HALO);
    check('and it is painted under the glyphs rather than over them',
          /\.fm-code \{[^}]*paint-order: stroke/.test(css));
    check('a moving plane is hidden until the clock starts',
          /\.fm-wait \{ visibility: hidden/.test(css));
    check('the routes are stroked and never filled',
          /\.fm-route \{ fill: none/.test(css));
    /* The one rule the brand has: the amber is spent on the masthead. */
    check('the map spends no amber',
          !/\.fm-[a-z-]+[^}]*var\(--brand/.test(css) && !/\.fmap[^}]*var\(--brand/.test(css));
})();

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail)
                         : 'ALL ' + pass + ' CHECKS PASSED'));
process.exitCode = fail ? 1 : 0;
