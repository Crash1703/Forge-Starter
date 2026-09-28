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
  /** Length of road from this manoeuvre to the next, in metres. */
  distance: number;
  /** Valhalla manoeuvre type (turn left, roundabout, arrive…); see maneuverKind(). */
  type: number;
  /** Index into the route's path where this manoeuvre happens. */
  at: number;
  /** Road you're turning onto, if it has a name. */
  street?: string;
  /** Short spoken form for the warning ahead, e.g. "Turn left onto Main Road." */
  alert?: string;
  /** Spoken form for the moment itself. */
  verbal?: string;
  /** Roundabout exit number. */
  exit?: number;
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
    maneuvers?: ValhallaManeuver[];
  }[];
}

/** Step type for reaching one of the rider's stops mid-route (not a Valhalla type). */
export const STOP_TYPE = 99;

interface ValhallaManeuver {
  instruction: string;
  length: number; // km
  type: number;
  begin_shape_index?: number;
  street_names?: string[];
  verbal_transition_alert_instruction?: string;
  verbal_pre_transition_instruction?: string;
  roundabout_exit_count?: number;
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
  /** Direction of travel here (degrees), so the router doesn't start you off with a U-turn. */
  heading?: number;
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
      ...(p.heading != null ? { heading: Math.round(p.heading), heading_tolerance: 60 } : {}),
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
  const legPaths = trip.legs.map((l) => decodePolyline(l.shape, 6));
  const path = legPaths.flatMap((p, i) => p.slice(i ? 1 : 0));
  // Where each leg starts in the joined path, for placing its manoeuvres.
  const offsets = legPaths.map((_, i) => legPaths.slice(0, i).reduce((n, p) => n + p.length - 1, 0));
  return {
    id: Math.random().toString(36).slice(2),
    label,
    path,
    distance: trip.summary.length * 1000,
    duration: trip.summary.time,
    curviness: curviness(path),
    legs: trip.legs.map((l) => ({ distance: l.summary.length * 1000, duration: l.summary.time })),
    steps: trip.legs.flatMap((l, li) =>
      (l.maneuvers ?? []).flatMap((m, mi, all): Step[] => {
        // Between legs the router says "you have arrived" then "head north";
        // mid-route those are just the stop, so keep only the final arrival.
        const last = li === trip.legs.length - 1 && mi === all.length - 1;
        if (li > 0 && mi === 0 && m.type >= 1 && m.type <= 3) return [];
        const stop = !last && m.type >= 4 && m.type <= 6 ? li + 1 : 0;
        return [
          {
            ...(stop
              ? {
                  instruction: `Stop ${stop}`,
                  alert: `Stop ${stop} ahead.`,
                  verbal: `You've reached stop ${stop}.`,
                }
              : {
                  instruction: m.instruction,
                  alert: m.verbal_transition_alert_instruction,
                  verbal: m.verbal_pre_transition_instruction,
                }),
            maneuver: String(m.type),
            distance: m.length * 1000,
            type: stop ? STOP_TYPE : m.type,
            at: Math.min(path.length - 1, offsets[li] + (m.begin_shape_index ?? 0)),
            street: m.street_names?.[0],
            exit: m.roundabout_exit_count,
          },
        ];
      }),
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
export async function planRoute(
  points: RoutePoint[],
  opts: RouteOptions,
  signal?: AbortSignal,
  /** Roads to stay off (used when planning a loop one section at a time). */
  avoid: LatLng[] = [],
): Promise<RouteResult[]> {
  const stops = points.map((p) => p.pos);
  if (stops.length > MAX_STOPS) throw new RoutingError(`A route can have at most ${MAX_STOPS} stops.`);
  let base: Waypoint[] = points.map((p) => ({ ...p, via: false }));
  let baseRoutes: ValhallaTrip[];
  let turnsAround = false;
  try {
    baseRoutes = await computeRoutes(base, opts, true, signal, avoid);
  } catch (e) {
    // A pin at the end of a dead end can only be reached by turning around.
    // Allow it rather than failing, and tell the rider.
    if (!(e instanceof RoutingError && e.noPath && base.some((p) => p.noUturn))) throw e;
    base = base.map((p) => ({ ...p, noUturn: false }));
    baseRoutes = await computeRoutes(base, opts, true, signal, avoid);
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
      const other = await computeRoutes(relaxed, opts, true, signal, avoid);
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
          const [r] = await computeRoutes(pts, opts, false, signal, avoid);
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

/**
 * A way from where the rider is back onto their planned route, starting in
 * the direction they're already heading.
 */
export async function routeBack(
  from: LatLng,
  heading: number | null,
  to: LatLng,
  opts: RouteOptions,
  signal?: AbortSignal,
): Promise<RouteResult> {
  const points: Waypoint[] = [
    { pos: from, via: false, ...(heading != null ? { heading } : {}) },
    { pos: to, via: false },
  ];
  const [trip] = await computeRoutes(points, { ...opts, returnToStart: false }, false, signal);
  return toResult(trip, "Back to route", []);
}

/**
 * Speed limits along a route, in km/h per path point (null where the map
 * has none), from Valhalla's trace_attributes on the route's own geometry.
 */
export async function speedLimits(path: LatLng[], opts: RouteOptions, signal?: AbortSignal): Promise<(number | null)[]> {
  // Thin long routes: the public server caps trace sizes, and map matching
  // doesn't need every vertex. `k` maps sampled indices back to the path.
  const k = Math.max(1, Math.ceil(path.length / 1500));
  const shape = path.filter((_, i) => i % k === 0 || i === path.length - 1);
  const res = await fetch(`${VALHALLA_URL}/trace_attributes`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      shape: shape.map((p) => ({ lat: p.lat, lon: p.lng })),
      costing: costing(opts).costing,
      shape_match: "map_snap",
      filters: { attributes: ["edge.speed_limit", "edge.begin_shape_index", "edge.end_shape_index"], action: "include" },
    }),
  });
  if (!res.ok) throw new RoutingError(`Speed limits unavailable (HTTP ${res.status})`);
  const json: { edges?: { speed_limit?: number | string; begin_shape_index?: number; end_shape_index?: number }[] } =
    await res.json();
  const limits: (number | null)[] = path.map(() => null);
  for (const e of json.edges ?? []) {
    // Valhalla reports 0 or "unlimited"/missing where the limit isn't known or doesn't apply.
    const limit = typeof e.speed_limit === "number" && e.speed_limit > 0 ? e.speed_limit : null;
    if (limit == null || e.begin_shape_index == null || e.end_shape_index == null) continue;
    const from = e.begin_shape_index * k;
    const to = Math.min(path.length - 1, e.end_shape_index * k + k - 1);
    for (let i = from; i <= to; i++) limits[i] = limit;
  }
  return limits;
}

/**
 * Plan a route whose sections have their own ride styles (say, Fastest to
 * the hills, then Twisty): each section between stops is planned on its own
 * with its style, then they're joined into one route. `styles[i]` is the style
 * from stop i to stop i + 1; missing entries use `opts.style`.
 *
 * On a loop, a section that would ride back along road an earlier section
 * used is planned again staying off that road, as whole-route loops are.
 */
export async function planSections(
  points: RoutePoint[],
  styles: (RouteStyle | undefined)[],
  opts: RouteOptions,
  signal?: AbortSignal,
): Promise<RouteResult[]> {
  if (points.length > MAX_STOPS) throw new RoutingError(`A route can have at most ${MAX_STOPS} stops.`);
  const sections: RouteResult[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const legOpts = { ...opts, style: styles[i] ?? opts.style, returnToStart: false };
    // A section's own ends are plain stops; U-turn rules apply between stops, not at them.
    const pair = [{ ...points[i], noUturn: false }, { ...points[i + 1], noUturn: false }];
    let [best] = await planRoute(pair, legOpts, signal);
    if (opts.returnToStart && i > 0) {
      const earlier = sections.map((r) => r.path);
      const ends = [points[i].pos, points[i + 1].pos];
      if (sharedRoad(best.path, earlier, ends) >= LOOP_SHARED_METRES) {
        try {
          const [other] = await planRoute(pair, legOpts, signal, avoidPoints(earlier, ends));
          if (sharedRoad(other.path, earlier, ends) < sharedRoad(best.path, earlier, ends)) best = other;
        } catch (e) {
          if ((e as Error).name === "AbortError") throw e;
          // No other way: keep the first.
        }
      }
    }
    sections.push(best);
  }
  return [joinSections(sections)];
}

/** One route from consecutive sections: paths joined, steps renumbered, arrivals mid-way become stops. */
export function joinSections(sections: RouteResult[]): RouteResult {
  const path: LatLng[] = [];
  const steps: Step[] = [];
  sections.forEach((r, i) => {
    const offset = Math.max(0, path.length - 1);
    const last = i === sections.length - 1;
    path.push(...r.path.slice(i ? 1 : 0));
    for (const st of r.steps) {
      // A later section's "head north" is just carrying on from the stop.
      if (i > 0 && st.type >= 1 && st.type <= 3) continue;
      if (!last && st.type >= 4 && st.type <= 6) {
        steps.push({ ...st, at: st.at + offset, type: STOP_TYPE, instruction: `Stop ${i + 1}`, alert: `Stop ${i + 1} ahead.`, verbal: `You've reached stop ${i + 1}.` });
        continue;
      }
      steps.push({ ...st, at: st.at + offset });
    }
  });
  return {
    id: Math.random().toString(36).slice(2),
    label: "Recommended",
    path,
    distance: sections.reduce((a, r) => a + r.distance, 0),
    duration: sections.reduce((a, r) => a + r.duration, 0),
    curviness: curviness(path),
    legs: sections.flatMap((r) => r.legs),
    steps,
    detours: sections.flatMap((r) => r.detours),
    warnings: [...new Set(sections.flatMap((r) => r.warnings))],
  };
}
