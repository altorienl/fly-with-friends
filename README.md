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

### Surviving being shared

The Worker is public and unauthenticated, so the exposure is not the API key — that lives
only as a Cloudflare secret and never reaches the browser — it is the 250-search allowance.
**There is no per-person limit, on purpose.** The owner's position is upgrade rather than
ration, and it is the right one: a group searching hard is a customer, not a threat, and
"you have used your searches" is the worst possible first impression. What remains is only
what cannot be wished away — the provider's own monthly allowance, and a deliberately
generous hourly brake so a script cannot turn the whole month into one minute before anyone
notices. Separating humans from scripts is Turnstile's job, not a quota's.

An audit found two holes that meant the existing limits were not limits at all:

- **The per-IP cap counted requests, not searches.** One request for eight people on a round
  trip is sixteen billed searches, so 12 requests/hour was 192 searches/hour from a single
  address that never rotated. Caps are now counted in searches.
- **The global cap was not enforced under concurrency.** Read-modify-write on KV is
  last-write-wins, so parallel requests all read the same total, all passed the check, and
  all spent. Budget is now *reserved* before the provider is called and refunded if the call
  fails, which narrows the window from a multi-second round trip to one KV hop. A Durable
  Object is the actual fix and is the next thing to build.

Also closed: `currency` went unvalidated into both the cache key and the upstream URL; dates
were regex-checked but unbounded, making an unlimited supply of guaranteed cache misses
(`9999-99-99` passed); origin lists were unsorted, so `["SFO","OAK"]` and `["OAK","SFO"]`
were the same search paid for twice; `POST /trip` accepted any JSON, and the free tier allows
only 1,000 KV writes a day shared with the budget counters; and the provider was
client-selectable, which let a caller choose which paid API to spend.

There is now a `SEARCH_ENABLED=off` variable that stops new searches from the dashboard in
seconds without a redeploy, while cached results and shared links keep working.

Still outstanding before posting this anywhere with real traffic: **Cloudflare Turnstile**.
Everything above raises the cost of draining the allowance from one curl loop to rotating a
few IPv6 /64s, which is an afternoon's work for anyone who cares. Turnstile is the only
control that costs an attacker something. Note also that WAF and rate-limiting rules do not
apply here at all: `workers.dev` is Cloudflare's zone, not ours, so every protection is code
until the Worker sits on a custom domain.

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

Shared links are how this stays affordable. A finished trip is stored server-side by
`POST /trip` and handed out as `?t=<id>`, so opening one costs a single KV read rather than
re-running the search on each recipient's phone. (The older self-contained `#s=<base64>`
form still exists for a trip that has not been saved yet, and still costs a fresh paid
search per device — which is why every share route saves first.)

### The trip is a document, not a screenshot

A shared trip could say what the group *should* do and never what the group *had* done, so
the one question that actually blocks a group trip — has Ray bought his ticket yet — lived
in a chat window this app cannot see. The trip now carries a roster:

| route | what it does | cost |
| --- | --- | --- |
| `POST /trip` | stores the finished trip, returns a 6-char id | 2 writes (trip + per-IP counter) |
| `GET /trip/:id` | the trip document. Immutable, cached 300s at the edge | 1 read |
| `GET /trip/:id/marks` | just the roster. `no-store`, so it is never stale | 1 read |
| `POST /trip/:id/mark` | one person's status. Re-posting an unchanged state writes nothing | 1 write |

**Writes.** One per real status change, so at most one per person — ten for the largest trip
this app can produce, including the two that sharing already cost. Nothing writes on a page
view, on a refresh, or on choosing which card is you. The search allowance (230/month, eight
per four-person round trip) caps the system at roughly **28 shareable trips a month**, so
~280 roster writes a month against a **1,000-a-day** ceiling. Searches are still the
constraint; writes are two orders of magnitude from being one. `worker/test-worker.js`
counts the writes of a whole trip lifecycle rather than asserting this in prose.

**The rate limit is free.** A per-trip counter lives *inside* the trip, so the put that
records a status change is the put that increments it. 200 per trip id, ever — twenty-five
times what a real group needs, and a hard bound on a hostile loop.

