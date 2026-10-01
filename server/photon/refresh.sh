#!/usr/bin/env bash
# Australia's places for the search (Photon), from the weekly export
# (download1.graphhopper.com, OpenStreetMap data): built into data.new beside
# the running search, then switched over (search is down for the minute
# Photon takes to start). The monthly map refresh runs it; or by hand.
set -euo pipefail
DIR="${PHOTON_DIR:-$HOME/photon}"
JAVA="${JAVA:-$HOME/graphhopper/jdk/bin/java}"
DUMP="https://download1.graphhopper.com/public/australia-oceania/australia/photon-dump-australia-1.0-latest.jsonl.zst"
cd "$DIR"
curl -fsSL -o australia.jsonl.zst.new "$DUMP"
mv australia.jsonl.zst.new australia.jsonl.zst
rm -rf data.new
zstd --stdout -d australia.jsonl.zst | "$JAVA" -Xmx4g -jar photon-1.3.0.jar import -import-file - -languages en -data-dir data.new >import.log 2>&1
systemctl --user stop ride-forge-photon || true
rm -rf data.old
[ -d data ] && mv data data.old
mv data.new data
systemctl --user start ride-forge-photon
# Check it answers before letting the old data go.
for i in $(seq 1 30); do
  if curl -sf -m 5 "http://localhost:2322/api?q=Maleny&limit=1" | grep -q '"features"'; then
    rm -rf data.old
    echo "search: on the new data"
    exit 0
  fi
  sleep 10
done
echo "search: the new data didn't answer; switching back"
systemctl --user stop ride-forge-photon
rm -rf data.bad && mv data data.bad && mv data.old data
systemctl --user start ride-forge-photon
exit 1
