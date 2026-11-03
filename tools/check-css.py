#!/usr/bin/env python3
"""Balanced braces in every <style> block of index.html.

An unmatched } does not fail loudly. The CSS parser recovers by discarding
the NEXT rule, so the damage lands somewhere other than the typo and looks
like a completely different bug.

One stray brace, left behind when a @media block was deleted badly, took out
`.brand-left { position: relative }`. That moved an absolutely positioned
button from a 122px box to the full width of the masthead, where it swallowed
every click on the settings gear and painted its pressed background across
the whole header. Three rounds of fixes went out chasing those two symptoms
-- the Dynamic Island, a stranded inert attribute, a z-index -- before anyone
counted the braces.

Run from the repo root. Exits non-zero if any block is unbalanced.
"""
import io
import re
import sys

src = io.open('index.html', encoding='utf-8').read()
blocks = re.findall(r'<style>([\s\S]*?)</style>', src)
if not blocks:
    print('  no <style> block found -- has index.html moved?')
    sys.exit(1)

bad = 0
for i, blk in enumerate(blocks):
    # Comments and quoted strings can hold braces that are not structure.
    c = re.sub(r'/\*[\s\S]*?\*/', '', blk)
    c = re.sub(r'"[^"]*"', '', c)
    c = re.sub(r"'[^']*'", '', c)
    opens, closes = c.count('{'), c.count('}')
    if opens != closes:
        print('  style block %d UNBALANCED: %d open, %d close' % (i, opens, closes))
        # Point at the line where the depth first goes negative; that is where
        # a surplus } is, and it is the rule after it that will be lost.
        depth = 0
        for n, line in enumerate(c.split('\n'), 1):
            depth += line.count('{') - line.count('}')
            if depth < 0:
                print('    first surplus } at style-block line %d: %s'
                      % (n, line.strip()[:70]))
                break
        bad = 1
    else:
        print('  style block %d balanced (%d rules)' % (i, opens))

sys.exit(bad)
