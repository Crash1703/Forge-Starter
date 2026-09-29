import { distance, type LatLng } from "./geo";
import { defaultOptions, type RouteOptions, type RouteStyle } from "./routes";

export interface Stop {
  id: string;
  label: string;
  position: LatLng;
  /** Placed by the loop generator rather than chosen by the rider. */
  auto?: boolean;
  /** Ride style from this stop to the next, when it differs from the route's. */
  legStyle?: RouteStyle;
  /**
   * Shaping points on the way from this stop to the next: the route passes
   * near them without stopping there. Generated loops use them to keep
   * their shape with few pins.
   */
  shape?: LatLng[];
  /** The rider named this stop: moving its pin keeps the name. */
  named?: boolean;
  /** Placed by holding on the map: stays exactly there, not snapped to a road. */
  free?: boolean;
  /**
   * Tapped or dragged onto the map (not searched for, not held): only
   * roughly where the rider wants to go, so if the route has to ride up a
   * dead end or turn round to reach it, it may move back to the through road.
   */
  tapped?: boolean;
}

/**
 * Every point to route through, in order, with where it came from: a stop,
 * or one of the shaping points after it (`shape` is its index).
 */
export function routePoints(stops: Stop[], loop: boolean): { position: LatLng; stop: Stop; shape: number }[] {
  const out: { position: LatLng; stop: Stop; shape: number }[] = [];
  stops.forEach((s, i) => {
    out.push({ position: s.position, stop: s, shape: -1 });
    // The last stop's shaping points lead home, so they only count on a loop.
    if (i < stops.length - 1 || loop) (s.shape ?? []).forEach((p, k) => out.push({ position: p, stop: s, shape: k }));
  });
  if (loop && stops.length > 1) out.push({ position: stops[0].position, stop: stops[0], shape: -1 });
  return out;
}

/**
 * The same route ridden the other way. On a loop the start stays first.
 * Shaping points move to the stop that now begins their leg, in reverse.
 */
export function reverseStops(stops: Stop[], loop: boolean): Stop[] {
  const n = stops.length;
  if (n < 2) return stops;
  // Leg i runs from stop i to stop i+1 (wrapping home on a loop).
  const order = loop ? [0, ...stops.slice(1).map((_, i) => n - 1 - i)] : stops.map((_, i) => n - 1 - i);
  return order.map((idx, j) => {
    const next = order[j + 1] ?? (loop ? order[0] : -1);
    // Reversed, the leg idx -> next was originally next -> idx, shaped by stop `next`.
    const shape = next >= 0 ? stops[next].shape?.slice().reverse() : undefined;
    const { shape: _drop, legStyle: _style, ...rest } = stops[idx];
    return { ...rest, ...(shape?.length ? { shape } : {}), ...(next >= 0 && stops[next].legStyle ? { legStyle: stops[next].legStyle } : {}) };
  });
}

const STYLE_CODE: Record<RouteStyle, string> = { fastest: "f", scenic: "s", twisty: "t" };
const CODE_STYLE: Record<string, RouteStyle> = { f: "fastest", s: "scenic", t: "twisty" };

export interface SavedRoute {
  id: string;
  name: string;
  savedAt: number;
  stops: Stop[];
  options: RouteOptions;
  distance: number;
  duration: number;
  curviness: number;
}

const KEY = "forge.savedRoutes";

export const newId = () => Math.random().toString(36).slice(2, 10);

export function loadSaved(): SavedRoute[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SavedRoute[]) : [];
  } catch {
    return [];
  }
}

export function storeSaved(routes: SavedRoute[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(routes));
    return true;
  } catch {
    return false;
  }
}

/** The rider's home: a start point for loops and a "take me home" destination. */
export interface Home {
  label: string;
  position: LatLng;
}

const HOME_KEY = "forge.home";

export function loadHome(): Home | null {
  try {
    const h = JSON.parse(localStorage.getItem(HOME_KEY) ?? "null");
    return h && Number.isFinite(h.position?.lat) && Number.isFinite(h.position?.lng) ? { label: String(h.label || "Home"), position: h.position } : null;
  } catch {
    return null;
  }
}

