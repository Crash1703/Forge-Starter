/**
 * The rider's own GraphHopper server, spoken to in Valhalla's terms: the
 * app asks every route server as it asks Valhalla (/route, /locate,
 * /trace_attributes), and when the rider's server is GraphHopper these
 * functions turn the request into GraphHopper's and the answer back into
 * Valhalla's shape. The rest of the app never needs to know.
 *
 * GraphHopper's strength is choosing roads: its custom models let the ride
 * style ask for curvy, rural, sealed roads directly (see `styleModel`),
 * rather than only comparing candidate routes afterwards.
 */
import { encodePolyline } from "./polyline";
import { distance, type LatLng } from "./geo";

/** The app's own hints, sent alongside a Valhalla request (Valhalla never sees them). */
export interface RideHints {
  style: "fastest" | "scenic" | "twisty";
  detour: number;
}

interface ValhallaLocation {
  lat: number;
  lon: number;
  type?: "break" | "through" | "break_through" | "via";
  heading?: number;
  /** Metres around the point within which any road will do (Valhalla's radius). */
  radius?: number;
  search_filter?: { min_road_class?: string; max_road_class?: string };
}

/** Valhalla's road classes, best first, and GraphHopper's names for what lies below each. */
const VALHALLA_CLASSES = ["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "service_other"];
/** GraphHopper's names for Valhalla's classes above the lowest, for a max_road_class filter. */
const GH_CLASS: Record<string, string> = { motorway: "MOTORWAY", trunk: "TRUNK", primary: "PRIMARY", secondary: "SECONDARY", tertiary: "TERTIARY" };
const GH_BELOW: Record<string, string[]> = {
  tertiary: ["UNCLASSIFIED"],
  unclassified: ["RESIDENTIAL", "LIVING_STREET"],
  residential: ["SERVICE", "TRACK", "ROAD", "OTHER"],
};

/**
 * A request that only snaps `p` onto a road: GraphHopper has no road-class
 * filter for its nearest-road lookup, but snapping skips roads a request's
 * custom model rules out, so a point-to-itself route snaps as Valhalla's
 * search_filter would (and only ever onto a road the profile can ride).
 */
export function ghSnapRequest(p: { lat: number; lon: number }, profile: string, minClass?: string, maxClass?: string) {
  const from = minClass ? VALHALLA_CLASSES.indexOf(minClass) : -1;
  const to = maxClass ? VALHALLA_CLASSES.indexOf(maxClass) : -1;
  const below = [
    ...(from < 0 ? [] : VALHALLA_CLASSES.slice(from).flatMap((c) => GH_BELOW[c] ?? [])),
    ...(to < 0 ? [] : VALHALLA_CLASSES.slice(0, to).map((c) => GH_CLASS[c])),
  ];
  return {
    profile,
    points: [
      [p.lon, p.lat],
      [p.lon, p.lat],
    ],
    custom_model: { priority: below.length ? [{ if: below.map((c) => `road_class == ${c}`).join(" || "), multiply_by: "0" }] : [] },
    "ch.disable": true,
    instructions: false,
    points_encoded: false,
  };
}

export interface ValhallaRouteBody {
  locations: ValhallaLocation[];
  costing: "motorcycle" | "auto";
  costing_options?: {
    motorcycle?: { use_highways?: number; use_tolls?: number; use_ferry?: number; use_trails?: number };
    auto?: { use_highways?: number; use_tolls?: number; use_ferry?: number; exclude_unpaved?: boolean };
  };
  alternates?: number;
  directions_options?: { language?: string };
  exclude_locations?: { lat: number; lon: number }[];
  _rf?: RideHints;
}

type Statement = { if: string; multiply_by: string } | { else_if: string; multiply_by: string };
export interface CustomModel {
  distance_influence?: number;
  priority: Statement[];
  areas?: { type: "FeatureCollection"; features: unknown[] };
}

const UNPAVED = "surface == GRAVEL || surface == DIRT || surface == GROUND || surface == UNPAVED || surface == COMPACTED || surface == SAND || surface == GRASS";

/**
 * The ride style and avoid options as a GraphHopper custom model, on top of
 * the server's base profile. Everything only lowers priorities, which keeps
 * the server's landmarks (its speed-up) valid.
 */
export function styleModel(body: ValhallaRouteBody): CustomModel {
  const moto = body.costing === "motorcycle";
  const o = (moto ? body.costing_options?.motorcycle : body.costing_options?.auto) ?? {};
  const style = body._rf?.style ?? (o.use_highways === 0 ? "scenic" : "fastest");
  const detour = Math.min(1, Math.max(0, body._rf?.detour ?? 0.5));
  const priority: Statement[] = [];
  if (style !== "fastest" || o.use_highways === 0) priority.push({ if: "road_class == MOTORWAY || road_class == TRUNK", multiply_by: style === "twisty" ? "0.1" : "0.3" });
  if (style === "scenic") {
    priority.push({ if: "urban_density == CITY", multiply_by: "0.5" }, { else_if: "urban_density == RESIDENTIAL", multiply_by: "0.7" });
    priority.push({ if: "curvature >= 0.98", multiply_by: "0.8" });
  }
  if (style === "twisty") {
    priority.push({ if: "urban_density == CITY", multiply_by: "0.3" }, { else_if: "urban_density == RESIDENTIAL", multiply_by: "0.5" });
    // GraphHopper's curvature: 1 is dead straight, lower is bendier.
    priority.push({ if: "curvature >= 0.98", multiply_by: "0.4" }, { else_if: "curvature >= 0.9", multiply_by: "0.7" });
  }
  if (o.use_tolls === 0) priority.push({ if: "toll == ALL", multiply_by: "0.01" });
  if (o.use_ferry === 0) priority.push({ if: "road_environment == FERRY", multiply_by: "0.01" });
  const avoidDirt = moto ? (o as { use_trails?: number }).use_trails === 0 : (o as { exclude_unpaved?: boolean }).exclude_unpaved === true;
  if (avoidDirt) priority.push({ if: UNPAVED, multiply_by: "0.05" });
  const model: CustomModel = {
    // Lower lets the route stray further for better roads: Adventure strays most.
    // The server's base profile has 15, the lowest a request may ask for.
    distance_influence: style === "fastest" ? 70 : Math.max(15, Math.round(60 - 45 * detour)),
    priority,
  };
  // Valhalla drops the road nearest each point; here, stay off a small square round it.
  const avoid = body.exclude_locations ?? [];
  if (avoid.length) {
    model.areas = {
      type: "FeatureCollection",
      features: avoid.map((p, i) => ({ type: "Feature", id: `x${i}`, properties: {}, geometry: { type: "Polygon", coordinates: [square(p, 25)] } })),
    };
    model.priority.push({ if: avoid.map((_, i) => `in_x${i}`).join(" || "), multiply_by: "0" });
  }
  return model;
}

/** A square of `half` metres either side of `p`, as GeoJSON [lon, lat] ring. */
function square(p: { lat: number; lon: number }, half: number): [number, number][] {
  const dLat = half / 110540;
  const dLon = half / (111320 * Math.cos((p.lat * Math.PI) / 180));
  return [
    [p.lon - dLon, p.lat - dLat],
    [p.lon + dLon, p.lat - dLat],
    [p.lon + dLon, p.lat + dLat],
    [p.lon - dLon, p.lat + dLat],
    [p.lon - dLon, p.lat - dLat],
  ];
}

/** GraphHopper's /route request for a Valhalla /route body. */
export function ghRouteRequest(body: ValhallaRouteBody) {
  const locs = body.locations;
  const alternates = locs.length === 2 ? (body.alternates ?? 0) : 0;
  return {
    profile: body.costing === "motorcycle" ? "motorcycle" : "car",
    points: locs.map((l) => [l.lon, l.lat]),
    ...(locs.some((l) => l.heading != null) ? { headings: locs.map((l) => l.heading ?? Number.NaN) } : {}),
    // No pass_through (GraphHopper's "no turning round at via points"),
    // unlike Valhalla's break_through: with turn costs it rides on past a
    // point to loop round a block, or finds no route at all, and on a
    // loop's points (already snapped onto through roads) it isn't needed.
    // A dead end ridden up and back is still caught (planRoute's spurs).
    // Measured again on 30 Sep 2026 with 600 s U-turns (stress tests, pass
    // through at every stop that asks for it): U-turns 9 → 8, but riding up
    // side roads and back 8.8 → 13 km, with 4 new spurs over 1 km.
    pass_through: false,
    custom_model: styleModel(body),
    "ch.disable": true,
    instructions: true,
    locale: (body.directions_options?.language ?? "en").split("-")[0],
    points_encoded: true,
    points_encoded_multiplier: 1e6,
    // The roads' details, remembered for RideScore, speed limits and dirt (see roadsOf).
    details: ROAD_DETAILS,
    ...(alternates ? { algorithm: "alternative_route", "alternative_route.max_paths": alternates + 1 } : {}),
  };
}

interface GhInstruction {
  text: string;
  distance: number; // metres
  time: number; // ms
  sign: number;
  interval: [number, number];
  street_name?: string;
  exit_number?: number;
}
export interface GhPath {
  distance: number;
  time: number;
  points: string;
  instructions: GhInstruction[];
  details?: Record<string, Detail[]>;
}

/** What the app asks about each road (Valhalla's trace_attributes, from GraphHopper's path details). */
export const ROAD_DETAILS = ["road_class", "surface", "urban_density", "max_speed"];

/** One road's description, as Valhalla's trace_attributes gives it. */
export interface Road {
  road_class: string;
  surface: string;
  unpaved: boolean;
  density: number;
  speed_limit: number;
}

type Detail = [number, number, string | number | boolean | null];
const DIRT = new Set(["gravel", "dirt", "ground", "unpaved", "compacted", "sand", "grass"]);
const DENSITY: Record<string, number> = { rural: 0, residential: 5, city: 10 };

/** The road from point `i` to `i + 1` of a path with these details. */
function roadAt(details: Record<string, Detail[]> | undefined, i: number): Road {
  const at = (key: string) => {
    for (const [a, b, v] of details?.[key] ?? []) if (i >= a && i < b) return v;
    return null;
  };
  const surface = String(at("surface") ?? "paved").toLowerCase();
  const limit = Number(at("max_speed"));
  return {
    road_class: String(at("road_class") ?? "other").toLowerCase(),
    surface,
    unpaved: DIRT.has(surface),
    density: DENSITY[String(at("urban_density") ?? "rural").toLowerCase()] ?? 0,
    speed_limit: Number.isFinite(limit) && limit > 0 ? Math.round(limit) : 0,
  };
}

const pointKey = (p: { lat: number; lng: number }) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

/**
 * Each point of a planned path, with the road leaving it: remembered so
 * questions about that path's roads are answered without asking again
 * (GraphHopper's map matching takes seconds; this is instant).
 */
export function roadsOf(path: GhPath, decode: (s: string) => LatLng[]): [string, Road][] {
  const pts = decode(path.points);
  // The last point too (with the road into it): where legs from separate
  // requests join, a route's path keeps the end of one leg.
  return pts.map((p, i) => [pointKey(p), roadAt(path.details, Math.min(i, pts.length - 2))]);
}

/** Valhalla's edges for a path whose every point is known (see roadsOf), or null if any isn't. */
export function edgesFromKnown(shape: { lat: number; lon: number }[], known: (key: string) => Road | undefined) {
  const found = shape.slice(0, -1).map((p) => known(pointKey({ lat: p.lat, lng: p.lon })));
  const missing = found.filter((r) => !r).length;
  // A stray point or two (a join between legs) borrows the road beside it;
  // a path it mostly doesn't know was planned elsewhere.
  if (!found.length || missing > Math.max(2, found.length / 100) || missing * 2 >= found.length) return null;
  let last = found.find((r) => r)!;
  const roads = found.map((r) => (last = r ?? last));
  return mergeEdges(shape.map((p) => ({ lat: p.lat, lng: p.lon })), roads, (i) => i);
}

/** Runs of the same road as Valhalla's edges; `toShape` maps a point to the index of the sent shape. */
function mergeEdges(pts: LatLng[], roads: Road[], toShape: (i: number) => number) {
  const edges: (Road & { length: number; begin_shape_index: number; end_shape_index: number })[] = [];
  roads.forEach((e, i) => {
    const km = distance(pts[i], pts[i + 1]) / 1000;
    const last = edges[edges.length - 1];
    if (last && last.road_class === e.road_class && last.surface === e.surface && last.density === e.density && last.speed_limit === e.speed_limit) {
      last.length += km;
      last.end_shape_index = toShape(i + 1);
    } else edges.push({ ...e, length: km, begin_shape_index: toShape(i), end_shape_index: toShape(i + 1) });
  });
  return edges;
}

/** GraphHopper's instruction signs as Valhalla's manoeuvre types (what the turn arrows and voice use). */
const SIGN_TYPE: Record<number, number> = {
  [-98]: 12, [-8]: 13, [-7]: 24, [-6]: 27, [-3]: 14, [-2]: 15, [-1]: 16, 0: 8, 1: 9, 2: 10, 3: 11, 4: 4, 5: 4, 6: 26, 7: 23, 8: 12,
};

/**
 * A GraphHopper path as a Valhalla trip: split into legs at the stops
 * (not at shaping points, which Valhalla wouldn't split at either).
 */
export function tripFromPath(path: GhPath, body: ValhallaRouteBody, decode: (s: string) => LatLng[]) {
  const pts = decode(path.points);
  const breaks = body.locations.slice(1, -1).map((l) => l.type !== "through" && l.type !== "via");
  let via = 0;
  const legs: { from: number; to: number; ins: GhInstruction[] }[] = [{ from: 0, to: pts.length - 1, ins: [] }];
  for (const ins of path.instructions) {
    const leg = legs[legs.length - 1];
    if (ins.sign === 5) {
      const isBreak = breaks[via++] ?? true;
      if (!isBreak) continue; // a shaping point: not a stop
      leg.ins.push(ins);
      leg.to = ins.interval[0];
      legs.push({ from: ins.interval[0], to: pts.length - 1, ins: [] });
      continue;
    }
    leg.ins.push(ins);
  }
  const vLegs = legs.map((leg) => {
    const shape = pts.slice(leg.from, leg.to + 1);
    const length = leg.ins.reduce((a, i) => a + i.distance, 0) / 1000;
    const time = leg.ins.reduce((a, i) => a + i.time, 0) / 1000;
    return {
      shape: encodePolyline(shape, 6),
      summary: { length, time },
      maneuvers: leg.ins.map((ins, k) => ({
        instruction: ins.text,
        length: ins.distance / 1000,
        type: k === 0 && leg.from === 0 ? 1 : (SIGN_TYPE[ins.sign] ?? 8),
        begin_shape_index: Math.max(0, ins.interval[0] - leg.from),
        ...(ins.street_name ? { street_names: [ins.street_name] } : {}),
        ...(ins.exit_number ? { roundabout_exit_count: ins.exit_number } : {}),
      })),
    };
  });
  return { summary: { length: path.distance / 1000, time: path.time / 1000 }, legs: vLegs };
}

/** A path as GPX, for GraphHopper's map matching. */
export function toGpx(shape: { lat: number; lon: number }[]): string {
  const t0 = Date.UTC(2020, 0, 1);
  // Map matching wants times; a steady pace is fine.
  const pts = shape.map((p, i) => `<trkpt lat="${p.lat}" lon="${p.lon}"><time>${new Date(t0 + i * 10_000).toISOString()}</time></trkpt>`).join("");
  return `<?xml version="1.0"?><gpx version="1.1" creator="Ride Forge"><trk><trkseg>${pts}</trkseg></trk></gpx>`;
}

export interface GhMatch {
  paths: { points: string; details?: Record<string, Detail[]> }[];
}


/**
 * A GraphHopper map match as Valhalla's trace_attributes edges: one per
 * stretch of the same road class, surface, town density and speed limit,
 * with shape indices into the `shape` that was sent.
 */
export function edgesFromMatch(match: GhMatch, shape: { lat: number; lon: number }[], decode: (s: string) => LatLng[]) {
  const path = match.paths[0];
  if (!path) return [];
  const pts = decode(path.points);
  // For each matched point, the sent point it's nearest (moving forwards only).
  const input = shape.map((p) => ({ lat: p.lat, lng: p.lon }));
  const toInput: number[] = [];
  let j = 0;
  for (const p of pts) {
    while (j < input.length - 1 && distance(p, input[j + 1]) <= distance(p, input[j])) j++;
    toInput.push(j);
  }
  const roads = pts.slice(0, -1).map((_, i) => roadAt(path.details, i));
  return mergeEdges(pts, roads, (i) => toInput[i]);
}
