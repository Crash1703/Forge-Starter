import { curviness, distance, midpointOffset, type LatLng } from "./geo";
import { decodePolyline } from "./polyline";

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

interface ApiRoute {
  distanceMeters?: number;
  duration?: string;
  polyline?: { encodedPolyline?: string };
  warnings?: string[];
  legs?: {
    distanceMeters?: number;
    duration?: string;
    steps?: { distanceMeters?: number; navigationInstruction?: { maneuver?: string; instructions?: string } }[];
  }[];
}

const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
const FIELD_MASK = [
  "routes.distanceMeters",
  "routes.duration",
  "routes.polyline.encodedPolyline",
  "routes.warnings",
  "routes.legs.distanceMeters",
  "routes.legs.duration",
  "routes.legs.steps.distanceMeters",
  "routes.legs.steps.navigationInstruction",
].join(",");
const MAX_INTERMEDIATES = 25;

const waypoint = (p: LatLng, via = false) => ({
  location: { latLng: { latitude: p.lat, longitude: p.lng } },
  ...(via ? { via: true } : {}),
});

const seconds = (d?: string) => (d ? parseFloat(d) : 0);

export class RoutingError extends Error {}

interface Waypoint {
  pos: LatLng;
  via: boolean;
}

async function computeRoutes(
  key: string,
  points: Waypoint[],
  opts: RouteOptions,
  alternatives: boolean,
  signal?: AbortSignal,
): Promise<ApiRoute[]> {
  if (points.length - 2 > MAX_INTERMEDIATES) {
    throw new RoutingError(`Google allows at most ${MAX_INTERMEDIATES} stops between start and finish.`);
  }
  const avoidHighways = opts.avoidHighways || opts.style !== "fastest";
  const body = {
    origin: waypoint(points[0].pos),
    destination: waypoint(points[points.length - 1].pos),
    intermediates: points.slice(1, -1).map((p) => waypoint(p.pos, p.via)),
    travelMode: opts.vehicle === "motorcycle" ? "TWO_WHEELER" : "DRIVE",
    routingPreference: "TRAFFIC_UNAWARE",
    computeAlternativeRoutes: alternatives && points.length === 2,
    routeModifiers: { avoidHighways, avoidTolls: opts.avoidTolls, avoidFerries: opts.avoidFerries },
    languageCode: navigator.language || "en",
    units: "METRIC",
  };
  const res = await fetch(ENDPOINT, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELD_MASK },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg: string = json?.error?.message ?? `Routes API returned HTTP ${res.status}`;
    // Two-wheeler routing is only offered in some countries; retry as a car.
    if (opts.vehicle === "motorcycle" && /TWO_WHEELER|travel mode|not supported/i.test(msg)) {
      return computeRoutes(key, points, { ...opts, vehicle: "car" }, alternatives, signal);
    }
    throw new RoutingError(msg);
  }
  const routes: ApiRoute[] = json.routes ?? [];
  if (!routes.length) throw new RoutingError("No route found between these points.");
  return routes;
}

function toResult(r: ApiRoute, label: string, detours: LatLng[]): RouteResult {
  const path = decodePolyline(r.polyline?.encodedPolyline ?? "");
  return {
    id: Math.random().toString(36).slice(2),
    label,
    path,
    distance: r.distanceMeters ?? 0,
    duration: seconds(r.duration),
    curviness: curviness(path),
    legs: (r.legs ?? []).map((l) => ({ distance: l.distanceMeters ?? 0, duration: seconds(l.duration) })),
    steps: (r.legs ?? []).flatMap((l) =>
      (l.steps ?? [])
        .filter((s) => s.navigationInstruction?.instructions)
        .map((s) => ({
          instruction: s.navigationInstruction!.instructions!,
          maneuver: s.navigationInstruction!.maneuver ?? "",
          distance: s.distanceMeters ?? 0,
        })),
    ),
    detours,
    warnings: r.warnings ?? [],
  };
}

/**
 * Plan a route through `stops`.
 *
 * Google has no "curvy roads" option, so for the twisty style we ask for
 * several candidate routes (Google's alternatives plus variants pushed off to
 * either side of the longest leg by an extra via point), score each by how
 * much the road bends per km, and rank the curviest first. Candidates that
 * take far longer than the quickest one are dropped.
 */
export async function planRoute(
  key: string,
  stops: LatLng[],
  opts: RouteOptions,
  signal?: AbortSignal,
): Promise<RouteResult[]> {
  const base: Waypoint[] = stops.map((pos) => ({ pos, via: false }));
  const baseRoutes = await computeRoutes(key, base, opts, true, signal);
  const results = baseRoutes.map((r, i) => toResult(r, i === 0 ? "Recommended" : `Alternative ${i}`, []));

  if (opts.style === "twisty" && stops.length - 2 < MAX_INTERMEDIATES) {
    // Longest straight-line leg is where a detour has the most room to find better roads.
    let leg = 0;
    for (let i = 1; i < stops.length - 1; i++) {
      if (distance(stops[i], stops[i + 1]) > distance(stops[leg], stops[leg + 1])) leg = i;
    }
    const a = stops[leg];
    const b = stops[leg + 1];
    if (distance(a, b) > 5000) {
      const variants = [0.2, -0.2, 0.35, -0.35].map((f) => midpointOffset(a, b, f));
      const settled = await Promise.allSettled(
        variants.map((detour) => {
          const pts = [...base.slice(0, leg + 1), { pos: detour, via: true }, ...base.slice(leg + 1)];
          return computeRoutes(key, pts, opts, false, signal).then((r) => toResult(r[0], "Detour", [detour]));
        }),
      );
      for (const s of settled) if (s.status === "fulfilled") results.push(s.value);
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
