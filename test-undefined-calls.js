/* The Settings sheet opens for somebody who already has a saved group.
 *
 * settingsSheet() called groupNames() and nothing ever defined it. The call
 * sits behind hasGroup(), which is false until a search has saved a roster --
 * so a first run opens Settings perfectly and every run after that throws
 * "Can't find variable: groupNames" and shows nothing. The suite missed it
 * and so did a headless browser harness, because both start with empty
 * localStorage. It took a person on a phone with a real group to find.
 *
 * A general "every call target is defined" scan was tried here first and
 * removed: doing it properly needs a parser, and the regex version reported
 * forty false positives because an apostrophe inside a double-quoted string
 * swallows the rest of the file. A check that cries wolf is worse than none.
 *
 * So this is narrow and true: the functions the Settings sheet reaches on the
 * saved-group path all exist, and groupNames returns something printable for
 * the shapes loadGroup() can hand it.
 */
'use strict';
var fs = require('fs'), path = require('path');
var src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

var pass = 0, fail = 0;
function check(n, c, extra) {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (extra ? '\n          ' + extra : '')); }
}

console.log('the Settings sheet, on the saved-group path');

/* Every function the group branch of settingsSheet() touches. */
['groupNames', 'hasGroup', 'loadGroup', 'listOf', 'esc', 'forgetGroup'].forEach(function (fn) {
    check(fn + '() is defined',
        new RegExp('\\bfunction\\s+' + fn + '\\s*\\(').test(src),
        'settingsSheet() calls it behind hasGroup(), so it only throws once a '
        + 'group has been saved -- never on a first run.');
});

/* And it has to produce something, for every shape loadGroup() returns:
   two or three named parties, an unnamed card, more people than fit. */
var m = /\bfunction\s+listOf\s*\([\s\S]*?\n\}/.exec(src);
var g = /\bfunction\s+groupNames\s*\([\s\S]*?\n\}/.exec(src);
check('both functions can be lifted out of the shipped file', !!m && !!g);
if (m && g) {
    var groupNames = new Function(m[0] + '\n' + g[0] + '\nreturn groupNames;')();
    var cases = [
        [[{ name: 'Ben' }, { name: 'Fay' }], 'Ben and Fay'],
        [[{ name: 'Ben' }, { name: 'Fay' }, { name: 'Gus' }], 'Ben, Fay and Gus'],
        [[{ name: 'Ben' }, { name: '' }, { name: 'Gus' }], '3 people'],
        [[{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }], '4 people'],
        [[], 'this group']
    ];
    cases.forEach(function (c) {
        var got = groupNames(c[0]);
        check('groupNames(' + JSON.stringify(c[0].map(function (x) { return x.name; })) + ') = "'
            + c[1] + '"', got === c[1], 'got "' + got + '"');
    });
    check('never returns empty, whatever it is handed',
        [null, undefined, [{}], [{ name: null }]].every(function (bad) {
            return String(groupNames(bad) || '').length > 0;
        }));
}

console.log('');
if (fail) { console.log('FAILED ' + fail + ' of ' + (pass + fail)); process.exit(1); }
console.log('ALL ' + pass + ' CHECKS PASSED');
