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

/**
 * How far off the road ahead to look, per kind: the same distances as the
 * planner's "Find fuel & cafés", which the public server answers quickly.
 * Wider searches along a long line are what made it time out.
 */
const NEAR_ROUTE: Record<RidePlaceKind, number> = { fuel: 300, food: 200, lookout: 500, toilets: 300 };
/** Counted as "on the way" when this close to the road ahead. */
const ON_THE_WAY = 600;
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

export function placesQuery(kind: RidePlaceKind, line: LatLng[], from: LatLng): string {
  const coords = line.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(",");
  const parts = FILTERS[kind].flatMap((f) => [
    ...(line.length > 1 ? [`nwr${f}(around:${NEAR_ROUTE[kind]},${coords});`] : []),
    `nwr${f}(around:${AROUND_RIDER},${from.lat.toFixed(5)},${from.lng.toFixed(5)});`,
  ]);
  return `[out:json][timeout:25];(${parts.join("")});out center tags;`;
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
    let bestD = ON_THE_WAY;
    for (let i = 0; i < line.length; i++) {
      const d = distance(line[i], position);
      if (d < bestD) {
        best = i;
        bestD = d;
      }
    }
    const away = distance(from, position);
    // Neither on the way nor near the rider.
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
  const line = aheadLine(ahead);
  return rankPlaces(await overpass(placesQuery(kind, line, from), signal), kind, line, from);
}

/** The road ahead as the lookup uses it: 60 km, thinned like the planner's (~200 points). */
export function aheadLine(ahead: LatLng[]): LatLng[] {
  const stretch = firstStretch(ahead, LOOK_AHEAD);
  return resample(stretch, Math.max(400, pathLength(stretch) / 200));
}

/**
 * Fuel stations and cafés already found in the planner ("Find fuel &
 * cafés"), as places on the road ahead: no lookup needed.
 */
export function knownPlaces(
  known: { id: string; kind: "fuel" | "cafe"; name: string; position: LatLng }[],
  kind: RidePlaceKind,
  ahead: LatLng[],
  from: LatLng,
): RidePlace[] {
  const want = kind === "fuel" ? "fuel" : kind === "food" ? "cafe" : null;
  if (!want) return [];
  const elements = known
    .filter((k) => k.kind === want)
    .map((k) => ({ type: "known", id: 0, lat: k.position.lat, lon: k.position.lng, tags: { name: k.name }, key: k.id }));
  // rankPlaces keys by type/id; give each its own.
  return rankPlaces(
    elements.map((e, i) => ({ ...e, id: i })),
    kind,
    aheadLine(ahead),
    from,
  ).filter((p) => p.ahead != null);
}
