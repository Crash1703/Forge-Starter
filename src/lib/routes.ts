import { avoidPoints, centroid, crossings, curviness, distance, findSpurs, midpointOffset, outAndBack, sharedRoad, type LatLng } from "./geo";
import { decodePolyline } from "./polyline";
import { requestsAtOnce, routerFetch } from "./routeServer";

export type RouteStyle = "fastest" | "scenic" | "twisty";
export type Vehicle = "motorcycle" | "car";

export interface RouteOptions {
  style: RouteStyle;
  vehicle: Vehicle;
  avoidHighways: boolean;
  avoidTolls: boolean;
  avoidFerries: boolean;
  /**
   * Keep off dirt and gravel roads where there's a sealed way. On unless
   * the rider turns it off (routes saved before it existed count as on).
   */
  avoidUnpaved?: boolean;
  /**
   * Direct (0) to Adventure (1): how far a route may stray from the
   * quickest for better roads. 0.5 when not set.
   */
  detour?: number;
  /** Ride back to the first stop after the last one. */
  returnToStart: boolean;
}

export const defaultOptions: RouteOptions = {
  style: "scenic",
  vehicle: "motorcycle",
  avoidHighways: false,
  avoidTolls: false,
  avoidFerries: false,
  avoidUnpaved: true,
  detour: 0.5,
  returnToStart: false,
};

/** The Direct–Adventure setting, 0..1 (0.5 when not set). */
export const detourLevel = (opts: RouteOptions) => Math.min(1, Math.max(0, opts.detour ?? 0.5));

/**
 * How much slower than the quickest option a route may be: 1.15× at Direct,
 * 1.6× in the middle (as before the setting), 2.05× at Adventure.
 */
export const slowestAllowed = (opts: RouteOptions) => 1.15 + 0.9 * detourLevel(opts);

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
  /**
   * Movable stops the route rides up a dead end to reach, with the junction
   * at the foot of that dead end: move the stop there and re-plan.
   */
  moves?: { stop: number; to: LatLng }[];
  /**
   * Where the route actually meets each stop (the road the router snapped
   * it to): the start of each leg, then the finish.
   */
  stopsAt?: LatLng[];
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

/** A spur this close to a generated point (which snaps within 1 km) is put down to it. */
const MOVE_REACH = 2000;

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
  /**
   * A point the app placed (a generated loop point), not the rider. It snaps
   * only to proper roads, not residential streets or service roads, and if
   * the route still has to ride up a dead end and back to reach it, the
   * result suggests where to move it (see `RouteResult.moves`).
   */
  movable?: boolean;
  /**
   * A shaping point: the route passes near it without stopping, and it
   * doesn't split the route into legs or count as a numbered stop.
   */
  via?: boolean;
}

/** Twisty's helper points only pull the route sideways; any road nearby will do. */
const HELPER_RADIUS = 1500;

interface Waypoint extends RoutePoint {
  /** Pass through without splitting the route into another leg. */
  via: boolean;
}

/**
 * Each point's stop number as the rider sees it (A is 0, then 1, 2, ...),
 * or -1 for shaping points, which aren't numbered.
 */
