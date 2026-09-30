#!/usr/bin/env bash
# The latest feedback and error reports from the app (newest last).
#   show.sh            the last 20
#   show.sh 50 error   the last 50 errors (or: feedback)
set -euo pipefail
DIR="${FEEDBACK_DIR:-$HOME/ride-forge-feedback}"
N="${1:-20}"
KIND="${2:-}"
cat "$DIR"/*.jsonl 2>/dev/null | { [ -n "$KIND" ] && grep "\"kind\":\"$KIND\"" || cat; } | tail -n "$N" |
  node -e 'require("readline").createInterface({ input: process.stdin }).on("line", (l) => {
    const e = JSON.parse(l);
    console.log(`${e.at.slice(0, 16).replace("T", " ")}  ${e.kind.padEnd(8)} ${e.version ?? "?"} ${e.platform ?? ""}  ${e.message}`);
    if (e.detail) console.log("    " + e.detail.split("\n").slice(0, 4).join("\n    "));
  })'
