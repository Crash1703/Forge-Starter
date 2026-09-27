import { useEffect, useRef } from "react";
import { GeolocateControl, LngLatBounds, Map as MapLibre, Marker, NavigationControl, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import type { FeatureCollection } from "geojson";
import { distance, pathLength, type LatLng } from "../lib/geo";
import type { RouteResult } from "../lib/routes";
import type { Stop } from "../lib/storage";
import { MAP_STYLE } from "../lib/config";

interface Props {
  stops: Stop[];
  routes: RouteResult[];
  selected: number;
  hover: LatLng | null;
  /** Changing this re-fits the view to the current route or stops. */
  fitKey: number;
  onMapClick: (p: LatLng) => void;
  onStopMove: (id: string, p: LatLng) => void;
  onRouteClick: (p: LatLng, legIndex: number) => void;
  onSelectRoute: (i: number) => void;
  onLocate?: (p: LatLng) => void;
}

// MapLibre looks for its worker next to its own script, which bundling moves;
// let Vite bundle the worker (with its shared chunk) and point MapLibre at it.
setWorkerUrl(workerUrl);

const ROUTE = "#ff6a13";
const ALT = "#8a94a6";

type Geo = FeatureCollection;
const coords = (path: LatLng[]) => path.map((p) => [p.lng, p.lat]);
const lines = (routes: { path: LatLng[]; idx: number }[]): Geo => ({
  type: "FeatureCollection",
  features: routes.map((r) => ({
    type: "Feature",
    properties: { idx: r.idx },
    geometry: { type: "LineString", coordinates: coords(r.path) },
  })),
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
  const ready = useRef<Promise<void> | null>(null);
  const markers = useRef(new globalThis.Map<string, { marker: Marker; el: HTMLDivElement }>());
  // Handlers change every render; listeners read the latest through this ref.
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    if (!el.current) return;
    const m = new MapLibre({
      container: el.current,
      style: MAP_STYLE,
      center: [11.4, 47.3],
      zoom: 7,
      attributionControl: { compact: true },
    });
    m.addControl(new NavigationControl({ visualizePitch: false }), "top-right");
    const geo = new GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false });
    geo.on("geolocate", (e) => cb.current.onLocate?.({ lat: e.coords.latitude, lng: e.coords.longitude }));
    m.addControl(geo, "top-right");

    ready.current = new Promise((resolve) =>
      m.on("load", () => {
        const empty: Geo = { type: "FeatureCollection", features: [] };
        for (const id of ["alts", "route", "dots", "hover"]) m.addSource(id, { type: "geojson", data: empty });
        const round = { "line-cap": "round", "line-join": "round" } as const;
        m.addLayer({ id: "alts", type: "line", source: "alts", layout: round, paint: { "line-color": ALT, "line-width": 5, "line-opacity": 0.8 } });
        m.addLayer({ id: "route-casing", type: "line", source: "route", layout: round, paint: { "line-color": "#1b1f24", "line-width": 9, "line-opacity": 0.5 } });
        m.addLayer({ id: "route", type: "line", source: "route", layout: round, paint: { "line-color": ROUTE, "line-width": 6 } });
        const dot = { "circle-color": ROUTE, "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 };
        m.addLayer({ id: "dots", type: "circle", source: "dots", paint: { ...dot, "circle-radius": 5 } });
        m.addLayer({ id: "hover", type: "circle", source: "hover", paint: { ...dot, "circle-radius": 7 } });
        resolve();
      }),
    );

    m.on("click", (e) => {
      const box: [[number, number], [number, number]] = [
        [e.point.x - 6, e.point.y - 6],
        [e.point.x + 6, e.point.y + 6],
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
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      markers.current.clear();
    };
  }, []);

  // Stop markers
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const seen = new Set<string>();
    props.stops.forEach((s, i) => {
      const kind = i === 0 ? "start" : i === props.stops.length - 1 ? "end" : "via";
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
      entry.el.className = `pin pin-${kind}`;
      entry.el.textContent = kind === "start" ? "A" : kind === "end" ? "B" : String(i);
      entry.el.title = s.label;
    });
    for (const [id, entry] of markers.current) {
      if (!seen.has(id)) {
        entry.marker.remove();
        markers.current.delete(id);
      }
    }
  }, [props.stops]);

  // Route lines: alternatives underneath, selected route on top with a casing.
  useEffect(() => {
    const { routes, selected } = props;
    ready.current?.then(() => {
      const m = map.current;
      if (!m) return;
      const sel = routes[selected];
      (m.getSource("alts") as GeoJSONSource).setData(
        lines(routes.map((r, idx) => ({ path: r.path, idx })).filter((r) => r.idx !== selected)),
      );
      (m.getSource("route") as GeoJSONSource).setData(lines(sel ? [{ path: sel.path, idx: selected }] : []));
      // Pass-through points the twisty planner added, so riders can see why the route bends away.
      (m.getSource("dots") as GeoJSONSource).setData(points(sel?.detours ?? []));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.routes, props.selected]);

  // Fit view on request.
  useEffect(() => {
    const m = map.current;
    if (!m || props.fitKey === 0) return;
    const pts = props.routes[props.selected]?.path ?? props.stops.map((s) => s.position);
    if (!pts.length) return;
    if (pts.length === 1) {
      m.easeTo({ center: [pts[0].lng, pts[0].lat], zoom: Math.max(m.getZoom(), 12) });
      return;
    }
    const b = new LngLatBounds();
    pts.forEach((p) => b.extend([p.lng, p.lat]));
    m.fitBounds(b, { padding: 60, duration: 600 });
    // Only fit on explicit requests, not on every route update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fitKey]);

  // Elevation-chart hover marker
  useEffect(() => {
    const hover = props.hover;
    ready.current?.then(() => (map.current?.getSource("hover") as GeoJSONSource | undefined)?.setData(points(hover ? [hover] : [])));
  }, [props.hover]);

  return <div ref={el} className="map" />;
}