/** Remember (or with null, forget) home. False if the browser won't store it. */
export function storeHome(home: Home | null): boolean {
  try {
    if (home) localStorage.setItem(HOME_KEY, JSON.stringify(home));
    else localStorage.removeItem(HOME_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Compact, shareable URL hash: #r=<style>.<vehicle>.<flags>~lat,lng,label~... */
export function encodeShare(stops: Stop[], o: RouteOptions): string {
  // A 5th flag, set, means dirt roads are allowed (absent: kept off them, as before it existed).
  const flags = [o.avoidHighways, o.avoidTolls, o.avoidFerries, o.returnToStart, o.avoidUnpaved === false].map((b) => (b ? 1 : 0)).join("");
  // encodeURIComponent leaves "~" alone, but it is our separator.
  const enc = (s: string) => encodeURIComponent(s).replace(/~/g, "%7E");
  // A section's own style rides along as a 4th field (f, s or t), and any
  // shaping points after the stop as a 5th ("lat:lng;lat:lng").
  const pts = stops.map((s) => {
    const shape = (s.shape ?? []).map((p) => `${p.lat.toFixed(5)}:${p.lng.toFixed(5)}`).join(";");
    const extra = shape ? `,${s.legStyle ? STYLE_CODE[s.legStyle] : ""},${shape}` : s.legStyle ? `,${STYLE_CODE[s.legStyle]}` : "";
    return `${s.position.lat.toFixed(5)},${s.position.lng.toFixed(5)},${enc(s.label)}${extra}`;
  });
  // The Direct–Adventure setting as a 4th part ("d50"), only when it isn't the middle.
  const detour = o.detour != null && Math.round(o.detour * 100) !== 50 ? `.d${Math.round(o.detour * 100)}` : "";
  return `#r=${[`${o.style}.${o.vehicle}.${flags}${detour}`, ...pts].join("~")}`;
}

export function decodeShare(hash: string): { stops: Stop[]; options: RouteOptions } | null {
  const m = /^#r=(.+)$/.exec(hash);
  if (!m) return null;
  const [head, ...pts] = m[1].split("~");
  const [style, vehicle, flags = "000", detourPart] = head.split(".");
  const detour = /^d(\d{1,3})$/.exec(detourPart ?? "");
  const stops = pts.flatMap((p) => {
    const [lat, lng, label = "", code = "", shapeText = ""] = p.split(",");
    const position = { lat: parseFloat(lat), lng: parseFloat(lng) };
    if (!Number.isFinite(position.lat) || !Number.isFinite(position.lng)) return [];
    const legStyle = CODE_STYLE[code];
    const shape = shapeText
      .split(";")
      .map((q) => q.split(":").map(parseFloat))
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
      .map(([a, b]) => ({ lat: a, lng: b }));
    return [
      {
        id: newId(),
        label: decodeURIComponent(label) || `${lat}, ${lng}`,
        position,
        ...(legStyle ? { legStyle } : {}),
        ...(shape.length ? { shape } : {}),
      },
    ];
  });
  if (stops.length < 2) return null;
  const options: RouteOptions = {
    style: (["fastest", "scenic", "twisty"] as const).find((s) => s === style) ?? defaultOptions.style,
    vehicle: vehicle === "car" ? "car" : "motorcycle",
    avoidHighways: flags[0] === "1",
    avoidTolls: flags[1] === "1",
    avoidFerries: flags[2] === "1",
    returnToStart: flags[3] === "1",
    avoidUnpaved: flags[4] !== "1",
    detour: detour ? Math.min(100, +detour[1]) / 100 : 0.5,
  };
  return normalizeLoop(stops, options);
}

/**
 * Older loops stored the finish as a copy of the start. Turn that into the
 * "return to start" option so the finish can't drift from the start again.
 */
export function normalizeLoop(stops: Stop[], options: RouteOptions): { stops: Stop[]; options: RouteOptions } {
  // Within 50 m counts as closed: GPX loops rarely end on the exact start coordinate.
  const closed = stops.length > 2 && distance(stops[0].position, stops[stops.length - 1].position) < 50;
  return closed
    ? { stops: stops.slice(0, -1), options: { ...options, returnToStart: true } }
    : { stops, options: { ...options, returnToStart: !!options.returnToStart } };
}
