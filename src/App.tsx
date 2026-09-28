import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Map as MapLibre } from "maplibre-gl";
import MapView from "./components/MapView";
import BottomSheet, { type Snap } from "./components/BottomSheet";
import TwistGauge from "./components/TwistGauge";
import RideView from "./components/RideView";
import RidesPanel from "./components/RidesPanel";
import WeatherStrip from "./components/WeatherStrip";
import StopsAlong from "./components/StopsAlong";
import type { Poi } from "./lib/pois";
import { useRecording } from "./lib/useRecording";
import { deleteRide, listRides, putRide } from "./lib/rideStore";
import { trackPath, type RideRecord } from "./lib/recorder";
import type { RideLayer } from "./components/MapView";
import MapErrorBoundary from "./components/MapErrorBoundary";
import PlaceSearch from "./components/PlaceSearch";
import ElevationChart from "./components/ElevationChart";
import {
  countBends,
  curvinessLabel,
  formatDistance,
  formatDuration,
  isDaylight,
  LOOP_KMH,
  loopThrough,
  roundTripWaypoints,
  twistScore,
  type LatLng,
} from "./lib/geo";
import { defaultOptions, planRoute, planSections, type RouteOptions, type RouteResult, type RouteStyle } from "./lib/routes";
import { elevationProfile, type ElevationProfile } from "./lib/elevation";
import { reverseGeocode } from "./lib/places";
import { parseGpx, sampleStops, toGpx } from "./lib/gpx";
import { saveFile, shareableUrl, shareLink } from "./lib/native";
import {
  decodeShare,
  encodeShare,
  loadSaved,
  newId,
  normalizeLoop,
  storeSaved,
  type SavedRoute,
  type Stop,
} from "./lib/storage";

const STYLES: { id: RouteStyle; name: string; hint: string }[] = [
  { id: "fastest", name: "Fastest", hint: "Quickest way, motorways allowed" },
  { id: "scenic", name: "Scenic", hint: "Avoids motorways, sensible detours" },
  { id: "twisty", name: "Twisty", hint: "Hunts for the curviest roads" },
];

/** Short commit ID of this build, shown in the footer so riders can tell whether a refresh picked up an update. */
const BUILD = (import.meta.env.VITE_BUILD_ID as string | undefined)?.slice(0, 7) || "dev";

/** Compass rose for round trips: 8 directions around "any direction". */
const COMPASS: { label: string; name: string; deg: number | null }[] = [
  { label: "NW", name: "North-west", deg: 315 },
  { label: "N", name: "North", deg: 0 },
  { label: "NE", name: "North-east", deg: 45 },
  { label: "W", name: "West", deg: 270 },
  { label: "Any", name: "Any direction", deg: null },
  { label: "E", name: "East", deg: 90 },
  { label: "SW", name: "South-west", deg: 225 },
  { label: "S", name: "South", deg: 180 },
  { label: "SE", name: "South-east", deg: 135 },
];

type MapTheme = "auto" | "light" | "dark";
const THEME_KEY = "forge.mapTheme";
const loadTheme = (): MapTheme => {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "auto";
  } catch {
    return "auto";
  }
};

/** The stops in riding order, including the ride back to the start on a loop. */
function ridePath(stops: Stop[], returnToStart: boolean): Stop[] {
  return returnToStart && stops.length > 1 ? [...stops, stops[0]] : stops;
}

