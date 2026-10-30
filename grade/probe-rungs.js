/* FWF.DEFAULT_THRESHOLDS runs 15,30,45,60,90,120,180,240,INF -- there is no
 * rung between four hours and unlimited. Any group whose tightest achievable
 * spread is 5-8h (one party with two flights a day, or a three-time-zone
 * spread) therefore falls straight through to "cheapest, any time".
 *
 * This probes what the headline becomes with 300 and 360 added, changing
 * nothing else. Run against the patched app.js. */
var H = require('./harness.js');
var F = require('./fixtures.js');
var R = require('./report.js');

['F3', 'F1', 'F2', 'F4'].forEach(function (k) {
  [false, true].forEach(function (withRungs) {
    var ctx = H.makeContext();
    if (withRungs) {
      ctx.FWF.DEFAULT_THRESHOLDS = [15, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480, ctx.FWF.INF];
    }
    var r = H.run(ctx, F[k]);
    console.log(R.pad(k, 4) + (withRungs ? ' +rungs ' : ' stock  ')
      + ' -> th=' + R.pad(r.best.th === Infinity ? 'any' : r.best.th + 'm', 5)
      + ' $' + R.pad(r.best.total, 6)
      + ' apart ' + R.pad(R.hm(r.best.worst), 9)
      + ' lands ' + r.out.ctx.ids.map(function (id) {
          return r.out.rows[id].option.arrive.slice(11);
        }).sort().join(',')
      + ' conns=' + (r.best.conn || []).length);
  });
});
