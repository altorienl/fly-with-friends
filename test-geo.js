/* Tests for the map's geography: airports-geo.js and the geometry block in
 * app.js.
 *
 * The map is the one picture in this app that can be wrong and still look
 * right. A card that prints the wrong price is caught by somebody reading it;
 * a route drawn 600km off its true path, or an airport placed in the wrong
 * ocean, is caught by nobody, because nobody has the real one to compare it
 * against. The mockup this replaces was captioned "Conceptual visualization"
 * for exactly that reason and that caption is not shipping.
 *
 * So the things asserted here are the things that fail silently:
 *
 *   a code with no coordinate            -- a traveler who is not on the map
 *   a coordinate at (0, 0)               -- a traveler in the Gulf of Guinea
 *   a latitude read as a longitude       -- a map that is merely plausible
 *   kilometers quietly holding miles     -- every distance 61% too big
 *   a straight line instead of an arc    -- a route over the wrong continent
 *   a sign flip                          -- invisible until somebody flies
 *                                           from the southern hemisphere
 *   the antimeridian                     -- Tokyo to Los Angeles drawn the
 *                                           long way round the entire world
 *
 * No DOM: the geometry is sliced into a vm whose context has console and
 * nothing else, so anything in that block that reached for document or window
 * would throw here rather than at render time. It is sliced by the two
 * landmark comments wrapped round it rather than by the name of the first
 * statement in it, and cut() exits non-zero when it cannot find either end.
 */
var fs = require('fs'), vm = require('vm');
var src = fs.readFileSync(__dirname + '/app.js', 'utf8');
var AIRPORTS = require(__dirname + '/airports.js');
var GEO = require(__dirname + '/airports-geo.js');

