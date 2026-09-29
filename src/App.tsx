import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Map as MapLibre } from "maplibre-gl";
import MapView from "./components/MapView";
import BottomSheet, { type Snap } from "./components/BottomSheet";
import TwistGauge from "./components/TwistGauge";
import RideView from "./components/RideView";
import RidesPanel from "./components/RidesPanel";
import Icon, { type IconName } from "./components/Icon";
import SettingsScreen from "./components/SettingsScreen";
import StopList from "./components/StopList";
import RoundTripScreen, { type LoopStart } from "./components/RoundTripScreen";
import StopCard from "./components/StopCard";
import RideScoreCard from "./components/RideScoreCard";
import { rideScore, roadFacts, type RoadFacts } from "./lib/rideScore";
import type { LoopChoice, LoopShape } from "./lib/loopChoice";
import { findLoops as findLoopsAround, type FoundLoop } from "./lib/loopFinder";
import { requestsAtOnce } from "./lib/routeServer";
import { applySettings, loadSettings, storeSettings, type Settings } from "./lib/settings";
import { clearRecentSearches } from "./lib/places";
import { loadFuelPrices, priceNear, type FuelPrice, type Snapshot } from "./lib/fuelPrices";
import { MAX_SPAN, SIGHT_NAMES, sightsIn, type Bounds, type Sight } from "./lib/sights";
import WeatherStrip from "./components/WeatherStrip";
import StopsAlong from "./components/StopsAlong";
import { poiKind, type Poi } from "./lib/pois";
import { useRecording } from "./lib/useRecording";
import { deleteRide, listRides, putRide } from "./lib/rideStore";
import { trackPath, type RideRecord } from "./lib/recorder";
import type { RideLayer } from "./components/MapView";
import MapErrorBoundary from "./components/MapErrorBoundary";
import PlaceSearch from "./components/PlaceSearch";
import ElevationChart from "./components/ElevationChart";
import {
  bestInsertIndex,
  countBends,
  curvinessLabel,
  distance,
  midpointOffset,
  formatDistance,
  formatDuration,
  isDaylight,
  LOOP_KMH,
  loopLayout,
  loopThrough,
  roundTripWaypoints,
  twistScore,
  type LatLng,
} from "./lib/geo";
import { defaultOptions, planRoute, planSections, quickPlan, snapToRoad, throughRoadsNear, type RoutePoint, type RouteOptions, type RouteResult, type RouteStyle } from "./lib/routes";
import { elevationProfile, type ElevationProfile } from "./lib/elevation";
import { reverseGeocode } from "./lib/places";
import { parseGpx, sampleStops, toGpx } from "./lib/gpx";
import { saveFile, shareableUrl, shareLink } from "./lib/native";
import {
  decodeShare,
  encodeShare,
  loadHome,
  loadSaved,
  newId,
  normalizeLoop,
  reverseStops,
  routePoints,
  storeHome,
  storeSaved,
  type Home,
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

type MapTheme = "auto" | "light" | "dark" | "topo";

const MAP_LAYERS: { id: MapTheme; name: string; hint: string; icon: IconName }[] = [
  { id: "auto", name: "Automatic", hint: "Day map, dark after sunset", icon: "clock" },
  { id: "light", name: "Day", hint: "Road map", icon: "map" },
  { id: "dark", name: "Night", hint: "Dark road map", icon: "eye" },
  { id: "topo", name: "Terrain", hint: "Hills, contours and tracks", icon: "mountain" },
];
const THEME_KEY = "forge.mapTheme";
const loadTheme = (): MapTheme => {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" || t === "topo" ? t : "auto";
  } catch {
    return "auto";
  }
};

/** The stops in riding order, including the ride back to the start on a loop. */
/** Routes planned this visit, by stops and options, newest last. */
const plannedRoutes = new Map<string, RouteResult[]>();
const KEEP_ROUTES = 30;
function rememberRoutes(key: string, routes: RouteResult[]) {
  plannedRoutes.delete(key);
  plannedRoutes.set(key, routes);
  if (plannedRoutes.size > KEEP_ROUTES) plannedRoutes.delete(plannedRoutes.keys().next().value!);
}

/** What the router is asked to ride through for these stops. */
/** Rounds of moving a loop's points off dead ends before settling for what's left. */
const MAX_DEAD_END_FIXES = 2;

function planPoints(stops: Stop[], returnToStart: boolean): RoutePoint[] {
  const plan = routePoints(stops, returnToStart);
  // No turning back at stops on a loop (or at generated loop points), so
  // the route can't ride up a dead end and straight back down it.
  return plan.map(({ position, stop: s, shape }, i) => {
    const between = i > 0 && i < plan.length - 1;
    // Shaping points only steer: the route may pass anywhere within 2 km.
    if (between && shape >= 0) return { pos: position, via: true, radius: 2000, movable: true };
    return {
      pos: position,
      noUturn: between && (returnToStart || s.auto),
      // Generated loop points are arbitrary, so any road within 1 km will do;
      // the rider's own pins may snap to a road within 75 m.
      radius: between ? (s.auto ? 1000 : 75) : undefined,
      movable: between && s.auto,
    };
  });
}

