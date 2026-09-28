import { distance, pathLength, resample, type LatLng } from "./geo";
import { overpass, type OverpassElement } from "./overpass";

export type PoiKind = "fuel" | "cafe" | "food" | "pub" | "toilets" | "lookout";

/** What can be looked up along a route, and how far off the road each may be. */
export const POI_KINDS: { kind: PoiKind; name: string; one: string; filters: string[]; near: number }[] = [
  { kind: "fuel", name: "Fuel", one: "Fuel", filters: ['["amenity"="fuel"]'], near: 300 },
  { kind: "cafe", name: "Cafés", one: "Café", filters: ['["amenity"="cafe"]', '["shop"="bakery"]'], near: 200 },
  { kind: "food", name: "Food", one: "Food", filters: ['["amenity"~"^(restaurant|fast_food)$"]'], near: 200 },
  { kind: "pub", name: "Pubs", one: "Pub", filters: ['["amenity"~"^(pub|bar|biergarten)$"]'], near: 200 },
  { kind: "toilets", name: "Toilets", one: "Toilets", filters: ['["amenity"="toilets"]'], near: 300 },
  { kind: "lookout", name: "Lookouts", one: "Lookout", filters: ['["tourism"="viewpoint"]'], near: 500 },
];

export const poiKind = (kind: PoiKind) => POI_KINDS.find((k) => k.kind === kind)!;

/** A place near the route: fuel, a café, a pub, toilets, a lookout. */
export interface Poi {
  id: string;
  kind: PoiKind;
  name: string;
  position: LatLng;
  at: number; // metres along the route
}

/** The route as the lookup sends it: ~200 points, which the public servers answer quickly. */
export function lookupLine(path: LatLng[]): LatLng[] {
  return resample(path, Math.max(400, pathLength(path) / 200));
}

/** One kind of place near a line, plus (optionally) around a point. */
export function poiQuery(kind: PoiKind, line: LatLng[], around?: { at: LatLng; radius: number }): string {
  const k = poiKind(kind);
  const coords = line.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(",");
  const parts = k.filters.flatMap((f) => [
    ...(line.length > 1 ? [`nwr${f}(around:${k.near},${coords});`] : []),
    ...(around ? [`nwr${f}(around:${around.radius},${around.at.lat.toFixed(5)},${around.at.lng.toFixed(5)});`] : []),
  ]);
  return `[out:json][timeout:25];(${parts.join("")});out center tags;`;
}

/**
 * Places of one kind along a route, from OpenStreetMap via Overpass, in
 * riding order. One kind at a time keeps each question small and quick.
 */
export async function poisAlong(path: LatLng[], kind: PoiKind, signal?: AbortSignal): Promise<Poi[]> {
  const line = lookupLine(path);
  return placeAlong(await overpass(poiQuery(kind, line), signal), line, kind);
}

/** Turn Overpass elements into stops, each placed at its distance along the route. */
export function placeAlong(elements: OverpassElement[], line: LatLng[], kind: PoiKind): Poi[] {
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
    const name = tags.name || tags.brand || tags.operator || (tags.shop === "bakery" ? "Bakery" : poiKind(kind).one);
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
