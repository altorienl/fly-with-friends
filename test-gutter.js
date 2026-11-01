/* The page gutter, and the one rule that cancels it.
 *
 * .res-head is a sticky header inside an inset page, and it bleeds its own
 * background out to the screen edges with a negative margin that is supposed
 * to cancel .container's padding exactly. For a while it did not: the 420px
 * breakpoint moved .container to a 16px gutter and left .res-head negating
 * 20px, so every phone narrower than 420 rendered the header 8px wider than
 * its container -- 4px past each edge -- and the whole page scrolled
 * sideways. Measured in Chrome at a 390 viewport before the fix:
 * documentElement.scrollWidth 394 against clientWidth 390, with res-head the
 * only element whose right edge exceeded the viewport.
 *
 * Two correct expressions that merely had to match is the failure mode, so
 * the fix is that there is now one expression -- --pad-l / --pad-r -- and
 * both sides reference it. These checks assert that property, because the
 * runtime symptom only shows up in a real browser and this suite has no DOM.
 * What can be checked here is the invariant the browser result follows from:
 * nothing in the gutter chain may hard-code a length, and the bleed must be
 * the arithmetic negation of the inset it cancels. */
var fs = require('fs'), path = require('path');
var css = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

var pass = 0, fail = 0;
function ck(n, c) { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); } }

/* The body of one rule, by selector, from the single inline stylesheet. */
function rule(sel) {
    var re = new RegExp('(^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
    var m = re.exec(css);
    return m ? m[2].replace(/\s+/g, ' ').trim() : null;
}

console.log('\n-- the gutter is one declaration --');
/* The :root block that contains --gut, found by walking back to the opening
 * brace rather than forward from a token inside it -- searching forward from
 * --r-sm lands on the NEXT :root, which is a different block. */
var gutAt = css.indexOf('--gut:');
var root = css.slice(css.lastIndexOf(':root {', gutAt));
root = root.slice(0, root.indexOf('\n}'));
ck('--gut is defined once, as a bare length', /--gut:\s*\d+px/.test(root));
ck('--pad-l carries the whole inset expression',
   /--pad-l:\s*max\(var\(--gut\),\s*env\(safe-area-inset-left\)\)/.test(root));
ck('--pad-r carries the whole inset expression',
   /--pad-r:\s*max\(var\(--gut\),\s*env\(safe-area-inset-right\)\)/.test(root));

/* The narrow override may move the gutter, but only by moving --gut: if it
 * ever sets a padding or a margin directly, the two sides are two numbers
 * again and this is exactly the bug coming back. */
console.log('\n-- the narrow breakpoint moves the token, not the rules --');
var narrow = /@media \(max-width: 420px\) \{([^]*?)\n\}/.exec(css);
ck('a max-width: 420px block still exists', !!narrow);
if (narrow) {
    var body = narrow[1];
    ck('...and it only reassigns --gut', /--gut:\s*\d+px/.test(body));
    ck('...and sets no padding of its own', !/padding/.test(body));
    ck('...and sets no margin of its own', !/margin/.test(body));
}

console.log('\n-- .container and .res-head cancel by construction --');
var container = rule('.container'), head = rule('.res-head');
ck('.container still exists', !!container);
ck('.res-head still exists', !!head);
ck('.container takes its side padding from the tokens',
   /var\(--pad-r\)/.test(container) && /var\(--pad-l\)/.test(container));
ck('.res-head pads with the same two tokens',
   /padding-left:\s*var\(--pad-l\)/.test(head) && /padding-right:\s*var\(--pad-r\)/.test(head));
ck('.res-head bleeds by negating the left token exactly',
   /margin-left:\s*calc\(var\(--pad-l\)\s*\*\s*-1\)/.test(head));
ck('.res-head bleeds by negating the right token exactly',
   /margin-right:\s*calc\(var\(--pad-r\)\s*\*\s*-1\)/.test(head));

/* The original defect was a literal px in one of the two places. Any literal
 * in either rule's horizontal chain can reintroduce it, so none are allowed. */
ck('.container hard-codes no horizontal length',
   !/padding[^;]*\b(?!0)\d+px[^;]*;/.test(container.replace(/calc\(var\(--s7\)[^;]*;/, '')));
ck('.res-head hard-codes no horizontal inset',
   !/margin-(left|right):\s*-?\d+px/.test(head) && !/padding-(left|right):\s*\d+px/.test(head));

console.log('\n-- the masthead shares the page edge --');
var brand = rule('.brand');
ck('.brand reads the same two tokens rather than its own max()',
   /var\(--pad-r\)/.test(brand) && /var\(--pad-l\)/.test(brand));
ck('.brand hard-codes no side gutter', !/max\(\s*\d+px,\s*env\(safe-area-inset-(left|right)\)/.test(brand));

/* Nobody may reconstruct the expression at a call site: an inlined
 * max(var(--gut), env(...)) is a second authority wearing the token's name,
 * which is the shape the bug had. --pad-l / --pad-r are the only legal way in. */
console.log('\n-- no call site rebuilds the inset by hand --');
var style = css.slice(css.indexOf('<style>'), css.indexOf('</style>'));
/* Comments out first: the note on --gut names the anti-pattern in prose, and
 * a check that cannot tell a rule from the comment warning about it is not a
 * check. */
var decls = style.replace(/\/\*[^]*?\*\//g, '');
var inlined = decls.split('\n').filter(function (l) {
    return /max\(var\(--gut\)/.test(l) && !/--pad-[lr]:/.test(l);
});
if (inlined.length) console.log('      offenders: ' + inlined.join(' | '));
ck('max(var(--gut), env(...)) appears only in the token definitions', inlined.length === 0);

/* ---------------------------------------- every token has to exist
 *
 * A custom property that is never declared is invalid at computed-value
 * time, and the declaration is simply dropped -- so `font-size: var(--t-0)`
 * does not fall back to a sensible size, it falls back to INHERITED. That
 * failure is silent, survives every suite, and renders as text at the wrong
 * size that looks deliberate.
 *
 * It has now happened three times, in three different branches, all with
 * --t-0 on a ramp whose smallest rung is --t-1: twice in the recents list
 * and once on the booking note, where a caption rendered at 15px, the same
 * size as the button it was explaining. Each was found by eye. This finds
 * the next one.
 *
 * A var() WITH a fallback is fine and deliberate -- several tokens are set
 * from JS at runtime and carry a fallback for the first paint -- so only an
 * undeclared name used with no fallback is a failure. */
(function () {
    var declared = {};
    (css.match(/(--[a-zA-Z0-9-]+)\s*:/g) || []).forEach(function (m) {
        declared[m.replace(/\s*:$/, '')] = 1;
    });
    /* var(--name) with nothing after the name: no comma, so no fallback. */
    var bare = {};
    (css.match(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g) || []).forEach(function (m) {
        bare[m.replace(/var\(\s*/, '').replace(/\s*\)$/, '')] = 1;
    });
    var missing = Object.keys(bare).filter(function (n) { return !declared[n]; });
    ck('every token used without a fallback is declared somewhere: '
       + (missing.length ? missing.join(' ') : 'all of them'), missing.length === 0);

    /* The specific name that has caused all three, pinned so a future ramp
     * edit cannot quietly reintroduce the gap at the bottom. */
    ck('the type ramp starts at --t-1 and nothing asks for --t-0',
       !/var\(\s*--t-0\s*[),]/.test(css));
}());

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail)
                         : 'ALL ' + pass + ' CHECKS PASSED'));
process.exitCode = fail ? 1 : 0;
