/* Tests for airline matching and alliance membership.
 *
 * The filter is only as good as the name matching underneath it. Two specific
 * ways it could silently do the wrong thing:
 *   - collapsing two different carriers into one key, so avoiding one avoids
 *     the other (Air China is Star, China Airlines is SkyTeam);
 *   - stale alliance membership, so "only my alliance" quietly excludes the
 *     carrier somebody actually has status with. */

var fs = require('fs'), vm = require('vm');
var src = fs.readFileSync(__dirname + '/app.js', 'utf8');
var from = src.indexOf('/* ------------------------------------------------------------ airlines');
var to = src.indexOf('function airlineSite(o)');
if (from < 0 || to < 0) { console.error('FAIL: could not locate airline helpers'); process.exit(1); }

var ctx = { DATA: null, state: { q: { avoid: [] } } };
vm.createContext(ctx);
vm.runInContext(src.slice(from, to), ctx);

var pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name); }
}
function eq(name, got, want) {
    if (got === want) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + '  got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }
}

console.log('\n-- one carrier, many spellings --');
eq('Delta Air Lines == Delta', ctx.normAirline('Delta Air Lines'), ctx.normAirline('Delta'));
eq('American Airlines == American', ctx.normAirline('American Airlines'), ctx.normAirline('American'));
eq('case and punctuation ignored', ctx.normAirline('BRITISH AIRWAYS'), ctx.normAirline('British Airways'));

console.log('\n-- carriers that must NOT collapse --');
/* Stripping a leading "Air" would make these equal and put somebody on the
 * wrong airline, in the wrong alliance. */
check('Air China != China Airlines', ctx.normAirline('Air China') !== ctx.normAirline('China Airlines'));
check('Air China != China Eastern', ctx.normAirline('Air China') !== ctx.normAirline('China Eastern'));
check('Air Canada != Canada', ctx.normAirline('Air Canada') !== ctx.normAirline('Canada Jetlines'));
check('Air France != Finnair', ctx.normAirline('Air France') !== ctx.normAirline('Finnair'));

console.log('\n-- alliance membership, including the ones usually listed wrong --');
eq('United is Star', ctx.allianceOf('United'), 'star');
eq('Delta is SkyTeam', ctx.allianceOf('Delta'), 'sky');
eq('American is oneworld', ctx.allianceOf('American'), 'one');
eq('Alaska is oneworld, not unaligned', ctx.allianceOf('Alaska Airlines'), 'one');
eq('SAS is SkyTeam since Sept 2024, not Star', ctx.allianceOf('SAS'), 'sky');
eq('Virgin Atlantic is SkyTeam', ctx.allianceOf('Virgin Atlantic'), 'sky');
eq('Air China is Star', ctx.allianceOf('Air China'), 'star');
eq('China Airlines is SkyTeam', ctx.allianceOf('China Airlines'), 'sky');
eq('JetBlue is unaligned', ctx.allianceOf('JetBlue'), null);
eq('Southwest is unaligned', ctx.allianceOf('Southwest'), null);
eq('Frontier is unaligned', ctx.allianceOf('Frontier'), null);
eq('Emirates is unaligned', ctx.allianceOf('Emirates'), null);

console.log('\n-- no carrier claimed by two alliances --');
var dupes = [];
var seen = {};
ctx.ALLIANCES.forEach(function (a) {
    a.members.forEach(function (m) {
        var k = ctx.normAirline(m);
        if (seen[k] && seen[k] !== a.k) dupes.push(m + ' (' + seen[k] + ' and ' + a.k + ')');
        seen[k] = a.k;
    });
});
check('membership is unambiguous' + (dupes.length ? ': ' + dupes.join(', ') : ''), dupes.length === 0);

console.log('\n-- carriersInResults, against the real fixture --');
ctx.DATA = JSON.parse(fs.readFileSync(__dirname + '/flights.json', 'utf8'));
var cs = ctx.carriersInResults();
check('finds carriers in the fixture', cs.length > 1);
check('sorted by how many options they fly',
      cs.every(function (c, i) { return i === 0 || cs[i - 1].n >= c.n; }));
check('every entry has a display name and a count',
      cs.every(function (c) { return c.name && c.n > 0 && c.key; }));
console.log('        ' + cs.map(function (c) {
    return c.name + ' x' + c.n + (c.alliance ? ' [' + c.alliance + ']' : '');
}).join(', '));

console.log('\n-- isAvoided reads the live query --');
ctx.state.q.avoid = [ctx.normAirline('United')];
check('avoided carrier reports true', ctx.isAvoided('United Airlines'));
check('other carriers unaffected', !ctx.isAvoided('Delta'));
ctx.state.q.avoid = [];
check('cleared list avoids nothing', !ctx.isAvoided('United'));

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASSED'));
process.exitCode = fail ? 1 : 0;
