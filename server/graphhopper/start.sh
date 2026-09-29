#!/usr/bin/env bash
# Serve the routing graph built by setup.sh on port 8989.
set -euo pipefail
cd "${GH_DIR:-$HOME/graphhopper}"
exec jdk/bin/java -Xmx8g -Xms2g -jar graphhopper-web-11.0.jar server config.yml