function stopNumbers(points: RoutePoint[]): number[] {
  let n = 0;
  return points.map((p, i) => (i > 0 && p.via ? -1 : n++));
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
  const dirtOk = opts.avoidUnpaved === false;
  // The ride style for a GraphHopper server, which chooses roads by it (Valhalla never sees this).
  const _rf = { style: opts.style, detour: detourLevel(opts) };
  if (opts.vehicle === "car") return { costing: "auto", costing_options: { auto: { ...common, ...(dirtOk ? {} : { exclude_unpaved: true }) } }, _rf };
  // Motorcycle costing favours smaller roads as use_highways drops. use_trails
  // 0 keeps it on sealed roads wherever there's a way (from Imbil to Jimna it
  // rides 143 km sealed rather than 58 km with 48 km of gravel); 0.5 lets it
  // take gravel when that's the natural way.
  return { costing: "motorcycle", costing_options: { motorcycle: { ...common, use_trails: dirtOk ? 0.5 : 0 } }, _rf };
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
      // Generated points: skip residential streets and service roads, where
      // cul-de-sacs are; points that only steer the route snap to proper
      // through roads (tertiary or better), never a track in a forest.
      ...(p.movable ? { search_filter: { min_road_class: p.via ? "tertiary" : "unclassified" } } : {}),
    })),
    ...costing(opts),
    ...(alternatives && points.length === 2 ? { alternates: 2 } : {}),
    directions_options: { units: "kilometers", language: navigator.language || "en-US" },
    // Roads to stay off; Valhalla drops the road nearest each point.
    ...(avoid.length ? { exclude_locations: avoid.map((p) => ({ lat: p.lat, lon: p.lng })) } : {}),
  };
  let res: Response;
  try {
    res = await routerFetch("/route", body, signal);
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
  const stopsAt = legPaths.length ? [...legPaths.map((p) => p[0]), legPaths[legPaths.length - 1][legPaths[legPaths.length - 1].length - 1]] : [];
  return {
    id: Math.random().toString(36).slice(2),
    label,
    path,
    stopsAt,
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
 * A loop's legs shouldn't cross each other (a figure of eight, or riding
 * back across the way out). For each leg that crosses another, try the
 * router's other ways between its ends, and the same leg told to stay off
 * the road at the crossing, and keep whichever crosses least, as long as it
 * isn't much slower.
 */
async function uncrossLoop(
  trip: ValhallaTrip,
  waypoints: Waypoint[],
  opts: RouteOptions,
  signal?: AbortSignal,
): Promise<ValhallaTrip> {
  const breaks = waypoints.flatMap((w, i) => (w.via ? [] : [i]));
  if (trip.legs.length !== breaks.length - 1 || trip.legs.length < 2) return trip;
  const legs = trip.legs.slice();
  const paths = legs.map((l) => decodePolyline(l.shape, 6));
  const stops = breaks.map((i) => waypoints[i].pos);
  const hitsOf = (path: LatLng[], k: number) => [
    ...crossings(path, null, stops),
    ...paths.flatMap((other, j) => (j === k ? [] : crossings(path, other, stops))),
  ];
  let changed = false;
  // Worst leg first; a fixed leg may fix the one it crossed too.
  const order = paths.map((p, k) => ({ k, n: hitsOf(p, k).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  for (const { k } of order) {
    const hits = hitsOf(paths[k], k);
    if (!hits.length) continue;
    const ends = [waypoints[breaks[k]], waypoints[breaks[k + 1]]].map((w) => ({ ...w, via: false, noUturn: false }));
    const shaped = waypoints.slice(breaks[k], breaks[k + 1] + 1).map((w, i, all) => (i === 0 || i === all.length - 1 ? { ...w, noUturn: false } : w));
    const candidates: ValhallaTrip[] = [];
    for (const attempt of [
      () => computeRoutes(ends, opts, true, signal),
      () => computeRoutes(shaped, opts, false, signal, hits),
    ]) {
      try {
        candidates.push(...(await attempt()));
      } catch (e) {
        if ((e as Error).name === "AbortError") throw e;
        // No other way from there: try the next idea.
      }
    }
    let best = { n: hits.length, leg: legs[k], path: paths[k] };
    for (const c of candidates) {
      if (c.legs.length !== 1 || c.summary.time > legs[k].summary.time * 1.5 + 300) continue;
      const path = decodePolyline(c.legs[0].shape, 6);
      const n = hitsOf(path, k).length;
      if (n < best.n) best = { n, leg: c.legs[0], path };
    }
    if (best.leg !== legs[k]) {
      legs[k] = best.leg;
      paths[k] = best.path;
      changed = true;
    }
  }
  if (!changed) return trip;
  const sum = (f: (l: ValhallaTrip["legs"][number]) => number) => legs.reduce((a, l) => a + f(l), 0);
  return { summary: { length: sum((l) => l.summary.length), time: sum((l) => l.summary.time) }, legs };
}

/** Where the route actually reached stop `n` (its road, which may be some way from the pin). */
function reachedStop(r: RouteResult, n: number): LatLng | null {
  const step = r.steps.find((st) => st.type === STOP_TYPE && st.instruction === `Stop ${n}`);
  return step ? r.path[step.at] : null;
}

/**
 * One quick look at a route through `points`: a single request, none of the
 * loop clean-up or twisty detours. For comparing candidate loops before
 * planning the chosen one properly. Null if there's no route.
 */
export async function quickPlan(points: RoutePoint[], opts: RouteOptions, signal?: AbortSignal): Promise<RouteResult | null> {
  const base: Waypoint[] = points.map((p, i) => ({ ...p, via: !!p.via && i > 0 && i < points.length - 1 }));
  for (const pts of [base, base.map((p) => ({ ...p, noUturn: false }))]) {
    try {
      const [trip] = await computeRoutes(pts, opts, false, signal);
      return toResult(trip, "", []);
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      // A point at the end of a dead end: try once more allowing a U-turn.
    }
  }
  return null;
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
  /**
   * The middle of the loop this route is part of: detours for twistier
   * roads only go outwards from it, never across the loop's middle.
   */
  loopCentre?: LatLng,
  /** Check the result for dirt roads and steer off them (not when already doing so). */
  checkDirt = true,
): Promise<RouteResult[]> {
  const stops = points.map((p) => p.pos);
  const centre = loopCentre ?? (opts.returnToStart ? centroid(stops) : undefined);
  if (stops.length > MAX_STOPS) throw new RoutingError(`A route can have at most ${MAX_STOPS} stops.`);
  let base: Waypoint[] = points.map((p, i) => ({ ...p, via: !!p.via && i > 0 && i < points.length - 1 }));
  const numbers = stopNumbers(base);
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
    ? async (trip: ValhallaTrip, pts: Waypoint[]) => uncrossLoop(await untangleLoop(trip, pts, opts, signal), pts, opts, signal)
    : async (trip: ValhallaTrip) => trip;
  baseRoutes = [await loop(baseRoutes[0], base), ...baseRoutes.slice(1)];

  // Banning U-turns can backfire: a pin on a side street makes the route
  // ride on past it to find somewhere to turn, then come back. Where that
  // happens, also try allowing a U-turn at those stops and keep whichever
  // version rides less road twice.
  const ridesTwice = (trip: ValhallaTrip) => {
    const path = toResult(trip, "", []).path;
    return points.slice(1, -1).map((p, i) => (base[i + 1].via ? 0 : outAndBack(path, p.pos)));
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
      .flatMap((p, i) => (numbers[i + 1] > 0 && outAndBack(r.path, p.pos) > SPUR_METRES ? [spurWarning(numbers[i + 1])] : []));
    // Each dead end the route rides up and back, blamed on the generated
    // point that led it there: the one it reached nearest the spur's tip.
    const moves: { stop: number; to: LatLng }[] = [];
    for (const spur of findSpurs(r.path, SPUR_METRES)) {
      let best = -1;
      let bestDist = MOVE_REACH;
      points.forEach((p, i) => {
        if (!p.movable || i === 0 || i === points.length - 1 || moves.some((m) => m.stop === i)) return;
        const reached = numbers[i] > 0 ? reachedStop(r, numbers[i]) : null;
        const d = Math.min(distance(p.pos, spur.tip), distance(reached ?? p.pos, spur.tip));
        if (d < bestDist) {
          best = i;
          bestDist = d;
        }
      });
      if (best > 0) moves.push({ stop: best, to: spur.base });
    }
    return { ...r, warnings: spurs.length ? spurs : turnsAround ? [UTURN_WARNING] : [], ...(moves.length ? { moves } : {}) };
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
      const middle = midpointOffset(a, b, 0);
      // On a loop, a detour into the middle would make it cross itself.
      // Adventure pushes the detour points further out; Direct keeps them close.
      const reach = 0.5 + detourLevel(opts);
      const variants = [0.2, -0.2, 0.35, -0.35]
        .map((f) => midpointOffset(a, b, f * reach))
        .filter((p) => !centre || distance(p, centre) > distance(middle, centre));
      const tryDetour = async (detour: LatLng): Promise<RouteResult | null> => {
        const pts = [...base.slice(0, leg + 1), { pos: detour, via: true, radius: HELPER_RADIUS }, ...base.slice(leg + 1)];
        try {
          const [r] = await computeRoutes(pts, opts, false, signal, avoid);
          const candidate = toResult(await loop(r, pts), "Detour", [detour]);
          // The helper point only exists to pull the route sideways. If
          // reaching it means riding up a dead end and back, drop this option.
          return outAndBack(candidate.path, detour) > SPUR_METRES ? null : withWarnings(candidate);
        } catch (e) {
          if ((e as Error).name === "AbortError") throw e;
          // A detour point in a lake or on a mountain top just has no route; skip it.
          return null;
        }
      };
      // A few at a time: quicker than one by one, without upsetting the
      // public server (it refuses bigger bursts).
      const atOnce = requestsAtOnce();
      for (let i = 0; i < variants.length && !signal?.aborted; i += atOnce) {
        const found = await Promise.all(variants.slice(i, i + atOnce).map(tryDetour));
        results.push(...found.filter((r): r is RouteResult => !!r));
      }
    }
  }

  const ranked = rank(results, points, opts);
  if (!checkDirt || opts.avoidUnpaved === false || !ranked.length) return ranked;
  return lessDirt(ranked, points, opts, signal, avoid, loopCentre);
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
 * From where the rider is, to a stop they've just picked, and on to `rejoin`
 * (a point on their route ahead), or ending at the stop when `rejoin` is null.
 * The stop becomes "Stop 1" in the directions, named for the voice.
 */
export async function routeVia(
  from: LatLng,
  heading: number | null,
  stop: { name: string; position: LatLng },
  rejoin: LatLng | null,
  opts: RouteOptions,
  signal?: AbortSignal,
): Promise<RouteResult> {
  const points: Waypoint[] = [
    { pos: from, via: false, ...(heading != null ? { heading } : {}) },
    { pos: stop.position, via: false, radius: 50 },
    ...(rejoin ? [{ pos: rejoin, via: false }] : []),
  ];
  const [trip] = await computeRoutes(points, { ...opts, returnToStart: false }, false, signal);
  const r = toResult(trip, stop.name, []);
  return {
    ...r,
    steps: r.steps.map((st) =>
      st.type === STOP_TYPE ? { ...st, instruction: stop.name, alert: `${stop.name} ahead.`, verbal: `You've reached ${stop.name}.` } : st,
    ),
  };
}

/** How far a tapped or dragged pin may jump to reach a road. */
const SNAP_REACH_M = 1000;

/**
 * The nearest point on a rideable road to `p` (the route server's
 * locate), for pins the rider puts down by hand. Returns `p` unchanged if
 * there's no road within reach or the server doesn't answer quickly.
 */
export async function snapToRoad(p: LatLng, opts: RouteOptions, signal?: AbortSignal): Promise<LatLng> {
  try {
    const timeout = AbortSignal.timeout(5000);
    const res = await routerFetch(
      "/locate",
      { locations: [{ lat: p.lat, lon: p.lng }], costing: costing(opts).costing, verbose: false },
      signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : (signal ?? timeout),
    );
    if (!res.ok) return p;
    const json = (await res.json()) as { edges?: { correlated_lat: number; correlated_lon: number }[] }[];
    let best: LatLng | null = null;
    for (const e of json?.[0]?.edges ?? []) {
      const q = { lat: e.correlated_lat, lng: e.correlated_lon };
      if (Number.isFinite(q.lat) && Number.isFinite(q.lng) && (!best || distance(p, q) < distance(p, best))) best = q;
    }
    return best && distance(p, best) <= SNAP_REACH_M ? best : p;
  } catch (e) {
    if (signal?.aborted) throw e;
    return p;
  }
}

/**
 * For each point, the nearest spot on a proper through road (tertiary or
 * better), or null if the server has none to offer (or doesn't answer).
 * One request for many points, to check where a generated loop's points
 * land: in the sea or deep in a forest, the nearest such road is far off.
 */
export async function throughRoadsNear(points: LatLng[], opts: RouteOptions, signal?: AbortSignal): Promise<(LatLng | null)[]> {
  const out: (LatLng | null)[] = points.map(() => null);
  // The public server caps locations per request.
  for (let i = 0; i < points.length; i += 20) {
    const chunk = points.slice(i, i + 20);
    try {
      const res = await routerFetch(
        "/locate",
        {
          locations: chunk.map((p) => ({ lat: p.lat, lon: p.lng, search_filter: { min_road_class: "tertiary" } })),
          costing: costing(opts).costing,
          verbose: false,
        },
        signal,
      );
      if (!res.ok) continue;
      const json = (await res.json()) as ({ edges?: { correlated_lat: number; correlated_lon: number }[] } | null)[];
      chunk.forEach((p, k) => {
        let best: LatLng | null = null;
        for (const e of json?.[k]?.edges ?? []) {
          const q = { lat: e.correlated_lat, lng: e.correlated_lon };
          if (Number.isFinite(q.lat) && Number.isFinite(q.lng) && (!best || distance(p, q) < distance(p, best))) best = q;
        }
        out[i + k] = best;
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      // No answer: the loop is planned from the points as they are.
    }
  }
  return out;
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
  const res = await routerFetch(
    "/trace_attributes",
    {
      shape: shape.map((p) => ({ lat: p.lat, lon: p.lng })),
      costing: costing(opts).costing,
      shape_match: "map_snap",
      filters: { attributes: ["edge.speed_limit", "edge.begin_shape_index", "edge.end_shape_index"], action: "include" },
    },
    signal,
  );
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

/** Dirt that's not worth mentioning or steering round (a car park, a gravel driveway). */
const DIRT_TOLERANCE_M = 200;

/**
 * How much of `path` is dirt or gravel road, and where: the route server
 * matches the path to the map and reports each road's surface.
 */
export async function dirtOn(path: LatLng[], opts: RouteOptions, signal?: AbortSignal): Promise<{ metres: number; stretches: LatLng[][] }> {
  const k = Math.max(1, Math.ceil(path.length / 1500));
  const shape = path.filter((_, i) => i % k === 0 || i === path.length - 1);
  const res = await routerFetch(
    "/trace_attributes",
    {
      shape: shape.map((p) => ({ lat: p.lat, lon: p.lng })),
      costing: costing(opts).costing,
      shape_match: "map_snap",
      filters: { attributes: ["edge.unpaved", "edge.surface", "edge.length", "edge.begin_shape_index", "edge.end_shape_index"], action: "include" },
    },
    signal,
  );
  if (!res.ok) throw new RoutingError(`Road surfaces unavailable (HTTP ${res.status})`);
  const json: { edges?: { unpaved?: boolean; surface?: string; length?: number; begin_shape_index?: number; end_shape_index?: number }[] } = await res.json();
  let metres = 0;
  const stretches: LatLng[][] = [];
  for (const e of json.edges ?? []) {
    const dirt = e.unpaved || ["dirt", "gravel", "path", "impassable"].includes(e.surface ?? "");
    if (!dirt || e.begin_shape_index == null || e.end_shape_index == null) continue;
    metres += (e.length ?? 0) * 1000; // km
    stretches.push(shape.slice(e.begin_shape_index, e.end_shape_index + 1));
  }
  return { metres, stretches };
}

/** "Includes 700 m of dirt road" */
export const dirtWarning = (metres: number) =>
  `Includes ${metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres / 50) * 50} m`} of dirt road (there's no sealed way round).`;

/**
 * The best route still takes a dirt road: plan again, told to stay off
 * those stretches (except right by a stop, which may only be reachable that
 * way). Keep whichever has less dirt, unless it's much slower; say how much
 * dirt is left.
 */
async function lessDirt(
  ranked: RouteResult[],
  points: RoutePoint[],
  opts: RouteOptions,
  signal: AbortSignal | undefined,
  avoid: LatLng[],
  loopCentre: LatLng | undefined,
): Promise<RouteResult[]> {
  const best = ranked[0];
  const note = (list: RouteResult[], metres: number) =>
    metres < DIRT_TOLERANCE_M ? list : [{ ...list[0], warnings: [...list[0].warnings, dirtWarning(metres)] }, ...list.slice(1)];
  let dirt: Awaited<ReturnType<typeof dirtOn>>;
  try {
    dirt = await dirtOn(best.path, opts, signal);
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    return ranked; // can't tell: leave the route as planned
  }
  if (dirt.metres < DIRT_TOLERANCE_M) return ranked;
  try {
    const steer = avoidPoints(dirt.stretches, points.map((p) => p.pos), 50 - Math.min(avoid.length, 40), 300);
    if (!steer.length) return note(ranked, dirt.metres);
    const again = await planRoute(points, opts, signal, [...avoid, ...steer], loopCentre, false);
    const other = again[0];
    if (other && other.duration <= best.duration * 1.5 + 600) {
      const left = await dirtOn(other.path, opts, signal);
      if (left.metres < dirt.metres * 0.7) return note(again, left.metres);
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    // No other way (say, a stop only reachable on gravel): keep the first plan.
  }
  return note(ranked, dirt.metres);
}

/**
 * Drop options much slower than the quickest and near-duplicates, then put
 * the best first for the style (loops that don't cross themselves ahead).
 */
function rank(results: RouteResult[], points: RoutePoint[], opts: RouteOptions): RouteResult[] {
  const quickest = Math.min(...results.map((r) => r.duration));
  const unique = results.filter(
    (r, i) =>
      r.duration <= quickest * slowestAllowed(opts) &&
      !results.slice(0, i).some((o) => Math.abs(o.distance - r.distance) < r.distance * 0.01),
  );
  // A loop that crosses over itself rides a figure of eight; rank clean loops first.
  const stopPositions = points.map((p) => p.pos);
  const crossed = new Map(unique.map((r) => [r, opts.returnToStart ? crossings(r.path, null, stopPositions).length : 0]));
  const byCrossings = (x: RouteResult, y: RouteResult) => crossed.get(x)! - crossed.get(y)!;
  if (opts.style === "twisty") unique.sort((x, y) => byCrossings(x, y) || y.curviness - x.curviness);
  else if (opts.style === "fastest") unique.sort((x, y) => byCrossings(x, y) || x.duration - y.duration);
  else unique.sort(byCrossings);

  return unique.map((r, i) => ({
    ...r,
    label: i === 0 ? (opts.style === "twisty" ? "Twistiest" : opts.style === "fastest" ? "Fastest" : "Recommended") : `Option ${i + 1}`,
  }));
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
  // One section per pair of numbered stops, with any shaping points between them.
  const breaks = points.flatMap((p, i) => (i === 0 || i === points.length - 1 || !p.via ? [i] : []));
  const all = points.map((p) => p.pos);
  const centre = opts.returnToStart ? centroid(all) : undefined;
  for (let k = 0; k < breaks.length - 1; k++) {
    const legOpts = { ...opts, style: styles[k] ?? opts.style, returnToStart: false };
    // A section's own ends are plain stops; U-turn rules apply between stops, not at them.
    const between = points.slice(breaks[k], breaks[k + 1] + 1);
    const pair = between.map((p, j) => (j === 0 || j === between.length - 1 ? { ...p, noUturn: false, via: false } : p));
    const found = await planRoute(pair, legOpts, signal, [], centre);
    let [best] = found;
    // Of this section's options, the one crossing itself and the sections
    // before it least (a loop shouldn't ride a figure of eight).
    const hits = (r: RouteResult) =>
      opts.returnToStart ? crossings(r.path, null, all).length + sections.reduce((n, o) => n + crossings(r.path, o.path, all).length, 0) : 0;
    best = found.reduce((b, r) => (hits(r) < hits(b) ? r : b), best);
    if (opts.returnToStart && k > 0) {
      const earlier = sections.map((r) => r.path);
      const ends = [pair[0].pos, pair[pair.length - 1].pos];
      if (sharedRoad(best.path, earlier, ends) >= LOOP_SHARED_METRES) {
        try {
          const [other] = await planRoute(pair, legOpts, signal, avoidPoints(earlier, ends), centre);
          if (sharedRoad(other.path, earlier, ends) < sharedRoad(best.path, earlier, ends) && hits(other) <= hits(best)) best = other;
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
    // Each section ends where the next starts.
    stopsAt: sections.flatMap((r, i) => (i ? (r.stopsAt ?? []).slice(1) : (r.stopsAt ?? []))),
  };
}
