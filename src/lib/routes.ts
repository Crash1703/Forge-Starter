import { avoidPoints, curviness, distance, midpointOffset, outAndBack, sharedRoad, type LatLng } from "./geo";
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
  /** Ride back to the first stop after the last one. */
  returnToStart: boolean;
}

export const defaultOptions: RouteOptions = {
  style: "scenic",
  vehicle: "motorcycle",
  avoidHighways: false,
  avoidTolls: false,
  avoidFerries: false,
  returnToStart: false,
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

export class RoutingError extends Error {
  /** The router ran but found no way through these stops (as opposed to being busy or unreachable). */
  constructor(message: string, readonly noPath = false) {
    super(message);
  }
}

/** Riding more than this far up a road and back down it counts as a dead-end spur. */
const SPUR_METRES = 100;

export const spurWarning = (stop: number) =>
  `The route rides up and back down the same road to reach stop ${stop}. Move that pin onto a through road to avoid it.`;

export const UTURN_WARNING =
  "One of your stops can only be reached by turning around, so the route turns back there. Move that pin onto a through road to avoid it.";

/** A stop to route through. */
export interface RoutePoint {
  pos: LatLng;
  /**
   * Forbid turning around here. Used for generated loop points, which can land
   * near a dead end the router would otherwise ride up and back down.
   */
  noUturn?: boolean;
  /**
   * Metres around `pos` within which any road will do. Lets the router pick a
   * through road near a loosely placed point instead of the exact side street
   * or dead end under it.
   */
  radius?: number;
}

/** Twisty's helper points only pull the route sideways; any road nearby will do. */
const HELPER_RADIUS = 1500;

interface Waypoint extends RoutePoint {
  /** Pass through without splitting the route into another leg. */
  via: boolean;
}

/** Valhalla location type: legs split at "break*" types, U-turns allowed only at "break" and "via". */
const locationType = (p: Waypoint) => (p.via ? "through" : p.noUturn ? "break_through" : "break");

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
  avoid: LatLng[] = [],
): Promise<ValhallaTrip[]> {
  const body = {
    locations: points.map((p) => ({
      lat: p.pos.lat,
      lon: p.pos.lng,
      type: locationType(p),
      ...(p.radius ? { radius: Math.round(p.radius) } : {}),
    })),
    ...costing(opts),
    ...(alternatives && points.length === 2 ? { alternates: 2 } : {}),
    directions_options: { units: "kilometers", language: navigator.language || "en-US" },
    // Roads to stay off; Valhalla drops the road nearest each point.
    ...(avoid.length ? { exclude_locations: avoid.map((p) => ({ lat: p.lat, lon: p.lng })) } : {}),
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
    throw new RoutingError(json.error ? `No route: ${json.error}` : `Routing failed (HTTP ${res.status})`, res.status === 400);
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

/** A leg sharing more road than this with earlier legs gets re-planned on a loop. */
const LOOP_SHARED_METRES = 1000;

/**
 * On a loop, the router happily rides back the way it came: nothing asks it
 * for a different road home. Re-plan any leg that runs along road an earlier
 * leg already used, telling the router to stay off that road (except near
 * the leg's own ends, where sharing the roads around a stop or home is
 * fine). Keeps the original leg if there's no other way.
 */
async function untangleLoop(
  trip: ValhallaTrip,
  waypoints: Waypoint[],
  opts: RouteOptions,
  signal?: AbortSignal,
): Promise<ValhallaTrip> {
  // Legs split at every non-via waypoint.
  const breaks = waypoints.flatMap((w, i) => (w.via ? [] : [i]));
  if (trip.legs.length !== breaks.length - 1) return trip;
  const legs = trip.legs.slice();
  const paths = legs.map((l) => decodePolyline(l.shape, 6));
  let changed = false;
  for (let k = 1; k < legs.length; k++) {
    const ends = [waypoints[breaks[k]].pos, waypoints[breaks[k + 1]].pos];
    const earlier = paths.slice(0, k);
    const shared = sharedRoad(paths[k], earlier, ends);
    if (shared < LOOP_SHARED_METRES) continue;
    // Just this leg, with its helper points; a leg's own ends are plain stops.
    const pts = waypoints
      .slice(breaks[k], breaks[k + 1] + 1)
      .map((w, i, all) => (i === 0 || i === all.length - 1 ? { ...w, noUturn: false } : w));
    try {
      const [alt] = await computeRoutes(pts, opts, false, signal, avoidPoints(earlier, ends));
      const altPath = decodePolyline(alt.legs[0].shape, 6);
      if (alt.legs.length === 1 && sharedRoad(altPath, earlier, ends) < shared) {
        legs[k] = alt.legs[0];
        paths[k] = altPath;
        changed = true;
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      // No other way round (say, a town with one road in): keep the original leg.
    }
  }
  if (!changed) return trip;
  const sum = (f: (l: ValhallaTrip["legs"][number]) => number) => legs.reduce((a, l) => a + f(l), 0);
  return { summary: { length: sum((l) => l.summary.length), time: sum((l) => l.summary.time) }, legs };
}

/**
 * Plan a route through `points`, in order.
 *
 * For the twisty style we ask for several candidate routes (the router's
 * alternatives plus variants pushed off to either side of the longest leg by
 * an extra pass-through point), score each by how much the road bends per km,
 * and rank the curviest first. Candidates that take far longer than the
 * quickest one, or that ride up a dead end and back to reach their helper
 * point, are dropped.
 */
export async function planRoute(points: RoutePoint[], opts: RouteOptions, signal?: AbortSignal): Promise<RouteResult[]> {
  const stops = points.map((p) => p.pos);
  if (stops.length > MAX_STOPS) throw new RoutingError(`A route can have at most ${MAX_STOPS} stops.`);
  let base: Waypoint[] = points.map((p) => ({ ...p, via: false }));
  let baseRoutes: ValhallaTrip[];
  let turnsAround = false;
  try {
    baseRoutes = await computeRoutes(base, opts, true, signal);
  } catch (e) {
    // A pin at the end of a dead end can only be reached by turning around.
    // Allow it rather than failing, and tell the rider.
    if (!(e instanceof RoutingError && e.noPath && base.some((p) => p.noUturn))) throw e;
    base = base.map((p) => ({ ...p, noUturn: false }));
    baseRoutes = await computeRoutes(base, opts, true, signal);
    turnsAround = true;
  }
  const loop = opts.returnToStart
    ? (trip: ValhallaTrip, pts: Waypoint[]) => untangleLoop(trip, pts, opts, signal)
    : async (trip: ValhallaTrip) => trip;
  baseRoutes = [await loop(baseRoutes[0], base), ...baseRoutes.slice(1)];

  // Banning U-turns can backfire: a pin on a side street makes the route
  // ride on past it to find somewhere to turn, then come back. Where that
  // happens, also try allowing a U-turn at those stops and keep whichever
  // version rides less road twice.
  const ridesTwice = (trip: ValhallaTrip) => {
    const path = toResult(trip, "", []).path;
    return points.slice(1, -1).map((p) => outAndBack(path, p.pos));
  };
  const twice = ridesTwice(baseRoutes[0]);
  if (twice.some((m, i) => m > SPUR_METRES && points[i + 1].noUturn)) {
    const relaxed = base.map((p, i) => (i > 0 && twice[i - 1] > SPUR_METRES ? { ...p, noUturn: false } : p));
    try {
      const other = await computeRoutes(relaxed, opts, true, signal);
      other[0] = await loop(other[0], relaxed);
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
      if (sum(ridesTwice(other[0])) < sum(twice)) {
        base = relaxed;
        baseRoutes = other;
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      // Keep the no-U-turn version.
    }
  }
  // Name any stop the route has to ride up and back to reach. Stops are
  // numbered as in the stop list: A is 0, then 1, 2, ...; the last point
  // (the finish, or the start again on a loop) is skipped.
  const withWarnings = (r: RouteResult): RouteResult => {
    const spurs = points
      .slice(1, -1)
      .flatMap((p, i) => (outAndBack(r.path, p.pos) > SPUR_METRES ? [spurWarning(i + 1)] : []));
    return { ...r, warnings: spurs.length ? spurs : turnsAround ? [UTURN_WARNING] : [] };
  };
  const results = baseRoutes.map((r, i) => withWarnings(toResult(r, i === 0 ? "Recommended" : `Alternative ${i}`, [])));

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
        const pts = [...base.slice(0, leg + 1), { pos: detour, via: true, radius: HELPER_RADIUS }, ...base.slice(leg + 1)];
        try {
          const [r] = await computeRoutes(pts, opts, false, signal);
          const candidate = toResult(await loop(r, pts), "Detour", [detour]);
          // The helper point only exists to pull the route sideways. If
          // reaching it means riding up a dead end and back, drop this option.
          if (outAndBack(candidate.path, detour) > SPUR_METRES) continue;
          results.push(withWarnings(candidate));
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
