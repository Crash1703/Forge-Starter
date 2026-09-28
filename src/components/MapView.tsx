import { useEffect, useRef } from "react";
import { LngLatBounds, Map as MapLibre, Marker, NavigationControl, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import type { FeatureCollection } from "geojson";
import { distance, pathLength, twistSections, type LatLng } from "../lib/geo";
import type { RouteResult } from "../lib/routes";
import type { Stop } from "../lib/storage";
import type { Poi } from "../lib/pois";
import { SIGHT_ICONS, type Sight } from "../lib/sights";
import { MAP_STYLE, MAP_STYLE_DARK } from "../lib/config";

// MapLibre looks for its worker next to its own script, which bundling moves;
// let Vite bundle the worker (with its shared chunk) and point MapLibre at it.
setWorkerUrl(workerUrl);

/** What Ride mode draws: the road still ahead, and where the rider is. */
export interface RideLayer {
  ahead: LatLng[];
  position: LatLng | null;
  heading: number | null;
  /** Keep the camera on the rider, heading-up. */
  follow: boolean;
}

interface Props {
  stops: Stop[];
  /** The route returns to the first stop, so the last stop isn't the finish. */
  loop: boolean;
  routes: RouteResult[];
  selected: number;
  hover: LatLng | null;
  /** Changing this re-fits the view to the current route or stops. */
  fitKey: number;
  theme: "light" | "dark";
  /** Pixels of map hidden under the planner panel at the bottom (phones). */
  insetBottom: number;
  /** Pixels hidden under a top banner (Ride mode). */
  insetTop?: number;
  /** Where the rider is (outside Ride mode: after "locate me"). */
  me: LatLng | null;
  /** Set while riding; the planned routes and stop editing step aside. */
  ride: RideLayer | null;
  /** A recorded ride being looked at in the logbook. */
  track?: LatLng[] | null;
  /** Faint lines of every recorded ride ("ghost lines"). */
  history?: LatLng[][];
  /** Fuel stations and cafés along the route. */
  pois?: Poi[];
  /** Sights to show as photo bubbles. */
  sights?: Sight[];
  onSightClick?: (s: Sight) => void;
  onMapClick: (p: LatLng) => void;
  onStopMove: (id: string, p: LatLng) => void;
  onRouteClick: (p: LatLng, legIndex: number) => void;
  onSelectRoute: (i: number) => void;
  onMapReady?: (map: MapLibre) => void;
  /** The rider dragged the map while it was following them. */
  onFollowBroken?: () => void;
}

const ALT = "#8a94a6";
/** Recorded rides: a colour no planned route uses. */
const RIDE_PURPLE = "#7b61ff";
/** Route colour by twistiness: easy, curvy, twisty, very twisty. */
export const TWIST_COLOURS = ["#f5a25d", "#ff6a13", "#e8363d", "#b0126b"];

type Geo = FeatureCollection;
const EMPTY: Geo = { type: "FeatureCollection", features: [] };
const coords = (path: LatLng[]) => path.map((p) => [p.lng, p.lat]);
const line = (path: LatLng[], properties: Record<string, number> = {}) => ({
  type: "Feature" as const,
  properties,
  geometry: { type: "LineString" as const, coordinates: coords(path) },
});
const points = (pts: LatLng[]): Geo => ({
  type: "FeatureCollection",
  features: pts.map((p) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [p.lng, p.lat] } })),
});

