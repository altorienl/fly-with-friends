# Parked workflows

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

---

## `budget-watch.yml`

The daily check on the SerpApi allowance. It is parked for reason 2 above and
nothing else: it is finished, it is valid, and it wants to be running.

It matters more than it looks. When the month's searches are spent the app
fails *politely* -- a friendly 429, everything else healthy -- so the one state
worth knowing about is the state that looks like nothing. This is the only
thing that would tell you.

Two bugs were fixed before it was parked here, both of which meant it had never
actually run:

- It was listed in `.git/info/exclude`, so it was never committed. That file is
  local, so the exclusion would have died with the machine and taken the only
  copy with it.
- It was not valid YAML. The budget JSON was parsed by an inline `python3 -c`
  whose body sat at column 1, which ends the enclosing `run: |` block scalar.
  The logic is now one `actions/github-script` step -- one language, and
  indentation that cannot escape its own block.

It also commits a one-line heartbeat on the first of each month, because GitHub
disables scheduled workflows after 60 days with no repo activity. Without it the
alarm switches itself off two months after the last commit, which is precisely
when it becomes the only thing watching.

To turn it on:

```
gh auth refresh -s workflow
git mv .github/workflows-disabled/budget-watch.yml .github/workflows/budget-watch.yml
git commit -m "Turn the budget watch on"
git push
gh workflow run "Budget watch"      # prove it before trusting the cron
```
