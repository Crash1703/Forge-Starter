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

/** Compact, shareable URL hash: #r=<style>.<vehicle>.<flags>~lat,lng,label~... */
export function encodeShare(stops: Stop[], o: RouteOptions): string {
  const flags = [o.avoidHighways, o.avoidTolls, o.avoidFerries, o.returnToStart].map((b) => (b ? 1 : 0)).join("");
  // encodeURIComponent leaves "~" alone, but it is our separator.
  const enc = (s: string) => encodeURIComponent(s).replace(/~/g, "%7E");
  // A section's own style rides along as a 4th field: f, s or t.
  const pts = stops.map(
    (s) => `${s.position.lat.toFixed(5)},${s.position.lng.toFixed(5)},${enc(s.label)}${s.legStyle ? `,${STYLE_CODE[s.legStyle]}` : ""}`,
  );
  return `#r=${[`${o.style}.${o.vehicle}.${flags}`, ...pts].join("~")}`;
}

export function decodeShare(hash: string): { stops: Stop[]; options: RouteOptions } | null {
  const m = /^#r=(.+)$/.exec(hash);
  if (!m) return null;
  const [head, ...pts] = m[1].split("~");
  const [style, vehicle, flags = "000"] = head.split(".");
  const stops = pts.flatMap((p) => {
    const [lat, lng, label = "", code = ""] = p.split(",");
    const position = { lat: parseFloat(lat), lng: parseFloat(lng) };
    if (!Number.isFinite(position.lat) || !Number.isFinite(position.lng)) return [];
    const legStyle = CODE_STYLE[code];
    return [{ id: newId(), label: decodeURIComponent(label) || `${lat}, ${lng}`, position, ...(legStyle ? { legStyle } : {}) }];
  });
  if (stops.length < 2) return null;
  const options: RouteOptions = {
    style: (["fastest", "scenic", "twisty"] as const).find((s) => s === style) ?? defaultOptions.style,
    vehicle: vehicle === "car" ? "car" : "motorcycle",
    avoidHighways: flags[0] === "1",
    avoidTolls: flags[1] === "1",
    avoidFerries: flags[2] === "1",
    returnToStart: flags[3] === "1",
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