/** Which leg (between stops i and i+1) the path point nearest to `p` belongs to. */
function legAt(route: RouteResult, p: LatLng): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < route.path.length; i++) {
    const d = distance(route.path[i], p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  // Leg distances come from the router, the path from its geometry; compare
  // by fraction of the whole trip so the two scales don't need to agree.
  const fraction = pathLength(route.path.slice(0, best + 1)) / (pathLength(route.path) || 1);
  const total = route.legs.reduce((s, l) => s + l.distance, 0);
  let acc = 0;
  for (let i = 0; i < route.legs.length; i++) {
    acc += route.legs[i].distance;
    if (fraction * total <= acc) return i;
  }
  return Math.max(0, route.legs.length - 1);
}

export default function MapView(props: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibre | null>(null);
  const markers = useRef(new globalThis.Map<string, { marker: Marker; el: HTMLDivElement }>());
  const puck = useRef<{ marker: Marker; el: HTMLDivElement } | null>(null);
  const poiMarkers = useRef<Marker[]>([]);
  const sightMarkers = useRef<Marker[]>([]);
  const sightClick = useRef(props.onSightClick);
  sightClick.current = props.onSightClick;
  // Latest data for each source, so it can be re-applied after a style switch.
  const data = useRef<Record<string, Geo>>({ history: EMPTY, track: EMPTY, alts: EMPTY, route: EMPTY, dots: EMPTY, hover: EMPTY, ride: EMPTY });
  // Handlers change every render; listeners read the latest through this ref.
  const cb = useRef(props);
  cb.current = props;

  const setData = (id: string, geo: Geo) => {
    data.current[id] = geo;
    const src = map.current?.getSource(id) as GeoJSONSource | undefined;
    src?.setData(geo);
  };

  useEffect(() => {
    if (!el.current) return;
    const m = new MapLibre({
      container: el.current,
      style: props.theme === "dark" ? MAP_STYLE_DARK : MAP_STYLE,
      center: [153.0, -27.0],
      zoom: 7,
      attributionControl: { compact: true },
    });
    // Zoom buttons for mouse users; phones pinch.
    if (window.matchMedia("(min-width: 761px)").matches) {
      m.addControl(new NavigationControl({ visualizePitch: false }), "bottom-right");
    }

    // Our sources and layers, (re-)added whenever a map style finishes loading.
    m.on("style.load", () => {
      for (const id of ["history", "track", "alts", "route", "dots", "hover", "ride"]) {
        if (!m.getSource(id)) m.addSource(id, { type: "geojson", data: data.current[id] });
      }
      const round = { "line-cap": "round", "line-join": "round" } as const;
      const add = (layer: Parameters<MapLibre["addLayer"]>[0]) => {
        if (!m.getLayer(layer.id)) m.addLayer(layer);
      };
      // Recorded rides sit underneath planned routes.
      add({ id: "history", type: "line", source: "history", layout: round, paint: { "line-color": RIDE_PURPLE, "line-width": 3, "line-opacity": 0.35 } });
      add({ id: "track", type: "line", source: "track", layout: round, paint: { "line-color": RIDE_PURPLE, "line-width": 6 } });
      add({ id: "alts", type: "line", source: "alts", layout: round, paint: { "line-color": ALT, "line-width": 5, "line-opacity": 0.8 } });
      add({ id: "route-casing", type: "line", source: "route", layout: round, paint: { "line-color": "#1b1f24", "line-width": 9, "line-opacity": 0.55 } });
      add({
        id: "route",
        type: "line",
        source: "route",
        layout: round,
        paint: {
          "line-color": ["match", ["get", "level"], 1, TWIST_COLOURS[1], 2, TWIST_COLOURS[2], 3, TWIST_COLOURS[3], TWIST_COLOURS[0]],
          "line-width": 6,
        },
      });
      add({ id: "ride-casing", type: "line", source: "ride", layout: round, paint: { "line-color": "#0b3d91", "line-width": 12, "line-opacity": 0.5 } });
      add({ id: "ride", type: "line", source: "ride", layout: round, paint: { "line-color": "#2f7bff", "line-width": 8 } });
      const dot = { "circle-color": TWIST_COLOURS[1], "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 };
      add({ id: "dots", type: "circle", source: "dots", paint: { ...dot, "circle-radius": 5 } });
      add({ id: "hover", type: "circle", source: "hover", paint: { ...dot, "circle-radius": 7 } });
    });

    m.on("click", (e) => {
      if (cb.current.ride) return;
      const box: [[number, number], [number, number]] = [
        [e.point.x - 8, e.point.y - 8],
        [e.point.x + 8, e.point.y + 8],
      ];
      const hits = m.getLayer("route") ? m.queryRenderedFeatures(box, { layers: ["route", "alts"] }) : [];
      const p = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      const { routes, selected } = cb.current;
      const onRoute = hits.find((h) => h.layer.id === "route");
      const onAlt = hits.find((h) => h.layer.id === "alts");
      if (onRoute && routes[selected]) cb.current.onRouteClick(p, legAt(routes[selected], p));
      else if (onAlt) cb.current.onSelectRoute(onAlt.properties.idx as number);
      else cb.current.onMapClick(p);
    });
    for (const layer of ["route", "alts"]) {
      m.on("mouseenter", layer, () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", layer, () => (m.getCanvas().style.cursor = ""));
    }
    // A drag by the rider (not our own camera moves) stops follow mode.
    m.on("dragstart", () => {
      if (cb.current.ride?.follow) cb.current.onFollowBroken?.();
    });
    map.current = m;
    cb.current.onMapReady?.(m);
    return () => {
      m.remove();
      map.current = null;
      markers.current.clear();
      puck.current = null;
    };
    // The initial theme only; later changes go through setStyle below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Day / night map
  const firstTheme = useRef(true);
  useEffect(() => {
    if (firstTheme.current) {
      firstTheme.current = false;
      return;
    }
    map.current?.setStyle(props.theme === "dark" ? MAP_STYLE_DARK : MAP_STYLE);
  }, [props.theme]);

  // The last zoom-to-fit, so a padding change straight after can redo it.
  const lastFit = useRef<{ bounds: LngLatBounds; at: number } | null>(null);

  // Keep the visible middle of the map above the planner panel.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    m.setPadding({ top: props.insetTop ?? 0, left: 0, right: 0, bottom: props.insetBottom });
    // setPadding stops any camera animation, including a fit that just started
    // (the panel often moves at the same moment); redo it with the new padding.
    const fit = lastFit.current;
    if (fit && performance.now() - fit.at < 1500) m.fitBounds(fit.bounds, { padding: 50, duration: 400 });
  }, [props.insetBottom, props.insetTop]);

  // Stop markers (fixed in place while riding).
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const seen = new Set<string>();
    const riding = !!props.ride;
    props.stops.forEach((s, i) => {
      const kind = i === 0 ? "start" : i === props.stops.length - 1 && !props.loop ? "end" : "via";
      seen.add(s.id);
      let entry = markers.current.get(s.id);
      if (!entry) {
        const pin = document.createElement("div");
        const marker = new Marker({ element: pin, draggable: true }).setLngLat([s.position.lng, s.position.lat]).addTo(m);
        marker.on("dragend", () => {
          const { lat, lng } = marker.getLngLat();
          cb.current.onStopMove(s.id, { lat, lng });
        });
        entry = { marker, el: pin };
        markers.current.set(s.id, entry);
      }
      entry.marker.setLngLat([s.position.lng, s.position.lat]);
      entry.marker.setDraggable(!riding);
      entry.el.className = `pin pin-${kind}`;
      entry.el.textContent = kind === "start" ? "A" : kind === "end" ? "B" : String(i);
      entry.el.title = kind === "start" && props.loop ? `${s.label} (start and finish)` : s.label;
    });
    for (const [id, entry] of markers.current) {
      if (!seen.has(id)) {
        entry.marker.remove();
        markers.current.delete(id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.stops, props.loop, !!props.ride]);

  // Route lines: alternatives underneath, selected route on top, coloured by twistiness.
  useEffect(() => {
    const { routes, selected, ride } = props;
    const sel = routes[selected];
    setData("alts", {
      type: "FeatureCollection",
      features: ride ? [] : routes.flatMap((r, idx) => (idx === selected ? [] : [line(r.path, { idx })])),
    });
    setData("route", {
      type: "FeatureCollection",
      features: sel ? twistSections(sel.path).map((s) => line(s.path, { level: s.level })) : [],
    });
    // Pass-through points the twisty planner added, so riders can see why the route bends away.
    setData("dots", points(ride ? [] : (sel?.detours ?? [])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.routes, props.selected, !!props.ride]);

  useEffect(() => {
    setData("track", { type: "FeatureCollection", features: props.track && props.track.length > 1 ? [line(props.track)] : [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.track]);

  useEffect(() => {
    setData("history", { type: "FeatureCollection", features: (props.history ?? []).filter((h) => h.length > 1).map((h) => line(h)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.history]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    poiMarkers.current.forEach((mk) => mk.remove());
    poiMarkers.current = (props.ride ? [] : (props.pois ?? [])).map((p) => {
      const el = document.createElement("div");
      el.className = `poi poi-${p.kind}`;
      el.textContent = p.kind === "fuel" ? "⛽" : "☕";
      el.title = p.name;
      return new Marker({ element: el }).setLngLat([p.position.lng, p.position.lat]).addTo(m);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pois, !!props.ride]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    sightMarkers.current.forEach((mk) => mk.remove());
    sightMarkers.current = (props.ride ? [] : (props.sights ?? [])).map((s) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `sight${s.photo ? " has-photo" : ""}`;
      el.setAttribute("aria-label", s.name);
      el.title = s.name;
      if (s.photo) {
        const img = document.createElement("img");
        img.src = s.photo;
        img.alt = "";
        img.loading = "lazy";
        // No photo after all: fall back to the icon.
        img.onerror = () => {
          img.remove();
          el.classList.remove("has-photo");
          el.textContent = SIGHT_ICONS[s.kind];
        };
        el.appendChild(img);
      } else el.textContent = SIGHT_ICONS[s.kind];
      // A tap on a sight is not a tap on the map (which would add a stop).
      for (const ev of ["mousedown", "touchstart", "pointerdown", "dblclick"]) el.addEventListener(ev, (e) => e.stopPropagation());
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        sightClick.current?.(s);
      });
      return new Marker({ element: el }).setLngLat([s.position.lng, s.position.lat]).addTo(m);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sights, !!props.ride]);

  // Ride mode: the road ahead in blue on top.
  useEffect(() => {
    const ahead = props.ride?.ahead ?? [];
    setData("ride", { type: "FeatureCollection", features: ahead.length > 1 ? [line(ahead)] : [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.ride?.ahead]);

  // The rider's position arrow, and the follow camera.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const pos = props.ride?.position ?? props.me;
    if (!pos) {
      puck.current?.marker.remove();
      puck.current = null;
      return;
    }
    if (!puck.current) {
      const dotEl = document.createElement("div");
      dotEl.className = "puck";
      puck.current = {
        marker: new Marker({ element: dotEl, rotationAlignment: "map" }).setLngLat([pos.lng, pos.lat]).addTo(m),
        el: dotEl,
      };
    }
    const heading = props.ride?.heading;
    puck.current.marker.setLngLat([pos.lng, pos.lat]);
    puck.current.el.classList.toggle("puck-heading", heading != null);
    puck.current.marker.setRotation(heading ?? 0);
    if (props.ride?.follow) {
      m.easeTo({
        center: [pos.lng, pos.lat],
        bearing: heading ?? m.getBearing(),
        zoom: Math.max(m.getZoom(), 15.5),
        pitch: 45,
        duration: 900,
      });
    }
  }, [props.ride?.position, props.ride?.heading, props.ride?.follow, props.me]);

  // Back to a flat north-up map after riding.
  const wasRiding = useRef(false);
  useEffect(() => {
    const riding = !!props.ride;
    if (wasRiding.current && !riding) map.current?.easeTo({ pitch: 0, bearing: 0, duration: 600 });
    wasRiding.current = riding;
  }, [props.ride]);

  // Fit view on request.
  useEffect(() => {
    const m = map.current;
    if (!m || props.fitKey === 0) return;
    const pts = props.track?.length ? props.track : (props.routes[props.selected]?.path ?? props.stops.map((s) => s.position));
    if (!pts.length) return;
    if (pts.length === 1) {
      m.easeTo({ center: [pts[0].lng, pts[0].lat], zoom: Math.max(m.getZoom(), 12) });
      return;
    }
    const b = new LngLatBounds();
    pts.forEach((p) => b.extend([p.lng, p.lat]));
    lastFit.current = { bounds: b, at: performance.now() };
    m.fitBounds(b, { padding: 50, duration: 600 });
    // Only fit on explicit requests, not on every route update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fitKey]);

  // Elevation-chart hover marker
  useEffect(() => {
    setData("hover", points(props.hover ? [props.hover] : []));
  }, [props.hover]);

  return <div ref={el} className="map" />;
}
