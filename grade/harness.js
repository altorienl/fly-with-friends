/* Grading harness: runs the REAL app.js decision pipeline under node.
 *
 * app.js is an IIFE with no globals, so the whole body is stripped of its
 * wrapper and run in a vm context against a DOM stub. That way the thing under
 * test is the same compute() / tripLadder() / tripBest() / legBreakdown() the
 * results screen calls, not a reimplementation of them.
 *
 * No network: fetch() returns a promise that never settles, so the /budget poll
 * and /search are both inert. Nothing here can spend search quota.
 */
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');

function stubEl(id) {
  var e = {
    id: id, innerHTML: '', textContent: '', value: '', checked: false,
    dataset: {}, style: {}, children: [], className: '',
    classList: { add: function () {}, remove: function () {}, toggle: function () {},
                 contains: function () { return false; } },
    addEventListener: function () {}, removeEventListener: function () {},
    setAttribute: function (k, v) { e['attr_' + k] = v; },
    getAttribute: function (k) { return e['attr_' + k]; },
    removeAttribute: function () {}, appendChild: function () {}, insertBefore: function () {},
    querySelector: function (s) { return stubEl(id + s); }, querySelectorAll: function () { return []; },
    closest: function () { return null; }, focus: function () {}, blur: function () {},
    click: function () {}, scrollIntoView: function () {},
    getBoundingClientRect: function () { return { top: 0, left: 0, width: 0, height: 0 }; },
    contains: function () { return false; }, remove: function () {}
  };
  return e;
}

function makeContext() {
  var els = {};
  var doc = {
    getElementById: function (id) { return els[id] || (els[id] = stubEl(id)); },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    createElement: function (t) { return stubEl('new-' + t); },
    addEventListener: function () {},
    documentElement: stubEl('html'), body: stubEl('body'), head: stubEl('head'), title: ''
  };
  var store = {};
  var ctx = {
    console: console, document: doc, __els: els,
    navigator: { userAgent: 'node', standalone: false, share: null, clipboard: null },
    location: { search: '', hash: '', href: 'http://localhost/', pathname: '/', origin: 'http://localhost' },
    history: { replaceState: function () {}, pushState: function () {} },
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; }
    },
    matchMedia: function () { return { matches: false, addEventListener: function () {}, addListener: function () {} }; },
    fetch: function () { return new Promise(function () {}); },
    setTimeout: function () { return 0; }, clearTimeout: function () {},
    setInterval: function () { return 0; }, clearInterval: function () {},
    requestAnimationFrame: function () { return 0; },
    scrollTo: function () {}, scrollBy: function () {}, addEventListener: function () {},
    removeEventListener: function () {}, alert: function () {}, open: function () { return null; },
    getComputedStyle: function () { return { getPropertyValue: function () { return ''; } }; },
    btoa: function (s) { return Buffer.from(s, 'binary').toString('base64'); },
    atob: function (s) { return Buffer.from(s, 'base64').toString('binary'); },
    encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
    Promise: Promise, Intl: Intl, URL: URL
  };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'optimizer.js'), 'utf8'), ctx, { filename: 'optimizer.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'airports.js'), 'utf8'), ctx, { filename: 'airports.js' });

  var src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  var HEAD = "(function () {\n'use strict';";
  var open = src.indexOf(HEAD);
  if (open < 0) throw new Error('could not find app.js IIFE head');
  var body = src.slice(open + HEAD.length);
  var close = body.lastIndexOf('})();');
  if (close < 0) throw new Error('could not find app.js IIFE tail');
  vm.runInContext(body.slice(0, close), ctx, { filename: 'app.js' });
  return ctx;
}

/* fx = { dest, dep, ret, parties:[{id,name,seats,airports,rules}],
 *        legs:{ outbound:{id:[opt]}, return:{id:[opt]} }, q:{}, set:{} } */
function run(ctx, fx) {
  ctx.SET = ctx.loadSet();
  if (fx.set) Object.keys(fx.set).forEach(function (k) { ctx.SET[k] = fx.set[k]; });
  var q = ctx.blankQuery();
  q.dest = fx.dest; q.dep = fx.dep; q.ret = fx.ret || '';
  q.parties = fx.parties.map(function (p) {
    return { id: p.id, name: p.name, seats: p.seats || 1,
             airports: p.airports.slice(), rules: p.rules || {} };
  });
  if (fx.q) Object.keys(fx.q).forEach(function (k) { q[k] = fx.q[k]; });
  ctx.state.q = q;
  ctx.state.leg = 'outbound';
  ctx.state.recommend = fx.recommend || 'value';
  ctx.thReset();
  ctx.DATA = { generated_at: 'fixture', currency: 'USD', sample: true,
               trips: { query: { outbound: fx.legs.outbound, 'return': fx.legs['return'] || {} } },
               errors: [] };
  ctx.looseTh = {};
  ctx.C = ctx.compute();
  var ladder = ctx.tripLadder();
  var best = ladder ? ctx.tripBest(ladder) : null;
  if (best) ctx.state.th.outbound = best.th;   /* what clicking "Best option" does */
  var out = ctx.legBreakdown('outbound');
  var back = fx.ret ? ctx.legBreakdown('return') : null;
  return { ctx: ctx, ladder: ladder, best: best, out: out, back: back,
           trip: ctx.tripTotal(),
           reason: (best && ladder) ? ctx.pickReason(best, ladder) : null };
}

module.exports = { makeContext: makeContext, run: run, ROOT: ROOT };
