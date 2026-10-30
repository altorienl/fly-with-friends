#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generates airports-extra.js from the OurAirports dataset.

The hand-curated table in airports.js covers the ~300 airports a group of
friends is most likely to use, with short familiar names ("Sky Harbor", not
"Phoenix Sky Harbor International Airport") and the metro groupings. It was
never meant to be exhaustive -- and then somebody stood next to CEN, typed CEN,
and was told no such airport exists. For a GROUP app that is fatal rather than
annoying: one person who cannot enter their city cannot be on the trip.

So the curated list stays exactly as it is, and everything else with scheduled
commercial service is appended from a public-domain dataset. Curated entries win
on a code collision, which is what keeps the good names.

    python3 tools/make-airports.py [path/to/airports.csv]

Source: https://davidmegginson.github.io/ourairports-data/airports.csv
(OurAirports, public domain). Re-run when it is worth refreshing; the output is
committed so the app has no build step.
"""
import csv, io, os, re, sys, subprocess, urllib.request

URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv'
URL_C = 'https://davidmegginson.github.io/ourairports-data/countries.csv'
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# Scheduled passenger service only. A seaplane base or a heliport with a code is
# a real place, but it is not somewhere this app can price a flight from, and an
# airport that returns nothing is a worse answer than one that is not offered.
KEEP = {'large_airport', 'medium_airport', 'small_airport'}


def clean(name):
    n = re.sub(r'\s+', ' ', name.strip())
    n = re.sub(r'\bInternational\b', 'Intl', n)
    n = re.sub(r'\s*(Airport|Airfield|Aerodrome)$', '', n)
    return n.strip() or name.strip()


def curated_countries():
    src = io.open(os.path.join(ROOT, 'airports.js'), encoding='utf-8').read()
    body = src[:src.index('var LIST = A.map')]
    # Not anchored on a closing bracket: the CLOSED rows carry a note and a
    # list of alternates after the country, and leaving them out meant Ukraine
    # had no name behind it and four airports could not say where they were.
    return set(re.findall(r"\['[A-Z]{3}','[^']*','[^']*','([A-Z]{2})'", body))


def curated_codes():
    """Every code airports.js already defines, so the generator never shadows a
    hand-written name. Read out of the file rather than maintained twice."""
    src = io.open(os.path.join(ROOT, 'airports.js'), encoding='utf-8').read()
    body = src[:src.index('var LIST = A.map')]
    return set(re.findall(r"\['([A-Z]{3})',", body))


def main(path=None, cpath=None):
    if path:
        raw = io.open(path, encoding='utf-8').read()
    else:
        sys.stderr.write('fetching %s\n' % URL)
        raw = urllib.request.urlopen(URL, timeout=120).read().decode('utf-8')
    if cpath:
        craw = io.open(cpath, encoding='utf-8').read()
    else:
        sys.stderr.write('fetching %s\n' % URL_C)
        craw = urllib.request.urlopen(URL_C, timeout=120).read().decode('utf-8')
    countries = {r['code'].strip(): r['name'].strip()
                 for r in csv.DictReader(io.StringIO(craw)) if r['code'].strip()}

    have = curated_codes()
    sys.stderr.write('curated codes: %d\n' % len(have))

    seen, out, regions = set(), [], {}
    for r in csv.DictReader(io.StringIO(raw)):
        code = r['iata_code'].strip().upper()
        if (r['scheduled_service'] != 'yes' or r['type'] not in KEEP
                or not re.fullmatch(r'[A-Z]{3}', code)
                or not r['municipality'].strip()
                or code in have or code in seen):
            continue
        seen.add(code)
        out.append((code, r['municipality'].strip(), clean(r['name']), r['iso_country'].strip()))
        iso = r['iso_region'].strip()
        if iso[:3] in ('US-', 'CA-'):
            regions[code] = iso.split('-', 1)[1]

    out.sort()
    q = lambda s: "'" + s.replace('\\', '\\\\').replace("'", "\\'") + "'"
    lines, row = [], []
    for e in out:
        row.append('[' + ','.join(q(x) for x in e) + ']')
        if len(row) == 3:
            lines.append('    ' + ','.join(row) + ',')
            row = []
    if row:
        lines.append('    ' + ','.join(row) + ',')

    reg = ['    ' + ' '.join('%s:%s,' % (c, q(regions[c])) for c in chunk)
           for chunk in [sorted(regions)[i:i + 6] for i in range(0, len(regions), 6)]]

    # Only the countries something in the merged table actually sits in. The
    # curated rows are included because they need naming too -- "London" is in
    # this app twice now, once in England and once in Ontario.
    used = sorted({e[3] for e in out} | curated_countries())
    cn = ['    ' + ' '.join('%s:%s,' % (c, q(countries.get(c, c))) for c in chunk)
          for chunk in [used[i:i + 4] for i in range(0, len(used), 4)]]

    body = HEADER % (len(out), len(regions)) + '\n'.join(lines) \
        + '\n  ];\n\n  var R = {\n' + '\n'.join(reg) + '\n  };\n' \
        + '\n  /* Country names, for every country the merged table reaches. */\n' \
        + '  var C = {\n' + '\n'.join(cn) + '\n  };\n' + FOOTER
    dest = os.path.join(ROOT, 'airports-extra.js')
    io.open(dest, 'w', encoding='utf-8').write(body)
    sys.stderr.write('wrote %s: %d airports, %d with a state or province\n'
                     % (dest, len(out), len(regions)))


HEADER = '''/* GENERATED by tools/make-airports.py -- do not hand-edit.
 *
 * Every airport with scheduled passenger service and an IATA code that the
 * curated table in airports.js does not already name. %d of them, %d with a
 * US state or Canadian province.
 *
 * The curated list covers the airports a group of friends is most likely to
 * use, with short familiar names and the metro groupings, and it wins on any
 * code collision -- so PHX stays "Sky Harbor" rather than becoming "Phoenix Sky
 * Harbor Intl". This file is the long tail, and it exists because the curated
 * list alone told somebody standing next to CEN that there is no such airport.
 *
 * Source: OurAirports (public domain).
 */
(function (root) {
  'use strict';

  var A = [
'''

FOOTER = '''
  var api = { AIRPORTS_EXTRA: A, REGIONS_EXTRA: R, COUNTRY_NAMES: C };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.FWF_AIRPORTS_EXTRA = A; root.FWF_REGIONS_EXTRA = R;
         root.FWF_COUNTRY_NAMES = C; }
})(typeof globalThis !== 'undefined' ? globalThis : this);
'''

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else None,
         sys.argv[2] if len(sys.argv) > 2 else None)
