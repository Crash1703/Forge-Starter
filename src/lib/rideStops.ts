import { distance, type LatLng } from "./geo";
import { overpass, type OverpassElement } from "./overpass";
import { lookupLine, poiKind, poiQuery, POI_KINDS, type Poi, type PoiKind } from "./pois";

/** Kinds of stop offered while riding: the same as the planner's. */
export type RidePlaceKind = PoiKind;
export const RIDE_PLACE_KINDS = POI_KINDS;

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

/** The road ahead as the lookup uses it: the next 60 km, thinned like the planner's. */
export const aheadLine = (ahead: LatLng[]) => lookupLine(firstStretch(ahead, LOOK_AHEAD));

/** The same question the planner asks, for the road ahead, plus 3 km around the rider. */
export const placesQuery = (kind: RidePlaceKind, line: LatLng[], from: LatLng) => poiQuery(kind, line, { at: from, radius: AROUND_RIDER });

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
      name: tags.name || tags.brand || tags.operator || poiKind(kind).one,
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

/** Places already found in the planner, as places on the road ahead: no lookup needed. */
export function knownPlaces(known: Poi[], kind: RidePlaceKind, ahead: LatLng[], from: LatLng): RidePlace[] {
  const elements = known
    .filter((k) => k.kind === kind)
    .map((k, i) => ({ type: "known", id: i, lat: k.position.lat, lon: k.position.lng, tags: { name: k.name } }));
  return rankPlaces(elements, kind, aheadLine(ahead), from).filter((p) => p.ahead != null);
}
