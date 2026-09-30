#!/usr/bin/env bash
# An https address for the route server through Cloudflare. With a named
# tunnel set up in ~/graphhopper/tunnel.yml (see docs/own-route-server.md),
# that one: a fixed address on your own domain. Otherwise a quick tunnel,
# whose trycloudflare.com address changes on every restart.
set -euo pipefail
cd "${GH_DIR:-$HOME/graphhopper}"
if [ -f tunnel.yml ]; then
  exec ./cloudflared tunnel --no-autoupdate --config tunnel.yml run
fi
exec ./cloudflared tunnel --no-autoupdate --url http://localhost:8989
