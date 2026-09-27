import type { LatLng } from "./geo";
import { defaultOptions, type RouteOptions } from "./routes";

export interface Stop {
  id: string;
  label: string;
  position: LatLng;
}

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
  const flags = [o.avoidHighways, o.avoidTolls, o.avoidFerries].map((b) => (b ? 1 : 0)).join("");
  // encodeURIComponent leaves "~" alone, but it is our separator.
  const enc = (s: string) => encodeURIComponent(s).replace(/~/g, "%7E");
  const pts = stops.map((s) => `${s.position.lat.toFixed(5)},${s.position.lng.toFixed(5)},${enc(s.label)}`);
  return `#r=${[`${o.style}.${o.vehicle}.${flags}`, ...pts].join("~")}`;
}

export function decodeShare(hash: string): { stops: Stop[]; options: RouteOptions } | null {
  const m = /^#r=(.+)$/.exec(hash);
  if (!m) return null;
  const [head, ...pts] = m[1].split("~");
  const [style, vehicle, flags = "000"] = head.split(".");
  const stops = pts.flatMap((p) => {
    const [lat, lng, label = ""] = p.split(",");
    const position = { lat: parseFloat(lat), lng: parseFloat(lng) };
    if (!Number.isFinite(position.lat) || !Number.isFinite(position.lng)) return [];
    return [{ id: newId(), label: decodeURIComponent(label) || `${lat}, ${lng}`, position }];
  });
  if (stops.length < 2) return null;
  const options: RouteOptions = {
    style: (["fastest", "scenic", "twisty"] as const).find((s) => s === style) ?? defaultOptions.style,
    vehicle: vehicle === "car" ? "car" : "motorcycle",
    avoidHighways: flags[0] === "1",
    avoidTolls: flags[1] === "1",
    avoidFerries: flags[2] === "1",
  };
  return { stops, options };
}
