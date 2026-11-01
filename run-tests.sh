#!/bin/bash
# Every suite, with a CRASH counted as a failure.
#
# Written after two suites spent a day not running. test-objective.js threw on
# boot when a DOM stub lacked style.setProperty, and test-booking.js exited 1
# because it sliced app.js on a comment that had been rewritten. Both printed a
# stack trace instead of the word FAILED, so every loop that grepped for FAILED
# reported a clean run. Exit codes do not have that problem.
fail=0; total=0
for f in test-*.js worker/test-worker.js; do
    out=$(node "$f" 2>&1); code=$?
    last=$(echo "$out" | tail -1)
    n=$(echo "$last" | grep -oE 'ALL ([0-9]+) CHECKS' | grep -oE '[0-9]+')
    if [ $code -ne 0 ]; then
        printf '  %-24s FAILED (exit %d)\n' "$f" "$code"
        echo "$out" | grep -E 'FAIL|Error' | head -3 | sed 's/^/      /'
        fail=1
    else
        printf '  %-24s %s\n' "$f" "$last"
        total=$((total + ${n:-0}))
    fi
done
echo
[ $fail -eq 0 ] && echo "ALL SUITES PASS - $total checks" || echo "SUITE FAILURES ABOVE"
exit $fail
