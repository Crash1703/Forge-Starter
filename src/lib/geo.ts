export interface LatLng {
  lat: number;
  lng: number;
}

const R = 6371000; // mean Earth radius in metres
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in metres. */
export function distance(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pathLength(path: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += distance(path[i - 1], path[i]);
  return total;
}

/** Initial bearing from a to b, degrees in [0, 360). */
export function bearing(a: LatLng, b: LatLng): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Point reached by travelling `metres` from `from` on `bearingDeg`. */
export function destination(from: LatLng, bearingDeg: number, metres: number): LatLng {
  const d = metres / R;
  const b = rad(bearingDeg);
  const lat1 = rad(from.lat);
  const lng1 = rad(from.lng);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: deg(lat2), lng: ((deg(lng2) + 540) % 360) - 180 };
}

/** Smallest signed difference between two bearings, in (-180, 180]. */
export function turnAngle(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * Resample a path to points roughly `step` metres apart. Router geometry is
 * dense in bends and sparse on straights; resampling makes the curviness score
 * independent of how the router chose to encode the geometry.
 */
export function resample(path: LatLng[], step: number): LatLng[] {
  if (path.length < 2) return path.slice();
  const out: LatLng[] = [path[0]];
  let carry = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const seg = distance(a, b);
    if (seg === 0) continue;
    const brg = bearing(a, b);
    let pos = step - carry;
    while (pos <= seg) {
      out.push(destination(a, brg, pos));
      pos += step;
    }
    carry = seg - (pos - step);
  }
  const last = path[path.length - 1];
  if (distance(out[out.length - 1], last) > step / 4) out.push(last);
  return out;
}

/**
 * Curviness in degrees of heading change per km. Straight motorway ≈ 0-20,
 * rural roads ≈ 40-100, alpine passes and twisty back roads 150+.
 */
export function curviness(path: LatLng[]): number {
  const pts = resample(path, 25);
  const km = pathLength(pts) / 1000;
  if (km < 0.1 || pts.length < 3) return 0;
  let total = 0;
  let prev = bearing(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i++) {
    const cur = bearing(pts[i - 1], pts[i]);
    // Cap each turn: hairpins on mountain passes count fully, but a single
    // U-turn at a dead end or roundabout can't dominate the score.
    total += Math.min(Math.abs(turnAngle(prev, cur)), 120);
    prev = cur;
  }
  return total / km;
}

export type CurvinessLabel = "Straight" | "Gentle" | "Curvy" | "Twisty" | "Very twisty";

export function curvinessLabel(score: number): CurvinessLabel {
  if (score < 25) return "Straight";
  if (score < 60) return "Gentle";
  if (score < 110) return "Curvy";
  if (score < 180) return "Twisty";
  return "Very twisty";
}

/**
 * Waypoints for a loop that starts and ends at `start` and is roughly
 * `targetMetres` long by road. Roads are longer than straight lines, so the
 * polygon perimeter is shrunk by `roadFactor`.
 */
export function roundTripWaypoints(
  start: LatLng,
  targetMetres: number,
  headingDeg: number,
  points = 3,
  roadFactor = 1.35,
): LatLng[] {
  const perimeter = targetMetres / roadFactor;
  // A circle through `start` whose centre lies on `headingDeg`.
  const radius = perimeter / (2 * Math.PI);
  const centre = destination(start, headingDeg, radius);
  const back = (headingDeg + 180) % 360; // bearing from centre to start
  const out: LatLng[] = [];
  for (let i = 1; i <= points; i++) {
    const angle = back + (360 * i) / (points + 1);
    out.push(destination(centre, angle, radius));
  }
  return out;
}

/**
 * How many metres of road the route rides twice, out and back, around the
 * point of `path` nearest to `near`: the signature of a detour up a dead end
 * (or to a turning circle) and back down the same road.
 *
 * A stretch counts as ridden twice when a point before the nearest one lies
 * within `tolerance` metres of a point after it. Both passes follow the same
 * road centreline, so they coincide; the parallel legs of a hairpin are
 * further apart than that, so switchbacks aren't mistaken for spurs.
 */
export function outAndBack(path: LatLng[], near: LatLng, window = 3000, tolerance = 12): number {
  const step = 20;
  const pts = resample(path, step);
  if (pts.length < 3) return 0;
  let mid = 0;
  for (let i = 1; i < pts.length; i++) if (distance(pts[i], near) < distance(pts[mid], near)) mid = i;
  const span = Math.round(window / step);
  const before = pts.slice(Math.max(0, mid - span), mid);
  const after = pts.slice(mid + 1, mid + 1 + span);
  let twice = 0;
  for (const p of before) if (after.some((q) => distance(p, q) < tolerance)) twice += step;
  return twice;
}

export function midpointOffset(a: LatLng, b: LatLng, fraction: number): LatLng {
  const d = distance(a, b);
  const brg = bearing(a, b);
  const mid = destination(a, brg, d / 2);
  return destination(mid, (brg + (fraction >= 0 ? 90 : 270)) % 360, Math.abs(fraction) * d);
}

export function formatDistance(m: number): string {
  return m >= 10000 ? `${(m / 1000).toFixed(0)} km` : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

export function formatDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m.toString().padStart(2, "0")} min` : `${m} min`;
}
