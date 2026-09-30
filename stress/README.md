# Stress tests on real roads

These plan loops from Caloundra the way the app does, make the edits a rider
makes, and count what goes wrong. They need the route server (GraphHopper on
`localhost:8989`, or `STRESS_SERVER=https://…`), so they don't run with
`npm test` or in CI.

```sh
npm run stress                    # both suites, compared with baseline.json
STRESS_UPDATE=1 npm run stress    # accept this run as the new baseline
```

- **loops** (`loops.stress.ts`): six loops of 90–130 km, each put through
  add a stop, reverse, drag a pin, Scenic, add a stop, Fastest, reverse and
  Twisty (54 plans).
- **legs** (`legs.stress.ts`): the same six loops with a style for every
  leg: Fastest, Scenic, Twisty and a mix, then add a stop and Fastest again
  (42 plans).

For each plan it counts failed routes, U-turns (and what they're near: home,
a hidden shaping point, one of the app's pins or the rider's own), and dead
ends ridden up and back ("spurs": how many, metres in all, and how many over
1 km; loops from home always have a ~300 m one on the home street).

A run fails when it's noticeably worse than `baseline.json`: any more failed
routes, more than 3 extra U-turns, 30% (+1.5 km) more riding up spurs, or
more than one extra spur over 1 km. After a change that makes routing
better, update the baseline so the next regression shows.

**Nightly:** `nightly.sh` runs both suites on the latest `main` at 3 am
Queensland time, in its own copy of the repo:
```sh
cp ~/Forge-Starter/stress/ride-forge-stress.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now ride-forge-stress.timer
journalctl --user -u ride-forge-stress     # each night's summary
```
Results are kept for a month in `~/.local/state/ride-forge-stress/`. With
`NTFY_TOPIC` set (see the health check in docs/own-route-server.md), a worse
night sends a phone notification.
