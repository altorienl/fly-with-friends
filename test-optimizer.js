/* Brute-force verification of the arrival-window optimizer.
 *
 * Run: node test-optimizer.js
 *
 * Fixtures are deliberately small. At 7 travelers x 25 options the combination
 * space is 25^7, far past enumerating -- so correctness is established here on
 * sizes that CAN be enumerated, and the real data then runs through the verified
 * implementation.
 */
var F = require('./optimizer.js');
var INF = F.INF;

var pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}

/* Deterministic PRNG so failures are reproducible. */
function rng(seed) {
  var s = seed >>> 0;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

var DAY = '2027-02-12 ';
function stamp(minutesFromMidnight) {
  var h = Math.floor(minutesFromMidnight / 60) % 24, m = minutesFromMidnight % 60;
  return DAY + (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m);
}

function makeFixture(rand, nTravelers, nOptions) {
  var ids = [], byTraveler = {};
  for (var i = 0; i < nTravelers; i++) {
    var id = 'p' + i;
    ids.push(id);
    var list = [];
    for (var j = 0; j < nOptions; j++) {
      list.push({
        price: 100 + Math.floor(rand() * 400),
        depart: stamp(Math.floor(rand() * 400)),
        arrive: stamp(300 + Math.floor(rand() * 900)),
        bags: { carry_on_included: true, checked_first_price: null, confidence: 'absent' }
      });
    }
    byTraveler[id] = list;
  }
  return { ids: ids, byTraveler: byTraveler };
}

/* Enumerate every combination: one option per traveler. */
function bruteForce(prepared, costFn) {
  var ids = prepared.ids;
  var combos = [];
  (function walk(i, picks) {
    if (i === ids.length) {
      var times = ids.map(function (id) { return picks[id].clusterMin; });
      var cost = ids.reduce(function (s, id) { return s + costFn(picks[id], id); }, 0);
      combos.push({
        spread: Math.max.apply(null, times) - Math.min.apply(null, times),
        cost: cost
      });
      return;
    }
    var list = prepared.options[ids[i]];
    for (var k = 0; k < list.length; k++) {
      picks[ids[i]] = list[k];
      walk(i + 1, picks);
    }
  })(0, {});
  return combos;
}

var fareOnly = function (o) { return o.price || 0; };

console.log('\n1. Time parsing');
check('toMinutes parses "YYYY-MM-DD HH:MM"',
  F.toMinutes('2027-02-12 15:40') === Date.UTC(2027, 1, 12, 15, 40) / 60000);
check('toMinutes handles ISO T separator',
  F.toMinutes('2027-02-12T15:40') === F.toMinutes('2027-02-12 15:40'));
check('toMinutes rejects junk', F.toMinutes('not a date') === null);
check('arrival ordering across midnight is absolute, not clock-wrapped',
  F.toMinutes('2027-02-13 00:10') > F.toMinutes('2027-02-12 23:50'));

console.log('\n2. Hand-checked fixture');
(function () {
  var byTraveler = {
    alex: [{ price: 212, arrive: '2027-02-12 15:40', depart: '2027-02-12 07:15' },
           { price: 288, arrive: '2027-02-12 16:20', depart: '2027-02-12 08:05' },
           { price: 198, arrive: '2027-02-12 22:15', depart: '2027-02-12 13:40' }],
    sam:  [{ price: 148, arrive: '2027-02-12 15:52', depart: '2027-02-12 13:10' },
           { price: 132, arrive: '2027-02-12 16:20', depart: '2027-02-12 13:35' },
           { price: 118, arrive: '2027-02-12 09:30', depart: '2027-02-12 06:50' }],
    jo:   [{ price: 176, arrive: '2027-02-12 15:58', depart: '2027-02-12 13:05' },
           { price: 204, arrive: '2027-02-12 16:12', depart: '2027-02-12 13:20' },
           { price: 158, arrive: '2027-02-12 12:40', depart: '2027-02-12 09:45' }]
  };
  var prep = F.prepare(byTraveler, ['alex', 'sam', 'jo']);

  // alex 16:20, sam 16:20, jo 16:12 -> 8 minutes, the tightest possible.
  var tight = F.tightestWindow(prep);
  check('tightest window is 8 minutes', tight.spread === 8,
    'got ' + (tight && tight.spread));

  // Within 8 minutes everyone is forced onto their 16:1x option: 288+132+204.
  var at8 = F.minCostAtWindow(prep, 8, fareOnly);
  check('cost at 8 minutes is 624', at8.cost === 624, 'got ' + (at8 && at8.cost));

  // Loosening to 20 lets alex take 15:40 and sam/jo their 15:5x: 212+148+176.
  var at20 = F.minCostAtWindow(prep, 20, fareOnly);
  check('cost at 20 minutes is 536', at20.cost === 536, 'got ' + (at20 && at20.cost));

  // Unconstrained: each traveler's own cheapest, scattered across the day.
  var atInf = F.minCostAtWindow(prep, INF, fareOnly);
  check('unconstrained cheapest is 474', atInf.cost === 474, 'got ' + (atInf && atInf.cost));
  check('unconstrained really is scattered', atInf.spread > 240,
    'spread ' + (atInf && atInf.spread));
})();

console.log('\n3. Brute force agreement (200 random fixtures)');
(function () {
  var rand = rng(20260127);
  var tightMismatch = 0, costMismatch = 0, trials = 0;

  for (var n = 0; n < 200; n++) {
    var nT = 2 + Math.floor(rand() * 3);      // 2-4 travelers
    var nO = 2 + Math.floor(rand() * 4);      // 2-5 options each
    var fx = makeFixture(rand, nT, nO);
    var prep = F.prepare(fx.byTraveler, fx.ids);
    var combos = bruteForce(prep, fareOnly);

    var bfTight = Math.min.apply(null, combos.map(function (c) { return c.spread; }));
    var got = F.tightestWindow(prep);
    if (!got || got.spread !== bfTight) tightMismatch++;

    [0, 15, 30, 60, 120, 240, 600, INF].forEach(function (S) {
      trials++;
      var feasible = combos.filter(function (c) { return c.spread <= S; });
      var bfCost = feasible.length
        ? Math.min.apply(null, feasible.map(function (c) { return c.cost; }))
        : null;
      var res = F.minCostAtWindow(prep, S, fareOnly);
      var gotCost = res ? res.cost : null;
      if (gotCost !== bfCost) costMismatch++;
    });
  }

  check('tightest window matches brute force on all 200 fixtures', tightMismatch === 0,
    tightMismatch + ' mismatches');
  check('min cost matches brute force across ' + trials + ' (fixture, S) pairs',
    costMismatch === 0, costMismatch + ' mismatches');
})();

console.log('\n4. Ladder invariants');
(function () {
  var rand = rng(777);
  var nonMonotonic = 0, dominatedKept = 0;

  for (var n = 0; n < 50; n++) {
    var fx = makeFixture(rand, 4, 6);
    var prep = F.prepare(fx.byTraveler, fx.ids);
    var lad = F.ladder(prep, fareOnly);

    var prev = null;
    lad.all.forEach(function (row) {
      if (!row.feasible) return;
      if (prev !== null && row.result.cost > prev) nonMonotonic++;
      prev = row.result.cost;
    });

    var lastKept = null;
    lad.rows.forEach(function (row) {
      if (!row.feasible) return;
      if (lastKept !== null && row.result.cost >= lastKept) dominatedKept++;
      lastKept = row.result.cost;
    });
  }

  check('cost never rises as the window loosens', nonMonotonic === 0,
    nonMonotonic + ' violations');
  check('no dominated rows survive filtering', dominatedKept === 0,
    dominatedKept + ' violations');
})();

console.log('\n5. Subset handling');
(function () {
  var byTraveler = {
    a: [{ price: 200, arrive: '2027-02-12 16:00', depart: '2027-02-12 09:00' }],
    b: [{ price: 210, arrive: '2027-02-12 16:10', depart: '2027-02-12 09:10' }],
    c: [{ price: 190, arrive: '2027-02-12 16:20', depart: '2027-02-12 09:20' }],
    // Ray can only land at dawn or near midnight -- hours outside any cluster.
    ray: [{ price: 189, arrive: '2027-02-12 06:10', depart: '2027-02-12 01:00' },
          { price: 240, arrive: '2027-02-12 23:45', depart: '2027-02-12 18:00' }]
  };
  var ids = ['a', 'b', 'c', 'ray'];
  var prep = F.prepare(byTraveler, ids);

  var tight = F.tightestWindow(prep);
  check('full-group tightest is hours wide', tight.spread > 240, 'got ' + tight.spread);
  check('30-minute target is infeasible for the full group',
    F.minCostAtWindow(prep, 30, fareOnly) === null);

  var sub = F.bestSubset(prep, 30, fareOnly);
  check('subset finds 3 of 4', sub.included.length === 3,
    'got ' + (sub && sub.included.length));
  check('subset names ray as the outlier',
    sub.excluded.length === 1 && sub.excluded[0].id === 'ray');
  // Window is [16:00, 16:30]. Ray's nearest option is the 23:45 arrival, 435m
  // past the window end -- closer than the 06:10 one, which is 590m before it.
  check('ray gap is measured to his nearest option, not his first',
    sub.excluded[0].gapMinutes === 435, 'got ' + sub.excluded[0].gapMinutes);
  check('ray gap uses the 23:45 flight', sub.excluded[0].nearest.arrive === '2027-02-12 23:45',
    'got ' + sub.excluded[0].nearest.arrive);
  check('subset cost covers only the included three', sub.cost === 600,
    'got ' + sub.cost);
})();

console.log('\n6. Incomplete data is refused, not averaged over');
(function () {
  var prep = F.prepare({
    a: [{ price: 200, arrive: '2027-02-12 16:00', depart: '2027-02-12 09:00' }],
    b: []
  }, ['a', 'b']);
  check('prepare flags the empty traveler', prep.complete === false && prep.missing[0] === 'b');
  check('tightestWindow refuses incomplete groups', F.tightestWindow(prep) === null);
  check('minCostAtWindow refuses incomplete groups',
    F.minCostAtWindow(prep, 30, fareOnly) === null);
})();

console.log('\n7. Bag fees are never silently zero');
(function () {
  var settings = { assumedCheckedBagFee: 35, assumedCarryOnFee: 30 };
  var traveler = { id: 'a', bags: { carry_on: 1, checked: 1 } };

  var parsed = F.allInCost(
    { price: 200, bags: { confidence: 'parsed', checked_first_price: 40, carry_on_included: true } },
    traveler, settings);
  check('a known fee is used exactly', parsed.total === 240 && parsed.estimated === false,
    JSON.stringify(parsed));

  var unknown = F.allInCost(
    { price: 200, bags: { confidence: 'fee_unknown', checked_first_price: null, carry_on_included: true } },
    traveler, settings);
  check('an unknown fee falls back to the assumption and is flagged',
    unknown.total === 235 && unknown.estimated === true, JSON.stringify(unknown));

  var absent = F.allInCost(
    { price: 200, bags: { confidence: 'absent', checked_first_price: null, carry_on_included: null } },
    traveler, settings);
  check('absent bag data is never scored as free',
    absent.bagFee > 0 && absent.estimated === true, JSON.stringify(absent));

  var free = F.allInCost(
    { price: 200, bags: { confidence: 'parsed', checked_first_price: 0, carry_on_included: true } },
    traveler, settings);
  check('an included bag really is free', free.total === 200 && free.estimated === false,
    JSON.stringify(free));

  var noBags = F.allInCost(
    { price: 200, bags: { confidence: 'absent' } },
    { id: 'a', bags: { carry_on: 0, checked: 0 } }, settings);
  check('a traveler bringing nothing pays no bag fee', noBags.total === 200);

  var carryOnFee = F.allInCost(
    { price: 200, bags: { confidence: 'parsed', checked_first_price: 0, carry_on_included: false } },
    { id: 'a', bags: { carry_on: 1, checked: 0 } }, settings);
  check('an excluded carry-on is charged', carryOnFee.total === 230,
    JSON.stringify(carryOnFee));
})();

console.log('\n8. Ranking honours tightest-then-cheapest');
(function () {
  var byTraveler = {
    a: [{ price: 500, arrive: '2027-02-12 16:00', depart: '2027-02-12 09:00' },
        { price: 100, arrive: '2027-02-12 20:00', depart: '2027-02-12 13:00' }],
    b: [{ price: 500, arrive: '2027-02-12 16:05', depart: '2027-02-12 09:05' },
        { price: 100, arrive: '2027-02-12 08:00', depart: '2027-02-12 01:05' }]
  };
  var prep = F.prepare(byTraveler, ['a', 'b']);
  var best = F.tightestThenCheapest(prep, fareOnly);
  check('picks the 5-minute pairing even though it costs 5x',
    best.spread === 5 && best.result.cost === 1000,
    JSON.stringify({ spread: best.spread, cost: best.result.cost }));
  check('the cheap pairing is genuinely far apart',
    F.minCostAtWindow(prep, INF, fareOnly).cost === 200);
})();

console.log('\n9. Arrival-time band');
check('parseTimeOfDay 11:00 -> 660', F.parseTimeOfDay('11:00') === 660);
check('parseTimeOfDay 9:30 -> 570', F.parseTimeOfDay('9:30') === 570);
check('parseTimeOfDay 23:59 -> 1439', F.parseTimeOfDay('23:59') === 1439);
check('parseTimeOfDay 00:00 -> 0', F.parseTimeOfDay('00:00') === 0);
check('parseTimeOfDay rejects 24:00', F.parseTimeOfDay('24:00') === null);
check('parseTimeOfDay rejects 11:60', F.parseTimeOfDay('11:60') === null);
check('parseTimeOfDay rejects junk', F.parseTimeOfDay('elevenish') === null);
check('parseTimeOfDay rejects empty', F.parseTimeOfDay('') === null);

check('timeOfDay strips the date', F.timeOfDay(F.toMinutes('2027-02-12 11:00')) === 660);
check('timeOfDay works past midnight', F.timeOfDay(F.toMinutes('2027-02-13 00:30')) === 30);

var at = function (s) { return F.toMinutes('2027-02-12 ' + s); };
check('inBand inside a normal range', F.inBand(at('11:00'), 600, 720) === true);
check('inBand on the lower edge is inclusive', F.inBand(at('10:00'), 600, 720) === true);
check('inBand on the upper edge is inclusive', F.inBand(at('12:00'), 600, 720) === true);
check('inBand outside a normal range', F.inBand(at('13:00'), 600, 720) === false);
check('inBand wraps past midnight (23:00 in 22:00-02:00)',
  F.inBand(at('23:00'), 1320, 120) === true);
check('inBand wraps past midnight (01:00 in 22:00-02:00)',
  F.inBand(at('01:00'), 1320, 120) === true);
check('inBand wrapped range excludes the middle of the day',
  F.inBand(at('12:00'), 1320, 120) === false);
check('inBand with no bounds accepts everything', F.inBand(at('03:00'), null, null) === true);

console.log('\n10. Band filtering inside prepare');
(function () {
  var byTraveler = {
    a: [{ price: 300, arrive: '2027-02-12 10:45', depart: '2027-02-12 06:00' },   // in band
        { price: 100, arrive: '2027-02-12 19:30', depart: '2027-02-12 14:00' }],  // out
    b: [{ price: 320, arrive: '2027-02-12 11:10', depart: '2027-02-12 07:00' },   // in band
        { price: 120, arrive: '2027-02-12 22:15', depart: '2027-02-12 17:00' }],  // out
    c: [{ price: 90,  arrive: '2027-02-12 02:30', depart: '2027-02-11 21:00' }]   // never in band
  };

  var band = { from: F.parseTimeOfDay('10:00'), to: F.parseTimeOfDay('12:00') };

  var two = F.prepare(byTraveler, ['a', 'b'], 'arrive', band);
  check('band keeps only in-band options',
    two.options.a.length === 1 && two.options.b.length === 1);
  check('band reports how many were dropped',
    two.dropped.a === 1 && two.dropped.b === 1, JSON.stringify(two.dropped));
  check('band is echoed back on the prepared set',
    two.band.from === 600 && two.band.to === 720);
  check('in-band group is still complete', two.complete === true);
  check('cost reflects the in-band options, not the cheap out-of-band ones',
    F.minCostAtWindow(two, 60, fareOnly).cost === 620,
    'got ' + JSON.stringify(F.minCostAtWindow(two, 60, fareOnly) && F.minCostAtWindow(two, 60, fareOnly).cost));
  check('unconstrained is cheaper and is what the band is measured against',
    F.minCostAtWindow(F.prepare(byTraveler, ['a', 'b'], 'arrive'), 1440, fareOnly).cost === 220);

  var three = F.prepare(byTraveler, ['a', 'b', 'c'], 'arrive', band);
  check('a traveller with nothing in band makes the group incomplete',
    three.complete === false && three.missing.join() === 'c');
  check('an incomplete banded group yields no plan',
    F.tightestWindow(three) === null && F.minCostAtWindow(three, 60, fareOnly) === null);

  var subset = F.bestSubset(three, 60, fareOnly);
  check('subset still answers for the band, naming who cannot make it',
    subset.included.length === 2 && subset.excluded.length === 1 && subset.excluded[0].id === 'c');
})();

console.log('\n11. Band composes with the existing algorithms unchanged');
(function () {
  var rand = rng(4242);
  var mismatches = 0;
  for (var n = 0; n < 40; n++) {
    var fx = makeFixture(rand, 3, 6);
    var band = { from: 600, to: 900 };
    var banded = F.prepare(fx.byTraveler, fx.ids, 'arrive', band);
    if (!banded.complete) continue;

    // Everything the banded set offers must itself be inside the band.
    fx.ids.forEach(function (id) {
      banded.options[id].forEach(function (o) {
        if (!F.inBand(o.clusterMin, 600, 900)) mismatches++;
      });
    });

    // And the chosen plan must be too.
    var plan = F.minCostAtWindow(banded, 120, fareOnly);
    if (plan) {
      fx.ids.forEach(function (id) {
        if (!F.inBand(plan.picks[id].option.clusterMin, 600, 900)) mismatches++;
      });
    }
  }
  check('no out-of-band option ever survives into a plan', mismatches === 0,
    mismatches + ' leaks');
})();

console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASSED' : pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
