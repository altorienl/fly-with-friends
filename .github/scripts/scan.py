#!/usr/bin/env python3
"""Fan out SerpApi Google Flights searches for every traveler on every active trip.

One one-way search per traveler per leg. Round-trip mode is deliberately avoided:
SerpApi returns only outbound options for type=1, and each set of return options
costs another call keyed to one specific chosen outbound, which both explodes the
call count and stops the optimizer from ranging freely over both legs.

Writes flights.json. Never spends a search without checking the budget first.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CONFIG_PATH = os.path.join(ROOT, "config.json")
OUTPUT_PATH = os.path.join(ROOT, "flights.json")

ENDPOINT = "https://serpapi.com/search.json"
SECONDS_BETWEEN_CALLS = 2  # free tier allows 50/hour; this keeps us well clear


# ---------------------------------------------------------------- baggage

# Google exposes bag information only as free text in `extensions`. There is no
# structured "checked bag included" field, and SerpApi's `bags` request param
# filters carry-on only (checked-bag filtering is still open on their roadmap).
# So we parse best-effort and are explicit about what we could not determine --
# a missing fee must never be scored as $0, because that systematically flatters
# the basic-economy fares most likely to look artificially cheap.

PRICE_PATTERNS = [
    re.compile(r"1st\s+checked\s+bag[:\s]+\$?(\d+)", re.I),
    re.compile(r"first\s+checked\s+bag[:\s]+\$?(\d+)", re.I),
    re.compile(r"checked\s+bag[:\s]+\$?(\d+)", re.I),
]
FEE_UNKNOWN_PATTERNS = [
    re.compile(r"checked\s+baggage\s+for\s+a\s+fee", re.I),
    re.compile(r"bag\s+and\s+fare\s+conditions", re.I),
]
CARRY_ON_INCLUDED = re.compile(r"(free\s+carry[- ]on|carry[- ]on\s+(bag\s+)?included)", re.I)
CARRY_ON_EXCLUDED = re.compile(r"carry[- ]on\s+(bag\s+)?(not\s+included|for\s+a\s+fee)", re.I)
CHECKED_INCLUDED = re.compile(r"(\d+)\s+free\s+checked\s+bag", re.I)


def parse_bags(extensions):
    """Turn Google's free-text extensions into a structured, honest bag summary."""
    text = " | ".join(extensions or [])

    carry_on_included = None
    if CARRY_ON_INCLUDED.search(text):
        carry_on_included = True
    elif CARRY_ON_EXCLUDED.search(text):
        carry_on_included = False

    checked_free = CHECKED_INCLUDED.search(text)
    if checked_free and int(checked_free.group(1)) > 0:
        return {
            "carry_on_included": carry_on_included,
            "checked_first_price": 0,
            "confidence": "parsed",
        }

    for pattern in PRICE_PATTERNS:
        hit = pattern.search(text)
        if hit:
            return {
                "carry_on_included": carry_on_included,
                "checked_first_price": int(hit.group(1)),
                "confidence": "parsed",
            }

    for pattern in FEE_UNKNOWN_PATTERNS:
        if pattern.search(text):
            # We know a fee exists but not its size. Distinct from knowing nothing.
            return {
                "carry_on_included": carry_on_included,
                "checked_first_price": None,
                "confidence": "fee_unknown",
            }

    return {
        "carry_on_included": carry_on_included,
        "checked_first_price": None,
        "confidence": "absent",
    }


# ---------------------------------------------------------------- serpapi

def call_serpapi(api_key, params):
    query = dict(params)
    query["api_key"] = api_key
    query["engine"] = "google_flights"
    url = ENDPOINT + "?" + urllib.parse.urlencode(query)
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def extract_options(payload, limit):
    """Flatten best_flights + other_flights into comparable itineraries.

    Unlike an ordinary fare scraper we keep the whole option set, not just the
    cheapest -- the optimizer needs every arrival time to find a tight window.
    """
    options = []
    for itinerary in (payload.get("best_flights") or []) + (payload.get("other_flights") or []):
        legs = itinerary.get("flights") or []
        if not legs:
            continue

        first, last = legs[0], legs[-1]
        departure = (first.get("departure_airport") or {}).get("time")
        arrival = (last.get("arrival_airport") or {}).get("time")
        price = itinerary.get("price")
        if not departure or not arrival or price is None:
            continue

        extensions = list(itinerary.get("extensions") or [])
        for leg in legs:
            extensions.extend(leg.get("extensions") or [])

        airlines = []
        for leg in legs:
            name = leg.get("airline")
            if name and name not in airlines:
                airlines.append(name)

        options.append({
            "price": price,
            "depart": departure,
            "arrive": arrival,
            "duration_minutes": itinerary.get("total_duration"),
            "stops": max(len(legs) - 1, 0),
            "airlines": airlines,
            "from": (first.get("departure_airport") or {}).get("id"),
            "to": (last.get("arrival_airport") or {}).get("id"),
            "airline_logo": itinerary.get("airline_logo") or first.get("airline_logo"),
            "booking_token": itinerary.get("booking_token"),
            "extensions": extensions,
            "bags": parse_bags(extensions),
        })

    options.sort(key=lambda o: o["price"])
    return options[:limit]


