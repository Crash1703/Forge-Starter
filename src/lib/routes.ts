import { curviness, distance, midpointOffset, type LatLng } from "./geo";
import { decodePolyline } from "./polyline";
import { VALHALLA_URL } from "./config";

export type RouteStyle = "fastest" | "scenic" | "twisty";
export type Vehicle = "motorcycle" | "car";

export interface RouteOptions {
  style: RouteStyle;
  vehicle: Vehicle;
  avoidHighways: boolean;
  avoidTolls: boolean;
  avoidFerries: boolean;
}

export const defaultOptions: RouteOptions = {
  style: "scenic",
  vehicle: "motorcycle",
  avoidHighways: false,
  avoidTolls: false,
  avoidFerries: false,
};

export interface Step {
  instruction: string;
  maneuver: string;
  distance: number;
}

export interface RouteResult {
  id: string;
  label: string;
  path: LatLng[];
  distance: number; // metres
  duration: number; // seconds
  curviness: number; // degrees per km
  legs: { distance: number; duration: number }[];
  steps: Step[];
  /** Extra via points the planner added to find a curvier line. */
  detours: LatLng[];
  warnings: string[];
}

/** The parts of a Valhalla /route response we use. */
export interface ValhallaTrip {
  summary: { length: number; time: number }; // km, s
  legs: {
    shape: string; // polyline, precision 6
    summary: { length: number; time: number };
    maneuvers?: { instruction: string; length: number; type: number }[];
  }[];
}

interface ValhallaResponse {
  trip?: ValhallaTrip;
  alternates?: { trip: ValhallaTrip }[];
  error?: string;
  error_code?: number;
}

// Valhalla allows more, but the public server caps requests; stay well under.
const MAX_STOPS = 25;

export class RoutingError extends Error {}

interface Waypoint {
  pos: LatLng;
  /** Pass through without splitting the route into another leg. */
  via: boolean;
}

/**
 * Valhalla costing for our options. `use_*` values run 0..1, where 0 means
 * "avoid unless there's no other way".
 */
export function costing(opts: RouteOptions) {
  const avoidHighways = opts.avoidHighways || opts.style !== "fastest";
  const common = {
    use_highways: avoidHighways ? 0 : 1,
    use_tolls: opts.avoidTolls ? 0 : 0.5,
    use_ferry: opts.avoidFerries ? 0 : 0.5,
  };
  if (opts.vehicle === "car") return { costing: "auto", costing_options: { auto: common } };
  // Motorcycle costing favours smaller roads as use_highways drops; keep it on paved roads.
  return { costing: "motorcycle", costing_options: { motorcycle: { ...common, use_trails: 0 } } };
}

async function computeRoutes(
  points: Waypoint[],
  opts: RouteOptions,
  alternatives: boolean,
  signal?: AbortSignal,
): Promise<ValhallaTrip[]> {
  const body = {
    locations: points.map((p) => ({ lat: p.pos.lat, lon: p.pos.lng, type: p.via ? "through" : "break" })),
    ...costing(opts),
    ...(alternatives && points.length === 2 ? { alternates: 2 } : {}),
    directions_options: { units: "kilometers", language: navigator.language || "en-US" },
  };
  let res: Response;
  try {
    res = await fetch(`${VALHALLA_URL}/route`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new RoutingError("Couldn't reach the routing server. Check your connection and try again.");
  }
  const json: ValhallaResponse = await res.json().catch(() => ({}));
  if (!res.ok || !json.trip) {
    if (res.status === 429) throw new RoutingError("The free routing server is busy. Wait a moment and try again.");
    throw new RoutingError(json.error ? `No route: ${json.error}` : `Routing failed (HTTP ${res.status})`);
  }
  return [json.trip, ...(json.alternates ?? []).map((a) => a.trip)];
}

export function toResult(trip: ValhallaTrip, label: string, detours: LatLng[]): RouteResult {
  // Each leg's shape starts where the previous one ended; drop the repeated point.
  const path = trip.legs.flatMap((l, i) => decodePolyline(l.shape, 6).slice(i ? 1 : 0));
  return {
    id: Math.random().toString(36).slice(2),
    label,
    path,
    distance: trip.summary.length * 1000,
    duration: trip.summary.time,
    curviness: curviness(path),
    legs: trip.legs.map((l) => ({ distance: l.summary.length * 1000, duration: l.summary.time })),
    steps: trip.legs.flatMap((l) =>
      (l.maneuvers ?? []).map((m) => ({ instruction: m.instruction, maneuver: String(m.type), distance: m.length * 1000 })),
    ),
    detours,
    warnings: [],
  };
}

/**
 * Plan a route through `stops`.
 *
 * For the twisty style we ask for several candidate routes (the router's
 * alternatives plus variants pushed off to either side of the longest leg by
 * an extra pass-through point), score each by how much the road bends per km,
 * and rank the curviest first. Candidates that take far longer than the
 * quickest one are dropped.
 */
export async function planRoute(stops: LatLng[], opts: RouteOptions, signal?: AbortSignal): Promise<RouteResult[]> {
  if (stops.length > MAX_STOPS) throw new RoutingError(`A route can have at most ${MAX_STOPS} stops.`);
  const base: Waypoint[] = stops.map((pos) => ({ pos, via: false }));
  const baseRoutes = await computeRoutes(base, opts, true, signal);
  const results = baseRoutes.map((r, i) => toResult(r, i === 0 ? "Recommended" : `Alternative ${i}`, []));

  if (opts.style === "twisty" && stops.length < MAX_STOPS) {
    // Longest straight-line leg is where a detour has the most room to find better roads.
    let leg = 0;
    for (let i = 1; i < stops.length - 1; i++) {
      if (distance(stops[i], stops[i + 1]) > distance(stops[leg], stops[leg + 1])) leg = i;
    }
    const a = stops[leg];
    const b = stops[leg + 1];
    if (distance(a, b) > 5000) {
      const variants = [0.2, -0.2, 0.35, -0.35].map((f) => midpointOffset(a, b, f));
      // Sequential, not parallel: the public server rate-limits bursts.
      for (const detour of variants) {
        if (signal?.aborted) break;
        const pts = [...base.slice(0, leg + 1), { pos: detour, via: true }, ...base.slice(leg + 1)];
        try {
          const [r] = await computeRoutes(pts, opts, false, signal);
          results.push(toResult(r, "Detour", [detour]));
        } catch (e) {
          if ((e as Error).name === "AbortError") throw e;
          // A detour point in a lake or on a mountain top just has no route; skip it.
        }
      }
    }
  }

  const quickest = Math.min(...results.map((r) => r.duration));
  const unique = results.filter(
    (r, i) =>
      r.duration <= quickest * 1.6 &&
      !results.slice(0, i).some((o) => Math.abs(o.distance - r.distance) < r.distance * 0.01),
  );
  if (opts.style === "twisty") unique.sort((x, y) => y.curviness - x.curviness);
  else if (opts.style === "fastest") unique.sort((x, y) => x.duration - y.duration);

  return unique.map((r, i) => ({
    ...r,
    label: i === 0 ? (opts.style === "twisty" ? "Twistiest" : opts.style === "fastest" ? "Fastest" : "Recommended") : `Option ${i + 1}`,
  }));
}