**Trust: the link is the credential, and first claim wins.** There are no accounts. The
first device to mark a person mints a random key, kept in that device's localStorage; the
Worker stores it beside the mark and no read ever returns it. After that only that device
can change that person's state. So whoever later finds the link **cannot un-book Ray** —
the move that would make the document lie about money. What they *can* do is claim a person
nobody has claimed yet. That is the honest price of having no login, and it is the right
trade: a group passing a private link around needs protecting from the link leaking later,
not from each other.

**Stale fares.** Flight numbers, routes and times are published months ahead and do not
move; only the price does. So a re-opened trip says which half to stop trusting, and the
offer is deliberately *not* "search again" — Book opens Google's live price for the exact
pinned itinerary, free, where a re-search costs eight searches and produces a new trip id,
silently abandoning the document the group has been ticking itself off on.

## Live

- App: https://fly-with-friends.altorien.workers.dev
- API: https://fly-with-friends-api.altorien.workers.dev

Two Workers, deployed separately so searching can be paused or rate-limited without
taking the app down. Deploy them with an explicit config path — run bare from `worker/`,
wrangler walks up, finds `wrangler.site.toml` and tries to serve a `public/` directory
that does not exist:

`wrangler.site.toml` serves `./dist`, which is assembled by copying — so `splash/` has to
be copied in with everything else. A missing launch image does not error, it just means
iOS launches that phone to a white screen, which is the one failure mode nobody reports.

```
cp index.html app.js airports.js optimizer.js flights.json manifest.json *.png dist/
cp -r splash dist/
npx wrangler deploy -c wrangler.site.toml          # the app, from the repo root
cd worker && npx wrangler deploy -c ./wrangler.toml # the API
```

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
node test-optimizer.js             # 80 checks
cd worker && node test-worker.js   # 41 checks
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

**Arrival-time band.** "Tightest window somewhere in the day" is not the same as "we land
at 11am", and the second is usually what a group actually needs — villa check-in, a booked
shuttle, not landing at 2am. So each leg takes an optional time-of-day band: arrivals on the
way out, departures on the way home. Bands wrap past midnight, so `22:00`–`02:00` is
expressible.

The band filters options the app has already fetched, so **changing it never costs a
search**. That matters: it is the one control a group fiddles with repeatedly, and on a
250/month budget it had to be free.

It also splits the cost into two numbers that add up, which is the part worth having:

```
cheapest at any time        $1,763
  + cost of your window     +$459   (cheapest within 12:00-14:00)
  + cost of landing together  +$98   (clustered to 30 minutes)
  = the plan                $2,320
```

On a real four-person Cabo search the window cost five times more than the clustering did —
which is the opposite of what you would guess, and the kind of thing the tool exists to say.

**A party is an airport, not a person.** Two people leaving the same city are one card, one
search and one booking — which is both cheaper in API credits and closer to how groups
actually buy tickets. A seat count multiplies the fare and the bag fees, so a couple from
Chicago weighs correctly against a single traveller from Denver in the group total.

**Airports are picked, not typed.** Free text was a silent failure mode: typing `SAN` when
you meant `SJD` returns a real answer for the wrong city and nothing downstream can detect
it. There are 306 curated airports with search over code, city and airport name.

Four of those airports have **no commercial service** — Kyiv, Lviv and Odesa since February
2022. Typing "kyiv" returns them with the reason and the airports people actually fly from
instead (Kraków, Warsaw, Rzeszów, Chișinău), rather than an empty result or a search that
burns a credit proving it.

**What each person pays.** A group total answers nobody's actual question, which is "what
does this cost *me* for these dates". Every party gets a row with their outbound, their
return, their bags and their seat count — and a per-seat figure where a card covers more
than one person.

**No partial figure is ever presented as the cost.** If a filter pushes someone out of the
window they still buy a ticket, so they are priced at their own cheapest and the trip total
covers everybody. The window is reported separately from the money: *"includes everyone,
but not everyone is inside the window"*. Showing a total that silently drops a traveller was
the single most misleading thing this app did.