# ---------------------------------------------------------------- planning

def build_jobs(config):
    """Every (trip, traveler, leg) search this run intends to make."""
    travelers = {t["id"]: t for t in config["travelers"]}
    jobs = []

    for trip in config["trips"]:
        if not trip.get("active"):
            continue
        for traveler_id in trip["travelers"]:
            traveler = travelers.get(traveler_id)
            if traveler is None:
                print("WARNING: trip %s lists unknown traveler %s" % (trip["id"], traveler_id))
                continue
            jobs.append({
                "trip": trip, "traveler": traveler, "leg": "outbound",
                "departure_id": ",".join(traveler["origins"]),
                "arrival_id": ",".join(trip["airports"]),
                "date": trip["depart_date"],
            })
            jobs.append({
                "trip": trip, "traveler": traveler, "leg": "return",
                "departure_id": ",".join(trip["airports"]),
                "arrival_id": ",".join(traveler["origins"]),
                "date": trip["return_date"],
            })
    return jobs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true",
                        help="print the planned call count and exit without spending searches")
    args = parser.parse_args()

    with open(CONFIG_PATH) as handle:
        config = json.load(handle)

    jobs = build_jobs(config)
    budget = config.get("max_searches_per_run", 32)

    print("Planned searches: %d (budget %d)" % (len(jobs), budget))
    for job in jobs:
        print("  %-10s %-8s %s -> %s on %s" % (
            job["traveler"]["id"], job["leg"], job["departure_id"], job["arrival_id"], job["date"]))

    if len(jobs) > budget:
        print("\nABORT: %d searches exceeds max_searches_per_run=%d. Nothing was spent."
              % (len(jobs), budget), file=sys.stderr)
        return 1

    if args.dry_run:
        print("\nDry run: no searches made.")
        return 0

    api_key = os.environ.get("SERPAPI_KEY")
    if not api_key:
        print("ABORT: SERPAPI_KEY is not set.", file=sys.stderr)
        return 1

    # Ask for the largest carry-on count in the group so results are not filtered
    # down to fares that exclude a bag everyone is actually bringing.
    carry_on = max([t.get("bags", {}).get("carry_on", 0) for t in config["travelers"]] or [0])
    limit = config.get("max_options_per_leg", 25)

    trips = {}
    errors = []

    for index, job in enumerate(jobs):
        trip_id = job["trip"]["id"]
        traveler_id = job["traveler"]["id"]
        trips.setdefault(trip_id, {"outbound": {}, "return": {}})

        params = {
            "type": 2,  # one way; see module docstring
            "departure_id": job["departure_id"],
            "arrival_id": job["arrival_id"],
            "outbound_date": job["date"],
            "currency": config.get("currency", "USD"),
            "adults": 1,
            "bags": carry_on,
            "hl": "en",
            "gl": "us",
        }

        try:
            payload = call_serpapi(api_key, params)
            if payload.get("error"):
                raise RuntimeError(payload["error"])
            options = extract_options(payload, limit)
            if not options:
                raise RuntimeError("no results returned")
            trips[trip_id][job["leg"]][traveler_id] = options
            print("ok   %s %s: %d options, cheapest %s"
                  % (traveler_id, job["leg"], len(options), options[0]["price"]))
        except Exception as exc:  # one dead route must not void the whole run
            trips[trip_id][job["leg"]][traveler_id] = []
            errors.append({
                "trip_id": trip_id, "traveler_id": traveler_id,
                "leg": job["leg"], "reason": str(exc),
            })
            print("FAIL %s %s: %s" % (traveler_id, job["leg"], exc), file=sys.stderr)

        if index < len(jobs) - 1:
            time.sleep(SECONDS_BETWEEN_CALLS)

    output = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "currency": config.get("currency", "USD"),
        "sample": False,
        "trips": trips,
        "errors": errors,
    }

    with open(OUTPUT_PATH, "w") as handle:
        json.dump(output, handle, indent=2)
        handle.write("\n")

    print("\nWrote %s (%d searches, %d errors)" % (OUTPUT_PATH, len(jobs), len(errors)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
