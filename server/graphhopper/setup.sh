#!/usr/bin/env bash
# Ride Forge's own route server: GraphHopper with Australia's roads, in
# ~/graphhopper, without admin rights or Docker. Run once, then again every
# month or two to pick up new roads (see docs/own-route-server.md).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${GH_DIR:-$HOME/graphhopper}"
GH_VERSION=11.0
MAP_URL="${MAP_URL:-https://download.geofabrik.de/australia-oceania/australia-latest.osm.pbf}"
mkdir -p "$DIR/custom_models" "$DIR/logs"
cd "$DIR"

if [ ! -x jdk/bin/java ]; then
  echo "Downloading Java 21…"
  curl -fsSL -o jdk.tar.gz "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse"
  mkdir -p jdk && tar -xzf jdk.tar.gz -C jdk --strip-components=1 && rm jdk.tar.gz
fi
if [ ! -f "graphhopper-web-$GH_VERSION.jar" ]; then
  echo "Downloading GraphHopper $GH_VERSION…"
  curl -fsSL -o "graphhopper-web-$GH_VERSION.jar" "https://github.com/graphhopper/graphhopper/releases/download/$GH_VERSION/graphhopper-web-$GH_VERSION.jar"
fi
echo "Downloading the map (about 1 GB)…"
curl -fsSL -o map.osm.pbf.new "$MAP_URL" && mv map.osm.pbf.new australia-latest.osm.pbf
cp "$HERE/config.yml" config.yml
cp "$HERE"/custom_models/*.json custom_models/

echo "Building the routing graph (about 20–40 minutes)…"
rm -rf graph-cache.new
jdk/bin/java -Xmx11g -Xms2g -Ddw.graphhopper.graph.location=graph-cache.new -jar "graphhopper-web-$GH_VERSION.jar" import config.yml > logs/import.out 2>&1
rm -rf graph-cache.old
[ -d graph-cache ] && mv graph-cache graph-cache.old
mv graph-cache.new graph-cache
rm -rf graph-cache.old
echo "Done. Start (or restart) the server: systemctl --user restart ride-forge-graphhopper"
