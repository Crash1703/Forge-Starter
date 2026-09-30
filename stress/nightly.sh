#!/usr/bin/env bash
# Nightly stress test (ride-forge-stress.timer): the latest main, in its own
# copy of the repo so it never disturbs the working copy, against the route
# server here. Each night's numbers and log go to
# ~/.local/state/ride-forge-stress/<date>.{json,log}; the journal gets the
# summary:  journalctl --user -u ride-forge-stress
# If anything got worse than stress/baseline.json, it says so, and sends a
# phone notification when NTFY_TOPIC is set (~/.config/ride-forge/health.env).
set -uo pipefail
REPO="${REPO:-$HOME/Forge-Starter}"
WORK="${STRESS_WORK:-$HOME/.cache/ride-forge-stress}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/ride-forge-stress"
mkdir -p "$STATE"
day=$(date +%F)

git -C "$REPO" fetch -q origin main || { echo "couldn't fetch main"; exit 1; }
if [ -d "$WORK/.git" ] || [ -f "$WORK/.git" ]; then
  git -C "$WORK" checkout -q --detach origin/main
else
  git -C "$REPO" worktree add -q --detach "$WORK" origin/main
fi
cd "$WORK"
# Reinstall only when the dependencies changed.
if ! cmp -s package-lock.json node_modules/.package-lock.json 2>/dev/null; then npm ci --no-audit --no-fund -s; fi

NO_COLOR=1 STRESS_OUT="$STATE/$day.json" npm run -s stress >"$STATE/$day.log" 2>&1
status=$?
grep -oE "(loops|legs)( baseline)?: .*" "$STATE/$day.log"
if [ "$status" -ne 0 ]; then
  worse=$(grep -oE "AssertionError: [^:]+" "$STATE/$day.log" | sed 's/AssertionError: //' | sort -u | paste -sd, -)
  echo "WORSE than the baseline: ${worse:-see $STATE/$day.log}"
  [ -n "${NTFY_TOPIC:-}" ] && curl -s -m 10 -H "Title: Ride Forge stress test" -d "Tonight's routing got worse: ${worse:-see the log}" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null
fi
# Keep a month of results.
find "$STATE" -name '20*' -mtime +31 -delete
exit "$status"
