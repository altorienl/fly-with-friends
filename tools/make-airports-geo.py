#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generates airports-geo.js -- a latitude and longitude for every code in the
merged airports.js table.

airports.js knows what an airport is CALLED and nothing about where it is. The
map cannot be drawn from names, and a map drawn from invented positions is the
one thing this app does not ship: every number on a card is a real number, and
a decorative map would be the only lie on the screen.

So the geometry comes from the same public-domain dataset the airport names
already come from, and it is GENERATED rather than hand-kept, for the same
reason airports-extra.js is -- 3,951 coordinates nobody can proofread are
3,951 chances for one of them to be quietly wrong, and the only honest answer
to that is a script somebody can re-run.

    python3 tools/make-airports-geo.py [path/to/airports.csv]

Source: https://davidmegginson.github.io/ourairports-data/airports.csv
(OurAirports, public domain -- no attribution required, given anyway).
Re-run when it is worth refreshing; the output is committed so the app has no
build step. Re-running after a refresh of airports-extra.js is not optional:
a code in the table with no coordinate is a traveler who cannot be drawn.
"""
import csv, datetime, gzip, io, os, re, subprocess, sys, urllib.request

URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv'
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEST = os.path.join(ROOT, 'airports-geo.js')

# Two decimal places. 0.01 degrees of latitude is 1.11km, and 1.11km or less of
# longitude everywhere, so a position is within about 1.6km of true at worst.
#
# That sounds slack and is not, because the map is 300px across and is fitted
# to the airports in play rather than to the world. The tightest fit this app
# can produce is a group who all live in one region -- LAX and SAN converging
# on SFO is about 600km of span -- which is 2km a pixel, so the rounding is
# under a pixel. On any trip that crosses an ocean it is a thousandth of one.
#
# Three decimals costs 6KB gzipped to buy precision 20x finer than the finest
# pixel this will ever be drawn at. One decimal is 11km, which at that same
# 600km fit is five pixels -- an airport visibly off its city -- and it is not
# even a saving, because the packed form below at two decimals is smaller than
# a readable table at one.
DP = 2
LAT_SPAN = 180 * 10 ** DP + 1         # 18001 distinct latitudes
LON_SPAN = 360 * 10 ** DP + 1         # 36001 distinct longitudes

# Base 62, so a (latitude, longitude) pair fits in five characters:
# 18001 x 36001 = 648,054,001 states, and 62^5 = 916,132,832 holds it.
# Digits first so the alphabet is the obvious one and the decoder on the other
# side can be read without a table.
A62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
STRIDE = 8                            # 3 characters of code + 5 of position
PER_LINE = 10                         # records per source line, for diffs

# Codes the dataset no longer files under their own iata_code.
#
# Each of these is a real airport that is still in airports.js under the code
# this app has always used, and that OurAirports has since relabeled. It has
# NOT dropped them: the retired code stays in the row's `keywords` column,
# which is exactly how that dataset records a reassignment, so the position is
# recoverable from the same source rather than typed in from somewhere else.
#
# The expected ident is pinned here so the recovery cannot drift silently. If
# a keyword search stops landing on the row named below, this script stops --
# an unpinned keyword match is a guess, and a guess is how a map gets a wrong
# city in it.
RELABELLED = {
    'KIV': ('LUKK', 'Chisinau Intl, now filed under RMO; "KIV" kept in keywords'),
    'PBI': ('KPBI', 'Palm Beach Intl, now filed under DJT after the rename; '
                    '"PBI, KPBI" kept in keywords'),
    # REP is the one that is not merely a relabeling. The airport that holds
    # the code closed on 15 October 2023 and Siem Reap is served by SAI, 45km
    # east, which airports.js also lists. This file answers "where is the
    # airport with this code", so REP is placed at the field that bears the
    # code, and SAI at the one flights actually use. They are 45km apart, which
    # is a quarter of a pixel on any fit wider than the province, so the map is
    # the same either way -- but somebody deciding what to do about REP in
    # airports.js should find the fact here rather than discover it at a gate.
    # Pinned on KH-0003 rather than VDSR because OurAirports retires the ICAO
    # ident along with the airport and files a closed field under a country
    # placeholder. That is a less stable handle than the other two, which is
    # precisely why it is pinned: if it moves, this stops rather than picking
    # up whatever else the keyword lands on.
    'REP': ('KH-0003', 'old Siem Reap Intl, closed 15 Oct 2023, type now '
                       '"closed" and ident retired; "REP, VDSR" kept in keywords'),
}


def wanted_codes():
    """Every code the merged table defines, read out of the module itself.

    Not regexed out of the source the way make-airports.py has to do it --
    that script generates a file airports.js loads, so it cannot load
    airports.js. This one has no such problem, and asking the module is the
    only way to be sure the answer includes the long tail in airports-extra.js
    and the closed rows, both of which arrive after the literal array."""
    out = subprocess.check_output(
        ['node', '-p',
         "require('./airports.js').LIST.map(function(a){return a.code;}).join('\\n')"],
        cwd=ROOT)
    codes = sorted(set(out.decode('utf-8').split()))
    bad = [c for c in codes if not re.fullmatch(r'[A-Z]{3}', c)]
    if bad:
        sys.exit('airports.js has codes this packing cannot hold: %s' % bad)
    return codes


def pack(n, width):
    s = ''
    for _ in range(width):
        s = A62[n % 62] + s
        n //= 62
    assert n == 0, 'overflowed %d characters' % width
    return s


def main(path=None):
    if path:
        raw = io.open(path, encoding='utf-8').read()
        when = datetime.date.fromtimestamp(os.path.getmtime(path))
    else:
        sys.stderr.write('fetching %s\n' % URL)
        raw = urllib.request.urlopen(URL, timeout=180).read().decode('utf-8')
        when = datetime.date.today()

    want = wanted_codes()
    sys.stderr.write('codes in airports.js: %d\n' % len(want))

    rows = list(csv.DictReader(io.StringIO(raw)))
    sys.stderr.write('rows in dataset: %d\n' % len(rows))

    # Pass one: the code is the dataset's own iata_code.
    pos, src = {}, {}
    for r in rows:
        c = r['iata_code'].strip().upper()
        if c in pos or c not in set(want):
            continue
        try:
            pos[c] = (float(r['latitude_deg']), float(r['longitude_deg']))
        except ValueError:
            continue
        src[c] = r['ident']

    # Pass two: the stragglers, recovered through keywords and pinned above.
    for c in sorted(set(want) - set(pos)):
        if c not in RELABELLED:
            continue
        ident, why = RELABELLED[c]
        hit = [r for r in rows
               if c in {k.strip().upper() for k in r['keywords'].split(',')}]
        if len(hit) != 1:
            sys.exit('%s: wanted exactly one row with it in keywords, found %d'
                     % (c, len(hit)))
        if hit[0]['ident'] != ident:
            sys.exit('%s: keywords now point at %s, not the pinned %s (%s)'
                     % (c, hit[0]['ident'], ident, why))
        pos[c] = (float(hit[0]['latitude_deg']), float(hit[0]['longitude_deg']))
        src[c] = ident
        sys.stderr.write('  recovered %s from %s -- %s\n' % (c, ident, why))

    missing = sorted(set(want) - set(pos))
    if missing:
        sys.exit('no coordinate for %d codes, and no pinned recovery for them: %s'
                 % (len(missing), missing))

    # Quantize, and refuse the two shapes of corruption that are invisible once
    # they are in the blob: out of range, and null island. (0, 0) is in the
    # Atlantic off Ghana and is what a dataset prints when it means "unknown";
    # an airport drawn there is a bug that looks like a destination.
    recs = []
    for c in want:
        lat, lon = pos[c]
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            sys.exit('%s is off the planet: %r' % (c, (lat, lon)))
        la = int(round(lat * 10 ** DP))
        lo = int(round(lon * 10 ** DP))
        if la == 0 and lo == 0:
            sys.exit('%s rounds to null island, which no airport is' % c)
        recs.append(c + pack((la + 9000) * LON_SPAN + (lo + 18000), 5))

    body = ''.join(recs)
    lines = ["'%s'" % body[i:i + STRIDE * PER_LINE]
             for i in range(0, len(body), STRIDE * PER_LINE)]
    out = (HEADER % (len(recs), when.isoformat(), DP, len(recs), STRIDE,
                     len(recs) * STRIDE)
           + '  var P =\n    ' + ' +\n    '.join(lines) + ';\n'
           + FOOTER % len(recs))
    io.open(DEST, 'w', encoding='utf-8').write(out)

    nraw = len(out.encode('utf-8'))
    ngz = len(gzip.compress(out.encode('utf-8'), 9))
    sys.stderr.write('wrote %s: %d airports, %d bytes raw, %d gzipped\n'
                     % (DEST, len(recs), nraw, ngz))


HEADER = '''/* GENERATED by tools/make-airports-geo.py -- do not hand-edit.
 *
 * Where every airport in airports.js is: %d of them, one latitude and one
 * longitude each, and nothing else. airports.js says what an airport is
 * called; this says where it is, and the two are separate files because the
 * names are half hand-written and these are entirely machine-written.
 *
 * Source: OurAirports (public domain), snapshot of %s.
 * Regenerate with tools/make-airports-geo.py rather than editing: the script
 * records where the three relabeled codes came from and fails loudly if the
 * dataset stops agreeing with it.
 *
 * PRECISION: %d decimal places, so about 1.1km of latitude and no more of
 * longitude. The map is 300px wide and is fitted to the airports in play
 * rather than to the world, and the tightest fit a group can produce is
 * everyone living in one region -- LAX and SAN converging on SFO is about
 * 600km of span, or 2km a pixel. The rounding is under a pixel there and a
 * thousandth of one on anything that crosses an ocean.
 *
 * Three decimals costs 6KB gzipped for precision twenty times finer than the
 * finest pixel this will ever be drawn at. One decimal is 11km, which at that
 * same 600km fit is five pixels -- an airport visibly off its own city -- and
 * it is not even a saving: see below.
 *
 * ENCODING: one fixed-width string, %d records of %d characters, sorted by
 * code. Three characters of IATA code, then five of base 62 holding
 * (lat + 90) * 100 * 36001 + (lon + 180) * 100 -- 648,054,001 possible
 * positions in the 916,132,832 that five base-62 characters can hold.
 *
 * One string rather than an object literal for two reasons, and size is only
 * the first. The table packed is %d bytes, against 73,282 for the same
 * coordinates written out as {AAA:[-17.35,-145.51], ...}: 57%% off raw and
 * 31%% off gzipped, 31,608 against 73,282 and 22,977 against 33,409. It also
 * comes in under a readable table rounded all the way down to one decimal,
 * which gzips to 27,769 -- so there is no version of giving up precision that
 * pays for itself.
 *
 * Those are the table only, not this file, because a file cannot print its
 * own gzipped size without changing it. The script prints both totals for the
 * committed file every time it runs.
 *
 * The second reason is that a fixed stride is searchable in place. get()
 * binary searches the string itself, so nothing is parsed and nothing is
 * allocated at load, and a lookup is about twelve character comparisons --
 * measured at 0.26 microseconds, 790,000 lookups in 209ms. An object literal
 * of 3,951 keys has to be built on the main thread before the app can start.
 *
 * What that costs: nobody can read it. The audit is test-geo.js, which checks
 * that every code in airports.js resolves, that every position is on the
 * planet and none of them is null island, and that a handful of real airport
 * pairs come out at their published distance apart.
 */
(function (root) {
  'use strict';

'''

FOOTER = '''
  var A62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  var V = {};
  for (var i = 0; i < 62; i++) V[A62.charAt(i)] = i;

  var N = %d, STRIDE = 8;

  /* Binary search over the packed string. The records are fixed width and
   * sorted by code, so the string is its own index -- no map is built. */
  function get(code) {
    var c = String(code || '').toUpperCase();
    if (c.length !== 3) return null;
    var lo = 0, hi = N - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1, at = mid * STRIDE, k = P.slice(at, at + 3);
      if (k === c) {
        var n = 0;
        for (var j = at + 3; j < at + STRIDE; j++) n = n * 62 + V[P.charAt(j)];
        /* Integer math throughout: n tops out at 648,054,000, which is exact
         * in a double, so neither the divide nor the remainder can drift. */
        return { lat: (Math.floor(n / 36001) - 9000) / 100,
                 lon: (n %% 36001 - 18000) / 100 };
      }
      if (k < c) lo = mid + 1; else hi = mid - 1;
    }
    return null;
  }

  function isKnown(code) { return !!get(code); }

  /* Fresh object every call, deliberately. These are handed to drawing code
   * that has every reason to want to mutate a point, and one shared record
   * quietly rewritten is a bug that only shows up on the second render. */
  var api = { get: get, isKnown: isKnown, COUNT: N, PRECISION_DEG: 0.01 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AIRPORTS_GEO = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
'''

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else None)