export default function App() {
  const shared = useMemo(() => decodeShare(location.hash), []);
  const [stops, setStops] = useState<Stop[]>(shared?.stops ?? []);
  const [options, setOptions] = useState<RouteOptions>(shared?.options ?? defaultOptions);
  const [routes, setRoutes] = useState<RouteResult[]>([]);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [profile, setProfile] = useState<ElevationProfile | null>(null);
  const [hover, setHover] = useState<LatLng | null>(null);
  const [fitKey, setFitKey] = useState(0);
  const [tab, setTab] = useState<"plan" | "saved" | "rides">("plan");
  const [rides, setRides] = useState<RideRecord[]>([]);
  const [selectedRide, setSelectedRide] = useState<RideRecord | null>(null);
  const [showHistory, setShowHistory] = useState(() => {
    try {
      return localStorage.getItem("forge.showRides") === "1";
    } catch {
      return false;
    }
  });
  const [confirmStop, setConfirmStop] = useState(false);
  const [pois, setPois] = useState<Poi[]>([]);
  const backupInput = useRef<HTMLInputElement>(null);
  const autoRecord = useRef(false);
  const [saved, setSaved] = useState<SavedRoute[]>(loadSaved);
  const [name, setName] = useState("");
  const [loopKm, setLoopKm] = useState(120);
  const [loopMode, setLoopMode] = useState<"distance" | "time">("distance");
  const [loopMin, setLoopMin] = useState(120);
  const [loopDir, setLoopDir] = useState<number | null>(null); // compass degrees, null = any
  const [loopVia, setLoopVia] = useState<{ label: string; position: LatLng } | null>(null);
  // A time-based loop is checked once against its planned riding time, and resized if well off.
  const loopFit = useRef<{ targetSec: number; km: number } | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  const [toast, setToast] = useState("");
  const [center, setCenter] = useState<LatLng | undefined>();
  const [me, setMe] = useState<LatLng | null>(null);
  const [snap, setSnap] = useState<Snap>(shared ? "half" : "peek");
  const [cover, setCover] = useState(0);
  const [themePref, setThemePref] = useState<MapTheme>(loadTheme);
  const [daylight, setDaylight] = useState(true);
  const mapRef = useRef<MapLibre | null>(null);
  const [riding, setRiding] = useState<{ simulate: boolean } | null>(null);
  const [rideLayer, setRideLayer] = useState<RideLayer | null>(null);
  const [followBreaks, setFollowBreaks] = useState(0);
  const wantFit = useRef(!!shared);
  const dragFrom = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const route = routes[selected];
  const bends = useMemo(() => (route ? countBends(route.path) : 0), [route]);

  useEffect(() => {
    const fit = loopFit.current;
    if (!fit || !route || busy) return;
    loopFit.current = null;
    const ratio = fit.targetSec / Math.max(60, route.duration);
    // Close enough is fine: only resize when well off, and keep the same
    // direction so the loop just grows or shrinks rather than changing.
    if (ratio < 0.7 || ratio > 1.3) {
      makeLoop(Math.min(800, Math.max(10, fit.km * ratio)), true);
      flash(`Resizing the loop to about ${formatDuration(fit.targetSec)}`);
    }
    // Runs when a freshly planned route arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, busy]);

  // Auto map theme: dark from dusk to dawn where the map is (checked every 5 minutes).
  useEffect(() => {
    const check = () => {
      const c = mapRef.current?.getCenter();
      const here = me ?? center ?? stops[0]?.position ?? (c ? { lat: c.lat, lng: c.lng } : undefined);
      setDaylight(here ? isDaylight(here) : true);
    };
    check();
    const t = window.setInterval(check, 5 * 60_000);
    return () => clearInterval(t);
  }, [me, center, stops]);
  const theme = themePref === "auto" ? (daylight ? "light" : "dark") : themePref;

  function cycleTheme() {
    const next: MapTheme = themePref === "auto" ? "light" : themePref === "light" ? "dark" : "auto";
    setThemePref(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* remembered for this visit only */
    }
    flash(next === "auto" ? "Map: automatic (dark after sunset)" : next === "light" ? "Map: day" : "Map: night");
  }

  function centreOnMe() {
    if (!navigator.geolocation) {
      flash("Location isn't available here");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setMe(p);
        setCenter(p);
        mapRef.current?.easeTo({ center: [p.lng, p.lat], zoom: Math.max(mapRef.current.getZoom(), 13) });
      },
      () => flash("Couldn't get your location. Check location permission."),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(""), 2500);
  }, []);

  const refreshRides = useCallback(() => {
    listRides()
      .then(setRides)
      .catch(() => undefined);
  }, []);
  useEffect(refreshRides, [refreshRides]);

  const recording = useRecording((ride) => {
    refreshRides();
    setSelectedRide(ride);
    setTab("rides");
    setSnap("half");
    setFitKey((k) => k + 1);
    flash(`Ride saved: ${formatDistance(ride.stats.distance)}`);
  });

  async function stopRecording(save: boolean) {
    setConfirmStop(false);
    autoRecord.current = false;
    const tooShort = recording.state && recording.state.distance < recording.minMetres;
    await recording.stop(save);
    if (save && tooShort) flash("Too short to keep: rides under 200 m aren't saved");
  }

  const histories = useMemo(
    // Every 4th point is plenty for faint background lines.
    () => (showHistory ? rides.map((r) => trackPath(r.points).filter((_, i, a) => i % 4 === 0 || i === a.length - 1)) : []),
    [rides, showHistory],
  );
  const selectedTrack = useMemo(
    () => (tab === "rides" && selectedRide ? trackPath(selectedRide.points) : null),
    [tab, selectedRide],
  );

  // Recompute whenever the stops or options change (debounced so dragging feels calm).
  const stopsKey = stops.map((s) => `${s.position.lat},${s.position.lng}${s.auto ? "*" : ""}${s.legStyle ?? ""}`).join("|");
  useEffect(() => {
    if (stops.length < 2) {
      setRoutes([]);
      setProfile(null);
      setError("");
      return;
    }
    const ctrl = new AbortController();
    let replanning = false;
    const t = window.setTimeout(() => {
      setBusy(true);
      const ride = ridePath(stops, options.returnToStart);
      // No turning back at stops on a loop (or at generated loop points), so
      // the route can't ride up a dead end and straight back down it.
      const points = ride.map((s, i) => {
        const between = i > 0 && i < ride.length - 1;
        return {
          pos: s.position,
          noUturn: between && (options.returnToStart || s.auto),
          // Generated loop points are arbitrary, so any road within 1 km will do;
          // the rider's own pins may snap to a road within 75 m.
          radius: between ? (s.auto ? 1000 : 75) : undefined,
          movable: between && s.auto,
        };
      });
      // Sections with their own style are planned one at a time and joined.
      const styles = ride.slice(0, -1).map((s) => s.legStyle);
      (styles.some(Boolean) ? planSections(points, styles, options, ctrl.signal) : planRoute(points, options, ctrl.signal))
        .then((r) => {
          // A generated loop point the route has to ride up a dead end to
          // reach: move it to the foot of that road and plan again. Moved
          // points count as placed, so this happens once per point.
          const moves = r[0]?.moves ?? [];
          if (moves.length) {
            const to = new Map(moves.map((m) => [ride[m.stop].id, m.to]));
            setStops((ss) => ss.map((s) => (to.has(s.id) ? { ...s, position: to.get(s.id)!, auto: false } : s)));
            moves.forEach((m) => labelStop(ride[m.stop].id, m.to));
            flash(moves.length === 1 ? "Moved a loop point off a dead end" : `Moved ${moves.length} loop points off dead ends`);
            replanning = true;
            return;
          }
          setRoutes(r);
          setSnap((s) => (s === "peek" ? "half" : s));
          setSelected(0);
          setError("");
          if (wantFit.current) {
            wantFit.current = false;
            setFitKey((k) => k + 1);
          }
        })
        .catch((e: Error) => {
          if (e.name !== "AbortError") setError(e.message);
        })
        .finally(() => !ctrl.signal.aborted && !replanning && setBusy(false));
    }, 350);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // stopsKey captures the positions; labels changing must not re-route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopsKey, options]);

  useEffect(() => {
    setProfile(null);
    if (!route || route.path.length < 2) return;
    const ctrl = new AbortController();
    elevationProfile(route.path, ctrl.signal)
      .then(setProfile)
      .catch(() => !ctrl.signal.aborted && setProfile(null));
    return () => ctrl.abort();
  }, [route]);

  // Keep the URL shareable as the plan changes.
  useEffect(() => {
    const hash = stops.length >= 2 ? encodeShare(stops, options) : "";
    history.replaceState(null, "", hash || location.pathname + location.search);
  }, [stops, options]);

  const labelStop = useCallback((id: string, p: LatLng) => {
    reverseGeocode(p).then((label) => setStops((ss) => ss.map((s) => (s.id === id ? { ...s, label } : s))));
  }, []);

  function addStop(position: LatLng, label?: string, at?: number) {
    const id = newId();
    const stop = { id, position, label: label ?? "Locating…" };
    setStops((ss) => {
      const next = ss.slice();
      next.splice(at ?? ss.length, 0, stop);
      return next;
    });
    if (!label) labelStop(id, position);
    if (at === undefined && stops.length <= 1) wantFit.current = true;
  }

  function moveStop(id: string, position: LatLng) {
    setStops((ss) => ss.map((s) => (s.id === id ? { ...s, position, label: "Locating…", auto: false } : s)));
    labelStop(id, position);
  }

  function reorder(from: number, to: number) {
    if (from === to) return;
    setStops((ss) => {
      const next = ss.slice();
      const [s] = next.splice(from, 1);
      next.splice(to, 0, s);
      return next;
    });
  }

  function removeStop(id: string) {
    setStops((ss) => ss.filter((s) => s.id !== id));
  }

  /** Direction (or side, for a loop via a place) of the last loop made, reused when resizing it. */
  const loopShape = useRef<{ heading: number; side: 1 | -1 }>({ heading: 0, side: 1 });

  function makeLoop(km?: number, sameShape = false) {
    const origin = stops[0];
    if (!origin) {
      flash("Set a start point first");
      return;
    }
    const length = km ?? (loopMode === "distance" ? loopKm : (loopMin / 60) * LOOP_KMH[options.style]);
    let via: Stop[];
    if (loopVia) {
      // A different way round each time, unless resizing.
      const side = sameShape ? loopShape.current.side : Math.random() < 0.5 ? 1 : -1;
      loopShape.current.side = side;
      const { waypoints, viaIndex } = loopThrough(origin.position, loopVia.position, length * 1000, side);
      via = waypoints.map((p, i) =>
        i === viaIndex
          ? { id: newId(), position: p, label: loopVia.label }
          : { id: newId(), position: p, label: "Locating…", auto: true },
      );
    } else {
      // A chosen direction still varies a little, so "another loop" differs.
      const heading = sameShape
        ? loopShape.current.heading
        : loopDir == null
          ? Math.random() * 360
          : (loopDir + Math.random() * 40 - 20 + 360) % 360;
      loopShape.current.heading = heading;
      via = roundTripWaypoints(origin.position, length * 1000, heading).map((p) => ({
        id: newId(),
        position: p,
        label: "Locating…",
        auto: true,
      }));
    }
    setStops([{ ...origin, auto: false }, ...via]);
    setOptions((o) => ({ ...o, returnToStart: true }));
    via.filter((v) => v.auto).forEach((v) => labelStop(v.id, v.position));
    loopFit.current = loopMode === "time" && km === undefined ? { targetSec: loopMin * 60, km: length } : null;
    wantFit.current = true;
  }

  function locateMe() {
    if (!navigator.geolocation) {
      flash("Location isn't available in this browser");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setCenter(p);
        const id = newId();
        setStops((ss) => [{ id, position: p, label: "My location" }, ...ss.slice(ss.length > 1 ? 1 : 0)]);
        wantFit.current = true;
        setFitKey((k) => k + 1);
      },
      () => flash("Couldn't get your location"),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  /** Ride mode for real: record the ride too, unless already recording. */
  function startRide() {
    if (!recording.state) {
      recording.start(name.trim() || routeTitle());
      autoRecord.current = true;
    }
    setRiding({ simulate: false });
  }

  function planAgain(ride: RideRecord) {
    const plan = normalizeLoop(
      sampleStops(trackPath(ride.points), 8).map((p) => ({ id: newId(), position: p, label: "Locating…" })),
      options,
    );
    setStops(plan.stops);
    setOptions(plan.options);
    plan.stops.forEach((s) => labelStop(s.id, s.position));
    setName(ride.name);
    setSelectedRide(null);
    setTab("plan");
    wantFit.current = true;
  }

  function exportRide(ride: RideRecord) {
    const track = trackPath(ride.points);
    saveFile(
      `${ride.name.replace(/[^\w-]+/g, "_").slice(0, 60) || "ride"}.gpx`,
      toGpx({ name: ride.name, waypoints: [track[0], track[track.length - 1]], track }),
      "application/gpx+xml",
    ).catch(() => undefined);
  }

  function backUp() {
    const data = { app: "ride-forge", version: 1, savedAt: Date.now(), routes: saved, rides };
    const day = new Date().toISOString().slice(0, 10);
    saveFile(`ride-forge-backup-${day}.json`, JSON.stringify(data), "application/json")
      .then(() => flash(`Backed up ${saved.length} routes and ${rides.length} rides`))
      .catch(() => undefined);
  }

  async function restore(file: File) {
    try {
      const data = JSON.parse(await file.text());
      if (data?.app !== "ride-forge") throw new Error("That isn't a Ride Forge backup file");
      const routes: SavedRoute[] = Array.isArray(data.routes) ? data.routes : [];
      const newRoutes = routes.filter((r) => r?.id && !saved.some((x) => x.id === r.id));
      const merged = [...newRoutes, ...saved].sort((a, b) => b.savedAt - a.savedAt);
      setSaved(merged);
      storeSaved(merged);
      const incoming: RideRecord[] = Array.isArray(data.rides) ? data.rides : [];
      const newRides = incoming.filter((r) => r?.id && Array.isArray(r.points) && !rides.some((x) => x.id === r.id));
      for (const r of newRides) await putRide(r);
      refreshRides();
      flash(`Restored ${newRoutes.length} routes and ${newRides.length} rides`);
    } catch (e) {
      flash((e as Error).message || "Couldn't read that backup");
    }
  }

  function removeRide(ride: RideRecord) {
    deleteRide(ride.id)
      .then(() => {
        setSelectedRide(null);
        refreshRides();
        flash("Ride deleted");
      })
      .catch(() => flash("Couldn't delete that ride"));
  }

  function routeTitle() {
    const start = stops[0].label;
    return options.returnToStart ? `${start} loop` : `${start} → ${stops[stops.length - 1].label}`;
  }

  function saveRoute() {
    if (!route) return;
    const entry: SavedRoute = {
      id: newId(),
      name: name.trim() || routeTitle(),
      savedAt: Date.now(),
      stops,
      options,
      distance: route.distance,
      duration: route.duration,
      curviness: route.curviness,
    };
    const next = [entry, ...saved];
    setSaved(next);
    flash(storeSaved(next) ? "Route saved" : "Saved for this visit only (browser storage is blocked)");
    setName("");
  }

  function openSaved(r: SavedRoute) {
    const plan = normalizeLoop(
      r.stops.map((s) => ({ ...s, id: newId() })),
      { ...defaultOptions, ...r.options },
    );
    setStops(plan.stops);
    setOptions(plan.options);
    setName(r.name);
    wantFit.current = true;
    setTab("plan");
  }

  function deleteSaved(id: string) {
    const next = saved.filter((r) => r.id !== id);
    setSaved(next);
    storeSaved(next);
  }

  function exportGpx() {
    if (!route) return;
    const title = name.trim() || routeTitle();
    saveFile(
      `${title.replace(/[^\w-]+/g, "_").slice(0, 60) || "route"}.gpx`,
      toGpx({ name: title, waypoints: ridePath(stops, options.returnToStart).map((s) => s.position), track: route.path }),
      "application/gpx+xml",
    ).catch(() => {
      /* user closed the share sheet */
    });
  }

  async function importGpx(file: File) {
    try {
      const data = parseGpx(await file.text());
      const plan = normalizeLoop(
        data.waypoints.slice(0, 25).map((p) => ({ id: newId(), position: p, label: "Locating…" })),
        { ...options, returnToStart: false },
      );
      setStops(plan.stops);
      setOptions(plan.options);
      plan.stops.forEach((s) => labelStop(s.id, s.position));
      setName(data.name);
      wantFit.current = true;
      flash(data.waypoints.length > 25 ? "Imported the first 25 points (the routing limit)" : `Imported “${data.name}”`);
    } catch (e) {
      flash((e as Error).message);
    }
  }

  async function share() {
    const url = shareableUrl();
    try {
      if (!(await shareLink(name || "Route", url))) {
        await navigator.clipboard.writeText(url);
        flash("Link copied");
      }
    } catch {
      /* user cancelled the share sheet */
    }
  }

  const setOpt = <K extends keyof RouteOptions>(k: K, v: RouteOptions[K]) => setOptions((o) => ({ ...o, [k]: v }));

  return (
    <div className={`app${riding ? " riding" : ""}`}>
      {riding && route ? (
        <RideView
          route={route}
          options={options}
          loop={options.returnToStart}
          simulate={riding.simulate}
          followBreaks={followBreaks}
          onLayer={setRideLayer}
          onExit={() => {
            setRiding(null);
            setRideLayer(null);
            if (autoRecord.current) void stopRecording(true);
          }}
        />
      ) : (
      <BottomSheet snap={snap} onSnap={setSnap} onCover={setCover}>
        {recording.unfinished && !recording.state && (
          <section className="notice" role="status" data-peek>
            <p>
              An unfinished ride recording was found from{" "}
              {new Date(recording.unfinished.startedAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}.
            </p>
            <div className="button-row">
              <button className="primary" onClick={() => void recording.keepUnfinished()}>
                Save ride
              </button>
              <button onClick={() => void recording.discardUnfinished()}>Discard</button>
            </div>
          </section>
        )}
        {(route || busy) && (
          <section className="summary" aria-live="polite" data-peek>
            {busy && <div className="progress" />}
            {route ? (
              <>
                <TwistGauge curviness={route.curviness} />
                <div className="summary-text">
                  <strong>
                    <span className="nowrap">{formatDistance(route.distance)}</span> ·{" "}
                    <span className="nowrap">{formatDuration(route.duration)}</span>
                  </strong>
                  <span>
                    {[
                      `${bends} ${bends === 1 ? "bend" : "bends"}`,
                      profile ? `${Math.round(profile.ascent)} m climb` : null,
                      options.returnToStart ? "loop" : null,
                    ]
                      .filter(Boolean)
                      .map((part, i) => (
                        // Each phrase stays whole; lines break between them.
                        <span key={i}>
                          {i > 0 && " · "}
                          <span className="nowrap">{part}</span>
                        </span>
                      ))}
                  </span>
                  <button className="link preview" onClick={() => setRiding({ simulate: true })} disabled={busy}>
                    ▷ Preview ride
                  </button>
                </div>
                <button className="ride-go primary" onClick={startRide} disabled={busy}>
                  Ride
                </button>
              </>
            ) : (
              <div className="summary-text">
                <strong>Planning your route…</strong>
              </div>
            )}
          </section>
        )}
        <header className="brand">
          <span className="logo" aria-hidden>
            ◆
          </span>
          <h1>Forge</h1>
          <nav className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "plan"} onClick={() => setTab("plan")}>
              Plan
            </button>
            <button role="tab" aria-selected={tab === "saved"} onClick={() => setTab("saved")}>
              Saved{saved.length ? ` (${saved.length})` : ""}
            </button>
            <button role="tab" aria-selected={tab === "rides"} onClick={() => setTab("rides")}>
              Rides{rides.length ? ` (${rides.length})` : ""}
            </button>
          </nav>
        </header>

        {tab === "plan" ? (
          <div className="scroll">
            <section>
              <div onFocusCapture={() => setSnap("full")} data-peek={route ? undefined : ""}>
              <PlaceSearch
                near={stops[stops.length - 1]?.position ?? center}
                placeholder={stops.length ? "Add a stop or destination" : "Search for a start point"}
                onPick={(label, p) => {
                  addStop(p, label);
                  setSnap("half");
                }}
              />
              </div>
              <p className="hint">Or tap the map to add stops. Tap the route line to add a stop there, and drag pins to adjust.</p>

              {stops.length > 0 && (
                <ol className="stops">
                  {stops.map((s, i) => (
                    <li
                      key={s.id}
                      draggable
                      onDragStart={() => (dragFrom.current = i)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => {
                        if (dragFrom.current != null) reorder(dragFrom.current, i);
                        dragFrom.current = null;
                      }}
                    >
                      <StopBadge index={i} count={stops.length} loop={options.returnToStart} />
                      <span className="label" title={s.label}>
                        {s.label}
                      </span>
                      {(i < stops.length - 1 || (options.returnToStart && stops.length > 1)) && (
                        <select
                          className="leg-style"
                          aria-label={`Ride style from ${s.label} to the next stop`}
                          value={s.legStyle ?? ""}
                          onChange={(e) =>
                            setStops((ss) =>
                              ss.map((x) => (x.id === s.id ? { ...x, legStyle: (e.target.value || undefined) as RouteStyle | undefined } : x)),
                            )
                          }
                        >
                          <option value="">↓ {STYLES.find((x) => x.id === options.style)?.name}</option>
                          {STYLES.map((x) => (
                            <option key={x.id} value={x.id}>
                              ↓ {x.name}
                            </option>
                          ))}
                        </select>
                      )}
                      <span className="row-actions">
                        <button aria-label="Move up" disabled={i === 0} onClick={() => reorder(i, i - 1)}>
                          ↑
                        </button>
                        <button aria-label="Move down" disabled={i === stops.length - 1} onClick={() => reorder(i, i + 1)}>
                          ↓
                        </button>
                        <button aria-label="Remove stop" onClick={() => removeStop(s.id)}>
                          ✕
                        </button>
                      </span>
                    </li>
                  ))}
                  {options.returnToStart && stops.length > 1 && (
                    <li className="finish-row">
                      <span className="badge start">A</span>
                      <span className="label">Back to {stops[0].label}</span>
                    </li>
                  )}
                </ol>
              )}

              {stops.length > 1 && (
                <label className="check loop-toggle">
                  <input
                    id="return-to-start"
                    type="checkbox"
                    checked={options.returnToStart}
                    onChange={(e) => setOpt("returnToStart", e.target.checked)}
                  />
                  <span>
                    Loop back to the start (A)
                    <small>No turning around at stops, so the ride won't go up dead ends.</small>
                  </span>
                </label>
              )}

              <div className="button-row">
                <button onClick={locateMe}>◎ My location</button>
                {stops.length > 1 && (
                  <button
                    onClick={() =>
                      // On a loop, keep the start and ride the loop the other way round.
                      setStops((ss) => (options.returnToStart ? [ss[0], ...ss.slice(1).reverse()] : ss.slice().reverse()))
                    }
                  >
                    ⇅ Reverse
                  </button>
                )}
                {stops.length > 0 && (
                  <button
                    onClick={() => {
                      setStops([]);
                      setName("");
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
            </section>

            <section>
              <h2>Ride style</h2>
              <div className="segmented" role="radiogroup" aria-label="Ride style">
                {STYLES.map((s) => (
                  <button
                    key={s.id}
                    role="radio"
                    aria-checked={options.style === s.id}
                    title={s.hint}
                    onClick={() => setOpt("style", s.id)}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
              <p className="hint">{STYLES.find((s) => s.id === options.style)?.hint}</p>
              <div className="toggles">
                <label>
                  <input
                    type="checkbox"
                    checked={options.vehicle === "motorcycle"}
                    onChange={(e) => setOpt("vehicle", e.target.checked ? "motorcycle" : "car")}
                  />
                  Motorcycle routing
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={options.avoidHighways || options.style !== "fastest"}
                    disabled={options.style !== "fastest"}
                    onChange={(e) => setOpt("avoidHighways", e.target.checked)}
                  />
                  Avoid motorways
                </label>
                <label>
                  <input type="checkbox" checked={options.avoidTolls} onChange={(e) => setOpt("avoidTolls", e.target.checked)} />
                  Avoid tolls
                </label>
                <label>
                  <input type="checkbox" checked={options.avoidFerries} onChange={(e) => setOpt("avoidFerries", e.target.checked)} />
                  Avoid ferries
                </label>
              </div>
            </section>

            <section>
              <h2>Round trip</h2>
              <div className="segmented two" role="radiogroup" aria-label="Plan the loop by">
                {(["distance", "time"] as const).map((m) => (
                  <button key={m} role="radio" aria-checked={loopMode === m} onClick={() => setLoopMode(m)}>
                    {m === "distance" ? "Distance" : "Riding time"}
                  </button>
                ))}
              </div>
              <div className="loop">
                {loopMode === "distance" ? (
                  <input
                    id="loop-km"
                    type="range"
                    min={20}
                    max={500}
                    step={10}
                    value={loopKm}
                    onChange={(e) => setLoopKm(+e.target.value)}
                    aria-label="Round trip length"
                  />
                ) : (
                  <input
                    id="loop-min"
                    type="range"
                    min={30}
                    max={480}
                    step={15}
                    value={loopMin}
                    onChange={(e) => setLoopMin(+e.target.value)}
                    aria-label="Round trip riding time"
                  />
                )}
                <output>{loopMode === "distance" ? `${loopKm} km` : formatDuration(loopMin * 60)}</output>
              </div>
              <div className="loop-options">
                <div className={`compass${loopVia ? " disabled" : ""}`} role="radiogroup" aria-label="Head out towards">
                  {COMPASS.map((c) => (
                    <button
                      key={c.label}
                      role="radio"
                      aria-checked={loopDir === c.deg}
                      aria-label={c.name}
                      title={c.name}
                      disabled={!!loopVia}
                      onClick={() => setLoopDir(c.deg)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                <div className="loop-via">
                  <small>{loopVia ? "Riding via" : "Head out towards a direction, or ride via a place:"}</small>
                  {loopVia ? (
                    <span className="chip">
                      {loopVia.label}
                      <button aria-label={`Don't ride via ${loopVia.label}`} onClick={() => setLoopVia(null)}>
                        ✕
                      </button>
                    </span>
                  ) : (
                    <PlaceSearch
                      near={stops[0]?.position ?? center}
                      placeholder="Via a place (optional)"
                      onPick={(label, p) => setLoopVia({ label, position: p })}
                    />
                  )}
                </div>
              </div>
              <button className="wide" onClick={() => makeLoop()} disabled={!stops.length}>
                ↻ {options.returnToStart && stops.some((s) => s.auto) ? "Try another loop" : "Make a loop from A"}
              </button>
            </section>

            {(busy || error || route) && (
              <section className="result" aria-live="polite">
                {busy && <div className="progress" />}
                {error && <p className="error">{error}</p>}
                {route && (
                  <>
                    {routes.length > 1 && (
                      <div className="alternatives">
                        {routes.map((r, i) => (
                          <button key={r.id} aria-pressed={i === selected} onClick={() => setSelected(i)}>
                            <strong>{r.label}</strong>
                            <span>
                              {formatDistance(r.distance)} · {formatDuration(r.duration)}
                            </span>
                            <span className="curvy" title={curvinessLabel(r.curviness)}>
                              {twistScore(r.curviness).toFixed(1)}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                    <dl className="stats">
                      <div>
                        <dt>Distance</dt>
                        <dd>{formatDistance(route.distance)}</dd>
                      </div>
                      <div>
                        <dt>Time</dt>
                        <dd>{formatDuration(route.duration)}</dd>
                      </div>
                      <div>
                        <dt>Bends</dt>
                        <dd title={`${Math.round(route.curviness)}° of turning per km`}>{bends}</dd>
                      </div>
                      {profile && (
                        <div>
                          <dt>Climb</dt>
                          <dd>{Math.round(profile.ascent)} m</dd>
                        </div>
                      )}
                    </dl>
                    {route.warnings.map((w) => (
                      <p key={w} className="warning">
                        {w}
                      </p>
                    ))}
                    {profile && <ElevationChart profile={profile} onHover={setHover} />}
                    <WeatherStrip route={route} onHover={setHover} />
                    <StopsAlong
                      route={route}
                      onPois={setPois}
                      onFocus={(p) => mapRef.current?.easeTo({ center: [p.lng, p.lat], zoom: Math.max(mapRef.current.getZoom(), 14) })}
                    />

                    <div className="save">
                      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this route" aria-label="Route name" />
                      <button className="primary" onClick={saveRoute}>
                        Save
                      </button>
                    </div>
                    <div className="button-row">
                      <button onClick={exportGpx}>⤓ GPX</button>
                      <button onClick={share}>Share</button>
                      <button
                        onClick={() => {
                          const ride = ridePath(stops, options.returnToStart);
                          const dest = ride[ride.length - 1].position;
                          const way = ride.slice(1, -1).map((s) => `${s.position.lat},${s.position.lng}`).join("|");
                          window.open(
                            `https://www.google.com/maps/dir/?api=1&origin=${stops[0].position.lat},${stops[0].position.lng}&destination=${dest.lat},${dest.lng}${way ? `&waypoints=${encodeURIComponent(way)}` : ""}&travelmode=driving`,
                            "_blank",
                          );
                        }}
                        title="Open in Google Maps for turn-by-turn navigation (it re-routes, max 9 stops)"
                      >
                        Google Maps
                      </button>
                    </div>

                    <button className="link" onClick={() => setShowSteps((v) => !v)}>
                      {showSteps ? "Hide" : "Show"} directions ({route.steps.length})
                    </button>
                    {showSteps && (
                      <ol className="steps">
                        {route.steps.map((s, i) => (
                          <li key={i}>
                            <span>{s.instruction}</span>
                            <small>{formatDistance(s.distance)}</small>
                          </li>
                        ))}
                      </ol>
                    )}
                  </>
                )}
              </section>
            )}
          </div>
        ) : tab === "rides" ? (
          <RidesPanel
            rides={rides}
            selected={selectedRide}
            showHistory={showHistory}
            onToggleHistory={(on) => {
              setShowHistory(on);
              try {
                localStorage.setItem("forge.showRides", on ? "1" : "0");
              } catch {
                /* remembered for this visit */
              }
            }}
            onSelect={(r) => {
              setSelectedRide(r);
              if (r) setFitKey((k) => k + 1);
            }}
            onDelete={removeRide}
            onPlanAgain={planAgain}
            onExport={exportRide}
            onHover={setHover}
          />
        ) : (
          <div className="scroll">
            <section>
              <button className="wide" onClick={() => fileInput.current?.click()}>
                ⤒ Import GPX
              </button>
              <div className="button-row">
                <button onClick={backUp}>Back up routes &amp; rides</button>
                <button onClick={() => backupInput.current?.click()}>Restore a backup</button>
              </div>
              <p className="hint">A backup file moves your saved routes and rides between the website and the app, or to a new phone.</p>
              <input
                ref={backupInput}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void restore(f);
                  e.target.value = "";
                }}
              />
              <input
                ref={fileInput}
                type="file"
                accept=".gpx,application/gpx+xml"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    importGpx(f);
                    setTab("plan");
                  }
                  e.target.value = "";
                }}
              />
            </section>
            {saved.length === 0 ? (
              <p className="empty">No saved routes yet. Plan one and press Save.</p>
            ) : (
              <ul className="saved">
                {saved.map((r) => (
                  <li key={r.id}>
                    <button className="open" onClick={() => openSaved(r)}>
                      <strong>{r.name}</strong>
                      <span>
                        {formatDistance(r.distance)} · {formatDuration(r.duration)} · {curvinessLabel(r.curviness)}
                      </span>
                      <small>{new Date(r.savedAt).toLocaleDateString()}</small>
                    </button>
                    <button aria-label={`Delete ${r.name}`} onClick={() => deleteSaved(r.id)}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <footer className="credits">
          Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>{" "}
          contributors · tiles <a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> · routing{" "}
          <a href="https://valhalla.github.io/valhalla/" target="_blank" rel="noreferrer">Valhalla</a> (FOSSGIS) · search{" "}
          <a href="https://photon.komoot.io" target="_blank" rel="noreferrer">Photon</a> · elevation{" "}
          <a href="https://open-meteo.com" target="_blank" rel="noreferrer">Open-Meteo</a> · version {BUILD}
        </footer>
      </BottomSheet>
      )}

      <main className={`map-wrap${riding ? " riding" : ""}`}>
        <MapErrorBoundary>
          <MapView
            stops={stops}
            loop={options.returnToStart}
            routes={routes}
            selected={selected}
            hover={hover}
            fitKey={fitKey}
            theme={theme}
            insetBottom={riding ? 110 : cover}
            insetTop={riding ? 220 : 0}
            me={me}
            track={selectedTrack}
            pois={tab === "plan" ? pois : []}
            history={histories}
            ride={riding ? (rideLayer ?? { ahead: route?.path ?? [], position: null, heading: null, follow: true }) : null}
            onFollowBroken={() => setFollowBreaks((n) => n + 1)}
            onMapReady={(m) => (mapRef.current = m)}
            onMapClick={(p) => addStop(p)}
            onStopMove={moveStop}
            onRouteClick={(p, leg) => addStop(p, undefined, leg + 1)}
            onSelectRoute={setSelected}
          />
        </MapErrorBoundary>
        {!riding && (
        <div className="fabs">
          <button className="fab" onClick={cycleTheme} aria-label={`Map style: ${themePref}. Change`} title="Day, night or automatic map">
            <span aria-hidden>{themePref === "auto" ? "◐" : themePref === "light" ? "☀" : "☾"}</span>
            <small>{themePref === "auto" ? "Auto" : themePref === "light" ? "Day" : "Night"}</small>
          </button>
          <button
            className={`fab rec${recording.state ? " on" : ""}`}
            onClick={() => (recording.state ? setConfirmStop(true) : recording.start())}
            aria-label={recording.state ? "Stop recording" : "Record a ride"}
            title={recording.state ? "Stop recording" : "Record a ride"}
          >
            <span aria-hidden>{recording.state ? "■" : "●"}</span>
          </button>
          <button className="fab" onClick={centreOnMe} aria-label="Show my location">
            <span aria-hidden>◎</span>
          </button>
          {route && (
            <button className="fab" onClick={() => setFitKey((k) => k + 1)} aria-label="Zoom to route">
              <span aria-hidden>⤢</span>
            </button>
          )}
        </div>
        )}
        {recording.state && (
          <div className={`rec-pill${riding ? " riding" : ""}`} role="status">
            <span className="rec-dot" aria-hidden /> REC {formatClock(recording.state.elapsed)} · {formatDistance(recording.state.distance)}
          </div>
        )}
        {confirmStop && recording.state && (
          <div className="rec-confirm" role="dialog" aria-label="Stop recording?">
            <strong>Stop recording?</strong>
            <span>
              {formatDistance(recording.state.distance)} in {formatClock(recording.state.elapsed)}
            </span>
            <div className="button-row">
              <button className="primary" onClick={() => void stopRecording(true)}>
                Save ride
              </button>
              <button onClick={() => setConfirmStop(false)}>Keep recording</button>
              <button className="danger" onClick={() => void stopRecording(false)}>
                Discard
              </button>
            </div>
          </div>
        )}
        {toast && <div className="toast">{toast}</div>}
      </main>
    </div>
  );
}

/** A for the start, B for the finish, numbers in between. On a loop A is also the finish. */
function StopBadge({ index, count, loop }: { index: number; count: number; loop: boolean }) {
  const kind = index === 0 ? "start" : index === count - 1 && !loop ? "end" : "via";
  return <span className={`badge ${kind}`}>{kind === "start" ? "A" : kind === "end" ? "B" : index}</span>;
}

/** 1:05:09 or 5:09 */
function formatClock(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
