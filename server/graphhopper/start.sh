#!/usr/bin/env bash
# Serve the routing graph built by setup.sh on port 8989.
set -euo pipefail
cd "${GH_DIR:-$HOME/graphhopper}"
# The graph itself takes about 1.3 GB of heap (Australia, 2026); 3 GB leaves
# room for busy moments without holding memory it never uses (it held 5 GB at -Xmx8g).
exec jdk/bin/java -Xmx3g -Xms1g -jar graphhopper-web-11.0.jar server config.yml
