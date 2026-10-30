/* app.js:326  ->  if (cap != null && loner) {
 * `loner` is declared nowhere in the repo. It is only evaluated when
 * state.q.maxPremium is non-null, and no UI control sets maxPremium -- but a
 * shared trip carries the whole query object through hashPayload/readHash and
 * migrateQuery does not strip it. So one shared link with maxPremium set takes
 * the entire results screen down. */
var H = require('./harness.js');
var F = require('./fixtures.js');

var ctx = H.makeContext();
try {
  H.run(ctx, Object.assign({}, F.F2, { q: { maxPremium: 150 } }));
  console.log('no throw -- maxPremium path is reachable without error');
} catch (e) {
  console.log('THREW: ' + e.name + ': ' + e.message);
}

/* And prove it arrives through the share path rather than only by hand. */
var ctx2 = H.makeContext();
H.run(ctx2, F.F2);
ctx2.state.q.maxPremium = 150;
var pay = ctx2.hashPayload();
console.log('hashPayload carries maxPremium: ' + JSON.stringify(pay.q.maxPremium));
console.log('migrateQuery keeps it:          '
  + JSON.stringify(ctx2.migrateQuery(JSON.parse(JSON.stringify(pay.q))).maxPremium));
try { ctx2.compute('outbound'); console.log('compute() survived'); }
catch (e) { console.log('compute() after share: THREW ' + e.name + ': ' + e.message); }
