# Fly with Friends

Three or more people, three or more cities, one destination. This finds the set of
flights that gets everyone on the ground **within 15–30 minutes of each other**, and
shows what that costs.

That window is the point: tight enough that one shared pickup, one shared ride and one
arrival meetup actually work. It is also tight enough that it is often impossible — so
the app leads with the tightest window genuinely achievable, and prices the tradeoff
rather than quietly showing you the closest near-miss.

Idea started March 2023. Installable web app, no accounts, no payments, no app stores.
Anyone can use it: add two to eight people, give each an airport, name them or leave them
as Flight 1, Flight 2, Flight 3.

## How it works

The front end is a static page on GitHub Pages. Searches go to a Cloudflare Worker that
holds the SerpApi key and talks to Google Flights on the browser's behalf.

The proxy is not optional. SerpApi refuses cross-origin browser requests by design,
because the key would be visible to anyone who opened devtools. A static site cannot call
it directly even if you wanted to.

```
index.html  ->  worker/  ->  SerpApi            optimizer.js
 the form      key + cache    Google Flights     all maths, client-side
```

### Cost, and why the cache is the product

**The free tier is 250 searches/month, and a 4-person round trip costs 8 of them.** That is
roughly 31 group searches a month, shared across everyone who visits — about one a day.

Three things keep that workable, all in `worker/worker.js`:

- **Caching is per individual search**, keyed on (origins, destination, date, leg) rather
  than per group. Two different groups that share a leg only pay for it once, and a repeat
  of the same search is free for 24 hours.
- **A hard cap, checked before spending.** The Worker counts how many of the requested
  legs are *not* already cached, and refuses the whole request if that would exceed the
  monthly (230) or daily (24) limit. Per-IP throttling is 12 searches an hour.
- **Cached results still serve after the cap is hit**, so a shared link keeps working when
  the budget is gone. Sharing a link costs nothing.

Shared links are how this stays affordable: the search is encoded in the URL hash, so
passing one around replays it from cache instead of buying it again.

## Setup

1. **Get a SerpApi key** at serpapi.com (free tier is enough).
2. **Deploy the Worker:**
   ```
   cd worker
   npx wrangler kv namespace create FWF     # paste the id into wrangler.toml
   npx wrangler secret put SERPAPI_KEY
   npx wrangler deploy
   ```
3. **Point the app at it:** set `API_BASE` at the top of `index.html` to the deployed
   Worker URL. Until that is set the app runs in example mode only and says so.
4. **Serve it:** `python3 -m http.server 8000`, then open `localhost:8000`.
5. **Enable Pages** on `main`, then Add to Home Screen on your phone.

Before any of that, "See an example" renders the whole app against sample fares without
spending a search. The sample data is clearly flagged as fabricated in a banner.

### The fixed-roster mode

`config.json`, `.github/scripts/scan.py` and the scan workflow are the earlier private
design: a fixed group of friends, precomputed weekly into `flights.json`. That still works
and is what generates the sample data, but **the workflow's schedule is deliberately
disabled** — it draws on the same 250/month quota as real users, so a weekly run would
quietly take ~56 of their searches. Run it with `workflow_dispatch` on purpose, or
re-enable the cron if you go back to a private roster.

## The optimiser

`optimizer.js` is deliberately a separate file from `index.html`: this is the part where a
plausible-looking wrong answer would be invisible in the UI, so it has to be runnable
against brute force outside a browser.

```
node test-optimizer.js        # 31 checks
cd worker && node test-worker.js   # 19 checks
```

`test-optimizer.js` includes 1,600 comparisons against exhaustive enumeration on small
fixtures. `test-worker.js` checks request validation and, importantly, that the Worker's
bag-text parser agrees with the Python one in `scan.py` case for case — there are two
implementations of that parser and nothing but the tests keeps them honest.
Two exact algorithms:

- **Tightest achievable window** — the smallest range containing at least one arrival from
  every traveler. Two-pointer over the merged arrival list.
