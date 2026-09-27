import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { importLibrary, setOptions } from "@googlemaps/js-api-loader";
import MapView from "./components/MapView";
import MapErrorBoundary from "./components/MapErrorBoundary";
import PlaceSearch from "./components/PlaceSearch";
import ElevationChart from "./components/ElevationChart";
import { getApiKey, setStoredApiKey } from "./lib/config";
import {
  curvinessLabel,
  formatDistance,
  formatDuration,
  roundTripWaypoints,
  type LatLng,
} from "./lib/geo";
import { defaultOptions, planRoute, type RouteOptions, type RouteResult, type RouteStyle } from "./lib/routes";
import { elevationProfile, type ElevationProfile } from "./lib/elevation";
import { reverseGeocode } from "./lib/places";
import { parseGpx, toGpx } from "./lib/gpx";
import {
  decodeShare,
  encodeShare,
  loadSaved,
  newId,
  storeSaved,
  type SavedRoute,
  type Stop,
} from "./lib/storage";

const STYLES: { id: RouteStyle; name: string; hint: string }[] = [
  { id: "fastest", name: "Fastest", hint: "Quickest way, motorways allowed" },
  { id: "scenic", name: "Scenic", hint: "Avoids motorways, sensible detours" },
  { id: "twisty", name: "Twisty", hint: "Hunts for the curviest roads" },
];

const prefersDark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

export default function App() {
  const [apiKey, setApiKey] = useState(getApiKey);
  const [mapsReady, setMapsReady] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (!apiKey) return;
    // Google calls this global when it rejects the key (wrong key, API not enabled, referrer blocked).
    (window as unknown as { gm_authFailure: () => void }).gm_authFailure = () =>
      setLoadError("Google rejected this API key.");
    setOptions({ key: apiKey, v: "weekly" });
    Promise.all(["maps", "marker", "elevation", "geocoding"].map((l) => importLibrary(l as "maps")))
      .then(() => setMapsReady(true))
      .catch((e: Error) => setLoadError(e.message || "Could not load Google Maps"));
  }, [apiKey]);

  if (!apiKey) return <KeySetup onSave={setApiKey} />;
  if (loadError)
    return (
      <div className="centered">
        <div className="card">
          <h1>Google Maps didn't load</h1>
          <p>{loadError}</p>
          <p>
            Check that the key is correct, that billing is on for its Google Cloud project, that the Maps JavaScript
            API is enabled, and that any HTTP referrer restriction includes this site.
          </p>
          <button
            onClick={() => {
              setStoredApiKey("");
              location.reload();
            }}
          >
            Enter a different key
          </button>
        </div>
      </div>
    );
  if (!mapsReady) return <div className="centered muted">Loading map…</div>;
  return <Planner apiKey={apiKey} />;
}

function KeySetup({ onSave }: { onSave: (k: string) => void }) {
  const [key, setKey] = useState("");
  return (
    <div className="centered">
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          setStoredApiKey(key.trim());
          onSave(key.trim());
        }}
      >
        <h1>Forge Route Planner</h1>
        <p>
          Paste a Google Maps Platform API key to start. Enable the <b>Maps JavaScript</b>, <b>Routes</b>,{" "}
          <b>Places (New)</b>, <b>Geocoding</b> and <b>Elevation</b> APIs for it.
        </p>
        <p className="muted">
          The key is kept in this browser only. To build it in instead, set <code>VITE_GOOGLE_MAPS_API_KEY</code> in{" "}
          <code>.env</code>.
        </p>
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="AIza…" aria-label="API key" autoFocus />
        <button type="submit" className="primary" disabled={!key.trim()}>
          Start planning
        </button>
      </form>
    </div>
  );
}

