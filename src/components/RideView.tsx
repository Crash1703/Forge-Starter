import { useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import ManeuverIcon from "./ManeuverIcon";
import RideAddStop, { type AddMode } from "./RideAddStop";
import type { Poi, PoiKind } from "../lib/pois";
import type { FuelPrice } from "../lib/fuelPrices";
import type { RideLayer } from "./MapView";
import { distance, formatDistance, formatDuration, formatTime, speedUnit, toSpeed, type LatLng } from "../lib/geo";
import { Announcer, maneuverKind, Navigator, spliceLeg, spliceRejoin, type Fix, type NavRoute, type NavState } from "../lib/navigation";
import { routeBack, routeVia, speedLimits, STOP_TYPE, type RouteOptions, type RouteResult } from "../lib/routes";
import {
  askToShowRideNotification,
  clearOldTurnNotification,
  keepScreenOn,
  showOverLockScreen,
  simulateRide,
  speak,
  subscribeGps,
  type Stop,
} from "../lib/device";

interface Props {
  route: RouteResult;
  options: RouteOptions;
  loop: boolean;
  /** Preview: ride the route at 4× speed without moving. */
  simulate: boolean;
  /** Bumped when the rider drags the map, which pauses following. */
  followBreaks: number;
  onLayer: (layer: RideLayer | null) => void;
  /** Today's fuel price at a station, where known. */
  priceAt?: (p: LatLng) => FuelPrice | null;
  /** Fuel and cafés found in the planner, offered first when adding a stop. */
  knownPlaces?: Poi[];
  /** Let the screen sleep while navigating (voice still guides). */
  energySaving?: boolean;
  /** The rider paused (or resumed) the ride: hold recording too. */
  onPause?: (paused: boolean) => void;
  onExit: () => void;
}

/** A stop the rider added mid-ride. */
interface AddedStop {
  id: string;
  name: string;
  /** Fuel, café…: what it is, for its icon. Null for a searched place. */
  kind: PoiKind | null;
  position: LatLng;
  /** Where the route reaches it, on the road. */
  at: LatLng;
  /** Where its detour rejoins the route ("Stop on the way"). */
  rejoin: LatLng | null;
  /** "Finish here": the ride as it was before, to go back to if it's removed. */
  before: { route: NavRoute; from: number; endsHome: boolean } | null;
}

/** Path index where the route reaches `s`, at or after `from`; -1 if it no longer does. */
function stopIndex(s: AddedStop, path: LatLng[], from: number): number {
  for (let i = Math.max(0, from); i < path.length; i++) if (distance(path[i], s.at) < 25) return i;
  return -1;
}

/** Path index at or after `from` nearest to `p`. */
function nearestAfter(path: LatLng[], p: LatLng, from: number): number {
  let best = Math.min(Math.max(0, from), path.length - 1);
  let bestD = Infinity;
  for (let i = best; i < path.length; i++) {
    const d = distance(path[i], p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

const MUTE_KEY = "forge.muted";
/** Don't ask the router for a way back more often than this. */
const REROUTE_GAP_MS = 15_000;

/**
 * Ride mode: turn-by-turn along the planned route. Big type, voice prompts,
 * speed and limit, time to go. Leave the route and it finds a way back onto
 * it ahead, instead of re-planning the whole ride.
 */
export default function RideView({ route, options, loop, simulate, followBreaks, onLayer, onPause, onExit, energySaving, knownPlaces, priceAt }: Props) {
  const plan: NavRoute = { path: route.path, steps: route.steps, distance: route.distance, duration: route.duration };
  const active = useRef<NavRoute>(plan);
  const nav = useRef(new Navigator(plan));
  const talk = useRef(new Announcer(loop));
  const limits = useRef<(number | null)[]>([]);
  const lastReroute = useRef(0);
  const [state, setState] = useState<NavState | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);
  const [rerouting, setRerouting] = useState(false);
  const [gpsNote, setGpsNote] = useState("Finding your position…");
  const [follow, setFollow] = useState(true);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<AddedStop[]>([]);
  // "Finish here" turns a loop into a ride that ends somewhere else.
  const [endsHome, setEndsHome] = useState(loop);
  const lastFix = useRef<Fix | null>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const letSleepRef = useRef<Stop>(() => undefined);
  const [muted, setMuted] = useState(() => {
    try {
      return localStorage.getItem(MUTE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  // Dragging the map pauses following until "Re-centre".
  const firstBreak = useRef(followBreaks);
  useEffect(() => {
    if (followBreaks !== firstBreak.current) setFollow(false);
  }, [followBreaks]);

  const say = (text: string) => {
    if (!mutedRef.current) void speak(text).catch(() => undefined);
  };

  const loadLimits = (r: NavRoute) => {
    limits.current = [];
    speedLimits(r.path, options)
      .then((l) => {
        if (active.current === r) limits.current = l;
      })
      .catch(() => undefined); // no limits shown where the map has none or the server is busy
  };

  // Preview: the simulated rider, restarted along the route whenever it changes.
  const simFix = useRef<((f: Fix) => void) | null>(null);
  const simStop = useRef<Stop>(() => undefined);
  /** Preview: ride the route as it is now (after a stop, or a way back), not the one it began with. */
  const resimulate = (path: LatLng[]) => {
    if (!simulate || !simFix.current) return;
    simStop.current();
    simStop.current = simulateRide(path, simFix.current);
  };

  useEffect(() => {
    loadLimits(active.current);
    let stopGps: Stop = () => undefined;
    let letSleep: Stop = () => undefined;
    let cancelled = false;

    const onFix = (f: Fix) => {
      if (cancelled) return;
      setGpsNote("");
      setFix(f);
      lastFix.current = f;
      // Paused: show where you are, but no directions, voice or rerouting.
      if (pausedRef.current) return;
      const n = nav.current;
      const s = n.update(f);
      setState(s);
      const line = talk.current.next(s, active.current, (i) => {
        const steps = active.current.steps;
        return i > 0 ? n.cum[steps[i].at] - n.cum[steps[i - 1].at] : Infinity;
      });
      if (line) say(line);
      if (!s.onRoute && !s.arrived) void findWayBack(f, s);
    };

    const findWayBack = async (f: Fix, s: NavState) => {
      const now = Date.now();
      if (now - lastReroute.current < REROUTE_GAP_MS) return;
      lastReroute.current = now;
      setRerouting(true);
      const n = nav.current;
      // Never on the route yet (started away from it): join it near you, not at the start.
      const target = n.started ? n.rejoinIndex(800) : n.indexAt(n.cum[n.closestIndex(f.position)] + 300);
      try {
        const back = await routeBack(f.position, s.heading, active.current.path[target], options);
        if (cancelled) return;
        const joined = spliceRejoin(active.current, n, target, {
          path: back.path,
          steps: back.steps,
          distance: back.distance,
          duration: back.duration,
        });
        active.current = joined;
        nav.current = new Navigator(joined);
        talk.current = new Announcer(loop, true);
        loadLimits(joined);
        resimulate(joined.path);
        say("Found a way back to your route.");
        setState(nav.current.update(f));
      } catch {
        // Try again after the gap; meanwhile keep showing where the route is.
      } finally {
        if (!cancelled) setRerouting(false);
      }
    };

    (async () => {
      if (!simulate) await askToShowRideNotification();
      // Waking the phone mid-ride shows the ride, not the lock screen.
      if (!simulate) void showOverLockScreen(true);
      // 1.52 showed the next turn in a notification of its own; clear any left behind.
      if (!simulate) void clearOldTurnNotification();
      letSleep = energySaving ? () => undefined : await keepScreenOn().catch(() => () => undefined);
      letSleepRef.current = letSleep;
      if (simulate) {
        simFix.current = onFix;
        simStop.current = simulateRide(route.path, onFix);
        stopGps = () => simStop.current();
      } else stopGps = subscribeGps(onFix, (m) => !cancelled && setGpsNote(m));
    })();

    return () => {
      cancelled = true;
      stopGps();
      letSleep();
      letSleepRef.current();
      onLayer(null);
      if (!simulate) {
        void showOverLockScreen(false);
      }
    };
    // One ride per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * A stop picked mid-ride: route from here to it, then (on the way) back
   * onto the route at its nearest point ahead, or (finish) end there.
   */
  async function addStop(place: { name: string; position: LatLng; kind: PoiKind | null }, mode: AddMode) {
    const f = lastFix.current;
    if (!f) throw new Error("No position yet");
    const n = nav.current;
    const path = active.current.path;
    const here = state ? n.indexAt(state.along) : n.closestIndex(f.position);
    let rejoin = path.length - 1;
    if (mode === "via") {
      // Back onto the route where it passes closest to the stop, ahead of the rider.
      let bestD = Infinity;
      for (let i = here + 1; i < path.length; i++) {
        const d = distance(path[i], place.position);
        if (d < bestD) {
          bestD = d;
          rejoin = i;
        }
      }
    }
    const r = await routeVia(f.position, state?.heading ?? null, place, mode === "via" ? path[rejoin] : null, options);
    const leg: NavRoute = { path: r.path, steps: r.steps, distance: r.distance, duration: r.duration };
    const next = mode === "via" && rejoin < path.length - 1 ? spliceRejoin(active.current, n, rejoin, leg) : leg;
    const reached = r.steps.find((st) => st.type === STOP_TYPE);
    const stop: AddedStop = {
      id: `${Date.now()}`,
      name: place.name,
      kind: place.kind,
      position: place.position,
      at: reached ? r.path[reached.at] : r.path[r.path.length - 1],
      rejoin: mode === "via" ? path[rejoin] : null,
      before: mode === "finish" ? { route: active.current, from: here, endsHome } : null,
    };
    setAdded((a) => [...a, stop]);
    rideOn(next, mode === "via" && endsHome, f);
    setAdding(false);
    say(mode === "via" ? `Added a stop at ${place.name}.` : `Heading to ${place.name}.`);
  }

  /**
   * Take an added stop back out: from the stop before it (or from here), go
   * straight to where its detour rejoined the route. A "Finish here" stop
   * goes back to the ride as it was before it was added.
   */
  async function removeStop(id: string) {
    const x = added.find((s) => s.id === id);
    const f = lastFix.current;
    if (!x) return;
    if (!f) throw new Error("No position yet");
    const n = nav.current;
    const route = active.current;
    const path = route.path;
    const here = state ? n.indexAt(state.along) : n.closestIndex(f.position);
    const sx = stopIndex(x, path, here);
    const rest = added.filter((s) => s !== x);
    if (sx < 0) {
      // Already passed, or no longer on the route.
      setAdded(rest);
      return;
    }
    // The last of the rider's other stops before this one, if any: keep riding to it first.
    let anchor = -1;
    for (const s of rest) {
      const i = stopIndex(s, path, here);
      if (i >= 0 && i < sx && i > anchor) anchor = i;
    }
    let tail = route;
    let from: number;
    if (x.before) {
      tail = x.before.route;
      from = nearestAfter(tail.path, x.position, x.before.from);
    } else from = nearestAfter(path, x.rejoin ?? path[path.length - 1], sx + 1);
    const leg =
      anchor >= 0
        ? await routeBack(path[anchor], null, tail.path[from], options)
        : await routeBack(f.position, state?.heading ?? null, tail.path[from], options);
    const cut = anchor >= 0 ? anchor : here;
    const next = spliceLeg(route, Math.min(here, cut), cut, { path: leg.path, steps: leg.steps, distance: leg.distance, duration: leg.duration }, tail, from);
    setAdded(rest);
    rideOn(next, x.before ? x.before.endsHome : endsHome, f);
    say(`Removed ${x.name}.`);
  }

  /** Ride `next` from now on. */
  function rideOn(next: NavRoute, home: boolean, f: Fix) {
    active.current = next;
    nav.current = new Navigator(next);
    setEndsHome(home);
    talk.current = new Announcer(home, true);
    loadLimits(next);
    resimulate(next.path);
    setState(nav.current.update(f));
  }

  /** Pause: hold directions, voice, rerouting and recording; let the screen sleep. */
  async function togglePause() {
    const on = !pausedRef.current;
    pausedRef.current = on;
    setPaused(on);
    setAdding(false);
    onPause?.(on);
    if (on) {
      letSleepRef.current();
      letSleepRef.current = () => undefined;
      say("Ride paused.");
    } else {
      letSleepRef.current = energySaving ? () => undefined : await keepScreenOn().catch(() => () => undefined);
      // Don't go looking for a way back straight away if you've wandered off.
      lastReroute.current = Date.now() - REROUTE_GAP_MS + 5000;
      say("Resuming your ride.");
      const f = lastFix.current;
      if (f) setState(nav.current.update(f));
    }
  }

  // The added stops still ahead on the route.
  const here = state ? nav.current.indexAt(state.along) : 0;
  const stopsAhead = added.filter((s) => stopIndex(s, active.current.path, here) >= 0);

  // Tell the map what to draw: the road ahead, the stops added, and where you are.
  useEffect(() => {
    const n = nav.current;
    const path = active.current.path;
    const from = state ? n.indexAt(state.along) : 0;
    const ahead: LatLng[] = state ? [state.snapped, ...path.slice(from)] : path;
    onLayer({
      ahead,
      position: state?.snapped ?? fix?.position ?? null,
      heading: state?.heading ?? null,
      follow,
      stops: stopsAhead.map((s) => ({ id: s.id, name: s.name, kind: s.kind, position: s.position, finish: !!s.before })),
      onStop: () => !pausedRef.current && setAdding(true),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, follow, added]);

  const steps = active.current.steps;
  const next = state ? steps[state.step] : steps[0];
  const after = state ? steps[state.step + 1] : undefined;
  const n = nav.current;
  const showThen = next && after && n.cum[after.at] - n.cum[next.at] < 400;
  const speedKmh = state?.speed != null ? Math.round(state.speed * 3.6) : null;
  const speedShown = speedKmh != null ? Math.round(toSpeed(speedKmh)) : null;
  const limit = state ? (limits.current[n.indexAt(state.along)] ?? null) : null;
  const over = limit != null && speedKmh != null && speedKmh > limit + 3;
  const eta = state ? new Date(Date.now() + state.remainingTime * 1000) : null;


  return (
    <div className="ride" role="region" aria-label="Ride mode">
      <div className="ride-top">
        {state?.arrived ? (
          <div className="ride-next">
            <ManeuverIcon kind="arrive" />
            <div>
              <strong>{endsHome ? "Back home" : "Arrived"}</strong>
              <span>{formatDistance(route.distance)} ridden</span>
            </div>
          </div>
        ) : next ? (
          <div className="ride-next">
            <ManeuverIcon kind={maneuverKind(next.type)} />
            <div>
              <strong>{state ? formatDistance(state.toNext) : "–"}</strong>
              <span>{next.street ? `${next.exit ? `Exit ${next.exit} · ` : ""}${next.street}` : next.instruction}</span>
            </div>
          </div>
        ) : null}
        {showThen && !state?.arrived && (
          <div className="ride-then">
            Then <ManeuverIcon kind={maneuverKind(after.type)} size={24} />
          </div>
        )}
        {paused ? null : (state && !state.onRoute) || rerouting ? (
          <p className="ride-banner" role="status">
            Off route: finding the way back to your route…
          </p>
        ) : gpsNote ? (
          <p className="ride-banner" role="status">
            {gpsNote}
          </p>
        ) : null}
        {simulate && <p className="ride-preview">Preview ride · 4× speed</p>}
        <button
          className="ride-round ride-mute"
          aria-label={muted ? "Turn voice on" : "Mute voice"}
          aria-pressed={muted}
          onClick={() => {
            const m = !muted;
            setMuted(m);
            try {
              localStorage.setItem(MUTE_KEY, m ? "1" : "0");
            } catch {
              /* remembered for this ride only */
            }
          }}
        >
          <Icon name={muted ? "mute" : "volume"} size={22} />
        </button>
        {!state?.arrived && (
          <button className="ride-round ride-pause" aria-label={paused ? "Resume ride" : "Pause ride"} aria-pressed={paused} onClick={() => void togglePause()}>
            <Icon name={paused ? "play" : "pause"} size={22} filled={paused} />
          </button>
        )}

      </div>

      {paused && (
        <div className="ride-paused" role="status">
          <strong>Ride paused</strong>
          <span>Directions, voice{onPause ? " and recording" : ""} are on hold.</span>
          <button className="primary" onClick={() => void togglePause()}>
            <Icon name="play" size={20} filled /> Resume
          </button>
        </div>
      )}

      {adding && !paused && (
        <RideAddStop
          from={state?.snapped ?? fix?.position ?? route.path[0]}
          ahead={state ? active.current.path.slice(n.indexAt(state.along)) : active.current.path}
          onAdd={addStop}
          stops={stopsAhead.map((s) => ({ id: s.id, name: s.name, kind: s.kind, finish: !!s.before }))}
          onRemove={removeStop}
          known={knownPlaces}
          priceAt={priceAt}
          onClose={() => setAdding(false)}
        />
      )}

      {!follow && (
        <button className="ride-recentre" onClick={() => setFollow(true)}>
          <Icon name="locate" size={18} /> Re-centre
        </button>
      )}

      <div className="ride-bottom">
        <div className={`ride-speed${over ? " over" : ""}`} aria-label={speedShown != null ? `${speedShown} ${speedUnit()}` : "Speed unknown"}>
          <strong>{speedShown ?? "–"}</strong>
          <small>{speedUnit()}</small>
        </div>
        {limit != null && (
          <div className="ride-limit" aria-label={`Speed limit ${Math.round(toSpeed(limit))}`}>
            {Math.round(toSpeed(limit))}
          </div>
        )}
        <div className="ride-eta">
          <strong>{eta ? formatTime(eta) : "–"}</strong>
          <span>{state ? `${formatDistance(state.remaining)} · ${formatDuration(state.remainingTime)}` : "starting…"}</span>
        </div>
        {!state?.arrived && !paused && (
          <button className="ride-addstop" aria-label="Add a stop" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
            <Icon name="plus" size={22} />
            <small>Stop</small>
          </button>
        )}
        <button className="ride-end" onClick={onExit}>
          End
        </button>
      </div>
    </div>
  );
}
