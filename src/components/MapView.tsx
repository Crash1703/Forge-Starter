import { useEffect, useRef } from "react";
import { distance, pathLength, type LatLng } from "../lib/geo";
import type { RouteResult } from "../lib/routes";
import type { Stop } from "../lib/storage";
import { getMapId } from "../lib/config";

interface Props {
  stops: Stop[];
  routes: RouteResult[];
  selected: number;
  hover: LatLng | null;
  /** Changing this re-fits the view to the current route or stops. */
  fitKey: number;
  darkMode: boolean;
  onMapClick: (p: LatLng) => void;
  onStopMove: (id: string, p: LatLng) => void;
  onRouteClick: (p: LatLng, legIndex: number) => void;
  onSelectRoute: (i: number) => void;
  onMapReady?: (map: google.maps.Map) => void;
}

const ROUTE = "#ff6a13";
const ALT = "#8a94a6";

function pinContent(kind: "start" | "via" | "end", text: string) {
  const el = document.createElement("div");
  el.className = `pin pin-${kind}`;
  el.textContent = text;
  return el;
}

/**
 * A fixed-size dot drawn as a symbol on a zero-length polyline. Cheaper than
 * an advanced marker for display-only points and needs no DOM.
 */
function dot(map: google.maps.Map | null, position: LatLng, fill: string, scale: number) {
  return new google.maps.Polyline({
    map,
    path: [position, position],
    strokeOpacity: 0,
    clickable: false,
    zIndex: 15,
    icons: [
      {
        offset: "0",
        icon: { path: google.maps.SymbolPath.CIRCLE, scale, fillColor: fill, fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2.5 },
      },
    ],
  });
}

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
  // Leg distances come from Google's road network, the path from its polyline;
  // compare by fraction of the whole trip so the two scales don't need to agree.
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
  const map = useRef<google.maps.Map | null>(null);
  const markers = useRef(new Map<string, google.maps.marker.AdvancedMarkerElement>());
  const lines = useRef<google.maps.Polyline[]>([]);
  const detourDots = useRef<google.maps.Polyline[]>([]);
  const hoverDot = useRef<google.maps.Polyline | null>(null);
  // Handlers change every render; listeners read the latest through this ref.
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    if (!el.current) return;
    const m = new google.maps.Map(el.current, {
      center: { lat: 47.3, lng: 11.4 },
      zoom: 7,
      mapId: getMapId(),
      colorScheme: props.darkMode ? google.maps.ColorScheme.DARK : google.maps.ColorScheme.LIGHT,
      mapTypeControl: true,
      mapTypeControlOptions: { position: google.maps.ControlPosition.TOP_RIGHT },
      streetViewControl: false,
      fullscreenControl: false,
      clickableIcons: false,
      gestureHandling: "greedy",
    });
    m.addListener("click", (e: google.maps.MapMouseEvent) => {
      if (e.latLng) cb.current.onMapClick(e.latLng.toJSON());
    });
    map.current = m;
    cb.current.onMapReady?.(m);
    return () => {
      google.maps.event.clearInstanceListeners(m);
      map.current = null;
    };
    // The colour scheme is fixed at creation time by the Maps API.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stop markers
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const seen = new Set<string>();
    props.stops.forEach((s, i) => {
      const kind = i === 0 ? "start" : i === props.stops.length - 1 ? "end" : "via";
      const text = kind === "start" ? "A" : kind === "end" ? "B" : String(i);
      seen.add(s.id);
      let mk = markers.current.get(s.id);
      if (!mk) {
        mk = new google.maps.marker.AdvancedMarkerElement({ map: m, gmpDraggable: true, zIndex: 10 });
        mk.addListener("dragend", () => {
          const pos = mk!.position;
          if (!pos) return;
          const ll = pos instanceof google.maps.LatLng ? pos.toJSON() : { lat: Number(pos.lat), lng: Number(pos.lng) };
          cb.current.onStopMove(s.id, ll);
        });
        markers.current.set(s.id, mk);
      }
      mk.position = s.position;
      mk.title = s.label;
      mk.content = pinContent(kind, text);
    });
    for (const [id, mk] of markers.current) {
      if (!seen.has(id)) {
        mk.map = null;
        markers.current.delete(id);
      }
    }
  }, [props.stops]);

  // Route lines: alternatives underneath, selected route on top with a casing.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    lines.current.forEach((l) => l.setMap(null));
    lines.current = [];
    detourDots.current.forEach((d) => d.setMap(null));
    detourDots.current = [];

    props.routes.forEach((r, i) => {
      if (i === props.selected) return;
      const alt = new google.maps.Polyline({
        map: m,
        path: r.path,
        strokeColor: ALT,
        strokeOpacity: 0.75,
        strokeWeight: 5,
        zIndex: 1,
      });
      alt.addListener("click", () => cb.current.onSelectRoute(i));
      lines.current.push(alt);
    });
    const sel = props.routes[props.selected];
    if (sel) {
      lines.current.push(
        new google.maps.Polyline({ map: m, path: sel.path, strokeColor: "#1b1f24", strokeOpacity: 0.55, strokeWeight: 9, zIndex: 2, clickable: false }),
      );
      const main = new google.maps.Polyline({ map: m, path: sel.path, strokeColor: ROUTE, strokeWeight: 6, zIndex: 3 });
      main.addListener("click", (e: google.maps.PolyMouseEvent) => {
        if (e.latLng) cb.current.onRouteClick(e.latLng.toJSON(), legAt(sel, e.latLng.toJSON()));
      });
      lines.current.push(main);
      // Via points the twisty planner added, so riders can see why the route bends away.
      detourDots.current = sel.detours.map((d) => dot(m, d, ROUTE, 5));
    }
  }, [props.routes, props.selected]);

  // Fit view on request.
  useEffect(() => {
    const m = map.current;
    if (!m || props.fitKey === 0) return;
    const pts = props.routes[props.selected]?.path ?? props.stops.map((s) => s.position);
    if (!pts.length) return;
    if (pts.length === 1) {
      m.panTo(pts[0]);
      m.setZoom(Math.max(m.getZoom() ?? 12, 12));
      return;
    }
    const b = new google.maps.LatLngBounds();
    pts.forEach((p) => b.extend(p));
    m.fitBounds(b, { top: 60, bottom: 60, left: 60, right: 60 });
    // Only fit on explicit requests, not on every route update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fitKey]);

  // Elevation-chart hover marker
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!props.hover) {
      hoverDot.current?.setMap(null);
      return;
    }
    if (!hoverDot.current) hoverDot.current = dot(null, props.hover, ROUTE, 7);
    hoverDot.current.setPath([props.hover, props.hover]);
    if (!hoverDot.current.getMap()) hoverDot.current.setMap(m);
  }, [props.hover]);

  return <div ref={el} className="map" />;
}
