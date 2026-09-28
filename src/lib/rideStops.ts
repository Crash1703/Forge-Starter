import { distance, pathLength, resample, type LatLng } from "./geo";
import { overpass, type OverpassElement } from "./overpass";

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

/**
 * Small boxes covering the road ahead, ~10 km of it each, with a margin of
 * NEAR_ROUTE. A few boxes are far quicker for the server than a search
 * along a long line; what's in a box corner but away from the road is
 * dropped afterwards.
 */
export function boxesAlong(line: LatLng[], chunk = 10_000): [number, number, number, number][] {
  const boxes: [number, number, number, number][] = [];
  let start = 0;
  let done = 0;
  for (let i = 1; i <= line.length; i++) {
    if (i < line.length) done += distance(line[i - 1], line[i]);
    if (i === line.length || done >= chunk) {
      const part = line.slice(start, Math.min(i + 1, line.length));
      const lat = part.map((p) => p.lat);
      const lng = part.map((p) => p.lng);
      const padLat = NEAR_ROUTE / 110_540;
      const padLng = NEAR_ROUTE / (111_320 * Math.cos((lat[0] * Math.PI) / 180));
      boxes.push([Math.min(...lat) - padLat, Math.min(...lng) - padLng, Math.max(...lat) + padLat, Math.max(...lng) + padLng]);
      start = i;
      done = 0;
    }
  }
  return boxes;
}

export function placesQuery(kind: RidePlaceKind, line: LatLng[], from: LatLng): string {
  const boxes = line.length > 1 ? boxesAlong(line) : [];
  const parts = FILTERS[kind].flatMap((f) => [
    ...boxes.map((b) => `nwr${f}(${b.map((v) => v.toFixed(4)).join(",")});`),
    `nwr${f}(around:${AROUND_RIDER},${from.lat.toFixed(5)},${from.lng.toFixed(5)});`,
  ]);
  return `[out:json][timeout:15];(${parts.join("")});out center tags 400;`;
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
    const away = distance(from, position);
    // In a box's corner, well away from the road and from the rider.
    if (best < 0 && away > AROUND_RIDER * 1.1) continue;
    const tags = e.tags ?? {};
    out.push({
      id,
      name: tags.name || tags.brand || tags.operator || fallback,
      position,
      ahead: best >= 0 ? cum[best] : null,
      away,
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
  return rankPlaces(await overpass(placesQuery(kind, line, from), signal), kind, line, from);
}
