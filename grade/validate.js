/* Harness fidelity check: drive the shipped demo (flights.json, the real
 * 4-party Pittsburgh search) through render() and read the headline out of the
 * DOM, then confirm run() reports the same thing. If these two disagree the
 * grading below is measuring something the screen never says. */
var fs = require('fs'), path = require('path');
var H = require('./harness.js');
var R = require('./report.js');

var sample = JSON.parse(fs.readFileSync(path.join(H.ROOT, 'flights.json'), 'utf8'));
var trip = sample.trips['pit-feb'];

var fx = {
  name: 'F0 — shipped demo: 4 parties into PIT (real SerpApi capture)',
  dest: 'PIT', dep: '2027-02-12', ret: '2027-02-15',
  parties: [
    { id: 'alex', name: 'Alex', seats: 1, airports: ['SFO', 'OAK', 'SJC'] },
    { id: 'sam', name: 'Sam', seats: 2, airports: ['ORD'] },
    { id: 'jo', name: 'Jo', seats: 1, airports: ['ATL'] },
    { id: 'ray', name: 'Ray', seats: 1, airports: ['DEN'] }
  ],
  legs: { outbound: trip.outbound, 'return': trip['return'] }
};

var ctx = H.makeContext();
var r = H.run(ctx, fx);

/* Now the real render path, exactly as ?demo=1 would reach it. */
ctx.state.step = 4;
ctx.thReset();
ctx.render();
var html = ctx.__els.choices.innerHTML;
console.log('--- #choices innerHTML as rendered ---');
console.log(html.replace(/></g, '>\n<'));
console.log('\n--- run() view ---');
console.log(R.describe(r, fx));

var m = /Everyone lands within ([^<]*)</.exec(html);
var t = /class="pick-tot mono">\$([\d,]+)/.exec(html);
console.log('\nrendered headline: ' + (m && m[1]) + ' for $' + (t && t[1]));
console.log('run() headline:    ' + R.hm(r.best.worst) + ' for $' + r.best.total);
