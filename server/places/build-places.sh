#!/usr/bin/env bash
# The places the app looks up (fuel, cafés, food, pubs, toilets, lookouts,
# sights, mountain passes), cut from the Australia map into
# ~/places/places.geojsonseq for places.mjs. Takes about 4 minutes; the
# monthly map refresh runs it after switching to a new map. Needs osmium
# (sudo apt install osmium-tool).
set -euo pipefail
MAP="${MAP:-${GH_DIR:-$HOME/graphhopper}/australia-latest.osm.pbf}"
OUT="${PLACES_DIR:-$HOME/places}"
mkdir -p "$OUT"
# Every tag the app's queries use (src/lib/pois.ts, sights.ts).
osmium tags-filter "$MAP" \
  nwr/amenity=fuel,cafe,restaurant,fast_food,pub,bar,biergarten,toilets nwr/shop=bakery \
  nwr/tourism=viewpoint,attraction,museum,zoo,theme_park nwr/natural=waterfall,peak,saddle \
  nwr/historic=castle,monument,ruins,fort n/mountain_pass=yes \
  -o "$OUT/places.osm.pbf.new" --overwrite
osmium export "$OUT/places.osm.pbf.new" -f geojsonseq -a type,id -o "$OUT/places.geojsonseq.new" --overwrite
mv "$OUT/places.geojsonseq.new" "$OUT/places.geojsonseq"
rm -f "$OUT/places.osm.pbf.new"
echo "places: $(wc -l <"$OUT/places.geojsonseq") features in $OUT/places.geojsonseq"
