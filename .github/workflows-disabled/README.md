# Parked workflow

`scan.yml` is the fixed-roster scan from the earlier private design: a set group of
friends, precomputed weekly into `flights.json`. It is kept here rather than in
`.github/workflows/` for two reasons:

1. Its schedule is deliberately off. The live app draws on the same 250/month SerpApi
   quota, so a weekly run would quietly take ~56 searches from real users.
2. Pushing to `.github/workflows/` needs a token with the `workflow` scope, which the
   CLI login does not grant by default.

To re-enable it:

```
gh auth refresh -s workflow
git mv .github/workflows-disabled/scan.yml .github/workflows/scan.yml
git commit -m "Re-enable the fixed-roster scan workflow"
git push
```

Then uncomment the `schedule:` block in the file if you actually want it on a cron.
