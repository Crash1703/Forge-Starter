#!/usr/bin/env bash
# Ride Forge's own place search: Photon (the search engine the app has always
# used), with Australia's places, on localhost:2322. The tunnel sends
# https://<route server>/api and /reverse here, so it answers just as the
# public photon.komoot.io does. Data: refresh.sh.
set -euo pipefail
cd "${PHOTON_DIR:-$HOME/photon}"
exec "${JAVA:-$HOME/graphhopper/jdk/bin/java}" -Xmx2g -jar photon-1.3.0.jar serve \
  -data-dir data -listen-ip 127.0.0.1 -listen-port 2322 -cors-any -default-language en