**The optimum, not a round number.** 30 minutes is a guide, not a test. The default is the
knee of the cost curve — tight enough without paying for the last few minutes — and the
headline states the window the chosen plan actually achieves with the theoretical floor
beside it, rather than passing or failing against a threshold.

**It does not leave anyone behind.** Missing the target window is not a reason to delete a
traveller from the plan. If the group cannot all make 30 minutes, the answer is the tightest
window they *can* all make, and the subset is a last resort reserved for when a filter has
left somebody with no options at all — at which point the app names them and says which
filter to loosen rather than quietly solving for a smaller group.

That bug also produced a contradiction on screen: "6m apart" sitting under "closest possible
is 42m", because a two-person spread was being measured against a three-person floor.

**The verdict states a trade, not a correction.** It used to say "20m apart" and then
"tightest is 8m", which reads as the app second-guessing its own answer. It now reads
"8m is possible for $126 more", which is the actual decision.

**Nonstop is a preference, not a rule.** This was a behaviour bug, not a missing feature:
asking for nonstop used to eliminate every plan for everyone if a single person flying from a
smaller city had no nonstop. Now the preference is applied per traveller — honoured where it
exists, relaxed only for whoever cannot meet it, and stated plainly: *"Alex had no nonstop
option, so a connection was allowed rather than dropping the plan."*

**"What if it's cheaper the next day?"** The obvious question, asked by the second person to
try this. SerpApi has no flexible-date window — verified, not assumed — so every alternative
date is a full set of searches. That makes it an explicit, priced button rather than something
that quietly spends a tenth of the month's quota: *"Checks the day before and after. Costs 12
of your remaining searches."* The result is three dates side by side with the saving named.

Google also grades every fare against that route's own history and returns it in
`price_insights` on every search, which this was throwing away. A fare that is cheap or dear
for its route is now labelled on the row — free, no extra search, and it answers "is this
actually a good price" without checking another date at all.

**Cheapest first, then what closeness costs.** Two people used this before it read properly.
One said "that's expensive, why can't it show me the cheapest and the time difference". The
other found the best deal only by opening the filter panel — "it wasn't apparent". Both were
asking for the same thing: the floor, stated plainly, with the premium measured from it.

```
Cheapest                  7h 25m apart   $501 each at most   $1,890   the floor
A bit closer              20m apart      $530 each at most   $2,161   +$271 to land together
As close as they can get  15m apart      $577 each at most   $2,322   +$432 to land together
```

Reading down from the floor answers "why am I paying more than that" without opening
anything. One tap sets both legs. Computing the trade was never the hard part; showing it was.

A per-person budget ceiling was built and then removed: it asked the user to supply a number
the app could just as well derive, and flagging rows as over-budget said less than simply
showing the cheapest with the premium next to it.

**One card per person, both legs, one button.** The results are a single view: the trip
total, then the two landing windows as timelines, then one card per traveller containing
their outbound, their return, their total and a single booking link. Splitting a person's
trip across two scrolling sections with a booking link in each was the thing that made it
hard to read.

The booking link opens a round-trip search for that person's own route, with the two chosen
times printed beneath it so they know which rows to pick. There is no URL that pre-selects
two specific one-way flights, which is the honest ceiling of a tool that cannot sell a seat.

The cost ladders are still there, folded into "Other windows and what they cost" — they are
a tuning control, not the answer.

**The trip, not the leg.** The optimiser solves each leg separately, but nobody buys a
leg — they buy a trip. Each leg keeps its own chosen row so both can be priced at once.

**Partial totals say so.** If a filter excludes someone, the figure is no longer a group
total and is not labelled as one: it reads "4 of 5 travelling", turns red, and names who is
missing and what their fare would have been. Counting is in people, not cards, so a couple
sharing one card counts as two.

**Who carries the premium.** One group total is not what anyone pays, and the premium for
landing together almost never lands evenly — it falls on whoever is furthest away. Each
party's fare in the chosen plan is compared with what they would have paid flying whenever
they liked, so the plan reads *"Sam $114, Jo $78, Alex $76, Ray $11 — that is 41% on Sam
alone, worth deciding before anyone books."* Zero extra searches; it is subtraction over
data already in hand.

