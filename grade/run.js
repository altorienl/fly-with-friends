var F = require('./fixtures.js');
var R = require('./report.js');

var which = process.argv[2];
['F1', 'F2', 'F3', 'F4'].forEach(function (k) {
  if (which && which !== k) return;
  R.grade(F[k], null);
});
