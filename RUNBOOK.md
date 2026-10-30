# Runbook

What to do when something breaks, and what this costs to keep alive. Written to
be read by somebody who did not build it, including a later version of the
person who did.

## Does any of this need an AI service?

No. Nothing in the product calls a model, at build time or at run time. The only
mention of one anywhere in the repo is a `.gitignore` line for an agent's
scratch directory.

The shipped app is vanilla HTML, CSS and JavaScript with no build step and no
framework. It talks to exactly one service of its own — the API Worker in
`worker/` — which talks to exactly one paid service, SerpApi. Everything else it
links to (Google Flights, airline sites) is an outbound link a person clicks.

So the app does not stop working if an assistant, a subscription or an API key
for one goes away. What goes away is the speed of changing it, which is what the
tests and the comments are for.

## What it costs, and what happens when each thing lapses

| | cost | if it lapses |
|---|---|---|
| SerpApi | $25/mo Starter, or $0 free | searching stops; shared links and cached results keep working |
| Cloudflare Workers + KV | $0 (free plan) | everything stops |
| Domain | ~$12–15/yr | the app is still at `*.workers.dev`; shared links on the custom domain die |
| GitHub | $0 (private repo) | nothing; it is a backup, not a dependency |

**The most likely quiet death is a card expiring on SerpApi.** The plan drops to
free, the month's 250 searches go in a day or two, and from then on every search
returns "has used this month's flight-data allowance" while the app otherwise
looks healthy. Check it without logging in anywhere:

```
curl -s https://fly-with-friends-api.altorien.workers.dev/budget
```

`providerLeft` is SerpApi's own figure. If it is near zero early in the month,
that is the symptom.

## Where the secrets are

There is one secret in the whole system.

| what | where | rotate with |
|---|---|---|
| `SERPAPI_KEY` | Cloudflare secret on the `fly-with-friends-api` Worker | `cd worker && npx wrangler secret put SERPAPI_KEY` |

It is never in the repo, never in the browser bundle, and never in a response
body. The browser only ever talks to the API Worker. Confirm before publishing:

```
git grep -nIE "(api[_-]?key|secret|token)\s*[:=]\s*['\"][A-Za-z0-9_-]{12,}"
```

`ALLOWED_ORIGINS` in `worker/wrangler.toml` is not a secret but is load-bearing:
it is the list of sites allowed to spend searches. Leaving a site off it means
the page loads and every search returns 403 — see "symptoms" below.

## Deploying

Two Workers, deployed separately so searching and serving can be paused
independently. Always pass the config path explicitly; run bare from `worker/`
and wrangler walks up, finds the site config and tries to serve a directory that
does not exist.

```
# the app
cp index.html app.js airports.js airports-extra.js optimizer.js \
   flights.json manifest.json *.png favicon.svg robots.txt dist/
cp -r splash dist/
npx wrangler deploy -c wrangler.site.toml

# the API
cd worker && npx wrangler deploy -c ./wrangler.toml
```

`dist/` is assembled by copying and is gitignored. A missing launch image does
not error — it means iOS opens that phone size to a white screen, which is the
one failure nobody reports.

## Running the tests

No package manager, no install. Node 20 or newer.

```
for t in test-*.js; do node "$t" || echo "FAILED $t"; done
cd worker && node test-worker.js
```

Around 540 checks across eleven suites. They are the reason this is changeable
by somebody who did not write it: they encode what each piece is *for*, not just
that it runs. None of them touch the network — the provider is stubbed, so a
test that reached for SerpApi would throw rather than spend a search.

## The ceilings, and which one binds first

| ceiling | value | source |
|---|---|---|
| SerpApi searches | 1,000/mo, 200/hr on Starter | read live from the provider |
| Cloudflare KV writes | 1,000/day | free plan, **not** derived from anything |
| Cloudflare KV reads | 100,000/day | free plan |

The app's monthly and hourly caps are derived from the provider at request
time, so changing plan needs no deploy. The KV write ceiling is not derived
from anything and will not move on its own.

**There is no daily cap**, deliberately. SerpApi refuses rather than billing for
overage, so spending the month quickly costs nothing except having spent it,
and a daily cap's only effect was telling a real group "come back tomorrow" on
the day they were planning a trip. The hourly brake stays — it is a runaway
guard set far above any human session, not a quota.

An 8-party round trip costs 16 searches and 21 KV writes, so the two ceilings
are in different units:

- **KV bounds a day**: 47 such trips, the same on every plan
- **searches bound a month**: 14 on the free tier, 59 on the $25 tier

The month therefore runs out long before any single day could reach the write
ceiling, which is what makes having no daily cap safe rather than merely
allowed. That stops being true around a $75 / 5,000-search plan: at that point
a heavy day can exceed 1,000 KV writes, and **KV becomes the thing to watch,
not SerpApi**.

## Symptoms, and what they mean

**Every search returns 403, but the page loads and shared links work.**
The site's origin is not in `ALLOWED_ORIGINS`. Writes are gated on Origin and
reads deliberately are not, so this fails in exactly the half you do not notice.
Add the origin to `worker/wrangler.toml` and redeploy the API Worker. Keep old
origins in the list — existing `?t=` share links point at them.

**Every search errors with "could not be searched right now".**
SerpApi changed its response shape, or the key is invalid. Check `/budget`
first; if the provider figures are present the key is fine and it is the parser
(`extractOptions` in `worker/worker.js`).

**Book lands on "the itinerary you selected is no longer available".**
Usually normal: the fare moved between the search and the tap. Check the
freshness chip first — it reports the age of the *oldest* leg on screen, and
anything over a few hours makes this likely. If it happens on fares minutes old,
Google changed the `tfs=` deep-link format. `test-booking.js` will NOT catch
that: it checks our encoder against a golden vector, not Google's acceptance of
it. The fallback is already written — `tripBookUrl` degrades to a plain search
link when a flight is not pinnable, so the fix is to make `pinnable()` return
false and ship a dead-end-free, slightly worse Book button the same day.

**An airport somebody lives near is missing.**
Regenerate the table. The source is public domain and the curated names win, so
this never clobbers a hand-written entry:

```
python3 tools/make-airports.py          # fetches, or pass local CSV paths
```

## Turning it off

Delete the two Workers and the KV namespace in the Cloudflare dashboard, and
cancel the SerpApi plan. Shared trips live in KV with a 30-day TTL and expire on
their own. No personal data is stored anywhere else: there are no accounts, no
payments, no email addresses, and the only thing kept per person is a name they
typed and a random claim key in their own browser's localStorage.