var pass = 0, fail = 0;
function check(n, c, extra) {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (extra ? '\n          ' + extra : '')); }
}
function eq(n, got, want) { check(n, got === want, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want)); }
function near(n, got, want, tol) {
    check(n, Math.abs(got - want) <= tol,
          'got ' + got + ', wanted ' + want + ' +/- ' + tol);
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
vm.createContext(ctx);
vm.runInContext(cut('/* --- BEGIN map geometry', '/* --- END map geometry',
                    'the map geometry'), ctx);

/* Shorthand. P('SFO') is the real coordinate of SFO, which is the point --
 * every pair below is a pair of airports somebody could actually book. */
function P(code) {
    var g = GEO.get(code);
    if (!g) { console.error('FAIL: test fixture wants ' + code + ', which has no coordinate'); process.exit(1); }
    return g;
}

/* ------------------------------------------------------------------ */
console.log('\n-- every airport in the table has a place --');
(function () {
    /* Codes allowed to have no coordinate. Empty, and meant to stay empty:
     * this list is the honest way to record a gap, not a way to make one go
     * away. Anything added here needs a reason next to it, because an airport
     * with no position is a traveler the map silently drops. */
    var NO_COORD = [];

    var missing = [];
    AIRPORTS.LIST.forEach(function (a) {
        if (!GEO.get(a.code) && NO_COORD.indexOf(a.code) < 0) missing.push(a.code);
    });
    check('every code in airports.js resolves to a coordinate', missing.length === 0,
          missing.length + ' with no coordinate: ' + missing.slice(0, 12).join(','));
    eq('the exceptions list is empty', NO_COORD.length, 0);
    eq('the geo table holds exactly as many records as the airport table',
       GEO.COUNT, AIRPORTS.LIST.length);

    /* The three OurAirports relabeled under a different code. Named here
     * rather than left to the bulk check, because they are the three the
     * build script had to go and find and the ones a dataset refresh is most
     * likely to lose. */
    check('KIV is in Moldova, not missing',
          Math.abs(P('KIV').lat - 46.93) < 0.02 && Math.abs(P('KIV').lon - 28.93) < 0.02);
    check('PBI is in Florida, not missing',
          Math.abs(P('PBI').lat - 26.68) < 0.02 && Math.abs(P('PBI').lon + 80.10) < 0.02);
    check('REP is in Cambodia, not missing',
          Math.abs(P('REP').lat - 13.41) < 0.02 && Math.abs(P('REP').lon - 103.81) < 0.02);

    eq('an unknown code is null, not a guess', GEO.get('QQQ'), null);
    eq('...and so is one that sorts into the middle of the table', GEO.get('JQJ'), null);
    eq('a code of the wrong length is null', GEO.get('SFOO'), null);
    eq('empty is null', GEO.get(''), null);
    eq('undefined is null', GEO.get(undefined), null);
    check('lower case resolves, since a URL or a saved trip may carry it',
          GEO.get('sfo') !== null && GEO.get('sfo').lat === GEO.get('SFO').lat);

    /* Shared mutable records are a bug that only appears on the second
     * render, which is the hardest kind to find. */
    var g = GEO.get('SFO');
    g.lat = 0; g.lon = 0;
    check('a caller cannot corrupt the table by writing to what it returned',
          GEO.get('SFO').lat !== 0);
})();

/* ------------------------------------------------------------------ */
console.log('\n-- nothing is off the planet --');
(function () {
    var offLat = [], offLon = [], nan = [], nul = [], seen = {}, distinct = 0;
    AIRPORTS.LIST.forEach(function (a) {
        var g = GEO.get(a.code);
        if (!g) return;
        if (!(g.lat >= -90 && g.lat <= 90)) offLat.push(a.code);
        if (!(g.lon >= -180 && g.lon <= 180)) offLon.push(a.code);
        if (g.lat !== g.lat || g.lon !== g.lon
            || !isFinite(g.lat) || !isFinite(g.lon)) nan.push(a.code);
        if (g.lat === 0 && g.lon === 0) nul.push(a.code);
        var k = g.lat + ',' + g.lon;
        if (!seen[k]) { seen[k] = 1; distinct++; }
    });
    check('every latitude is in [-90, 90]', offLat.length === 0, offLat.slice(0, 8).join(','));
    check('every longitude is in [-180, 180]', offLon.length === 0, offLon.slice(0, 8).join(','));
    check('no NaN and no Infinity', nan.length === 0, nan.slice(0, 8).join(','));
    /* (0, 0) is in the Atlantic 600km south of Ghana. It is what a dataset
     * prints when it means "unknown", and an airport drawn there looks like a
     * destination rather than like a bug. */
    check('nothing is at null island', nul.length === 0, nul.slice(0, 8).join(','));

    /* A decoder that returned one constant, or that lost its low digits,
     * would pass every range check above. */
    check('the table holds thousands of DIFFERENT positions, not one repeated',
          distinct > 3500, distinct + ' distinct positions in ' + AIRPORTS.LIST.length);

    /* Six airports whose positions are common knowledge, to the quantum the
     * table is stored at. A latitude and longitude swapped, or a sign
     * dropped, dies here. */
    var known = [['SFO', 37.62, -122.37], ['JFK', 40.64, -73.78],
                 ['LHR', 51.47, -0.46], ['SYD', -33.95, 151.18],
                 ['NRT', 35.77, 140.39], ['GRU', -23.43, -46.47]];
    var wrong = known.filter(function (k) {
        var g = GEO.get(k[0]);
        return Math.abs(g.lat - k[1]) > 0.011 || Math.abs(g.lon - k[2]) > 0.011;
    });
    check('six well-known airports are where they are', wrong.length === 0,
          JSON.stringify(wrong.map(function (k) { return [k[0], GEO.get(k[0])]; })));

    /* The hemispheres are all occupied. A sign dropped on either axis empties
     * one of these and nothing else would notice. */
    var q = { ne: 0, nw: 0, se: 0, sw: 0 };
    AIRPORTS.LIST.forEach(function (a) {
        var g = GEO.get(a.code);
        q[(g.lat >= 0 ? 'n' : 's') + (g.lon >= 0 ? 'e' : 'w')]++;
    });
    check('all four quadrants of the planet have airports in them',
          q.ne > 100 && q.nw > 100 && q.se > 100 && q.sw > 100, JSON.stringify(q));
})();

/* ------------------------------------------------------------------ */
console.log('\n-- distances are real distances --');
(function () {
    /* Published great-circle distances, airport to airport, in kilometers.
     * Checked against the Great Circle Mapper and cross-checked against two
     * formulas other than the one under test.
     *
     * Tolerance is a quarter of a percent or 4km, whichever is larger. The
     * floor absorbs the table's own rounding -- two endpoints at two decimal
     * places can each be 1.6km out -- and the percentage is still forty times
     * tighter than the 61% a kilometer/mile mixup would move these by, and
     * hundreds of times tighter than a sign error. */
    [['JFK', 'LHR', 5540], ['SFO', 'JFK', 4152], ['LAX', 'NRT', 8753],
     ['SYD', 'LAX', 12061], ['JNB', 'CPT', 1271], ['ORD', 'ATL', 976],
     ['AKL', 'SYD', 2160], ['DXB', 'JFK', 11002]].forEach(function (t) {
        var got = ctx.gcDistanceKm(P(t[0]), P(t[1]));
        near(t[0] + ' to ' + t[1] + ' is ' + t[2] + 'km',
             Math.round(got * 10) / 10, t[2], Math.max(4, t[2] * 0.0025));
    });

    near('an airport is zero kilometers from itself',
         ctx.gcDistanceKm(P('SFO'), P('SFO')), 0, 1e-9);
    near('distance is symmetric',
         ctx.gcDistanceKm(P('SFO'), P('JFK')) - ctx.gcDistanceKm(P('JFK'), P('SFO')),
         0, 1e-9);
    /* Short arcs are the common case -- a group converging from three cities
     * in one country -- and they are where the law of cosines would lose its
     * precision. */
    near('LAX to SAN, a 176km hop, is not swallowed', ctx.gcDistanceKm(P('LAX'), P('SAN')), 176, 4);
})();

/* ------------------------------------------------------------------ */
console.log('\n-- the shortest path is a curve --');
(function () {
    var a = P('JFK'), b = P('LHR');
    var g = ctx.greatCircle(a, b, 33);
    eq('asks for 33 points and gets 33', g.length, 33);
    eq('the first point IS the origin, not a copy of it that nearly is',
       g[0].lat + '|' + g[0].lon, a.lat + '|' + a.lon);
    eq('...and the last IS the destination', g[32].lat + '|' + g[32].lon, b.lat + '|' + b.lon);

    /* Every sample is ON the arc, not merely near it: the two legs through it
     * add up to the whole. This is the assertion that a lat/lon interpolation
     * cannot pass -- its midpoint is 686km off the route, so the legs sum
     * long. */
    var whole = ctx.gcDistanceKm(a, b), worst = 0;
    g.forEach(function (p) {
        var d = ctx.gcDistanceKm(a, p) + ctx.gcDistanceKm(p, b) - whole;
        if (Math.abs(d) > worst) worst = Math.abs(d);
    });
    check('every point lies on the arc, not beside it', worst < 0.01,
          'worst leg sum is ' + worst.toFixed(4) + 'km long');

    /* Evenly spaced in kilometers, which is what slerp buys over a lat/lon
     * walk. Uneven spacing is the tell that someone interpolated the angles
     * of the coordinates rather than the rotation. */
    var step = ctx.gcDistanceKm(g[0], g[1]), off = 0;
    for (var i = 1; i < g.length - 1; i++) {
        off = Math.max(off, Math.abs(ctx.gcDistanceKm(g[i], g[i + 1]) - step));
    }
    check('the samples are evenly spaced along the ground', off < step * 0.001,
          'steps vary by ' + off.toFixed(3) + 'km on a ' + step.toFixed(1) + 'km step');

    /* The headline: the transatlantic route is not the straight line. */
    var m = g[16];
    var lerp = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
    check('the JFK-LHR midpoint is north of the straight-line midpoint', m.lat > lerp.lat);
    check('...by enough to be a different place entirely',
          ctx.gcDistanceKm(m, lerp) > 500,
          'only ' + ctx.gcDistanceKm(m, lerp).toFixed(0) + 'km apart');
    near('...and it sits off southern Greenland, near 52N 41W', m.lat, 52.2, 0.3);

    /* Degenerate inputs must not produce NaN; a NaN in a path attribute
     * deletes the shape rather than failing anywhere a person can see. */
    var same = ctx.greatCircle(P('SFO'), P('SFO'), 5);
    eq('two codes at the same place still return the points asked for', same.length, 5);
    check('...and none of them is NaN',
          same.every(function (p) { return isFinite(p.lat) && isFinite(p.lon); }));
    var anti = ctx.greatCircle({ lat: 0, lon: 0 }, { lat: 0, lon: 180 }, 5);
    check('an antipodal pair picks a plane instead of dividing by zero',
          anti.every(function (p) { return isFinite(p.lat) && isFinite(p.lon); }),
          JSON.stringify(anti));
    eq('fewer than two points is still two', ctx.greatCircle(P('SFO'), P('JFK'), 0).length, 2);
})();

/* ------------------------------------------------------------------ */
console.log('\n-- high latitude, where a straight line is furthest from the truth --');
(function () {
    /* Oslo to Anchorage. Both endpoints sit near 60 north and a straight line
     * in lat/lon stays there the whole way. The real route goes over the top
     * of Greenland at nearly 85 north, which is not a correction, it is a
     * different hemisphere's worth of map. */
    var a = P('OSL'), b = P('ANC');
    var g = ctx.greatCircle(a, b, 65);
    var top = g.reduce(function (m, p) { return p.lat > m ? p.lat : m; }, -90);
    check('the Oslo-Anchorage route goes over the Arctic, not along 60N',
          top > 83, 'tops out at ' + top.toFixed(2) + 'N');
    check('both endpoints are well south of the route it flies',
          a.lat < 62 && b.lat < 62 && top > a.lat + 20 && top > b.lat + 20);
    near('its midpoint is at about 85N', g[32].lat, 84.7, 0.5);
    check('every point of it is in the northern hemisphere',
          g.every(function (p) { return p.lat > 0; }));

    /* Mercator at high latitude. The clamp is a guard that real data never
     * reaches, and the whole point of choosing Mercator is that it does not
     * squash the Nordics the way an equirectangular fit would. */
    var fit = ctx.fitProjection([P('OSL'), P('ARN'), P('HEL')], {});
    check('a Nordic fit produces finite coordinates',
          [P('OSL'), P('ARN'), P('HEL')].every(function (p) {
              var q = fit.project(p);
              return isFinite(q.x) && isFinite(q.y);
          }));
    /* Equirectangular would hand back an aspect equal to the plain ratio of
     * the degree spans. Mercator stretches the vertical by about 1/cos(60),
     * so the fitted box is roughly half as wide relative to its height, and
     * that difference IS the projection doing its job. */
    var dLon = Math.max(P('OSL').lon, P('ARN').lon, P('HEL').lon)
             - Math.min(P('OSL').lon, P('ARN').lon, P('HEL').lon);
    var dLat = Math.max(P('OSL').lat, P('ARN').lat, P('HEL').lat)
             - Math.min(P('OSL').lat, P('ARN').lat, P('HEL').lat);
    check('the Nordic fit is not the equirectangular one',
          Math.abs(fit.aspect - dLon / dLat) > 0.2 * (dLon / dLat),
          'mercator ' + fit.aspect.toFixed(3) + ' vs equirectangular ' + (dLon / dLat).toFixed(3));
    near('...and it is narrower by about 1/cos(latitude)',
         fit.aspect, (dLon / dLat) * Math.cos(60.5 * Math.PI / 180), (dLon / dLat) * 0.06);
})();

/* ------------------------------------------------------------------ */
console.log('\n-- the southern hemisphere, where a sign error hides --');
(function () {
    /* Perth to Buenos Aires runs under Antarctica. If a latitude sign were
     * flipped anywhere in the chain this midpoint comes out at +85 instead of
     * -85, and the only thing on the screen that would say so is a route over
     * the north pole between two cities in the south. */
    var g = ctx.greatCircle(P('PER'), P('EZE'), 65);
    var bottom = g.reduce(function (m, p) { return p.lat < m ? p.lat : m; }, 90);
    check('Perth to Buenos Aires goes under Antarctica, not over the Arctic',
          bottom < -80, 'bottoms out at ' + bottom.toFixed(2));
    check('every point of it is in the southern hemisphere',
          g.every(function (p) { return p.lat < 0; }));
    near('its midpoint is at about 85S', g[32].lat, -85.6, 0.5);

    /* Sydney to Auckland, an ordinary southern trip, must stay ordinary. */
    var t = ctx.greatCircle(P('SYD'), P('AKL'), 33);
    check('Sydney to Auckland never strays north of the equator',
          t.every(function (p) { return p.lat < -30; }));
    near('...and is 2160km long', ctx.gcDistanceKm(P('SYD'), P('AKL')), 2160, 6);

    /* The projection's vertical sign, checked in the south where it is not
     * accidentally right. North is up: Johannesburg at -26 is ABOVE Cape Town
     * at -34, which means a SMALLER y, because y grows downward for SVG. */
    var fit = ctx.fitProjection([P('JNB'), P('CPT'), P('DUR')], {});
    var jnb = fit.project(P('JNB')), cpt = fit.project(P('CPT'));
    check('north is up in the southern hemisphere too', jnb.y < cpt.y,
          'JNB y ' + jnb.y.toFixed(4) + ', CPT y ' + cpt.y.toFixed(4));
    check('...and east is right', fit.project(P('JNB')).x > fit.project(P('CPT')).x);
})();

/* ------------------------------------------------------------------ */
console.log('\n-- the antimeridian --');
(function () {
    /* The single most likely bug in the whole feature. Tokyo is at 140.39
     * east and Los Angeles at 118.41 west; subtract those and you get 258.8
     * degrees, which is the wrong way round the Earth, across Asia and Europe
     * and the Atlantic and the entire United States. The real route is 101.2
     * degrees of empty Pacific. */
    var nrt = P('NRT'), lax = P('LAX');
    var g = ctx.greatCircle(nrt, lax, 65);

    /* Nothing on this route may be in the hemisphere it does not fly over.
     * Every point has to be east of Tokyo or west of Los Angeles; anything in
     * between is over somewhere the plane never goes. */
    var wrongWay = g.filter(function (p) { return p.lon < nrt.lon && p.lon > lax.lon; });
    check('no point of NRT-LAX is over Europe, Africa or western Asia',
          wrongWay.length === 0,
          wrongWay.length + ' stray points, first at lon ' + (wrongWay[0] || {}).lon);
    check('the path really does cross the line, east side',
          g.some(function (p) { return p.lon > 175; }));
    check('...and west side', g.some(function (p) { return p.lon < -175; }));
    check('it is a Pacific route, topping out in the Aleutians',
          g.reduce(function (m, p) { return Math.max(m, p.lat); }, -90) > 46);

    /* The fit has to agree. Centered on the mean of the two longitudes it
     * would sit over Libya with the airports at opposite edges. */
    near('the fit centers on the Pacific, not on Libya',
         ctx.lonCenter([nrt.lon, lax.lon]), -169.01, 0.05);
    near('a mainland US group still centers on the mainland',
         ctx.lonCenter([P('SFO').lon, P('ORD').lon, P('ATL').lon, P('PIT').lon]),
         -101.3, 0.1);

    var fit = ctx.fitProjection([nrt, lax], { width: 1, height: 1 });
    near('Tokyo lands on one edge of the box', fit.project(nrt).x, 0, 1e-9);
    near('Los Angeles lands on the other', fit.project(lax).x, 1, 1e-9);
    /* 101.2 degrees of Pacific across the box, so one degree is about a
     * hundredth of it. An unwrap failure shows up as a single step of nearly
     * the whole width. */
    var xs = fit.path(g).map(function (q) { return q.x; });
    var step = 0, back = 0;
    for (var i = 1; i < xs.length; i++) {
        step = Math.max(step, Math.abs(xs[i] - xs[i - 1]));
        if (xs[i] < xs[i - 1]) back++;
    }
    check('the drawn path never jumps across the map', step < 0.05,
          'largest single step is ' + step.toFixed(4) + ' of the box');
    eq('...and never doubles back on itself', back, 0);
    near('it spans the box exactly once, left edge', Math.min.apply(null, xs), 0, 1e-9);
    near('...to right edge', Math.max.apply(null, xs), 1, 1e-9);

    /* An airport the fit never saw is projected honestly, which for London
     * against a Pacific fit means well outside the box rather than folded
     * back into it. */
    check('London against a Pacific fit lands off the map, as it should',
          fit.project(P('LHR')).x > 1.5);

    /* Two real airports in the table, 210km apart, one either side of the
     * line. Taveuni is at 179.88 west and Moala at 179.95 east. */
    near('TVU to MFJ across the line is 210km, not half the world',
         ctx.gcDistanceKm(P('TVU'), P('MFJ')), 210, 5);
    var fj = ctx.fitProjection([P('TVU'), P('MFJ')], {});
    check('a Fiji fit is a fifth of a degree wide, not 360',
          (fj.bounds.east - fj.bounds.west) < 1,
          'spans ' + (fj.bounds.east - fj.bounds.west).toFixed(3) + ' degrees');
    check('both Fiji airports land inside the box',
          [P('TVU'), P('MFJ')].every(function (p) {
              var q = fj.project(p);
              return q.x >= -1e-9 && q.x <= 1 + 1e-9 && q.y >= -1e-9 && q.y <= 1 + 1e-9;
          }));

    /* The harder half of the same bug, and the one NRT-LAX alone does not
     * catch: a route that crosses the cut the FIT made rather than the one at
     * 180. Tokyo and Los Angeles meeting in London fits a box running east
     * from Tokyo across the Pacific and the Atlantic, so the seam falls over
     * Kazakhstan -- and the Tokyo to London flight goes straight over it.
     * Folding each sample into the box's window instead of against its
     * neighbor sends the middle of that route one and a half box widths
     * sideways and draws a horizontal line through the whole map. */
    var three = [P('NRT'), P('LAX'), P('LHR')];
    var tf = ctx.fitProjection(three, {});
    var leg = ctx.greatCircle(P('NRT'), P('LHR'), 33);
    var lx = tf.path(leg).map(function (q) { return q.x; });
    var lstep = 0;
    for (var m = 1; m < lx.length; m++) lstep = Math.max(lstep, Math.abs(lx[m] - lx[m - 1]));
    check('a route that crosses the fit\'s own seam is still drawn in one piece',
          lstep < 0.12, 'largest step is ' + lstep.toFixed(3) + ' of the box');

    /* And the fix the component is told to use: fit on the samples too, and
     * the frame grows to the 258 degrees that has everything in it. */
    var legs = ctx.greatCircle(P('NRT'), P('LHR'), 33)
                  .concat(ctx.greatCircle(P('LAX'), P('LHR'), 33));
    var wide = ctx.fitProjection(three.concat(legs), {});
    var out = wide.path(legs).filter(function (q) {
        return !(q.x >= -1e-9 && q.x <= 1 + 1e-9 && q.y >= -1e-9 && q.y <= 1 + 1e-9);
    });
    check('fitting on the route samples keeps both routes inside the box',
          out.length === 0, out.length + ' points escaped');
    near('...with Tokyo on one edge', wide.project(P('NRT')).x, 1, 1e-9);
    near('...and Los Angeles on the other', wide.project(P('LAX')).x, 0, 1e-9);

    eq('wrapLon folds a wide angle back', ctx.wrapLon(-200), 160);
    eq('...from the other side too', ctx.wrapLon(200), -160);
    eq('...and leaves an ordinary one alone', ctx.wrapLon(-122.37), -122.37);
})();

/* ------------------------------------------------------------------ */
console.log('\n-- the box --');
(function () {
    var codes = ['SFO', 'ORD', 'ATL', 'PIT'];
    var pts = codes.map(P);
    var fit = ctx.fitProjection(pts, {});

    var outside = pts.filter(function (p) {
        var q = fit.project(p);
        return !(q.x >= -1e-9 && q.x <= 1 + 1e-9 && q.y >= -1e-9 && q.y <= 1 + 1e-9);
    });
    check('every fitted airport lands inside the unit box', outside.length === 0);

    var xs = pts.map(function (p) { return fit.project(p).x; });
    var ys = pts.map(function (p) { return fit.project(p).y; });
    near('the widest pair touches the left edge', Math.min.apply(null, xs), 0, 1e-9);
    near('...and the right edge', Math.max.apply(null, xs), 1, 1e-9);
    /* The group is four times wider than it is tall, so the vertical does NOT
     * fill the box -- it is centered in it. Stretching it to fill would throw
     * away the only reason Mercator was chosen. */
    near('the shorter axis is centered rather than stretched to fit',
         Math.min.apply(null, ys) + Math.max.apply(null, ys), 1, 1e-9);
    check('...and really is shorter', Math.max.apply(null, ys) - Math.min.apply(null, ys) < 0.4);
    /* One scale, asserted directly rather than inferred from where things
     * landed. A degree of Mercator east has to be worth exactly as much box
     * as a degree of Mercator north, or the projection has stopped being
     * conformal and the only reason it was chosen is gone. */
    var o = fit.project({ lat: 40, lon: -100 });
    var perX = (fit.project({ lat: 40, lon: -99 }).x - o.x) / (1 * Math.PI / 180);
    var perY = (o.y - fit.project({ lat: 41, lon: -100 }).y)
                 / (ctx.mercY(41) - ctx.mercY(40));
    near('a degree east and a degree north are drawn at one scale', perX, perY, 1e-9);
    near('...and that scale is the one the fit reports', perX, fit.scale, 1e-9);

    near('the reported aspect matches what was drawn',
         (Math.max.apply(null, xs) - Math.min.apply(null, xs))
             / (Math.max.apply(null, ys) - Math.min.apply(null, ys)),
         fit.aspect, 1e-6);

    var padded = ctx.fitProjection(pts, { pad: 0.1 });
    near('padding insets the left edge', Math.min.apply(null, pts.map(function (p) {
        return padded.project(p).x; })), 0.1, 1e-9);
    near('...and the right', Math.max.apply(null, pts.map(function (p) {
        return padded.project(p).x; })), 0.9, 1e-9);

    var px = ctx.fitProjection(pts, { width: 300, height: 180, pad: 12 });
    near('a pixel box puts the west edge at the pad', Math.min.apply(null, pts.map(function (p) {
        return px.project(p).x; })), 12, 1e-9);
    near('...and the east edge a pad in from 300', Math.max.apply(null, pts.map(function (p) {
        return px.project(p).x; })), 288, 1e-9);
    check('...and nothing escapes vertically', pts.every(function (p) {
        var q = px.project(p); return q.y >= 12 - 1e-9 && q.y <= 168 + 1e-9; }));

    /* A group who all live in the same city is a real case -- it is the first
     * thing somebody tries -- and it is the one that divides by zero. */
    var one = ctx.fitProjection([P('SFO')], {});
    eq('one airport lands dead center, x', one.project(P('SFO')).x, 0.5);
    eq('...and y', one.project(P('SFO')).y, 0.5);
    eq('...with no aspect to report', one.aspect, null);
    var none = ctx.fitProjection([], {});
    check('an empty fit is still finite', isFinite(none.project(P('SFO')).x)
                                       && isFinite(none.project(P('SFO')).y));
    /* Junk in the list has to be ignored, not merely survived. A NaN
     * latitude paired with a real longitude, or a point with no longitude at
     * all, will not blow up a min/max -- every comparison against NaN is
     * false -- but its good half still widens the box and silently zooms the
     * whole map out. So the assertion is that the fit is IDENTICAL, not that
     * it is finite. */
    var clean = ctx.fitProjection([P('SFO'), P('JFK')], {});
    var dirty = ctx.fitProjection(
        [P('SFO'), null, undefined, { lat: NaN, lon: 0 }, { lat: 10 },
         { lon: 90 }, P('JFK')], {});
    var same = ['SFO', 'JFK'].every(function (c) {
        var a = clean.project(P(c)), b = dirty.project(P(c));
        return a.x === b.x && a.y === b.y;
    });
    check('junk in the list changes nothing about the fit', same,
          'clean ' + JSON.stringify(clean.project(P('SFO')))
            + ' dirty ' + JSON.stringify(dirty.project(P('SFO'))));

    /* The whole table through one world fit: 3,951 chances for a NaN to reach
     * an SVG attribute, where it deletes the shape without an error. */
    var world = ctx.fitProjection(AIRPORTS.LIST.map(function (a) { return GEO.get(a.code); }), {});
    var broken = [];
    AIRPORTS.LIST.forEach(function (a) {
        var q = world.project(GEO.get(a.code));
        if (!isFinite(q.x) || !isFinite(q.y)) broken.push(a.code);
    });
    check('no airport in the table projects to NaN', broken.length === 0,
          broken.slice(0, 8).join(','));

    /* North is up and east is right, stated once for the component that will
     * draw this. */
    var us = ctx.fitProjection([P('MIA'), P('SEA')], {});
    check('Seattle is above Miami', us.project(P('SEA')).y < us.project(P('MIA')).y);
    check('Miami is right of Seattle', us.project(P('MIA')).x > us.project(P('SEA')).x);
})();

/* ------------------------------------------------------------------ */
console.log('\n-- the geometry cannot reach the page --');
(function () {
    eq('the vm has no document', typeof ctx.document, 'undefined');
    eq('the vm has no window', typeof ctx.window, 'undefined');
    /* Belt and braces: the source of the block itself, with its comments
     * stripped so that prose about a longitude window is not mistaken for a
     * reference to one. A function that only touched the DOM on a branch the
     * tests above happen to miss would otherwise survive all of this. */
    var code = cut('/* --- BEGIN map geometry', '/* --- END map geometry', 'the map geometry')
                 .replace(/\/\*[\s\S]*?\*\//g, '');
    check('and the code never names one',
          !/\b(document|window|getElementById|querySelector|localStorage)\b/.test(code));
})();

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail)
                         : 'ALL ' + pass + ' CHECKS PASSED'));
process.exitCode = fail ? 1 : 0;