- **Minimum cost at a window width** — slide a window of width *S* over the actual arrival
  times; within each, take each traveler's cheapest option. Sliding over real arrivals is
  sufficient because an optimal window can always be shifted left until it starts at one,
  so this is the true optimum rather than an approximation.

Cost is non-increasing as the window loosens, by construction. If the ladder ever shows a
rise, the window logic is broken.

**Subset handling** is what makes this usable above three people. One person holding a
single bad option forces the window open for everyone, and "tightest possible: 4h 20m"
tells a group nothing. So the optimiser also solves for the largest subset that fits the
target and names who falls out — *"6 of 7 land within 28 minutes; Ray is +2h 10m outside"* —
which turns an impossible constraint into a real decision.

## Known limits

- **One-way searches, not round trips.** SerpApi's round-trip mode returns only outbound
  options; return flights need a second call bound to one specific chosen outbound, which
  explodes the call count and stops the optimiser ranging over both legs. The cost is that
  a true round-trip fare is sometimes cheaper than two one-ways on the same carrier. The
  Book links go to Google Flights, where you can compare before paying.
- **Bag fees are mostly unknowable, and this is weaker than it looks.** Google publishes
  bag information only as free text in `extensions`, and in practice that text is a bare
  `"Checked baggage for a fee"` on *every* itinerary — verified against live results for
  SFO/ORD -> PIT, where 33 of 33 came back that way with no price and no carry-on field.
  The parser handles priced strings like `"1st checked bag: 35"` when they appear, but on
  real data they generally do not. Consequences, stated plainly:
  - A checked bag becomes a flat assumption added to every option equally, so it moves the
    displayed totals but **cannot change which plan wins**. The UI says so when that is the
    case rather than badging every row as an estimate.
  - `carry_on_included` is essentially never `false` in live data, so **fares that exclude a
    carry-on are not penalised**. For carry-on specifically, an unknown fee *is* effectively
    treated as free. Checked bags are protected by the flat assumption; carry-on is not.
  - An airline-keyed fee table was considered and rejected: airline bag policy changes
    (Southwest dropped free checked bags in 2025), so hardcoding it would make the rankings
    confidently wrong rather than honestly uncertain.
- **`booking_token` is not used for booking.** Its lifetime is undocumented and these
  Google-side tokens go stale, so one captured in a weekly snapshot cannot be trusted. Book
  links are built from route and date at click time instead. The token is stored as
  metadata only.
- **Destination-side times only.** SerpApi returns local wall-clock times with no offset.
  Everything the optimiser compares happens at the one shared destination airport, so no
  timezone conversion is needed and none is done. Departure times across different origins
  are *not* comparable this way — do not extend the clustering to them without fixing it.
- **Bags are assumed per person, not per traveler.** The settings sheet sets one carry-on
  / checked-bag assumption for everyone, so group totals stay comparable. Real groups where
  one person checks a bag and another does not will be slightly off.
- **Incomplete data is refused, not averaged.** If a traveler has no options for a leg, the
  app says so instead of showing a group total. A total covering 3 of 4 people is a wrong
  number, not a partial one.

## Files

| file | what it is |
|---|---|
| `index.html` | the whole front end — styles, markup, rendering |
| `optimizer.js` | window/cost maths, runs in browser and node |
| `test-optimizer.js` | brute-force verification, `node test-optimizer.js` |
| `worker/worker.js` | SerpApi proxy: key, cache, budget cap, rate limit |
| `worker/wrangler.toml` | Worker config; needs your KV namespace id |
| `worker/test-worker.js` | parser parity and validation checks |
| `flights.json` | sample fares for the example mode |
| `config.json` | fixed-roster mode only (see above) |
| `.github/scripts/scan.py` | fixed-roster scan; schedule disabled |
| `.github/workflows/scan.yml` | manual trigger only |

Icons are generated stand-ins derived from the 2023 app icon; swap in the originals if you
still have the exports.
