#!/usr/bin/env bash
# Ride Forge health check, run every 5 minutes by ride-forge-health.timer.
# Asks the route server for a real (tiny) route, the fuel service for its
# fuel list, and the public address for the server's info; restarts what's
# stuck, and says so in the journal:
#   journalctl --user -u ride-forge-health
# With NTFY_TOPIC set in ~/.config/ride-forge/health.env, it also sends a
# phone notification (ntfy app) when something stays down, and when it's back.
set -u
ROUTE_URL="${ROUTE_URL:-https://routes.mbcgaming.net}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/ride-forge-health"
mkdir -p "$STATE"

say() { echo "$*"; }
# The monthly map refresh (refresh-map.sh) is rebuilding or switching the
# graph: leave everything alone until the time it gave.
if [ -f "$STATE/maintenance" ] && [ "$(date +%s)" -lt "$(cat "$STATE/maintenance")" ]; then
  say "map refresh under way: not checking"
  exit 0
fi
notify() {
  [ -n "${NTFY_TOPIC:-}" ] || return 0
  curl -s -m 10 -H "Title: Ride Forge server" -d "$1" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null || true
}
# Seconds since a user service last started (0 if it isn't running).
up_for() {
  local since now
  since=$(systemctl --user show -p ActiveEnterTimestampMonotonic --value "$1")
  [ "$(systemctl --user is-active "$1")" = active ] && [ "${since:-0}" -gt 0 ] || { echo 0; return; }
  now=$(awk '{print int($1)}' /proc/uptime)
  echo $((now - since / 1000000))
}
# Record a check's result; notify when it fails twice in a row, and when it recovers.
result() {
  local name=$1 ok=$2 what=$3 file="$STATE/$1" before
  before=$(cat "$file" 2>/dev/null || echo 0)
  if [ "$ok" = 1 ]; then
    [ "$before" -ge 2 ] && notify "$name is working again."
    echo 0 >"$file"
  else
    echo $((before + 1)) >"$file"
    [ "$before" -eq 1 ] && notify "$name is down: $what"
  fi
}

# 1. The route server: a real route across Caloundra, not just "I'm up".
route_ok=0
# The public address can only be judged while the route server is answering.
check_public=0
if curl -sf -m 15 -X POST http://localhost:8989/route -H 'Content-Type: application/json' \
  -d '{"profile":"motorcycle","points":[[153.1131,-26.7754],[153.0900,-26.7900]],"ch.disable":true,"instructions":false,"calc_points":false}' |
  grep -q '"paths"'; then
  route_ok=1
  check_public=1
elif [ "$(up_for ride-forge-graphhopper)" -lt 300 ] && [ "$(systemctl --user is-active ride-forge-graphhopper)" = active ]; then
  say "route server: not answering yet, but it started under 5 minutes ago (still loading the map)"
  route_ok=1
else
  say "route server: no route; restarting it"
  systemctl --user restart ride-forge-graphhopper
fi
result "Route server" "$route_ok" "it wasn't planning routes, so it was restarted"

# 2. The fuel price service. No answer at all: restart it. An error answer
# means the government's service is down, which a restart won't fix.
if [ -f "$HOME/.config/ride-forge/fuel-token" ]; then
  code=$(curl -s -o /dev/null -m 40 -w '%{http_code}' "http://localhost:8995/fuel/Subscriber/GetCountryFuelTypes?countryId=21")
  fuel_ok=1
  case "$code" in
    200) ;;
    000) say "fuel service: no answer; restarting it"; systemctl --user restart ride-forge-fuel; fuel_ok=0 ;;
    *) say "fuel service: up, but the Queensland fuel price service answered $code" ;;
  esac
  result "Fuel prices" "$fuel_ok" "the fuel service wasn't answering, so it was restarted"
fi

# 3. Feedback and error reports from the app: restart it if it doesn't answer.
if systemctl --user is-enabled -q ride-forge-feedback 2>/dev/null; then
  feedback_ok=1
  if ! curl -sf -m 10 http://localhost:8996/feedback/health >/dev/null; then
    say "feedback service: no answer; restarting it"
    systemctl --user restart ride-forge-feedback
    feedback_ok=0
  fi
  result "Feedback" "$feedback_ok" "the feedback service wasn't answering, so it was restarted"
fi

# 4. Weather (MET Norway through this server): restart it if it doesn't answer.
if systemctl --user is-enabled -q ride-forge-weather 2>/dev/null; then
  weather_ok=1
  if ! curl -sf -m 10 http://localhost:8997/weather/health >/dev/null; then
    say "weather service: no answer; restarting it"
    systemctl --user restart ride-forge-weather
    weather_ok=0
  fi
  result "Weather" "$weather_ok" "the weather service wasn't answering, so it was restarted"
fi

# 5. Elevation (the terrain model on this server): restart it if it doesn't answer.
if systemctl --user is-enabled -q ride-forge-elevation 2>/dev/null; then
  elevation_ok=1
  if ! curl -sf -m 10 http://localhost:8998/elevation/health >/dev/null; then
    say "elevation service: no answer; restarting it"
    systemctl --user restart ride-forge-elevation
    elevation_ok=0
  fi
  result "Elevation" "$elevation_ok" "the elevation service wasn't answering, so it was restarted"
fi

# 6. The public address (the tunnel), when the route server itself is answering.
if [ "$check_public" = 1 ]; then
  if curl -sf -m 20 "$ROUTE_URL/info" | grep -q '"profiles"'; then
    result "Public address" 1 ""
  elif [ "$(systemctl --user is-active ride-forge-tunnel)" = active ] && [ "$(up_for ride-forge-tunnel)" -lt 120 ]; then
    say "tunnel: $ROUTE_URL not answering yet, but the tunnel started under 2 minutes ago"
  else
    say "tunnel: $ROUTE_URL not answering; restarting the tunnel"
    systemctl --user restart ride-forge-tunnel
    result "Public address" 0 "$ROUTE_URL wasn't answering, so the tunnel was restarted"
  fi
fi