There is also a cap: **nobody absorbs more than $50/$100/$200**. It prunes each party's
options to those within their own baseline plus the cap and re-solves, as a filter on the
option set rather than a change to the optimiser, so the window algorithms stay exactly as
verified. On the example trip a $100 cap moves the window from 8 minutes to 20 and takes
$126 *off* the group total, because the expensive tight options were what the cap removed.

**Copy for the group chat.** The decision happens in a group chat, not here. The plan
exports as a paste-ready block — each person's flight, time, fare, who is paying extra, the
window, the total, the capture timestamp, and a link that opens on that exact row. The link
carries the chosen row, leg and bag assumptions, so the fifth person to open it sees the
same numbers rather than their own device's defaults.

**Stops and trip length.** The optimiser originally minimised price alone, which meant it
would happily pick a 31-hour two-stop itinerary to save $70. Two fixes:

- A **stops filter** (nonstop / up to 1 / any) and an optional duration cap, applied as hard
  constraints. Like the band, these filter options already fetched, so they are free.
- A **tie-break**: at equal price, fewer stops wins, then shorter time in the air. This keeps
  "cheapest" literally true while never leaving a nonstop on the table for a two-stop at the
  same fare.

Filters report who they exclude. On a real Cabo search, "nonstop only" correctly answers
*3 of 4* and names Kraków as the holdout, rather than pretending the group is covered.

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
- **Booking links are a search, not a checkout.** `booking_token` came back empty on every
  one of 76 real itineraries and its lifetime is undocumented even when present, so the
  primary link is a Google Flights search filtered to the route, date and carrier. A second
  link goes to the airline's own booking page — deliberately *not* a prefilled deep link,
  since those formats are undocumented, change without notice, and several carriers block
  anything that looks automated. A link that lands on an empty search is worse than one that
  works, so the label says where it goes.
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
  number, not a partial one. "No flights at all" and "flights, but none inside your time
  band" are reported as different problems, because they have different fixes.
- **Some origins genuinely have no answer.** Ukrainian airspace has been closed to civil
  aviation since February 2022 with no reopening date, so a search from KBP returns nothing
  and the app reports that traveler as uncovered. The real-world workaround is an overland
  departure from Kraków, Warsaw or Rzeszów — which the app will price, but cannot know to
  suggest.

## Files

| file | what it is |
|---|---|
| `index.html` | markup and styles for the four-step flow |
| `app.js` | steps, autocomplete, rendering, search, trip pricing |
| `airports.js` | 306 airports including ones with no service, and the lookup |
| `worker/worker.js` | SerpApi proxy: key, cache, budget cap, rate limit |
| `optimizer.js` | window/cost maths and time bands, runs in browser and node |
| `test-optimizer.js` | brute-force verification, `node test-optimizer.js` |
| `worker/worker.js` | SerpApi proxy: key, cache, budget cap, rate limit |
| `worker/wrangler.toml` | Worker config; needs your KV namespace id |
| `worker/test-worker.js` | parser parity and validation checks |
| `flights.json` | sample fares for the example mode |
| `config.json` | fixed-roster mode only (see above) |
| `.github/scripts/scan.py` | fixed-roster scan; schedule disabled |
| `.github/workflows/scan.yml` | manual trigger only |
| `splash/` | iOS launch images, one per logical size, orientation and colour scheme |
| `tools/make-splash.sh` | regenerates `splash/` and the `<link>` block in `index.html` |

Icons are generated stand-ins derived from the 2023 app icon; swap in the originals if you
still have the exports.

`apple-touch-startup-image` is the only launch-screen mechanism iOS honours, and it only
uses an image whose media query matches the device exactly — so the set has to be
exhaustive or the unmatched phones launch to a white screen. `tools/make-splash.sh`
regenerates the files and prints the matching `<link>` block; if the mark in `index.html`
changes, run it and paste the block back over the existing one.
