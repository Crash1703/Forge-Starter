import { bendAnalysis, pathLength, type BendReport, type LatLng } from "./geo";
import { routerFetch } from "./routeServer";
import { costing, RoutingError, type RouteOptions } from "./routes";

/** What the roads along a route are, by length (metres). */
export interface RoadFacts {
  total: number;
  /** Built-up: weighted by the router's road density (0–15; country 0–3, suburbs 4–8, city 9+). */
  town: number;
  motorway: number;
  dirt: number;
}

/**
 * A town share for a road from the router's density: nothing up to 3
 * (country roads round Maleny and Mount Mee read 0–2), fully town from 6
 * (Sunshine Coast suburbs read 4–8, inner Brisbane 9–13).
 */
export const townWeight = (density: number | undefined) => Math.min(1, Math.max(0, ((density ?? 0) - 3) / 3));

/** The route server's description of each road on a path: class, density and surface. */
export async function roadFacts(path: LatLng[], opts: RouteOptions, signal?: AbortSignal): Promise<RoadFacts> {
  const k = Math.max(1, Math.ceil(path.length / 1500));
  const shape = path.filter((_, i) => i % k === 0 || i === path.length - 1);
  const res = await routerFetch(
    "/trace_attributes",
    {
      shape: shape.map((p) => ({ lat: p.lat, lon: p.lng })),
      costing: costing(opts).costing,
      shape_match: "map_snap",
      filters: { attributes: ["edge.length", "edge.density", "edge.road_class", "edge.unpaved", "edge.surface"], action: "include" },
    },
    signal,
  );
  if (!res.ok) throw new RoutingError(`Road details unavailable (HTTP ${res.status})`);
  const json: { edges?: { length?: number; density?: number; road_class?: string; unpaved?: boolean; surface?: string }[] } = await res.json();
  const facts: RoadFacts = { total: 0, town: 0, motorway: 0, dirt: 0 };
  for (const e of json.edges ?? []) {
    const m = (e.length ?? 0) * 1000;
    facts.total += m;
    facts.town += m * townWeight(e.density);
    if (e.road_class === "motorway" || e.road_class === "trunk") facts.motorway += m;
    if (e.unpaved || ["dirt", "gravel", "path", "impassable"].includes(e.surface ?? "")) facts.dirt += m;
  }
  return facts;
}

export interface RideScore {
  /** 0–100 overall. */
  score: number;
  /** Each 0–100, or null where it isn't known (yet). */
  curves: number;
  flow: number;
  rural: number | null;
  hills: number | null;
  sealed: number | null;
  bends: BendReport;
}

const clamp = (v: number) => Math.round(Math.min(100, Math.max(0, v)));

/**
 * How good a route is to ride, 0–100, and why:
 * - Curves: bend quality (bendAnalysis): real bends per km, weighted by radius.
 * - Flow: few stops and turns: junction corners and turn instructions per km, and town riding.
 * - Rural: the share out of towns.
 * - Hills: climbing per km (40 m/km or more counts as full marks).
 * - Sealed: the share on sealed roads.
 * The overall score weighs Curves 40%, Flow 20%, Rural 15%, Hills 15% and
 * Sealed 10%, over whichever parts are known.
 */
export function rideScore(route: { path: LatLng[]; distance: number; steps: unknown[] }, facts: RoadFacts | null, ascent: number | null): RideScore {
  const bends = bendAnalysis(route.path);
  const km = Math.max(0.1, (route.distance || pathLength(route.path)) / 1000);
  const townShare = facts && facts.total > 0 ? facts.town / facts.total : null;
  const curves = bends.score;
  const turnsPerKm = route.steps.length / km;
  const flow = clamp(100 - Math.min(50, turnsPerKm * 25) - (bends.junctions / km) * 20 - (townShare ?? 0) * 40);
  const rural = townShare == null ? null : clamp(100 * (1 - townShare));
  const hills = ascent == null ? null : clamp(((ascent / km) / 40) * 100);
  const sealed = facts && facts.total > 0 ? clamp(100 * (1 - facts.dirt / facts.total)) : null;
  const parts: [number | null, number][] = [
    [curves, 0.4],
    [flow, 0.2],
    [rural, 0.15],
    [hills, 0.15],
    [sealed, 0.1],
  ];
  const known = parts.filter((p): p is [number, number] => p[0] != null);
  const weight = known.reduce((a, [, w]) => a + w, 0);
  const score = clamp(known.reduce((a, [v, w]) => a + v * w, 0) / weight);
  return { score, curves, flow, rural, hills, sealed, bends };
}
