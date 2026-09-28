import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Map as MapLibre } from "maplibre-gl";
import MapView from "./components/MapView";
import BottomSheet, { type Snap } from "./components/BottomSheet";
import TwistGauge from "./components/TwistGauge";
import RideView from "./components/RideView";
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
  roundTripWaypoints,
  twistScore,
  type LatLng,
} from "./lib/geo";
import { defaultOptions, planRoute, type RouteOptions, type RouteResult, type RouteStyle } from "./lib/routes";
import { elevationProfile, type ElevationProfile } from "./lib/elevation";
import { reverseGeocode } from "./lib/places";
import { parseGpx, toGpx } from "./lib/gpx";
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
  const [tab, setTab] = useState<"plan" | "saved">("plan");
  const [saved, setSaved] = useState<SavedRoute[]>(loadSaved);
  const [name, setName] = useState("");
  const [loopKm, setLoopKm] = useState(120);
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

  // Recompute whenever the stops or options change (debounced so dragging feels calm).
  const stopsKey = stops.map((s) => `${s.position.lat},${s.position.lng}${s.auto ? "*" : ""}`).join("|");
  useEffect(() => {
    if (stops.length < 2) {
      setRoutes([]);
      setProfile(null);
      setError("");
      return;
    }
    const ctrl = new AbortController();
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
        };
      });
      planRoute(points, options, ctrl.signal)
        .then((r) => {
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
        .finally(() => !ctrl.signal.aborted && setBusy(false));
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

  function makeLoop(start?: Stop) {
    const origin = start ?? stops[0];
    if (!origin) {
      flash("Set a start point first");
      return;
    }
    const heading = Math.random() * 360;
    const pts = roundTripWaypoints(origin.position, loopKm * 1000, heading);
    const via = pts.map((p) => ({ id: newId(), position: p, label: "Locating…", auto: true }));
    setStops([{ ...origin, auto: false }, ...via]);
    setOptions((o) => ({ ...o, returnToStart: true }));
    via.forEach((v) => labelStop(v.id, v.position));
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
          }}
        />
      ) : (
      <BottomSheet snap={snap} onSnap={setSnap} onCover={setCover}>
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
                <button className="ride-go primary" onClick={() => setRiding({ simulate: false })} disabled={busy}>
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
              <div className="loop">
                <input
                  type="range"
                  min={20}
                  max={500}
                  step={10}
                  value={loopKm}
                  onChange={(e) => setLoopKm(+e.target.value)}
                  aria-label="Round trip length"
                />
                <output>{loopKm} km</output>
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
        ) : (
          <div className="scroll">
            <section>
              <button className="wide" onClick={() => fileInput.current?.click()}>
                ⤒ Import GPX
              </button>
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