function Planner({ apiKey }: { apiKey: string }) {
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
  const [dark] = useState(prefersDark);
  const wantFit = useRef(!!shared);
  const dragFrom = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const route = routes[selected];

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(""), 2500);
  }, []);

  // Recompute whenever the stops or options change (debounced so dragging feels calm).
  const stopsKey = stops.map((s) => `${s.position.lat},${s.position.lng}`).join("|");
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
      planRoute(apiKey, stops.map((s) => s.position), options, ctrl.signal)
        .then((r) => {
          setRoutes(r);
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
  }, [stopsKey, options, apiKey]);

  useEffect(() => {
    setProfile(null);
    if (!route || route.path.length < 2) return;
    let live = true;
    elevationProfile(route.path, route.distance)
      .then((p) => live && setProfile(p))
      .catch(() => live && setProfile(null));
    return () => {
      live = false;
    };
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
    setStops((ss) => ss.map((s) => (s.id === id ? { ...s, position, label: "Locating…" } : s)));
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
    const via = pts.map((p) => ({ id: newId(), position: p, label: "Locating…" }));
    setStops([origin, ...via, { ...origin, id: newId() }]);
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

  function saveRoute() {
    if (!route) return;
    const entry: SavedRoute = {
      id: newId(),
      name: name.trim() || `${stops[0].label} → ${stops[stops.length - 1].label}`,
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
    setStops(r.stops.map((s) => ({ ...s, id: newId() })));
    setOptions(r.options);
    setName(r.name);
    wantFit.current = true;
    setTab("plan");
  }

  function deleteSaved(id: string) {
    const next = saved.filter((r) => r.id !== id);
    setSaved(next);
    storeSaved(next);
  }

  function download(filename: string, content: string, type: string) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportGpx() {
    if (!route) return;
    const title = name.trim() || `${stops[0].label} to ${stops[stops.length - 1].label}`;
    download(
      `${title.replace(/[^\w-]+/g, "_").slice(0, 60) || "route"}.gpx`,
      toGpx({ name: title, waypoints: stops.map((s) => s.position), track: route.path }),
      "application/gpx+xml",
    );
  }

  async function importGpx(file: File) {
    try {
      const data = parseGpx(await file.text());
      const imported = data.waypoints.slice(0, 27).map((p) => ({ id: newId(), position: p, label: "Locating…" }));
      setStops(imported);
      imported.forEach((s) => labelStop(s.id, s.position));
      setName(data.name);
      wantFit.current = true;
      flash(data.waypoints.length > 27 ? "Imported the first 27 points (Google's limit)" : `Imported “${data.name}”`);
    } catch (e) {
      flash((e as Error).message);
    }
  }

  async function share() {
    const url = location.href;
    try {
      if (navigator.share) await navigator.share({ title: name || "Route", url });
      else {
        await navigator.clipboard.writeText(url);
        flash("Link copied");
      }
    } catch {
      /* user cancelled the share sheet */
    }
  }

  const setOpt = <K extends keyof RouteOptions>(k: K, v: RouteOptions[K]) => setOptions((o) => ({ ...o, [k]: v }));

  return (
    <div className="app">
      <aside className="panel">
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
              <PlaceSearch
                apiKey={apiKey}
                near={stops[stops.length - 1]?.position ?? center}
                placeholder={stops.length ? "Add a stop or destination" : "Search for a start point"}
                onPick={(label, p) => addStop(p, label)}
              />
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
                      <span className={`badge ${i === 0 ? "start" : i === stops.length - 1 ? "end" : "via"}`}>
                        {i === 0 ? "A" : i === stops.length - 1 ? "B" : i}
                      </span>
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
                </ol>
              )}

              <div className="button-row">
                <button onClick={locateMe}>◎ My location</button>
                {stops.length > 1 && <button onClick={() => setStops((ss) => ss.slice().reverse())}>⇅ Reverse</button>}
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
                ↻ {stops.length > 2 && stops[0].position.lat === stops[stops.length - 1].position.lat ? "Try another loop" : "Make a loop from A"}
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
                            <span className="curvy">{curvinessLabel(r.curviness)}</span>
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
                        <dt>Curves</dt>
                        <dd title={`${Math.round(route.curviness)}° of turning per km`}>{curvinessLabel(route.curviness)}</dd>
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
                          const dest = stops[stops.length - 1].position;
                          const way = stops.slice(1, -1).map((s) => `${s.position.lat},${s.position.lng}`).join("|");
                          window.open(
                            `https://www.google.com/maps/dir/?api=1&origin=${stops[0].position.lat},${stops[0].position.lng}&destination=${dest.lat},${dest.lng}${way ? `&waypoints=${encodeURIComponent(way)}` : ""}&travelmode=driving`,
                            "_blank",
                          );
                        }}
                        title="Open in Google Maps for turn-by-turn navigation (it re-routes, max 9 stops)"
                      >
                        Navigate
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
      </aside>

      <main className="map-wrap">
        <MapErrorBoundary>
          <MapView
            stops={stops}
            routes={routes}
            selected={selected}
            hover={hover}
            fitKey={fitKey}
            darkMode={dark}
            onMapClick={(p) => addStop(p)}
            onStopMove={moveStop}
            onRouteClick={(p, leg) => addStop(p, undefined, leg + 1)}
            onSelectRoute={setSelected}
            onMapReady={(m) => {
              if (!shared)
                navigator.geolocation?.getCurrentPosition(
                  (pos) => {
                    const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                    setCenter(p);
                    m.panTo(p);
                    m.setZoom(10);
                  },
                  () => undefined,
                  { timeout: 5000 },
                );
            }}
          />
        </MapErrorBoundary>
        {route && (
          <button className="fit" onClick={() => setFitKey((k) => k + 1)} aria-label="Zoom to route">
            ⤢
          </button>
        )}
        {toast && <div className="toast">{toast}</div>}
      </main>
    </div>
  );
}
