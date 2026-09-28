import { distance, pathLength, resample, type LatLng } from "./geo";
import { OVERPASS_URL } from "./config";

export type RidePlaceKind = "fuel" | "food" | "lookout" | "toilets";

export const RIDE_PLACE_KINDS: { kind: RidePlaceKind; icon: string; name: string }[] = [
  { kind: "fuel", icon: "⛽", name: "Fuel" },
  { kind: "food", icon: "🍴", name: "Food" },
  { kind: "lookout", icon: "👁", name: "Lookout" },
  { kind: "toilets", icon: "🚻", name: "Toilets" },
];

/** A place to stop at while riding. */
export interface RidePlace {
  id: string;
  name: string;
  position: LatLng;
  /** Metres along the road ahead to where it is, if it's near the route. */
  ahead: number | null;
  /** Straight-line metres from the rider. */
  away: number;
}

const FILTERS: Record<RidePlaceKind, string[]> = {
  fuel: ['["amenity"="fuel"]'],
  food: ['["amenity"~"^(cafe|restaurant|fast_food|pub)$"]', '["shop"="bakery"]'],
  lookout: ['["tourism"="viewpoint"]'],
  toilets: ['["amenity"="toilets"]'],
};

/** How far off the route ahead a place may be, and how far ahead to look. */
const NEAR_ROUTE = 1000;
const LOOK_AHEAD = 60_000;
const AROUND_RIDER = 3000;

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** The first `metres` of a path. */
export function firstStretch(path: LatLng[], metres: number): LatLng[] {
  const out = path.slice(0, 1);
  let done = 0;
  for (let i = 1; i < path.length && done < metres; i++) {
    done += distance(path[i - 1], path[i]);
    out.push(path[i]);
  }
  return out;
}

export function placesQuery(kind: RidePlaceKind, line: LatLng[], from: LatLng): string {
  const coords = line.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(",");
  const parts = FILTERS[kind].flatMap((f) => [
    ...(line.length > 1 ? [`nwr${f}(around:${NEAR_ROUTE},${coords});`] : []),
    `nwr${f}(around:${AROUND_RIDER},${from.lat.toFixed(5)},${from.lng.toFixed(5)});`,
  ]);
  return `[out:json][timeout:20];(${parts.join("")});out center tags 200;`;
}

/**
 * Turn Overpass results into places, nearest ahead first: places close to
 * the road ahead by how far along it they are, then anything else nearby by
 * distance from the rider.
 */
export function rankPlaces(elements: OverpassElement[], kind: RidePlaceKind, line: LatLng[], from: LatLng, limit = 25): RidePlace[] {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + distance(line[i - 1], line[i]));
  const seen = new Set<string>();
  const out: RidePlace[] = [];
  const fallback = RIDE_PLACE_KINDS.find((k) => k.kind === kind)!.name;
  for (const e of elements) {
    const lat = e.lat ?? e.center?.lat;
    const lng = e.lon ?? e.center?.lon;
    const id = `${e.type}/${e.id}`;
    if (lat == null || lng == null || seen.has(id)) continue;
    seen.add(id);
    const position = { lat, lng };
    let best = -1;
    let bestD = NEAR_ROUTE * 1.2;
    for (let i = 0; i < line.length; i++) {
      const d = distance(line[i], position);
      if (d < bestD) {
        best = i;
        bestD = d;
      }
    }
    const tags = e.tags ?? {};
    out.push({
      id,
      name: tags.name || tags.brand || tags.operator || fallback,
      position,
      ahead: best >= 0 ? cum[best] : null,
      away: distance(from, position),
    });
  }
  return out
    .sort((a, b) => (a.ahead == null ? 1 : 0) - (b.ahead == null ? 1 : 0) || (a.ahead ?? a.away) - (b.ahead ?? b.away))
    .slice(0, limit);
}

/** Places of `kind` along the next 60 km of the route (`ahead`) and around the rider. */
export async function placesAhead(kind: RidePlaceKind, ahead: LatLng[], from: LatLng, signal?: AbortSignal): Promise<RidePlace[]> {
  const stretch = firstStretch(ahead, LOOK_AHEAD);
  const line = resample(stretch, Math.max(500, pathLength(stretch) / 120));
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(placesQuery(kind, line, from))}`,
  });
  if (!res.ok) throw new Error(res.status === 429 ? "The map data server is busy. Try again in a minute." : "Couldn't look up places");
  const json: { elements?: OverpassElement[] } = await res.json();
  return rankPlaces(json.elements ?? [], kind, line, from);
}
