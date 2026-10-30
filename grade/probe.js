/* Show every threshold the optimiser can actually reach for a fixture's
 * outbound leg -- including the rows tripLadder() drops as dominated -- so a
 * plan a person would prefer cannot hide behind the ladder's pruning. */
var H = require('./harness.js');
var F = require('./fixtures.js');
var R = require('./report.js');

var key = process.argv[2] || 'F1';
var fx = F[key];
var ctx = H.makeContext();
H.run(ctx, fx);
var C = ctx.compute('outbound');
var FWF = ctx.FWF;

console.log('\n==== ' + fx.name + ' :: outbound, every window width ====');
var ths = [15, 30, 45, 60, 75, 90, 105, 120, 150, 180, 210, 240, 300, 360, 480, FWF.INF];
ths.forEach(function (T) {
  var r = FWF.minCostAtWindow(C.prep, T, C.costFn);
  if (!r) { console.log('  ' + R.pad(T === Infinity ? 'any' : T + 'm', 5) + ' infeasible'); return; }
  var conns = 0, air = 0, latest = 0, earliestDep = 1e9;
  C.ids.forEach(function (id) {
    var o = r.picks[id].option;
    if ((o.stops || 0) > 0) conns++;
    if (o.duration_minutes) air += o.duration_minutes;
  });
  var g = ctx.regretOf(C, r.picks);
  console.log('  ' + R.pad(T === Infinity ? 'any' : T + 'm', 5)
    + ' $' + R.pad(Math.round(r.cost), 5)
    + ' spread ' + R.pad(R.hm(r.spread), 8)
    + ' land ' + FWF.fmtClock(r.firstArrival) + '-' + FWF.fmtClock(r.lastArrival)
    + ' conns=' + conns + ' air=' + R.pad(R.hm(air), 8)
    + ' regret=' + g.stops + 'stop/' + R.hm(g.mins) + (g.who ? '(' + g.who + ')' : '')
    + '  [' + C.ids.map(function (id) {
        var o = r.picks[id].option;
        return id + ':' + o.from + ' ' + o.arrive.slice(11) + (o.stops ? '*' : '') + ' $' + Math.round(r.picks[id].cost);
      }).join(' | ') + ']');
});

/* And the same leg priced with no connection allowed to anyone who has a
 * nonstop -- the comparison a user makes on Google Flights in one click. */
console.log('\n---- nonstop-only for anyone who has a nonstop ----');
var only = {};
C.ids.forEach(function (id) {
  var list = C.prep.options[id];
  var hasNonstop = list.some(function (o) { return (o.stops || 0) === 0; });
  only[id] = hasNonstop ? list.filter(function (o) { return (o.stops || 0) === 0; }) : list;
});
var p2 = FWF.prepare(only, C.ids, 'arrive', {});
ths.forEach(function (T) {
  var r = FWF.minCostAtWindow(p2, T, C.costFn);
  if (!r) return;
  console.log('  ' + R.pad(T === Infinity ? 'any' : T + 'm', 5)
    + ' $' + R.pad(Math.round(r.cost), 5) + ' spread ' + R.pad(R.hm(r.spread), 8)
    + ' land ' + FWF.fmtClock(r.firstArrival) + '-' + FWF.fmtClock(r.lastArrival)
    + '  [' + C.ids.map(function (id) {
        var o = r.picks[id].option;
        return id + ':' + o.from + ' ' + o.arrive.slice(11) + ' $' + Math.round(r.picks[id].cost);
      }).join(' | ') + ']');
});
