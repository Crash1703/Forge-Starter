import { useEffect, useRef, useState } from "react";
import ManeuverIcon from "./ManeuverIcon";
import RideAddStop, { type AddMode } from "./RideAddStop";
import type { RideLayer } from "./MapView";
import { distance, formatDistance, formatDuration, type LatLng } from "../lib/geo";
import { Announcer, maneuverKind, Navigator, spliceRejoin, type Fix, type NavRoute, type NavState } from "../lib/navigation";
import { routeBack, routeVia, speedLimits, type RouteOptions, type RouteResult } from "../lib/routes";
import { askToShowRideNotification, keepScreenOn, simulateRide, speak, subscribeGps, type Stop } from "../lib/device";

interface Props {
  route: RouteResult;
  options: RouteOptions;
  loop: boolean;
  /** Preview: ride the route at 4× speed without moving. */
  simulate: boolean;
  /** Bumped when the rider drags the map, which pauses following. */
  followBreaks: number;
  onLayer: (layer: RideLayer | null) => void;
  /** The rider paused (or resumed) the ride: hold recording too. */
  onPause?: (paused: boolean) => void;
  onExit: () => void;
}

const MUTE_KEY = "forge.muted";
/** Don't ask the router for a way back more often than this. */
const REROUTE_GAP_MS = 15_000;

/**
 * Ride mode: turn-by-turn along the planned route. Big type, voice prompts,
 * speed and limit, time to go. Leave the route and it finds a way back onto
 * it ahead, instead of re-planning the whole ride.
 */
export default function RideView({ route, options, loop, simulate, followBreaks, onLayer, onPause, onExit }: Props) {
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
      letSleep = await keepScreenOn().catch(() => () => undefined);
      letSleepRef.current = letSleep;
      stopGps = simulate
        ? simulateRide(route.path, onFix)
        : subscribeGps(onFix, (m) => !cancelled && setGpsNote(m));
    })();

    return () => {
      cancelled = true;
      stopGps();
      letSleep();
      letSleepRef.current();
      onLayer(null);
    };
    // One ride per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * A stop picked mid-ride: route from here to it, then (on the way) back
   * onto the route at its nearest point ahead, or (finish) end there.
   */
  async function addStop(place: { name: string; position: LatLng }, mode: AddMode) {
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
    active.current = next;
    nav.current = new Navigator(next);
    const home = mode === "via" && endsHome;
    setEndsHome(home);
    talk.current = new Announcer(home, true);
    loadLimits(next);
    setAdding(false);
    say(mode === "via" ? `Added a stop at ${place.name}.` : `Heading to ${place.name}.`);
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
      letSleepRef.current = await keepScreenOn().catch(() => () => undefined);
      // Don't go looking for a way back straight away if you've wandered off.
      lastReroute.current = Date.now() - REROUTE_GAP_MS + 5000;
      say("Resuming your ride.");
      const f = lastFix.current;
      if (f) setState(nav.current.update(f));
    }
  }

  // Tell the map what to draw: the road ahead and where you are.
  useEffect(() => {
    const n = nav.current;
    const path = active.current.path;
    const from = state ? n.indexAt(state.along) : 0;
    const ahead: LatLng[] = state ? [state.snapped, ...path.slice(from)] : path;
    onLayer({ ahead, position: state?.snapped ?? fix?.position ?? null, heading: state?.heading ?? null, follow });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, follow]);

  const steps = active.current.steps;
  const next = state ? steps[state.step] : steps[0];
  const after = state ? steps[state.step + 1] : undefined;
  const n = nav.current;
  const showThen = next && after && n.cum[after.at] - n.cum[next.at] < 400;
  const speedKmh = state?.speed != null ? Math.round(state.speed * 3.6) : null;
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
          {muted ? "🔇" : "🔊"}
        </button>
        {!state?.arrived && (
          <button className="ride-round ride-pause" aria-label={paused ? "Resume ride" : "Pause ride"} aria-pressed={paused} onClick={() => void togglePause()}>
            {paused ? "▶" : "⏸"}
          </button>
        )}

      </div>

      {paused && (
        <div className="ride-paused" role="status">
          <strong>⏸ Ride paused</strong>
          <span>Directions, voice{onPause ? " and recording" : ""} are on hold.</span>
          <button className="primary" onClick={() => void togglePause()}>
            ▶ Resume
          </button>
        </div>
      )}

      {adding && !paused && (
        <RideAddStop
          from={state?.snapped ?? fix?.position ?? route.path[0]}
          ahead={state ? active.current.path.slice(n.indexAt(state.along)) : active.current.path}
          onAdd={addStop}
          onClose={() => setAdding(false)}
        />
      )}

      {!follow && (
        <button className="ride-recentre" onClick={() => setFollow(true)}>
          ◎ Re-centre
        </button>
      )}

      <div className="ride-bottom">
        <div className={`ride-speed${over ? " over" : ""}`} aria-label={speedKmh != null ? `${speedKmh} km/h` : "Speed unknown"}>
          <strong>{speedKmh ?? "–"}</strong>
          <small>km/h</small>
        </div>
        {limit != null && (
          <div className="ride-limit" aria-label={`Speed limit ${limit}`}>
            {limit}
          </div>
        )}
        <div className="ride-eta">
          <strong>{eta ? eta.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "–"}</strong>
          <span>{state ? `${formatDistance(state.remaining)} · ${formatDuration(state.remainingTime)}` : "starting…"}</span>
        </div>
        {!state?.arrived && !paused && (
          <button className="ride-addstop" aria-label="Add a stop" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
            ＋<small>Stop</small>
          </button>
        )}
        <button className="ride-end" onClick={onExit}>
          End
        </button>
      </div>
    </div>
  );
}
