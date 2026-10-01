#!/usr/bin/env bash
# Monthly map refresh (ride-forge-map-refresh.timer): download the latest
# Australia map, build a new routing graph beside the old one while the
# route server keeps answering, then switch over (routes are down for the
# minute the server takes to load it). If the new graph doesn't plan a real
# route, it switches back. Log:  journalctl --user -u ride-forge-map-refresh
#
# The build needs ~9 GB. It runs as the first thing the kernel would stop
# if memory ran out, so the live server is never the one to go; if the
# build is stopped that way, it's done again with the server stopped
# (routes down for ~20 minutes, at 2 am).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${GH_DIR:-$HOME/graphhopper}"
SERVICE="${GH_SERVICE:-ride-forge-graphhopper}"
PORT="${GH_PORT:-8989}"
MAP_URL="${MAP_URL:-https://download.geofabrik.de/australia-oceania/australia-latest.osm.pbf}"
MAP="australia-latest.osm.pbf"
HEALTH="${XDG_STATE_HOME:-$HOME/.local/state}/ride-forge-health"
cd "$DIR" || exit 1
mkdir -p "$HEALTH" logs

say() { echo "$*"; }
notify() { [ -n "${NTFY_TOPIC:-}" ] && curl -s -m 10 -H "Title: Ride Forge map" -d "$1" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null; return 0; }
# The health check leaves the route server alone until this time.
maintenance() { echo $(($(date +%s) + $1)) >"$HEALTH/maintenance"; }
done_maintenance() { rm -f "$HEALTH/maintenance"; }
trap done_maintenance EXIT
# A real route across Caloundra, within `wait` seconds.
plans_routes() {
  local wait=$1 t=0
  while [ "$t" -lt "$wait" ]; do
    curl -sf -m 10 -X POST "http://localhost:$PORT/route" -H 'Content-Type: application/json' \
      -d '{"profile":"motorcycle","points":[[153.1131,-26.7754],[153.0900,-26.7900]],"ch.disable":true,"instructions":false,"calc_points":false}' |
      grep -q '"paths"' && return 0
    sleep 10
    t=$((t + 10))
  done
  return 1
}
# Build the graph into graph-cache.new from the new map, as the first process to stop if memory runs out.
build() {
  rm -rf graph-cache.new graph-cache.bad
  (
    echo 1000 >/proc/self/oom_score_adj
    exec jdk/bin/java -Xmx9g -Xms2g -Ddw.graphhopper.datareader.file="$MAP.new" -Ddw.graphhopper.graph.location=graph-cache.new \
      -jar graphhopper-web-11.0.jar import config.yml
  ) >logs/refresh-import.out 2>&1
}

big_enough() { [ -f "$MAP.new" ] && [ "$(stat -c %s "$MAP.new")" -gt 500000000 ]; }
# The latest map; if Geofabrik's "latest" link is broken (it looped on
# 30 Sep 2026), the newest dated copy (australia-YYMMDD.osm.pbf) from the
# region's page instead.
download() {
  say "downloading the map from $MAP_URL"
  curl -fsSL --max-redirs 5 -o "$MAP.new" "$MAP_URL" && big_enough && return 0
  local stem="${MAP_URL%-latest.osm.pbf}" name
  name=$(curl -fsS -m 30 "$stem.html" | grep -oE "href=\"${stem##*/}-[0-9]{6}\.osm\.pbf\"" | cut -d'"' -f2 | sort | tail -1)
  [ -n "$name" ] || return 1
  say "the latest-map link didn't work; downloading the newest dated copy, $name"
  curl -fsSL --max-redirs 5 -o "$MAP.new" "${MAP_URL%/*}/$name" && big_enough
}

if ! download; then
  say "download failed; keeping the current map"
  rm -f "$MAP.new"
  notify "Monthly map update: couldn't download the new map. Still on the old one."
  exit 1
fi
# The graph is built with the repo's settings, as setup.sh does.
cp "$HERE/config.yml" config.yml
cp "$HERE"/custom_models/*.json custom_models/

say "building the new graph beside the running server"
maintenance 7200
build
status=$?
if [ "$status" -ne 0 ]; then
  say "build stopped (exit $status, likely out of memory); building again with the server stopped"
  maintenance 7200
  systemctl --user stop "$SERVICE"
  build
  status=$?
  if [ "$status" -ne 0 ]; then
    say "build failed again (exit $status); back on the old map"
    rm -rf graph-cache.new "$MAP.new"
    systemctl --user start "$SERVICE"
    notify "Monthly map update failed (see logs/refresh-import.out). Still on the old map."
    exit 1
  fi
fi

say "switching to the new graph"
maintenance 900
systemctl --user stop "$SERVICE"
rm -rf graph-cache.old
mv graph-cache graph-cache.old && mv graph-cache.new graph-cache
systemctl --user start "$SERVICE"
if plans_routes 300; then
  rm -rf graph-cache.old
  mv "$MAP.new" "$MAP"
  date=$(curl -s -m 10 "http://localhost:$PORT/info" | grep -oE '"data_date":"[0-9-]+' | cut -d'"' -f4)
  say "done: the route server is on the new map (data from ${date:-?})"
  # The places the app looks up (fuel, cafés, sights…), from the same new map.
  if "$HERE/../places/build-places.sh" && systemctl --user restart ride-forge-places; then
    say "places rebuilt from the new map"
  else
    say "places couldn't be rebuilt; still on the old ones"
    notify "Monthly map update: the places (fuel, cafés…) couldn't be rebuilt from the new map. Still on the old ones."
  fi
  # Place search too (the weekly Photon export of Australia).
  if systemctl --user is-enabled -q ride-forge-photon 2>/dev/null; then
    if "$HERE/../photon/refresh.sh"; then say "place search refreshed"; else
      say "place search couldn't be refreshed; still on the old data"
      notify "Monthly map update: the place search couldn't be refreshed. Still on the old data."
    fi
  fi
  notify "Monthly map update done: map data from ${date:-?}."
else
  say "the new graph didn't plan routes; switching back"
  systemctl --user stop "$SERVICE"
  rm -rf graph-cache.bad && mv graph-cache graph-cache.bad && mv graph-cache.old graph-cache
  systemctl --user start "$SERVICE"
  rm -f "$MAP.new"
  plans_routes 300 && say "back on the old map, planning routes" || say "the old map isn't planning routes either!"
  notify "Monthly map update: the new map didn't work, so the server is back on the old one."
  exit 1
fi