/** Everything about the stops that changes the route (not their names). */
function keyOfStops(stops: Stop[]): string {
  return stops
    .map((s) => `${s.position.lat},${s.position.lng}${s.auto ? "*" : ""}${s.legStyle ?? ""}${(s.shape ?? []).map((p) => `/${p.lat},${p.lng}`).join("")}`)
    .join("|");
}

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
  /** Pins being moved onto the nearest road; planning waits for them. */
  const [snapping, setSnapping] = useState(0);
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
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [pois, setPois] = useState<Poi[]>([]);
  const backupInput = useRef<HTMLInputElement>(null);
  const autoRecord = useRef(false);
  const [saved, setSaved] = useState<SavedRoute[]>(loadSaved);
  const [name, setName] = useState("");
  const [loopKm, setLoopKm] = useState(120);
  const [loopMode, setLoopMode] = useState<"distance" | "time">("distance");
  const [loopMin, setLoopMin] = useState(120);
  const [loopScreen, setLoopScreen] = useState(false);
  const [loopStart, setLoopStart] = useState<LoopStart>("here");
  const [locating, setLocating] = useState(false);
  const [sightsOn, setSightsOn] = useState(false);
  const [passesOn, setPassesOn] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [home, setHomeState] = useState<Home | null>(loadHome);
  const [settings, setSettingsState] = useState<Settings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fuelData, setFuelData] = useState<Snapshot | null>(null);
  const [fuelNote, setFuelNote] = useState("");
  const [menu, setMenu] = useState<"avoid" | "more" | null>(null);
  /** Where the next searched place goes in the stop list (from a leg's +). */
  const [insertAt, setInsertAt] = useState<number | null>(null);
  const [sights, setSights] = useState<Sight[]>([]);
  const [sightsNote, setSightsNote] = useState("");
  const [sight, setSight] = useState<Sight | null>(null);
  /** A place along the route (fuel, a café…) whose card is open. */
  const [poiCard, setPoiCard] = useState<Poi | null>(null);
  /** Close the card of a sight or a place along the route. */
  const closePlace = () => {
    setSight(null);
    setPoiCard(null);
  };
  /** The stop whose pin was tapped: its card is open. */
  const [stopCardId, setStopCardId] = useState<string | null>(null);
  /** The open place's "Loop via here": choosing where to start. */
  const [loopPick, setLoopPick] = useState(false);
  useEffect(() => setLoopPick(false), [sight]);
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
  const fileInput = useRef<HTMLInputElement>(null);

  const route = routes[selected];
  const stopCardIndex = stopCardId ? stops.findIndex((s) => s.id === stopCardId) : -1;
  const stopCard = stopCardIndex >= 0 ? { stop: stops[stopCardIndex], index: stopCardIndex } : null;
  /** Each leg's distance and time, when the planned route matches the stops. */
  const stopLegs = route && !busy && route.legs.length === (options.returnToStart ? stops.length : stops.length - 1) ? route.legs : null;
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

  // Sights for the part of the map in view, re-checked as the map moves.
  useEffect(() => {
    const m = mapRef.current;
    if ((!sightsOn && !passesOn) || !m) {
      setSights([]);
      setSightsNote("");
      return;
    }
    let loaded: Bounds | null = null;
    let ctrl: AbortController | null = null;
    let timer = 0;
    const inside = (b: Bounds, o: Bounds) => b.south >= o.south && b.north <= o.north && b.west >= o.west && b.east <= o.east;
    const check = () => {
      const g = m.getBounds();
      const b = { south: g.getSouth(), west: g.getWest(), north: g.getNorth(), east: g.getEast() };
      if (b.north - b.south > MAX_SPAN || b.east - b.west > MAX_SPAN) {
        setSightsNote("Zoom in to see sights");
        return;
      }
      if (loaded && inside(b, loaded)) return;
      // Fetch a little beyond the view so small pans don't need another lookup.
      const padLat = (b.north - b.south) * 0.25;
      const padLng = (b.east - b.west) * 0.25;
      const want = { south: b.south - padLat, north: b.north + padLat, west: b.west - padLng, east: b.east + padLng };
      ctrl?.abort();
      ctrl = new AbortController();
      setSightsNote("Looking for sights…");
      sightsIn(want, ctrl.signal, { sights: sightsOn, passes: passesOn })
        .then((found) => {
          loaded = want;
          setSights(found);
          setSightsNote(found.length ? "" : "No sights found here");
        })
        .catch((e: Error) => e.name !== "AbortError" && setSightsNote(e.message));
    };
    const onMove = () => {
      clearTimeout(timer);
      timer = window.setTimeout(check, 700);
    };
    check();
    m.on("moveend", onMove);
    return () => {
      m.off("moveend", onMove);
      clearTimeout(timer);
      ctrl?.abort();
    };
  }, [sightsOn, passesOn]);

  // Queensland fuel prices, when there are fuel stations to price (or a ride
  // is on) and the rider has a token; refreshed every 15 minutes.
  const wantPrices = !!settings.fuelToken && (!!riding || pois.some((p) => p.kind === "fuel"));
  useEffect(() => {
    if (!wantPrices) return;
    let stop = false;
    const load = () =>
      loadFuelPrices(settings.fuelToken)
        .then((d) => {
          if (stop) return;
          setFuelData(d);
          setFuelNote("");
        })
        .catch((e: Error) => !stop && setFuelNote(e.message));
    void load();
    const t = window.setInterval(load, 15 * 60_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [wantPrices, settings.fuelToken]);
  const priceAt = useCallback(
    (p: LatLng): FuelPrice | null => (fuelData && settings.fuelToken ? priceNear(p, fuelData, settings.fuelType) : null),
    [fuelData, settings.fuelToken, settings.fuelType],
  );

  /** What the open place card shows: a sight, or a place along the route (with its fuel price). */
  const place: { name: string; position: LatLng; note: string; photo?: string; link?: { href: string; label: string } } | null = sight
    ? {
        name: sight.name,
        position: sight.position,
        note: `${SIGHT_NAMES[sight.kind]}${sight.ele != null ? ` · ${sight.ele.toLocaleString()} m` : ""}`,
        photo: sight.photo,
        ...(sight.link ? { link: { href: sight.link, label: "Wikipedia ↗" } } : {}),
      }
    : poiCard
      ? {
          name: poiCard.name,
          position: poiCard.position,
          note: [
            poiKind(poiCard.kind).one,
            poiCard.kind === "fuel" && priceAt(poiCard.position) ? `${priceAt(poiCard.position)!.cents.toFixed(1)} c/L` : "",
            `${formatDistance(poiCard.at)} along the route`,
          ]
            .filter(Boolean)
            .join(" · "),
          // Opening hours, reviews and photos live there.
          link: { href: `https://www.google.com/maps/search/?api=1&query=${poiCard.position.lat},${poiCard.position.lng}`, label: "Google Maps ↗" },
        }
      : null;

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

  function pickLayer(next: MapTheme) {
    setLayersOpen(false);
    setThemePref(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* remembered for this visit only */
    }
    flash(`Map: ${MAP_LAYERS.find((l) => l.id === next)?.name.toLowerCase()}`);
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

  const toastTimer = useRef(0);
  const flash = useCallback((msg: string) => {
    setToast(msg);
    // A newer message gets its full time on screen, not what's left of the last one's.
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2500);
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
  const stopsKey = keyOfStops(stops);
  /** Stops that moved onto the road their route already uses: no need to plan again. */
  const alreadyPlanned = useRef<string | null>(null);
  /** Rounds of moving generated points off dead ends since the last plan that needed none. */
  const deadEndFixes = useRef(0);
  useEffect(() => {
    if (stops.length < 2) {
      setRoutes([]);
      setProfile(null);
      setError("");
      return;
    }
    // A pin is on its way onto the road: plan once it's there.
    if (snapping > 0) return;
    if (alreadyPlanned.current === stopsKey) {
      alreadyPlanned.current = null;
      return;
    }
    alreadyPlanned.current = null;
    const ctrl = new AbortController();
    let replanning = false;
    /** Show newly planned routes. */
    const show = (r: RouteResult[]) => {
      setRoutes(r);
      setSnap((s) => (s === "peek" ? "half" : s));
      setSelected(0);
      setError("");
      if (wantFit.current) {
        wantFit.current = false;
        setFitKey((k) => k + 1);
      }
    };
    const t = window.setTimeout(() => {
      const ride = ridePath(stops, options.returnToStart);
      const plan = routePoints(stops, options.returnToStart);
      const points = planPoints(stops, options.returnToStart);
      // Sections with their own style are planned one at a time and joined.
      const styles = ride.slice(0, -1).map((s) => s.legStyle);
      // The same stops and options as a moment ago (say, back to Twisty after
      // a look at Fastest): no need to ask the router again.
      const key = JSON.stringify([points, styles, options]);
      const known = plannedRoutes.get(key);
      if (known) {
        show(known);
        setBusy(false);
        return;
      }
      setBusy(true);
      (styles.some(Boolean) ? planSections(points, styles, options, ctrl.signal) : planRoute(points, options, ctrl.signal))
        .then((r) => {
          // A generated loop point the route has to ride up a dead end to
          // reach: move it to the foot of that road and plan again. The
          // points stay the app's, so a later change (another ride style
          // reaches them differently) can move them again; a few rounds per
          // change at most, so it can never go round in circles.
          const moves = r[0]?.moves ?? [];
          if (moves.length && deadEndFixes.current < MAX_DEAD_END_FIXES) {
            deadEndFixes.current++;
            // A pin moves to just before the dead end's turn-off; a shaping
            // point that led there is simply dropped.
            const to = new Map(moves.filter((m) => plan[m.stop].shape < 0).map((m) => [plan[m.stop].stop.id, m.to]));
            const drop = new Set(moves.filter((m) => plan[m.stop].shape >= 0).map((m) => `${plan[m.stop].stop.id}/${plan[m.stop].shape}`));
            setStops((ss) =>
              ss.map((s) => {
                const shape = s.shape?.filter((_, k) => !drop.has(`${s.id}/${k}`));
                const moved = to.has(s.id) ? { position: to.get(s.id)! } : {};
                return { ...s, ...moved, ...(s.shape ? { shape } : {}) };
              }),
            );
            to.forEach((p, id) => labelStop(id, p));
            flash(moves.length === 1 ? "Kept the loop off a dead end" : `Kept the loop off ${moves.length} dead ends`);
            replanning = true;
            return;
          }
          deadEndFixes.current = 0;
          rememberRoutes(key, r);
          show(r);
          // Pins the app placed (loops, round trips) go where the route
          // actually meets the road, so none sits in a paddock or the water.
          // The route already runs there, so nothing needs planning again.
          const at = r[0]?.stopsAt;
          if (at && at.length >= stops.length) {
            const moved = stops.map((s, i) => (s.auto && !s.free && distance(s.position, at[i]) > 25 ? { ...s, position: at[i] } : s));
            if (moved.some((s, i) => s !== stops[i])) {
              alreadyPlanned.current = keyOfStops(moved);
              setStops(moved);
              moved.forEach((s, i) => s !== stops[i] && labelStop(s.id, s.position));
            }
          }
        })
        .catch((e: Error) => {
          deadEndFixes.current = 0;
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
  }, [stopsKey, options, snapping > 0]);

  // What the roads are (towns, motorways, dirt) for the RideScore; kept per route.
  const [facts, setFacts] = useState<RoadFacts | null>(null);
  const factsFor = useRef(new Map<string, RoadFacts>());
  useEffect(() => {
    if (!route || route.path.length < 2) {
      setFacts(null);
      return;
    }
    const known = factsFor.current.get(route.id);
    setFacts(known ?? null);
    if (known) return;
    const ctrl = new AbortController();
    roadFacts(route.path, options, ctrl.signal)
      .then((f) => {
        factsFor.current.set(route.id, f);
        setFacts(f);
      })
      .catch(() => {
        /* the score shows without town and surface */
      });
    return () => ctrl.abort();
    // The route carries its options; options alone changing re-plans anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);
  const score = useMemo(() => (route ? rideScore(route, facts, profile ? profile.ascent : null) : null), [route, facts, profile]);

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

  function toggleHistory(on: boolean) {
    setShowHistory(on);
    try {
      localStorage.setItem("forge.showRides", on ? "1" : "0");
    } catch {
      /* remembered for this visit */
    }
  }

  function changeSettings(s: Settings) {
    applySettings(s);
    setSettingsState(s);
    storeSettings(s);
  }

  function addStop(position: LatLng, label?: string, at?: number, free = false) {
    const id = newId();
    // "Set via points intelligently": fit it in where it adds the least riding.
    if (at === undefined && settings.smartVias && stops.length >= 2) {
      at = bestInsertIndex(
        stops.map((s) => s.position),
        position,
        options.returnToStart,
      );
    }
    const stop: Stop = { id, position, label: label ?? "Locating…", ...(free ? { free: true } : {}) };
    setStops((ss) => {
      const next = ss.slice();
      next.splice(at ?? ss.length, 0, stop);
      return next;
    });
    // A spot tapped on the map goes onto the nearest road (a searched place stays where it is).
    if (!label && free) labelStop(id, position);
    else if (!label) placeOnRoad(id, position, true);
    if (at === undefined && stops.length <= 1) wantFit.current = true;
  }

  /**
   * A new ride straight to a place: from where the rider is (or the current
   * start if their location isn't known yet), not a loop.
   */
  function rideTo(to: { name: string; position: LatLng }) {
    const from = me ? { id: newId(), position: me, label: "My location" } : stops[0] ? { ...stops[0], shape: undefined } : null;
    if (!from) {
      flash("Set a start point first");
      return;
    }
    closePlace();
    setLoopChoices([]);
    setOptions((o) => ({ ...o, returnToStart: false }));
    setStops([from, { id: newId(), position: to.position, label: to.name }]);
    setName("");
    wantFit.current = true;
  }

  /**
   * Move a pin the rider put down onto the nearest rideable road, as
   * Calimoto does, then name it. Route planning waits for this, so the
   * route is planned once, from the road.
   */
  function placeOnRoad(id: string, raw: LatLng, rename: boolean) {
    setSnapping((n) => n + 1);
    snapToRoad(raw, options)
      .then((p) => {
        // Only if the pin hasn't been moved again meanwhile.
        setStops((ss) => ss.map((s) => (s.id === id && s.position.lat === raw.lat && s.position.lng === raw.lng ? { ...s, position: p } : s)));
        if (rename) labelStop(id, p);
      })
      .finally(() => setSnapping((n) => n - 1));
  }

  function moveStop(id: string, position: LatLng) {
    // A name the rider gave stays; otherwise name the new spot.
    const stop = stops.find((s) => s.id === id);
    const named = stop?.named;
    setStops((ss) => ss.map((s) => (s.id === id ? { ...s, position, auto: false, ...(named ? {} : { label: "Locating…" }) } : s)));
    // A pin placed by holding stays exactly where it's dropped.
    if (stop?.free) {
      if (!named) labelStop(id, position);
    } else placeOnRoad(id, position, !named);
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
  const loopShape = useRef<{ heading: number; scale: number; side: 1 | -1; fitted: number; variant: number }>({
    heading: 0,
    scale: 1,
    side: 1,
    fitted: 0,
    variant: 0,
  });
  /** The loop search in progress, and the start and length it was for (to build another choice). */
  const loopSearch = useRef<AbortController | null>(null);
  const loopContext = useRef<{ origin: Stop; length: number; km?: number } | null>(null);
  /** How many loop shapes are being tried (0 when not searching). */
  const [findingLoop, setFindingLoop] = useState(0);
  /** The loops on offer after a search: the one ridden is `loopChoice`. */
  const [loopChoices, setLoopChoices] = useState<{ label: string; heading: number; scale: number; ring: LatLng[]; km: number; curves: number }[]>([]);
  const [loopChoice, setLoopChoice] = useState(0);
  /** The place a loop was made to visit, as its stop (so Recalculate knows the loop is ours to redo). */
  const [placeStopId, setPlaceStopId] = useState<string | null>(null);
  /** The last loop via a place was sized to fit the place (from a place's card), not to a length. */
  const loopFitsPlace = useRef(false);

  /**
   * Make a loop from `from` (default: the first stop): two pins round a
   * circle, with shaping points between them so the loop keeps its shape
   * without the rider having to reach many exact places. Via a place, the
   * loop is an oval out to the place and back another way, with the place
   * as its only pin; `fitPlace` makes it just big enough for that.
   *
   * A loop that fits the place has no guessed points at all: the road out
   * is the router's choice, and the way home is re-planned to stay off it
   * (see planRoute), so both follow real roads. Recalculate then tries one
   * steering point off to one side, then the other, then none again.
   */
  function makeLoop(
    km?: number,
    sameShape = false,
    from?: Stop,
    place: { label: string; position: LatLng } | null = loopVia,
    fitPlace = loopFitsPlace.current,
  ) {
    const origin = from ?? stops[0];
    if (!origin) {
      flash("Set a start point first");
      return;
    }
    const length = km ?? (loopMode === "distance" ? loopKm : (loopMin / 60) * LOOP_KMH[options.style]);
    let ring: LatLng[];
    let pins = [1, 3];
    let viaIndex = -1;
    // Resize to fit the riding time only when that's possible.
    let canFit = true;
    if (place && fitPlace) {
      // 0: no steering; 1 and 2: one point off to the left or right of the
      // straight line, on the way out (the way home finds its own road).
      const variant = sameShape ? loopShape.current.variant : (loopShape.current.variant + 1) % 3;
      loopShape.current.variant = variant;
      const d = distance(origin.position, place.position);
      const steer = variant === 0 ? [] : [midpointOffset(origin.position, place.position, (variant === 1 ? 1 : -1) * Math.min(0.25, 5000 / Math.max(d, 1)))];
      ring = [...steer, place.position];
      viaIndex = ring.length - 1;
      pins = [viaIndex];
      canFit = false;
    } else if (place) {
      // The other way round each time (out the way it came back last
      // time), unless resizing; a loop that fits the place also varies in
      // width a little, so Recalculate always gives a different ride.
      const side = sameShape ? loopShape.current.side : loopShape.current.side > 0 ? -1 : 1;
      loopShape.current.side = side;
      const shortest = loopThrough(origin.position, place.position, 0, side).minMetres;
      const target = fitPlace ? (sameShape ? loopShape.current.fitted : shortest * (1 + Math.random() * 0.3)) : length * 1000;
      loopShape.current.fitted = target;
      const loop = loopThrough(origin.position, place.position, target, side);
      ({ waypoints: ring, viaIndex } = loop);
      canFit = !fitPlace && loop.minMetres < length * 1000 * 0.9;
      pins = [viaIndex];
    } else if (sameShape) {
      // Resizing to fit a riding time: the same way round, bigger or smaller.
      ring = roundTripWaypoints(origin.position, length * 1000 * loopShape.current.scale, loopShape.current.heading, 5);
    } else {
      // A new loop: try several shapes, keep the best (and offer two others).
      void findLoops(origin, length, km);
      return;
    }
    if (!place || sameShape) setLoopChoices((c) => (sameShape ? c : []));
    else setLoopChoices([]);
    applyLoop(origin, ring, pins, viaIndex, place, fitPlace, canFit, length, km);
  }

  /** Put a generated loop's stops in place (pins and shaping points from `ring`). */
  function applyLoop(
    origin: Stop,
    ring: LatLng[],
    pins: number[],
    viaIndex: number,
    place: { label: string; position: LatLng } | null,
    fitPlace: boolean,
    canFit: boolean,
    length: number,
    km?: number,
  ) {
    const stopsNow = loopStops(origin, ring, pins, viaIndex, place);
    const via = stopsNow.slice(1);
    setStops(stopsNow);
    setPlaceStopId(place && fitPlace ? (via.find((v) => !v.auto)?.id ?? null) : null);
    setOptions((o) => ({ ...o, returnToStart: true }));
    via.filter((v) => v.auto).forEach((v) => labelStop(v.id, v.position));
    loopFit.current = loopMode === "time" && km === undefined && canFit ? { targetSec: loopMin * 60, km: length } : null;
    wantFit.current = true;
  }

  /** The stops for a loop from `origin` round `ring`: a few pins, the rest shaping points. */
  function loopStops(origin: Stop, ring: LatLng[], pins: number[], viaIndex: number, place: { label: string; position: LatLng } | null): Stop[] {
    const layout = loopLayout(ring, pins);
    const via: Stop[] = layout.stops.map((p) =>
      p.index === viaIndex
        ? { id: newId(), position: p.position, label: place!.label, shape: p.shape, auto: false }
        : { id: newId(), position: p.position, label: "Locating…", auto: true, shape: p.shape },
    );
    return [{ ...origin, shape: layout.startShape, auto: false }, ...via];
  }

  /**
   * A new round trip: try several loop shapes, tidy up the most promising
   * (off dead ends, nearer the asked length), then plan the best balance
   * properly and offer the curviest and one heading another way as
   * alternatives (see loopFinder).
   */
  async function findLoops(origin: Stop, length: number, km?: number) {
    loopSearch.current?.abort();
    const ctrl = new AbortController();
    loopSearch.current = ctrl;
    const atOnce = requestsAtOnce();
    const count = atOnce > 2 ? 8 : 6;
    const opts = { ...options, returnToStart: true };
    setLoopChoices([]);
    setFindingLoop(count);
    let choices: LoopChoice[] = [];
    try {
      ({ choices } = await findLoopsAround(
        {
          origin: origin.position,
          targetMetres: length * 1000,
          heading: loopDir,
          count,
          atOnce,
          plan: (ring) => quickPlan(planPoints(loopStops(origin, ring, [1, 3], -1, null), true), opts, ctrl.signal),
          locate: (points) => throughRoadsNear(points, opts, ctrl.signal),
        },
        ctrl.signal,
      ));
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
    } finally {
      if (loopSearch.current === ctrl) setFindingLoop(0);
    }
    if (ctrl.signal.aborted) return;
    loopContext.current = { origin, length, km };
    setLoopChoices(
      choices.map((c) => ({ label: c.label, heading: c.loop.heading, scale: c.loop.scale, ring: (c.loop as FoundLoop).ring, km: c.loop.route.distance / 1000, curves: c.loop.curves })),
    );
    setLoopChoice(0);
    // Nothing answered (offline, server busy): fall back to one loop, planned the usual way.
    const first = choices[0]?.loop as FoundLoop | undefined;
    takeLoopShape(first ?? { heading: loopDir ?? Math.random() * 360, scale: 1 });
  }

  /** Build the loop for one of the tried shapes (through the points it was tidied to, if any). */
  function takeLoopShape(s: LoopShape & { ring?: LatLng[] }) {
    const ctx = loopContext.current;
    if (!ctx) return;
    loopShape.current.heading = s.heading;
    loopShape.current.scale = s.scale;
    const ring = s.ring ?? roundTripWaypoints(ctx.origin.position, ctx.length * 1000 * s.scale, s.heading, 5);
    applyLoop(ctx.origin, ring, [1, 3], -1, null, false, true, ctx.length, ctx.km);
  }

  const isGeneratedLoop = options.returnToStart && stops.some((s) => s.auto || s.shape?.length || s.id === placeStopId);
  // Dirt roads are avoided unless turned off, so only the rider's own choices count.
  const avoidCount = [options.avoidHighways && options.style === "fastest", options.avoidTolls, options.avoidFerries].filter(Boolean).length;

  /** Start again: the planned route and its stops go (saved routes stay). `message` is shown as a toast. */
  const discardRide = (message: string) => {
    setConfirmDiscard(false);
    setStops([]);
    setName("");
    setLoopChoices([]);
    setStopCardId(null);
    setSnap("peek");
    if (message) flash(message);
  };

  /** Open (or close) a summary menu, with room below it in the planner. */
  function openMenu(which: "avoid" | "more") {
    setMenu((m) => (m === which ? null : which));
    setSnap((s) => (s === "peek" ? "half" : s));
  }

  // A menu that runs off the bottom of the screen pulls the sheet up so all of it shows.
  useEffect(() => {
    if (!menu) return;
    const t = window.setTimeout(() => {
      const box = document.querySelector(".summary .menu")?.getBoundingClientRect();
      if (box && box.bottom > window.innerHeight) setSnap("full");
    }, 350);
    return () => clearTimeout(t);
  }, [menu]);

  // A tap anywhere outside an open menu closes it.
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => !(e.target as Element).closest?.(".menu-wrap") && setMenu(null);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);

  /** "Customise": open the planner on the stop list. */
  function customise() {
    setMenu(null);
    setTab("plan");
    setSnap("full");
    requestAnimationFrame(() => document.querySelector(".stops")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }

  function setHome(h: Home | null) {
    setHomeState(h);
    const kept = storeHome(h);
    flash(!h ? "Home removed" : kept ? `Home set: ${h.label}` : "Home set for this visit only (browser storage is blocked)");
  }

  // Already finishing at home: a loop from home, or a route whose last stop is home.
  const atHome = (p?: LatLng) => !!home && !!p && distance(p, home.position) < 100;
  const endsAtHome = options.returnToStart ? atHome(stops[0]?.position) : stops.length > 0 && atHome(stops[stops.length - 1].position);

  /** "Home": start from home on an empty plan, otherwise ride home at the end. */
  function goHome() {
    if (!home) {
      setTab("saved");
      setSnap("full");
      flash("Set your home first");
      return;
    }
    // Home always goes on the end: it's where the ride finishes.
    addStop(home.position, home.label, stops.length);
  }

  function openLoopScreen() {
    setLoopStart(stops.length ? "first" : home ? "home" : "here");
    setLoopScreen(true);
  }

  /** "Create a round trip": from home, where the rider is now, or stop A. */
  function createLoop(start: LoopStart = loopStart, place = loopVia, fitPlace = false) {
    loopFitsPlace.current = fitPlace;
    // A new loop via a place starts with no steering (variant 0).
    loopShape.current.variant = -1;
    if (start === "home" && home) {
      setLoopScreen(false);
      makeLoop(undefined, false, { id: newId(), position: home.position, label: home.label }, place, fitPlace);
      return;
    }
    if (start === "first") {
      setLoopScreen(false);
      makeLoop(undefined, false, undefined, place, fitPlace);
      return;
    }
    if (!navigator.geolocation) {
      flash("Location isn't available here. Pick a start point instead.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setCenter(p);
        setLoopScreen(false);
        makeLoop(undefined, false, { id: newId(), position: p, label: "My location" }, place, fitPlace);
      },
      () => {
        setLocating(false);
        flash("Couldn't get your location");
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
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
    const data = { app: "ride-forge", version: 1, savedAt: Date.now(), routes: saved, rides, home };
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
      // Home comes back too, unless one is already set here.
      const h = data.home;
      if (!home && h && Number.isFinite(h.position?.lat) && Number.isFinite(h.position?.lng)) {
        setHomeState({ label: String(h.label || "Home"), position: h.position });
        storeHome({ label: String(h.label || "Home"), position: h.position });
      }
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
          onPause={(on) => recording.pause(on)}
          energySaving={settings.energySaving}
          knownPlaces={pois}
          priceAt={priceAt}
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
        {(route || busy || findingLoop > 0) && (
          <section className="summary" aria-live="polite" data-peek>
            {(busy || findingLoop > 0) && <div className="progress" />}
            {findingLoop > 0 && <p className="loop-note">Trying {findingLoop} loop shapes to find the best…</p>}
            {route ? (
              <>
                <div className="summary-top">
                  <TwistGauge curviness={route.curviness} />
                  <dl className="summary-stats">
                    <div>
                      <dt>Distance</dt>
                      <dd>
                        {formatDistance(route.distance)}
                      </dd>
                    </div>
                    <div>
                      <dt>Time</dt>
                      <dd>
                        {formatDuration(route.duration)}
                      </dd>
                    </div>
                    <div>
                      <dt>Bends</dt>
                      <dd>
                        {bends}
                      </dd>
                    </div>
                  </dl>
                </div>
                <p className="summary-meta">
                  {[profile ? `${Math.round(profile.ascent)} m climb` : null, options.returnToStart ? "loop" : null]
                    .filter(Boolean)
                    .map((part, i) => (
                      <span key={i} className="nowrap">
                        {part} ·{" "}
                      </span>
                    ))}
                  <button className="link preview" onClick={() => setRiding({ simulate: true })} disabled={busy}>
                    <Icon name="play" size={14} filled /> Preview ride
                  </button>
                </p>
                <div className="summary-tools">
                  <button onClick={customise}>
                    <Icon name="edit" size={18} /> Customise
                  </button>
                  {isGeneratedLoop && (
                    <button onClick={() => makeLoop()} title="Same settings, a different loop">
                      <Icon name="loop" size={18} /> Recalculate
                    </button>
                  )}
                  <div className="menu-wrap">
                    <button aria-expanded={menu === "avoid"} aria-haspopup="true" onClick={() => openMenu("avoid")}>
                      Avoid{avoidCount ? ` (${avoidCount})` : ""} <Icon name="chevronDown" size={16} />
                    </button>
                    {menu === "avoid" && (
                      <div className="menu" role="group" aria-label="Avoid">
                        <label>
                          <input
                            type="checkbox"
                            checked={options.avoidHighways || options.style !== "fastest"}
                            disabled={options.style !== "fastest"}
                            onChange={(e) => setOpt("avoidHighways", e.target.checked)}
                          />
                          Motorways
                        </label>
                        <label>
                          <input type="checkbox" checked={options.avoidTolls} onChange={(e) => setOpt("avoidTolls", e.target.checked)} />
                          Tolls
                        </label>
                        <label>
                          <input type="checkbox" checked={options.avoidFerries} onChange={(e) => setOpt("avoidFerries", e.target.checked)} />
                          Ferries
                        </label>
                        <label>
                          <input id="avoid-dirt" type="checkbox" checked={options.avoidUnpaved !== false} onChange={(e) => setOpt("avoidUnpaved", e.target.checked)} />
                          Dirt roads
                        </label>
                      </div>
                    )}
                  </div>
                </div>
                <div className="summary-actions">
                  <button className="ride-go primary" onClick={startRide} disabled={busy}>
                    <Icon name="navigate" size={18} filled /> Ride
                  </button>
                  <button onClick={saveRoute} disabled={busy}>
                    Save
                  </button>
                  <div className="menu-wrap">
                    <button className="more" aria-label="More" aria-expanded={menu === "more"} aria-haspopup="true" onClick={() => openMenu("more")}>
                      <Icon name="more" size={24} />
                    </button>
                    {menu === "more" && (
                      <div className="menu" role="menu">
                        <button role="menuitem" onClick={() => (setMenu(null), void share())}>
                          <Icon name="share" size={18} /> Share
                        </button>
                        <button role="menuitem" onClick={() => (setMenu(null), exportGpx())}>
                          <Icon name="download" size={18} /> Export GPX
                        </button>
                        <button role="menuitem" onClick={() => (setMenu(null), setRiding({ simulate: true }))}>
                          <Icon name="play" size={18} /> Preview ride
                        </button>
                        <button role="menuitem" onClick={() => (setMenu(null), setSnap("full"), setTab("plan"))}>
                          <Icon name="map" size={18} /> Route details
                        </button>
                        <button role="menuitem" className="danger-text" onClick={() => (setMenu(null), setConfirmDiscard(true))}>
                          <Icon name="trash" size={18} /> Discard ride
                        </button>
                      </div>
                    )}
                  </div>
                </div>
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
          <button className="settings-btn" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
            <Icon name="settings" size={22} />
          </button>
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
            {/* The route's loops on offer and its RideScore: part of the scrolling planner, so they never squeeze it. */}
            {isGeneratedLoop && loopChoices.length > 1 && findingLoop === 0 && (
              <div className="loop-choices" role="radiogroup" aria-label="Loops to choose from">
                {loopChoices.map((c, i) => (
                  <button
                    key={c.label}
                    role="radio"
                    aria-checked={loopChoice === i}
                    onClick={() => {
                      if (loopChoice === i) return;
                      setLoopChoice(i);
                      takeLoopShape(c);
                    }}
                  >
                    <strong>{c.label}</strong>
                    <small>
                      {formatDistance(c.km * 1000)} · curves {c.curves}
                    </small>
                  </button>
                ))}
              </div>
            )}
            {route && !busy && score && <RideScoreCard score={score} loading={!facts} />}
            <section>
              <div className="plan-search" onFocusCapture={() => setSnap("full")} data-peek={route ? undefined : ""}>
                <PlaceSearch
                  near={(insertAt != null ? stops[insertAt - 1] : stops[stops.length - 1])?.position ?? center}
                  placeholder={
                    insertAt != null && stops[insertAt - 1]
                      ? `Add a stop after ${stops[insertAt - 1].label}`
                      : stops.length
                        ? "Add a stop or destination"
                        : "Search for a start point"
                  }
                  onPick={(label, p) => {
                    addStop(p, label, insertAt ?? undefined);
                    setInsertAt(null);
                    setSnap("half");
                  }}
                />
                {insertAt != null && (
                  <button className="link" onClick={() => setInsertAt(null)}>
                    Add at the end instead
                  </button>
                )}
              </div>
              <p className="hint">Or tap the map to add stops (they land on the nearest road), or hold to place one exactly. Tap the route line to add a stop there, and drag pins to adjust.</p>

              <StopList
                stops={stops}
                loop={options.returnToStart}
                styles={STYLES}
                routeStyle={options.style}
                legs={stopLegs}
                onReorder={reorder}
                onRemove={removeStop}
                onLegStyle={(id, st) => setStops((ss) => ss.map((x) => (x.id === id ? { ...x, legStyle: st } : x)))}
                onInsert={(at) => {
                  setInsertAt(at);
                  setSnap("full");
                  requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".plan-search input")?.focus());
                }}
                onShow={(st) => {
                  setSnap("peek");
                  mapRef.current?.easeTo({ center: [st.position.lng, st.position.lat], zoom: Math.max(mapRef.current.getZoom(), 14) });
                }}
                onSetDestination={(id) => {
                  setStops((ss) => [...ss.filter((x) => x.id !== id), ...ss.filter((x) => x.id === id)]);
                  setOpt("returnToStart", false);
                }}
                onMenuOpen={() => setSnap("full")}
                onRoundTrip={(st) => {
                  setStops((ss) => [st, ...ss.filter((x) => x.id !== st.id)]);
                  setLoopStart("first");
                  setLoopScreen(true);
                }}
              />

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
                <button onClick={locateMe}>
                  <Icon name="locate" size={18} /> My location
                </button>
                {!endsAtHome && (
                  <button onClick={goHome} title={home ? `Add ${home.label}` : "Set your home location"}>
                    <Icon name="home" size={18} /> {home ? (stops.length ? "Ride home" : "From home") : "Set home"}
                  </button>
                )}
                {stops.length > 1 && (
                  <button
                    onClick={() =>
                      // On a loop, keep the start and ride the loop the other way round.
                      setStops((ss) => reverseStops(ss, options.returnToStart))
                    }
                  >
                    <Icon name="swap" size={18} /> Reverse
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
              <label className="detour-slider">
                <span>Detours</span>
                <input
                  id="detour"
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round((options.detour ?? 0.5) * 100)}
                  aria-valuetext={(options.detour ?? 0.5) < 0.34 ? "Direct" : (options.detour ?? 0.5) > 0.66 ? "Adventure" : "Balanced"}
                  onChange={(e) => setOpt("detour", +e.target.value / 100)}
                />
                <span className="detour-ends" aria-hidden>
                  <small>Direct</small>
                  <small>Adventure</small>
                </span>
              </label>
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
                <label>
                  <input type="checkbox" checked={options.avoidUnpaved !== false} onChange={(e) => setOpt("avoidUnpaved", e.target.checked)} />
                  Avoid dirt roads
                </label>
              </div>
            </section>

            <section className="rt-card">
              <h2>Round trip</h2>
              <p className="hint">A loop from your start, back home a different way.</p>
              <div className="button-row">
                <button className="primary" onClick={openLoopScreen}>
                  <Icon name="loop" size={18} /> Plan a round trip
                </button>
                {isGeneratedLoop && (
                  <button onClick={() => makeLoop()} title="Same settings, a different loop">
                    <Icon name="loop" size={18} /> Recalculate
                  </button>
                )}
              </div>
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
                      priceAt={priceAt}
                      priceNote={settings.fuelToken ? fuelNote : "Add a fuel price token in Settings to see Queensland prices."}
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
                      <button onClick={exportGpx}>
                        <Icon name="download" size={18} /> GPX
                      </button>
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
            onToggleHistory={toggleHistory}
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
            <section className="home-card">
              <h2>Home</h2>
              {home ? (
                <p className="home-label">
                  <strong>{home.label}</strong>
                  <button className="link" onClick={() => setHome(null)}>
                    Remove
                  </button>
                </p>
              ) : (
                <p className="hint">Set your home to start loops from it and ride home in one tap.</p>
              )}
              <div className="button-row">
                {stops[0] && (
                  <button onClick={() => setHome({ label: stops[0].label === "My location" ? "Home" : stops[0].label, position: stops[0].position })}>
                    Use stop A
                  </button>
                )}
                <button
                  onClick={() =>
                    navigator.geolocation?.getCurrentPosition(
                      (pos) => setHome({ label: "Home", position: { lat: pos.coords.latitude, lng: pos.coords.longitude } }),
                      () => flash("Couldn't get your location"),
                      { enableHighAccuracy: true, timeout: 10000 },
                    )
                  }
                >
                  <Icon name="locate" size={18} /> Where I am now
                </button>
              </div>
              <PlaceSearch near={home?.position ?? center} placeholder="Search for your home address" onPick={(label, p) => setHome({ label, position: p })} />
            </section>
            <section>
              <button className="wide" onClick={() => fileInput.current?.click()}>
                <Icon name="up" size={18} /> Import GPX
              </button>
              <div className="button-row">
                <button onClick={backUp}>Back up routes &amp; rides</button>
                <button onClick={() => backupInput.current?.click()}>Restore a backup</button>
              </div>
              <p className="hint">A backup file moves your saved routes and rides between the website and the app, or to a new phone.</p>
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
            sights={sights}
            priceAt={priceAt}
            home={settings.showHome ? (home?.position ?? null) : null}
            onSightClick={(x) => {
              setStopCardId(null);
              setPoiCard(null);
              setSight(x);
            }}
            onPoiClick={(x) => {
              setStopCardId(null);
              setSight(null);
              setLoopPick(false);
              setPoiCard(x);
            }}
            onMapClick={(p) => {
              // With a pin's card open, a tap on the map just closes it.
              if (stopCardId) setStopCardId(null);
              else addStop(p);
            }}
            onMapHold={(p) => {
              if (stopCardId) setStopCardId(null);
              addStop(p, undefined, undefined, true);
              flash("Pin placed exactly where you held");
            }}
            onStopClick={(id) => {
              closePlace();
              setStopCardId(id);
              // Room for the card on the map.
              setSnap("peek");
              // "… away from you": a recent fix is fine, and nothing is said if there's none.
              if (!me && navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(
                  (pos) => setMe({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
                  () => {},
                  { maximumAge: 5 * 60_000, timeout: 8000 },
                );
              }
            }}
            onStopMove={moveStop}
            onRouteClick={(p, leg) => addStop(p, undefined, leg + 1)}
            onSelectRoute={setSelected}
          />
        </MapErrorBoundary>
        {!riding && (
          <div className="map-chips">
            <button
              className="chip-toggle round"
              aria-label="Search for a place"
              onClick={() => {
                setTab("plan");
                setSnap("full");
                requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".plan-search input")?.focus());
              }}
            >
              <Icon name="search" size={20} />
            </button>
            <button
              className="chip-toggle"
              aria-pressed={sightsOn}
              onClick={() => {
                setSightsOn((on) => !on);
                closePlace();
              }}
            >
              <Icon name="camera" size={18} /> Sights{sightsOn && <Icon name="close" size={16} />}
            </button>
            <button
              className="chip-toggle"
              aria-pressed={passesOn}
              onClick={() => {
                setPassesOn((on) => !on);
                closePlace();
              }}
            >
              <Icon name="mountain" size={18} /> Passes{passesOn && <Icon name="close" size={16} />}
            </button>
            {(sightsOn || passesOn) && sightsNote && <span className="chip-note">{sightsNote}</span>}
          </div>
        )}
        {!riding && layersOpen && (
          <>
            <div className="backdrop" onClick={() => setLayersOpen(false)} />
            <div className="layers-menu" role="radiogroup" aria-label="Map">
              {MAP_LAYERS.map((l) => (
                <button key={l.id} role="radio" aria-checked={themePref === l.id} onClick={() => pickLayer(l.id)}>
                  <span className="layer-icon" aria-hidden>
                    <Icon name={l.icon} size={20} />
                  </span>
                  <span>
                    <strong>{l.name}</strong>
                    <small>{l.hint}</small>
                  </span>
                </button>
              ))}
              <div className="layers-toggles" role="group" aria-label="Show on the map">
                <label className="set-row">
                  <span>
                    <strong>My rides</strong>
                    <small>Recorded rides as faint lines</small>
                  </span>
                  <input type="checkbox" role="switch" className="switch" checked={showHistory} onChange={(e) => toggleHistory(e.target.checked)} />
                </label>
                <label className="set-row">
                  <span>
                    <strong>Home</strong>
                    <small>{home ? home.label : "Set it in the Saved tab"}</small>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    className="switch"
                    checked={settings.showHome}
                    onChange={(e) => changeSettings({ ...settings, showHome: e.target.checked })}
                  />
                </label>
              </div>
            </div>
          </>
        )}
        {!riding && stopCard && (
          <StopCard
            stop={stopCard.stop}
            index={stopCard.index}
            kind={stopCard.index === 0 ? "start" : stopCard.index === stops.length - 1 && !options.returnToStart ? "end" : "via"}
            prev={stopCard.index > 0 ? stops[stopCard.index - 1] : null}
            routeStyle={options.style}
            styles={STYLES}
            legs={stopLegs}
            me={me}
            canMoveUp={stopCard.index > 0}
            canMoveDown={stopCard.index < stops.length - 1}
            onRename={(label) => setStops((ss) => ss.map((x) => (x.id === stopCard.stop.id ? { ...x, label, named: true } : x)))}
            onLegStyle={(st) => {
              const prev = stops[stopCard.index - 1];
              setStops((ss) => ss.map((x) => (x.id === prev.id ? { ...x, legStyle: st } : x)));
            }}
            onMove={(dir) => reorder(stopCard.index, stopCard.index + dir)}
            onSetDestination={
              stopCard.index === stops.length - 1 && !options.returnToStart
                ? null
                : () => {
                    setStops((ss) => [...ss.filter((x) => x.id !== stopCard.stop.id), ...ss.filter((x) => x.id === stopCard.stop.id)]);
                    setOpt("returnToStart", false);
                  }
            }
            onRoundTrip={() => {
              setStopCardId(null);
              setStops((ss) => [stopCard.stop, ...ss.filter((x) => x.id !== stopCard.stop.id)]);
              setLoopStart("first");
              setLoopScreen(true);
            }}
            onSetHome={() => setHome({ label: stopCard.stop.label, position: stopCard.stop.position })}
            onRemove={() => {
              setStopCardId(null);
              removeStop(stopCard.stop.id);
            }}
            onClose={() => setStopCardId(null)}
          />
        )}
        {!riding && place && (
          <div className={`sight-card${loopPick ? " picking" : ""}`} role="dialog" aria-label={place.name}>
            {place.photo && !loopPick && <img src={place.photo.replace(/width=\d+/, "width=480")} alt="" />}
            <div className="sight-body">
              <small>{place.note}</small>
              <strong>{place.name}</strong>
              <div className="button-row">
                <button
                  className="primary"
                  onClick={() => {
                    // A place along the route goes in where it fits on the way.
                    addStop(place.position, place.name, poiCard && stops.length >= 2 ? bestInsertIndex(stops.map((s) => s.position), place.position, options.returnToStart) : undefined);
                    closePlace();
                    flash(`${place.name} added`);
                  }}
                >
                  <Icon name="plus" size={18} /> {poiCard && stops.length >= 2 ? "Stop on the way" : "Add as stop"}
                </button>
                <button onClick={() => rideTo(place)}>
                  <Icon name="navigate" size={18} /> Ride here
                </button>
                <button
                  aria-expanded={loopPick}
                  onClick={() => {
                    // Room for the choices below the card.
                    if (!loopPick) setSnap("peek");
                    setLoopPick((o) => !o);
                  }}
                >
                  <Icon name="loop" size={18} /> Loop via here
                </button>
                {place.link && (
                  <a className="button" href={place.link.href} target="_blank" rel="noreferrer">
                    {place.link.label}
                  </a>
                )}
              </div>
              {loopPick && (
                <div className="loop-pick" role="group" aria-label="Start the loop from">
                  <small>Start the loop from</small>
                  {(
                    [
                      home && ["home", `Home`],
                      ["here", "My location"],
                      // The current start, unless that's just home or here again.
                      stops[0] &&
                        stops[0].label !== "My location" &&
                        !(home && distance(stops[0].position, home.position) < 200) && ["first", `A · ${stops[0].label}`],
                    ].filter(Boolean) as [LoopStart, string][]
                  ).map(([start, label]) => (
                    <button
                      key={start}
                      disabled={locating}
                      onClick={() => {
                        const via = { label: place.name, position: place.position };
                        setLoopVia(via);
                        setLoopStart(start);
                        closePlace();
                        createLoop(start, via, true);
                      }}
                    >
                      <Icon name={start === "home" ? "home" : start === "here" ? "locate" : "navigate"} size={18} /> {label}
                    </button>
                  ))}
                  <button
                    className="link"
                    onClick={() => {
                      setLoopVia({ label: place.name, position: place.position });
                      closePlace();
                      openLoopScreen();
                    }}
                  >
                    Set a length or time…
                  </button>
                </div>
              )}
            </div>
            <button className="close" aria-label="Close" onClick={() => closePlace()}>
              ✕
            </button>
          </div>
        )}
        {!riding && (
        <div className="fabs">
          <button
            className="fab"
            onClick={() => {
              setLayersOpen((o) => !o);
              // Make room on the map for the menu.
              setSnap("peek");
            }}
            aria-label="Map layers"
            aria-expanded={layersOpen}
            title="Map layers"
          >
            <Icon name="layers" size={22} />
            <small>{MAP_LAYERS.find((l) => l.id === themePref)?.name.replace("Automatic", "Auto")}</small>
          </button>
          <button
            className={`fab rec${recording.state ? " on" : ""}`}
            onClick={() => (recording.state ? setConfirmStop(true) : recording.start())}
            aria-label={recording.state ? "Stop recording" : "Record a ride"}
            title={recording.state ? "Stop recording" : "Record a ride"}
          >
            <span aria-hidden>{recording.state ? <Icon name="stop" size={18} filled /> : "●"}</span>
          </button>
          <button className="fab accent" onClick={openLoopScreen} aria-label="Plan a round trip" title="Plan a round trip">
            <Icon name="loop" size={22} />
          </button>
          <button className="fab" onClick={centreOnMe} aria-label="Show my location">
            <Icon name="locate" size={22} />
          </button>
          {route && (
            <button className="fab" onClick={() => setFitKey((k) => k + 1)} aria-label="Zoom to route">
              <Icon name="fit" size={22} />
            </button>
          )}
        </div>
        )}
        {recording.state && (
          <div className={`rec-pill${riding ? " riding" : ""}${recording.state.paused ? " paused" : ""}`} role="status">
            <span className="rec-dot" aria-hidden /> {recording.state.paused ? "PAUSED" : "REC"} {formatClock(recording.state.elapsed)} ·{" "}
            {formatDistance(recording.state.distance)}
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
        {settingsOpen && (
          <SettingsScreen
            settings={settings}
            onChange={changeSettings}
            onClearSearches={() => {
              clearRecentSearches();
              flash("Search history deleted");
            }}
            onClose={() => setSettingsOpen(false)}
            build={BUILD}
          />
        )}
        {loopScreen && (
          <RoundTripScreen
            mode={loopMode}
            onMode={setLoopMode}
            km={loopKm}
            onKm={setLoopKm}
            minutes={loopMin}
            onMinutes={setLoopMin}
            style={options.style}
            styles={STYLES}
            onStyle={(v) => setOpt("style", v)}
            dir={loopDir}
            onDir={setLoopDir}
            via={loopVia}
            onVia={setLoopVia}
            start={loopStart}
            onStart={setLoopStart}
            firstStop={stops[0]?.label}
            home={home?.label}
            near={stops[0]?.position ?? center}
            busy={locating}
            onCreate={() => createLoop()}
            onClose={() => setLoopScreen(false)}
          />
        )}
        {toast && <div className="toast">{toast}</div>}
      </main>
      {/* Outside the map, so it sits above the planner sheet too. */}
      {confirmDiscard && (
        <div className="discard-shade" onClick={() => setConfirmDiscard(false)}>
          <div className="discard-sheet" role="dialog" aria-modal="true" aria-labelledby="discard-title" onClick={(e) => e.stopPropagation()}>
            <span className="sheet-grip" aria-hidden />
            <h2 id="discard-title">Would you like to save your ride?</h2>
            <p>Save it and it stays in Saved, ready to plan further or ride later. Discard it to clear the route and its stops and start again.</p>
            <button className="primary" onClick={() => (saveRoute(), discardRide(""))}>
              Save
            </button>
            <button className="discard" onClick={() => discardRide("Ride discarded")}>
              Discard ride
            </button>
            <button onClick={() => setConfirmDiscard(false)}>Back to planning</button>
          </div>
        </div>
      )}
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
    </div>
  );
}


/** 1:05:09 or 5:09 */
function formatClock(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
