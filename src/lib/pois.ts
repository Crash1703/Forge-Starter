import { distance, pathLength, resample, type LatLng } from "./geo";
import { OVERPASS_URL } from "./config";

export type PoiKind = "fuel" | "cafe";

/** A fuel station or café near the route. */
export interface Poi {
  id: string;
  kind: PoiKind;
  name: string;
  position: LatLng;
  at: number; // metres along the route
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/**
 * Fuel stations (within 300 m) and cafés and bakeries (within 200 m) along a
 * route, from OpenStreetMap via Overpass, in riding order.
 */
export async function poisAlong(path: LatLng[], signal?: AbortSignal): Promise<Poi[]> {
  const total = pathLength(path);
  // Overpass takes the route as a polyline; ~200 points keeps the query small.
  const line = resample(path, Math.max(400, total / 200));
  const coords = line.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(",");
  const query = `[out:json][timeout:25];(
nwr["amenity"="fuel"](around:300,${coords});
nwr["amenity"="cafe"](around:200,${coords});
nwr["shop"="bakery"](around:200,${coords});
);out center tags;`;
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(res.status === 429 ? "The map data server is busy. Try again in a minute." : "Couldn't look up stops");
  const json: { elements?: OverpassElement[] } = await res.json();
  return placeAlong(json.elements ?? [], line);
}

/** Turn Overpass elements into stops, each placed at its distance along the route. */
export function placeAlong(elements: OverpassElement[], line: LatLng[]): Poi[] {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + distance(line[i - 1], line[i]));
  const seen = new Set<string>();
  const out: Poi[] = [];
  for (const e of elements) {
    const lat = e.lat ?? e.center?.lat;
    const lng = e.lon ?? e.center?.lon;
    if (lat == null || lng == null) continue;
    const id = `${e.type}/${e.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const position = { lat, lng };
    let best = 0;
    for (let i = 1; i < line.length; i++) if (distance(line[i], position) < distance(line[best], position)) best = i;
    const tags = e.tags ?? {};
    const kind: PoiKind = tags.amenity === "fuel" ? "fuel" : "cafe";
    const name = tags.name || tags.brand || (kind === "fuel" ? "Fuel" : tags.shop === "bakery" ? "Bakery" : "Café");
    out.push({ id, kind, name, position, at: cum[best] });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Stretches longer than `range` metres with no fuel, counting from the
 * start (assume a full tank) to the finish.
 */
export function fuelGaps(pois: Poi[], total: number, range: number): { from: number; to: number }[] {
  const stops = [0, ...pois.filter((p) => p.kind === "fuel").map((p) => p.at), total];
  const gaps: { from: number; to: number }[] = [];
  for (let i = 1; i < stops.length; i++) if (stops[i] - stops[i - 1] > range) gaps.push({ from: stops[i - 1], to: stops[i] });
  return gaps;
}
