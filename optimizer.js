/* Fly with Friends — arrival-window optimizer.
 *
 * Kept out of index.html on purpose: this is the part where a plausible-looking
 * wrong answer is invisible in the UI, so it needs to be runnable under node
 * against brute force. Loads as a plain <script> in the browser too.
 *
 * Primary objective is the TIGHTEST arrival window. Cost is secondary -- used to
 * choose among plans that are already tight, and to price the tradeoff when the
 * target cannot be met.
 */
(function (root) {
  'use strict';

  var INF = Infinity;

  /* Times arrive as "YYYY-MM-DD HH:MM" local wall-clock with no offset. Every
   * arrival we compare is at the same destination airport, so a fixed-offset
   * parse is exact for clustering. Departure times across different origins are
   * NOT comparable this way -- do not reuse this for origin-side math. */
  function toMinutes(stamp) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(stamp || '');
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000;
  }

  function fmtClock(minutes, use24) {
    var d = new Date(minutes * 60000);
    var h = d.getUTCHours(), mm = d.getUTCMinutes();
    var pad = mm < 10 ? '0' + mm : '' + mm;
    if (use24) return (h < 10 ? '0' + h : h) + ':' + pad;
    var suffix = h < 12 ? 'am' : 'pm';
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ':' + pad + suffix;
  }

  function fmtGap(minutes) {
    if (minutes == null) return '--';
    var abs = Math.abs(Math.round(minutes));
    var h = Math.floor(abs / 60), m = abs % 60;
    if (h === 0) return m + 'm';
    if (m === 0) return h + 'h';
    return h + 'h ' + m + 'm';
  }

  /* ---------------------------------------------------------------- cost */

  /* All-in cost for one option. A missing bag fee is NEVER treated as $0 -- that
   * would systematically flatter the basic-economy fares most likely to look
   * artificially cheap. Unknown fees fall back to the configured assumption and
   * are flagged so the UI can badge them as estimates. */
  function allInCost(option, traveler, settings) {
    var fare = option.price || 0;
    var bags = option.bags || {};
    var wantChecked = ((traveler && traveler.bags) || {}).checked || 0;
    var wantCarryOn = ((traveler && traveler.bags) || {}).carry_on || 0;
    var bagFee = 0;
    var estimated = false;

    if (wantChecked > 0) {
      if (bags.confidence === 'parsed' && bags.checked_first_price != null) {
        bagFee += bags.checked_first_price * wantChecked;
      } else {
        bagFee += (settings.assumedCheckedBagFee || 0) * wantChecked;
        estimated = true;
      }
    }

    if (wantCarryOn > 0 && bags.carry_on_included === false) {
      bagFee += settings.assumedCarryOnFee || 0;
      estimated = true;
    }

    return { fare: fare, bagFee: bagFee, total: fare + bagFee, estimated: estimated };
  }

  function makeCostFn(travelers, settings) {
    var byId = {};
    travelers.forEach(function (t) { byId[t.id] = t; });
    return function (option, travelerId) {
      if (settings.priceDisplay === 'fare') return option.price || 0;
      return allInCost(option, byId[travelerId], settings).total;
    };
  }

  /* ------------------------------------------------------- normalisation */

  /* byTraveler: { travelerId: [option, ...] } -> { ids, options, complete }
   *
   * timeField selects which end of the itinerary is clustered: 'arrive' for the
   * outbound leg (everyone lands together) or 'depart' for the return (everyone
   * leaves the destination together and can share a ride out). Either way the
   * clustered times are all at the shared destination airport, so comparing them
   * without timezone conversion is exact. */
  function prepare(byTraveler, travelerIds, timeField) {
    var field = timeField || 'arrive';
    var ids = travelerIds.slice();
    var options = {};
    var missing = [];

    ids.forEach(function (id) {
      var list = (byTraveler[id] || []).map(function (o) {
        var copy = {};
        for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) copy[k] = o[k];
        copy.clusterMin = toMinutes(o[field]);
        copy.arriveMin = toMinutes(o.arrive);
        copy.departMin = toMinutes(o.depart);
        return copy;
      }).filter(function (o) { return o.clusterMin != null; });
      list.sort(function (a, b) { return a.clusterMin - b.clusterMin; });
      options[id] = list;
      if (!list.length) missing.push(id);
    });

    return { ids: ids, options: options, missing: missing,
             timeField: field, complete: missing.length === 0 };
  }

  /* -------------------------------------------- (a) tightest achievable */

  /* Smallest range containing at least one arrival from every traveler.
   * Two-pointer over the merged, sorted arrival list. Exact, O(n log n). */
  function tightestWindow(prepared) {
    if (!prepared.complete) return null;

    var merged = [];
    prepared.ids.forEach(function (id) {
      prepared.options[id].forEach(function (o) { merged.push({ t: o.clusterMin, id: id }); });
    });
    merged.sort(function (a, b) { return a.t - b.t; });

    var need = prepared.ids.length;
    var counts = {}, have = 0, left = 0;
    var best = null;

    for (var right = 0; right < merged.length; right++) {
      var rid = merged[right].id;
      counts[rid] = (counts[rid] || 0) + 1;
      if (counts[rid] === 1) have++;

      while (have === need) {
        var spread = merged[right].t - merged[left].t;
        if (best === null || spread < best.spread) {
          best = { spread: spread, start: merged[left].t, end: merged[right].t };
        }
        var lid = merged[left].id;
        counts[lid]--;
        if (counts[lid] === 0) have--;
        left++;
      }
    }
    return best;
  }

  /* ------------------------------------- (b) min cost at a window width */

  function cheapestInWindow(list, start, end, costFn, travelerId) {
    var best = null, bestCost = INF;
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (o.clusterMin < start) continue;
      if (o.clusterMin > end) break; // sorted by the clustered time
      var c = costFn(o, travelerId);
      if (c < bestCost) { bestCost = c; best = o; }
    }
    return best ? { option: best, cost: bestCost } : null;
  }

  function windowStarts(prepared) {
    var seen = {}, starts = [];
    prepared.ids.forEach(function (id) {
      prepared.options[id].forEach(function (o) {
        if (!seen[o.clusterMin]) { seen[o.clusterMin] = true; starts.push(o.clusterMin); }
      });
    });
    starts.sort(function (a, b) { return a - b; });
    return starts;
  }

  function summarise(picks, ids) {
    var times = ids.map(function (id) { return picks[id].option.clusterMin; });
    var cost = ids.reduce(function (sum, id) { return sum + picks[id].cost; }, 0);
    return {
      cost: cost,
      spread: Math.max.apply(null, times) - Math.min.apply(null, times),
      firstArrival: Math.min.apply(null, times),
      lastArrival: Math.max.apply(null, times),
      windowStart: Math.min.apply(null, times),
      windowEnd: Math.max.apply(null, times),
      picks: picks
    };
  }

  /* Minimum cost such that every traveler lands inside some window of width S.
   *
   * Sliding the window start over actual arrival times is sufficient: an optimal
   * window can always be shifted left until it begins at some arrival, so this
   * is the true optimum for each S rather than an approximation. */
  function minCostAtWindow(prepared, S, costFn) {
    if (!prepared.complete) return null;
    var ids = prepared.ids;

    if (S === INF) {
      var picks = {};
      for (var i = 0; i < ids.length; i++) {
        var got = cheapestInWindow(prepared.options[ids[i]], -INF, INF, costFn, ids[i]);
        if (!got) return null;
        picks[ids[i]] = got;
      }
      return summarise(picks, ids);
    }

    var starts = windowStarts(prepared);
    var best = null;

    for (var s = 0; s < starts.length; s++) {
      var start = starts[s], end = start + S;
      var candidate = {}, total = 0, feasible = true;

      for (var k = 0; k < ids.length; k++) {
        var hit = cheapestInWindow(prepared.options[ids[k]], start, end, costFn, ids[k]);
        if (!hit) { feasible = false; break; }
        candidate[ids[k]] = hit;
        total += hit.cost;
      }

      if (feasible && (best === null || total < best.cost)) {
        best = summarise(candidate, ids);
      }
    }
    return best;
  }

  /* ------------------------------------------------ (c) subset handling */

  /* With 7 travelers one person holding a single bad option forces the whole
   * window open, and "tightest possible: 4h 20m" tells the group nothing. So we
   * also solve for the largest subset that fits the target and name who falls
   * out -- that turns an impossible constraint into a real decision. */
  function bestSubset(prepared, S, costFn) {
    var ids = prepared.ids;
    var starts = windowStarts(prepared);
    var best = null;

    for (var s = 0; s < starts.length; s++) {
      var start = starts[s], end = start + S;
      var picks = {}, included = [], total = 0;

      for (var k = 0; k < ids.length; k++) {
        var hit = cheapestInWindow(prepared.options[ids[k]], start, end, costFn, ids[k]);
        if (hit) { picks[ids[k]] = hit; included.push(ids[k]); total += hit.cost; }
      }
      if (!included.length) continue;

      var better = best === null
        || included.length > best.included.length
        || (included.length === best.included.length && total < best.cost);

      if (better) {
        best = {
          included: included, picks: picks, cost: total,
          windowStart: start, windowEnd: end,
          summary: summarise(picks, included)
        };
      }
    }

    if (!best) return null;

    best.excluded = ids.filter(function (id) {
      return best.included.indexOf(id) === -1;
    }).map(function (id) {
      var list = prepared.options[id];
      var nearest = null, gap = INF;
      for (var i = 0; i < list.length; i++) {
        var t = list[i].clusterMin;
        var d = t < best.windowStart ? best.windowStart - t
              : t > best.windowEnd ? t - best.windowEnd : 0;
        if (d < gap) { gap = d; nearest = list[i]; }
      }
      return { id: id, gapMinutes: gap === INF ? null : gap, nearest: nearest };
    });

    return best;
  }

  /* ------------------------------------------------------------- ladder */

  var DEFAULT_THRESHOLDS = [15, 30, 45, 60, 90, 120, 180, 240, INF];

  /* Cost at each window width, with dominated rows dropped: a looser window that
   * saves nothing is never worth offering. Cost is non-increasing in S by
   * construction, so a rise here means the window logic is broken. */
  function ladder(prepared, costFn, thresholds) {
    var list = (thresholds || DEFAULT_THRESHOLDS).slice().sort(function (a, b) { return a - b; });
    var rows = [];

    list.forEach(function (S) {
      var result = minCostAtWindow(prepared, S, costFn);
      rows.push({ threshold: S, feasible: !!result, result: result });
    });

    var baseline = null;
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i].feasible) { baseline = rows[i].result.cost; break; }
    }

    var kept = [], lastCost = null;
    rows.forEach(function (row) {
      row.delta = row.feasible && baseline != null ? row.result.cost - baseline : null;
      if (!row.feasible) { kept.push(row); return; }
      row.dominated = lastCost != null && row.result.cost >= lastCost;
      if (!row.dominated) { kept.push(row); lastCost = row.result.cost; }
    });

    return { rows: kept, all: rows, baseline: baseline };
  }

  /* Default ranking: tightest spread first, cheapest within it second. */
  function tightestThenCheapest(prepared, costFn) {
    var tight = tightestWindow(prepared);
    if (!tight) return null;
    var result = minCostAtWindow(prepared, tight.spread, costFn);
    return result ? { spread: tight.spread, result: result } : null;
  }

  var api = {
    INF: INF,
    DEFAULT_THRESHOLDS: DEFAULT_THRESHOLDS,
    toMinutes: toMinutes,
    fmtClock: fmtClock,
    fmtGap: fmtGap,
    allInCost: allInCost,
    makeCostFn: makeCostFn,
    prepare: prepare,
    tightestWindow: tightestWindow,
    minCostAtWindow: minCostAtWindow,
    bestSubset: bestSubset,
    ladder: ladder,
    tightestThenCheapest: tightestThenCheapest
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FWF = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
