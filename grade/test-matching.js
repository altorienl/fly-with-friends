/* Regression tests for the connection margin added to compute().
 *
 * These assert the three things that rule has to get right at once: it must
 * drop a connection that is barely cheaper than the party's own nonstop, it
 * must NOT fire for a party that has no nonstop at all, and it must still let
 * a genuinely cheap connection through. The first is the bug; the other two
 * are the ways a fix for it goes wrong. */
var fs = require('fs'), path = require('path');
var H = require('./harness.js');
var F = require('./fixtures.js');

var pass = 0, fail = 0;
function check(name, cond, got) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (got !== undefined ? '\n          got: ' + got : '')); }
}
function plan(fx) {
  var ctx = H.makeContext();
  return H.run(ctx, fx);
}
function pick(leg, id) { return leg.rows[id].option; }

console.log('\n-- F1: a $9 connection must not beat a nonstop --');
/* LAX-BNA: 06:15 one-stop via IAH, 5h55m, $229 vs 08:30 Delta nonstop,
 * 3h55m, $238. Before the margin the optimiser took the connection. */
var r1 = plan(F.F1);
check('LAX party flies nonstop', pick(r1.out, 'lax').stops === 0,
      pick(r1.out, 'lax').stops + ' stops, ' + pick(r1.out, 'lax').duration_minutes + 'm');
check('nobody in the recommended outbound connects',
      r1.out.ctx.ids.every(function (id) { return pick(r1.out, 'lax').stops === 0 && (pick(r1.out, id).stops || 0) === 0; }));
check('the reason line says so', /everyone nonstop/.test(r1.reason || ''), r1.reason);
/* And the same on the way home: BNA-CLT 4h00 one-stop at $242 beat a 1h25m
 * nonstop at $274 by $32. */
check('CLT party flies the 1h25m nonstop home', pick(r1.back, 'clt').stops === 0,
      pick(r1.back, 'clt').duration_minutes + 'm, ' + pick(r1.back, 'clt').stops + ' stops');
/* The rule must not have been free: the group pays a little for it. */
check('the fix costs money and the total says so', r1.best.total > 2284, '$' + r1.best.total);

console.log('\n-- F4: the thin-spoke group stops being matched at 10pm --');
var r4 = plan(F.F4);
check('no connections in the recommended outbound',
      r4.out.ctx.ids.every(function (id) { return (pick(r4.out, id).stops || 0) === 0; }));
var arrive = r4.out.ctx.ids.map(function (id) { return pick(r4.out, id).arrive.slice(11); }).sort();
check('everyone lands between 10:00 and 14:00, not 20:40-22:25',
      arrive[0] >= '10:00' && arrive[arrive.length - 1] <= '14:00', arrive.join(' '));
check('and it is cheaper than the night plan it replaced', r4.out.total <= 790,
      '$' + Math.round(r4.out.total));

console.log('\n-- the shipped demo: no nonstop exists, so the rule must not fire --');
var sample = JSON.parse(fs.readFileSync(path.join(H.ROOT, 'flights.json'), 'utf8'));
var demo = {
  dest: 'PIT', dep: '2027-02-12', ret: '2027-02-15',
  parties: [{ id: 'alex', name: 'Alex', seats: 1, airports: ['SFO', 'OAK', 'SJC'] },
            { id: 'sam', name: 'Sam', seats: 2, airports: ['ORD'] },
            { id: 'jo', name: 'Jo', seats: 1, airports: ['ATL'] },
            { id: 'ray', name: 'Ray', seats: 1, airports: ['DEN'] }],
  legs: { outbound: sample.trips['pit-feb'].outbound, 'return': sample.trips['pit-feb']['return'] }
};
var rd = plan(demo);
check('Alex keeps the SFO one-stop (there is no nonstop to keep instead)',
      pick(rd.out, 'alex').stops === 1, pick(rd.out, 'alex').stops + ' stops');
check('headline is unchanged at 20m / $1788',
      rd.best.worst === 20 && rd.best.total === 1788,
      rd.best.worst + 'm / $' + rd.best.total);

console.log('\n-- a connection that is genuinely a bargain survives --');
/* Long-haul shape: the one-stop is 40 minutes longer and $260 cheaper. No
 * margin scaled to extra hours should touch that. */
var bargain = {
  dest: 'LHR', dep: '2027-05-04',
  parties: [{ id: 'a', name: 'A', seats: 1, airports: ['SFO'] },
            { id: 'b', name: 'B', seats: 1, airports: ['JFK'] }],
  legs: { outbound: {
    a: [F.o('SFO', 'LHR', '2027-05-04 16:30', '+1 10:50', 620, 0, 920, 'United', 'mainline'),
        F.o('SFO', 'LHR', '2027-05-04 15:10', '+1 10:30', 660, 1, 660, 'Air Canada', 'mainline')],
    b: [F.o('JFK', 'LHR', '2027-05-04 21:30', '+1 09:40', 430, 0, 540, 'Delta', 'mainline'),
        F.o('JFK', 'LHR', '2027-05-04 19:05', '+1 10:20', 495, 1, 410, 'Aer Lingus', 'mainline')]
  } }
};
var rb = plan(bargain);
check('A keeps the $260-cheaper one-stop', pick(rb.out, 'a').stops === 1,
      '$' + Math.round(rb.out.rows.a.cost) + ', ' + pick(rb.out, 'a').stops + ' stops');
check('B keeps the $130-cheaper one-stop', pick(rb.out, 'b').stops === 1,
      '$' + Math.round(rb.out.rows.b.cost) + ', ' + pick(rb.out, 'b').stops + ' stops');

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail) : 'ALL ' + pass + ' CHECKS PASSED'));
process.exitCode = fail ? 1 : 0;
