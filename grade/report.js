/* Pretty-print what the app decided for a fixture, in the terms a user judges
 * it in: who is on what flight, what it costs, how far apart they land. */
var H = require('./harness.js');

function hm(m) {
  if (m == null) return '--';
  var a = Math.abs(Math.round(m)), h = Math.floor(a / 60), x = a % 60;
  return (h ? h + 'h' : '') + (x ? (h ? ' ' : '') + x + 'm' : (h ? '' : '0m'));
}
function clock(s) { return (s || '').slice(11); }
function th(t) { return t === Infinity ? 'any' : t + 'm'; }

function describe(r, fx) {
  var L = [];
  L.push('  ladder (tightest -> cheapest):');
  (r.ladder || []).forEach(function (row) {
    L.push('    th=' + pad(th(row.th), 5) + ' total=$' + pad(row.total, 6)
      + ' apart=' + pad(hm(row.worst), 8)
      + ' air=' + pad(hm(row.mins), 9)
      + ' conns=' + pad((row.conn || []).length, 2)
      + ' regret=' + row.regret.stops + 'stop/' + hm(row.regret.mins)
      + (row.regret.who ? ' (' + row.regret.who + ')' : '')
      + ' worstPer=$' + row.topPer);
  });
  if (r.best) {
    L.push('  APP ANSWER: th=' + th(r.best.th) + '  total=$' + r.best.total
      + '  everyone lands within ' + hm(r.best.worst)
      + '  worst per-person $' + r.best.topPer);
    L.push('  why: ' + r.reason);
  } else L.push('  APP ANSWER: none');

  ['out', 'back'].forEach(function (k) {
    var leg = r[k];
    if (!leg) return;
    L.push('  ' + (k === 'out' ? 'OUTBOUND' : 'RETURN') + ' picks (plan th='
      + th(leg.plan.subset ? 'subset' : (k === 'out' ? r.ctx.state.th.outbound : r.ctx.state.th['return']))
      + ', spread ' + hm(leg.spread) + ', leg total $' + Math.round(leg.total) + '):');
    r.out.ctx.ids.forEach(function (id) {
      var row = leg.rows[id];
      if (!row) { L.push('    ' + pad(id, 7) + ' NO FLIGHT'); return; }
      var o = row.option;
      L.push('    ' + pad(id, 7) + ' ' + pad(o.from + '>' + o.to, 9)
        + ' ' + clock(o.depart) + '-' + clock(o.arrive)
        + ' ' + pad(o.stops + 'stop', 6) + ' ' + pad(hm(o.duration_minutes), 8)
        + ' ' + pad((o.airlines || []).join('/'), 18)
        + ' $' + pad(Math.round(row.cost), 5)
        + (row.inWindow === false ? '  [OUTSIDE WINDOW]' : '')
        + (row.premium ? '  (+$' + row.premium + ' vs own cheapest)' : ''));
    });
  });
  if (r.trip) L.push('  TRIP TOTAL (both legs, all seats): $' + Math.round(r.trip.total));
  return L.join('\n');
}
function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

function grade(fx, human) {
  var ctx = H.makeContext();
  var r = H.run(ctx, fx);
  console.log('\n================================================================');
  console.log(fx.name);
  console.log('================================================================');
  if (human) console.log('HUMAN ANSWER (written before running):\n' + human + '\n');
  console.log(describe(r, fx));
  return r;
}

module.exports = { grade: grade, describe: describe, hm: hm, pad: pad };
