/* A local stand-in for the deployed Worker, so the searching screen can be
 * driven and photographed without spending the month's allowance.
 *
 * The Worker's OWN code runs here, unmodified -- this file only supplies the
 * three things Cloudflare would: a KV namespace, an execution context, and a
 * SerpApi that answers. Per-leg latency is scripted so the waves a real
 * eight-person round trip produces can be reproduced on demand, and
 * ?scenario= forces the failure and partial states.
 *
 * Not part of the app and not deployed. Run: node worker/mock-server.mjs 8731
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const port = Number(process.argv[2] || 8731);

/* ----------------------------------------------------------- fake SerpApi */

let scenario = 'normal';
let billed = 0;
const realFetch = globalThis.fetch;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Measured against the live deployment on 2026-11-01: three cold legs in
 * parallel came back in 7.57s once and 2.60s once, so per-leg latency is wide
 * and heavy-tailed rather than tight. These stand-in delays reproduce that
 * spread deterministically. */
const LEG_MS = [900, 1600, 2400, 3300, 4200, 5100, 6000, 6900,
                1200, 2000, 2800, 3600, 4400, 5200, 6100, 7000];
let legN = 0;

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/account.json')) {
    return { json: async () => ({ this_month_usage: billed, total_searches_left: 950 - billed,
                                  searches_per_month: 1000, account_rate_limit_per_hour: 200,
                                  this_hour_searches: billed }) };
  }
  if (u.includes('serpapi.com/search.json')) {
    const i = legN++;
    await sleep(LEG_MS[i % LEG_MS.length]);
    const from = new URL(u).searchParams.get('departure_id').split(',')[0];
    const to = new URL(u).searchParams.get('arrival_id').split(',')[0];

    if (scenario === 'fail') throw new Error('upstream exploded');
    /* One traveler's leg cannot be searched, another's route has no service.
     * Both are real, both already have shapes in the payload, and neither
     * stops the other six legs from landing. */
    if (scenario === 'partial' && i === 2) throw new Error('upstream refused this leg');
    if (scenario === 'partial' && i === 4) {
      return { json: async () => ({ best_flights: [], other_flights: [] }) };
    }

    billed++;
    const mk = (n, price) => ({
      price, total_duration: 240 + n * 35,
      flights: [{ airline: ['United', 'Delta', 'Alaska', 'JetBlue'][n % 4],
                  flight_number: 'XX ' + (100 + n),
                  departure_airport: { id: from, time: '2027-03-17 0' + (6 + n) + ':15' },
                  arrival_airport: { id: to, time: '2027-03-17 1' + (2 + n) + ':40' },
                  extensions: [] }],
      extensions: ['1 free checked bag'],
    });
    return { json: async () => ({
      best_flights: [mk(0, 318), mk(1, 402)],
      other_flights: [mk(2, 455), mk(3, 511)],
    }) };
  }
  if (realFetch) return realFetch(url);
  throw new Error('unexpected fetch: ' + u);
};

/* -------------------------------------------------------------- fake KV */

const store = new Map();
const env = {
  FWF: {
    async get(k, opt) {
      const v = store.get(k);
      if (v === undefined) return null;
      const wantsJson = opt === 'json' || (opt && opt.type === 'json');
      return wantsJson ? JSON.parse(v) : v;
    },
    async put(k, v) { store.set(k, v); },
  },
  SERPAPI_KEY: 'mock',
  /* Left unset so originOk is permissive: the screen is served from
   * localhost on whatever port is free. */
  ALLOWED_ORIGINS: '',
};

const worker = (await import('./worker.js')).default;

/* ------------------------------------------------------------- the server */

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
                '.txt': 'text/plain', '.webmanifest': 'application/manifest+json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  /* Scenario is a server-side switch rather than a query string on /search,
   * so the app's own request body stays exactly what it would send in
   * production. */
  if (url.pathname === '/scenario') {
    scenario = url.searchParams.get('s') || 'normal';
    legN = 0;
    if (url.searchParams.get('clear') === '1') store.clear();
    /* Pre-spend the month so the budget gate refuses. The point is to prove
     * that a refusal comes back as a 429 with a JSON body even when the
     * caller asked for a stream. */
    const spent = url.searchParams.get('spent');
    if (spent) store.set('budget:' + new Date().toISOString().slice(0, 7), spent);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('scenario=' + scenario + ' cache=' + store.size);
  }

  if (url.pathname === '/search' || url.pathname === '/budget'
      || url.pathname === '/trip' || url.pathname.startsWith('/trip/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    headers.set('CF-Connecting-IP', '203.0.113.' + (1 + (Date.now() % 200)));
    const request = new Request('http://api.local' + req.url, {
      method: req.method, headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    const out = await worker.fetch(request, env, ctx);
    const h = {};
    out.headers.forEach((v, k) => { h[k] = v; });
    res.writeHead(out.status, h);
    if (!out.body) return res.end();
    const reader = out.body.getReader();
    let frames = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
      frames++;
      /* The dropped connection. Two legs land, then the socket dies without
       * a `done` event -- what a phone changing cells actually does to a
       * response that is still open. */
      if (scenario === 'cut' && frames >= 2) { res.destroy(); return; }
    }
    return res.end();
  }

  /* Everything else is the static app. */
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(root, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  let out = fs.readFileSync(file);
  /* app.js wraps itself in an IIFE under 'use strict', so nothing it declares
   * is reachable from a driver -- including the one constant that has to
   * change, which is where the worker lives. One exact substitution, on the
   * way out of this file only, so the copy on disk stays the shipped copy. */
  if (path.basename(file) === 'app.js') {
    const src = out.toString('utf8');
    const want = "var API = 'https://fly-with-friends-api.altorien.workers.dev';";
    if (!src.includes(want)) { res.writeHead(500); return res.end('API line not found in app.js'); }
    out = Buffer.from(src.replace(want, 'var API = location.origin;'), 'utf8');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
                       'Cache-Control': 'no-store' });
  res.end(out);
}).listen(port, () => console.log('mock worker + app on http://127.0.0.1:' + port));
