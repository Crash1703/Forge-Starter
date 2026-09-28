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

/** "northeast" etc. for a bearing in degrees. */
export function compassName(bearingDeg: number): string {
  const names = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  return names[Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8];
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

/** Ellipse perimeter (Ramanujan's approximation). */
function ellipsePerimeter(a: number, b: number): number {
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

/**
 * Waypoints for a loop from `start` that passes through `via`: an oval with
 * start and `via` at its ends, so the ride goes out one way, through the
 * place, and comes back a different way (on the `side`, +1 left or -1
 * right, going out). The oval widens to make the loop roughly
 * `targetMetres` long by road; it never gets narrower than needed for the
 * way back to be a different road, so a short target (or 0) gives the
 * shortest sensible loop via the place. For a loop longer than a circle
 * through both, it becomes a bigger circle with the place somewhere on it.
 *
 * Returns the waypoints in riding order with `via` among them (at
 * `viaIndex`), and `minMetres`, the shortest loop via this place.
 */
export function loopThrough(
  start: LatLng,
  via: LatLng,
  targetMetres: number,
  side: 1 | -1 = 1,
  roadFactor = 1.35,
): { waypoints: LatLng[]; viaIndex: number; minMetres: number } {
  const d = distance(start, via);
  const a = d / 2;
  const narrowest = Math.min(a, Math.max(0.3 * a, 2000));
  const minMetres = ellipsePerimeter(a, narrowest) * roadFactor;
  // Widen until the oval is about the target length (bisection; a circle at most).
  let lo = narrowest;
  let hi = a;
  const want = targetMetres / roadFactor;
  if (want <= ellipsePerimeter(a, lo)) hi = lo;
  else if (want >= ellipsePerimeter(a, hi)) lo = hi;
  for (let k = 0; k < 30 && hi - lo > 10; k++) {
    const mid = (lo + hi) / 2;
    if (ellipsePerimeter(a, mid) < want) lo = mid;
    else hi = mid;
  }
  const axis = bearing(start, via);
  if (want > ellipsePerimeter(a, a) * 1.05) {
    // Longer than a circle through both: a bigger circle, with the place
    // somewhere on it, swapped in for the nearest of its points.
    const radius = want / (2 * Math.PI);
    const h = Math.sqrt(Math.max(0, radius * radius - a * a));
    const centre = destination(destination(start, axis, a), (axis + (side > 0 ? 270 : 90)) % 360, h);
    const from = bearing(centre, start);
    const ring: LatLng[] = [];
    for (let i = 1; i <= 5; i++) ring.push(destination(centre, (from + (360 * i * side) / 6 + 360) % 360, radius));
    let viaIndex = 0;
    for (let i = 1; i < ring.length; i++) if (distance(ring[i], via) < distance(ring[viaIndex], via)) viaIndex = i;
    ring[viaIndex] = via;
    return { waypoints: ring, viaIndex, minMetres };
  }
  const b = (lo + hi) / 2;
  const centre = destination(start, axis, a);
  // Angle 180° is the start, 0° the place; out on one side, back on the other.
  const at = (deg: number) => {
    const t = (deg * Math.PI) / 180;
    const along = destination(centre, axis, a * Math.cos(t));
    const across = b * Math.sin(t) * side;
    return destination(along, (axis + (across >= 0 ? 270 : 90)) % 360, Math.abs(across));
  };
  return { waypoints: [at(120), at(60), via, at(-60), at(-120)], viaIndex: 2, minMetres };
}

/**
 * Split a generated loop's points (in riding order) into the few that become
 * pins (`pins`, indices into `ring`) and shaping points, each attached to the
 * pin before it (or to the start, as `startShape`).
 */
export function loopLayout(
  ring: LatLng[],
  pins: number[],
): { startShape: LatLng[]; stops: { position: LatLng; index: number; shape: LatLng[] }[] } {
  const startShape: LatLng[] = [];
  const stops: { position: LatLng; index: number; shape: LatLng[] }[] = [];
  ring.forEach((p, i) => {
    if (pins.includes(i)) stops.push({ position: p, index: i, shape: [] });
    else (stops.length ? stops[stops.length - 1].shape : startShape).push(p);
  });
  return { startShape, stops };
}

/** Typical average riding speed by style, for turning a riding time into a loop length. */
export const LOOP_KMH = { fastest: 75, scenic: 60, twisty: 50 } as const;

/**
 * How many metres of road the route rides twice, out and back, within
 * `window` metres (along the route) of the point of `path` nearest to `near`:
 * the signature of a detour up a dead end, or of riding on past a stop to
 * find somewhere to turn and coming back.
 *
 * Two samples count as the same stretch of road when they are at least
 * 100 m apart along the route but within `tolerance` metres of each other.
 * Both passes follow the same road (or its two carriageways), so they nearly
 * coincide; the parallel legs of a hairpin are further apart than that, so
 * switchbacks aren't mistaken for spurs. Only a local excursion counts:
 * leaving home and returning on the same road at the end of a long loop is
 * outside the window.
 */
export function outAndBack(path: LatLng[], near: LatLng, window = 5000, tolerance = 20): number {
  const step = 20;
  const minGap = 5; // samples, i.e. 100 m along the route
  const pts = resample(path, step);
  if (pts.length < minGap + 1) return 0;
  let mid = 0;
  for (let i = 1; i < pts.length; i++) if (distance(pts[i], near) < distance(pts[mid], near)) mid = i;
  const span = Math.round(window / step);
  const from = Math.max(0, mid - span);
  const to = Math.min(pts.length - 1, mid + span);
  // Flat-earth metres are plenty accurate over a few km and much cheaper than
  // great-circle distance in this O(n²) scan.
  const kx = 111320 * Math.cos(rad(pts[mid].lat));
  const ky = 110540;
  const tol2 = tolerance * tolerance;
  const twice = new Set<number>();
  for (let i = from; i <= to; i++) {
    for (let j = i + minGap; j <= to; j++) {
      const dx = (pts[j].lng - pts[i].lng) * kx;
      const dy = (pts[j].lat - pts[i].lat) * ky;
      if (dx * dx + dy * dy < tol2) {
        twice.add(i);
        twice.add(j);
      }
    }
  }
  // Each stretch ridden twice is counted once on the way out and once back.
  return (twice.size * step) / 2;
}

/**
 * Every dead-end spur along `path`: a stretch ridden out and straight back
 * along the same road. `tip` is the far end, `base` the junction it leaves
 * from, `length` how far up it goes (metres, one way). Turning circles and
 * small loops at the end are allowed for.
 */
export function findSpurs(path: LatLng[], minLength = 100, tolerance = 25): { tip: LatLng; base: LatLng; length: number }[] {
  const step = 20;
  const pts = resample(path, step);
  const n = pts.length;
  if (n < 12) return [];
  const kx = 111320 * Math.cos(rad(pts[Math.floor(n / 2)].lat));
  const ky = 110540;
  const tol2 = tolerance * tolerance;
  const near = (a: LatLng, b: LatLng) => {
    const dx = (a.lng - b.lng) * kx;
    const dy = (a.lat - b.lat) * ky;
    return dx * dx + dy * dy < tol2;
  };
  // Is pts[i] ridden again around index j, after the turn-around at t (the
  // passes drift a little apart)?
  const back = (i: number, j: number, t: number) => {
    for (let k = Math.max(t + 1, j - 3); k <= Math.min(n - 1, j + 3); k++) if (k - i >= 5 && near(pts[i], pts[k])) return k;
    return -1;
  };
  const out: { tip: LatLng; base: LatLng; length: number }[] = [];
  for (let t = 5; t < n - 5; t++) {
    // Try each place as the turn-around, allowing up to ~200 m of turning
    // circle or loop at the end before the two passes line up.
    let best: { up: number; down: number } | null = null;
    for (let slack = 0; slack <= 10 && !best; slack++) {
      let i = t - 3;
      let j = t + 3 + slack;
      if (i < 0 || j >= n || back(i, j, t) < 0) continue;
      let gap = 0;
      let up = i;
      let down = j;
      while (i > 0 && j < n - 1 && gap <= 3) {
        i--;
        j++;
        const k = back(i, j, t);
        if (k >= 0) {
          up = i;
          down = Math.max(down, k);
          j = Math.max(j, k);
          gap = 0;
        } else gap++;
      }
      if ((t - up) * step >= minLength) best = { up, down };
    }
    if (best) {
      // The turn-around is the point of the spur furthest along it from the foot.
      let far = t;
      for (let k = best.up; k <= best.down; k++) if (distance(pts[k], pts[best.up]) > distance(pts[far], pts[best.up])) far = k;
      out.push({ tip: pts[far], base: pts[best.up], length: (best.down - best.up) * step / 2 });
      t = Math.max(t, best.down); // carry on after the spur
    }
  }
  return out;
}

/**
 * Places where route `a` crosses route `b` (or itself, when `b` is omitted),
 * ignoring anything within `radius` metres of the points in `ignore` (stops,
 * where legs meet and roads naturally cross). Routes are compared as ~150 m
 * segments, so parallel lanes or a road ridden twice don't count as crossing.
 */
export function crossings(a: LatLng[], b: LatLng[] | null, ignore: LatLng[] = [], radius = 400): LatLng[] {
  const step = 150;
  const pa = resample(a, step);
  const pb = b ? resample(b, step) : pa;
  if (pa.length < 2 || pb.length < 2) return [];
  const lat0 = pa[0].lat;
  const kx = 111320 * Math.cos(rad(lat0));
  const ky = 110540;
  const xy = (p: LatLng) => [p.lng * kx, p.lat * ky] as const;
  const A = pa.map(xy);
  const B = b ? pb.map(xy) : A;
  const cross = (o: readonly number[], p: readonly number[], q: readonly number[]) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const hits: LatLng[] = [];
  for (let i = 0; i < A.length - 1; i++) {
    const [a1, a2] = [A[i], A[i + 1]];
    const minX = Math.min(a1[0], a2[0]);
    const maxX = Math.max(a1[0], a2[0]);
    const minY = Math.min(a1[1], a2[1]);
    const maxY = Math.max(a1[1], a2[1]);
    // Against itself: skip neighbouring segments (they share a point).
    for (let j = b ? 0 : i + 2; j < B.length - 1; j++) {
      const [b1, b2] = [B[j], B[j + 1]];
      if (Math.max(b1[0], b2[0]) < minX || Math.min(b1[0], b2[0]) > maxX || Math.max(b1[1], b2[1]) < minY || Math.min(b1[1], b2[1]) > maxY) continue;
      const d1 = cross(b1, b2, a1);
      const d2 = cross(b1, b2, a2);
      const d3 = cross(a1, a2, b1);
      const d4 = cross(a1, a2, b2);
      // Roads meeting at a real angle, not one road ridden twice (nearly parallel).
      const ux = a2[0] - a1[0];
      const uy = a2[1] - a1[1];
      const vx = b2[0] - b1[0];
      const vy = b2[1] - b1[1];
      const sin = Math.abs(ux * vy - uy * vx) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1);
      if (d1 * d2 < 0 && d3 * d4 < 0 && sin > 0.3) {
        const at = pa[i];
        if (!ignore.some((s) => distance(s, at) < radius) && !hits.some((h) => distance(h, at) < 300)) hits.push(at);
      }
    }
  }
  return hits;
}

/** A 0–10 twistiness score from degrees of turning per km (the "Calimeter" idea). */
export const twistScore = (curvinessDegPerKm: number) => Math.min(10, Math.max(0, curvinessDegPerKm / 20));

/**
 * Number of real bends: runs of turning in one direction that add up to at
 * least `minTurn` degrees. Small wobbles don't end a bend, a long straight
 * does, and a change of direction starts a new one (an S-bend counts twice).
 */
export function countBends(path: LatLng[], minTurn = 30): number {
  const step = 25;
  const pts = resample(path, step);
  if (pts.length < 3) return 0;
  let bends = 0;
  let sum = 0; // signed degrees in the current bend
  let calm = 0; // consecutive near-straight samples
  const close = () => {
    if (Math.abs(sum) >= minTurn) bends++;
    sum = 0;
  };
  let prev = bearing(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i++) {
    const cur = bearing(pts[i - 1], pts[i]);
    const t = turnAngle(prev, cur);
    prev = cur;
    if (Math.abs(t) > 120) {
      close(); // a U-turn or junction, not a bend
      continue;
    }
    if (Math.abs(t) < 2) {
      if (++calm >= 8) close(); // ~200 m of straight ends the bend
      continue;
    }
    calm = 0;
    if (sum !== 0 && Math.sign(t) !== Math.sign(sum)) close();
    sum += t;
  }
  close();
  return bends;
}

export type TwistLevel = 0 | 1 | 2 | 3;

/**
 * Split a route into ~`length`-metre sections, each tagged with how twisty
 * it is, for colouring the route line: 0 easy, 1 curvy, 2 twisty, 3 very twisty.
 */
export function twistSections(path: LatLng[], length = 400): { path: LatLng[]; level: TwistLevel }[] {
  const pts = resample(path, 25);
  const per = Math.max(2, Math.round(length / 25));
  const out: { path: LatLng[]; level: TwistLevel }[] = [];
  for (let i = 0; i < pts.length - 1; i += per) {
    // Overlap by one point so sections join up without gaps.
    const chunk = pts.slice(i, i + per + 1);
    const c = curvinessOfChunk(chunk);
    const level: TwistLevel = c >= 180 ? 3 : c >= 100 ? 2 : c >= 45 ? 1 : 0;
    const last = out[out.length - 1];
    if (last && last.level === level) last.path.push(...chunk.slice(1));
    else out.push({ path: chunk, level });
  }
  return out;
}

/** Curviness of an already-resampled chunk (degrees per km). */
function curvinessOfChunk(pts: LatLng[]): number {
  if (pts.length < 3) return 0;
  let total = 0;
  for (let i = 2; i < pts.length; i++) {
    total += Math.min(Math.abs(turnAngle(bearing(pts[i - 2], pts[i - 1]), bearing(pts[i - 1], pts[i]))), 120);
  }
  const km = pathLength(pts) / 1000;
  return km > 0 ? total / km : 0;
}

/**
 * Sun elevation in degrees at a place and time (NOAA's approximation; good to
 * a fraction of a degree, plenty for choosing a day or night map).
 */
export function sunElevation(p: LatLng, date: Date): number {
  const day = date.getTime() / 86400000 + 2440587.5 - 2451545; // days since J2000
  const g = rad((357.529 + 0.98560028 * day) % 360); // mean anomaly
  const q = (280.459 + 0.98564736 * day) % 360; // mean longitude
  const L = rad(q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)); // ecliptic longitude
  const e = rad(23.439 - 0.00000036 * day); // obliquity
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const gmst = (18.697374558 + 24.06570982441908 * day) % 24;
  const hourAngle = rad(gmst * 15 + p.lng) - ra;
  const lat = rad(p.lat);
  return deg(Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(hourAngle)));
}

/** Daylight, counting civil twilight as light enough for the day map. */
export const isDaylight = (p: LatLng, date = new Date()) => sunElevation(p, date) > -6;

/** Coarse spatial index: resampled points bucketed into `cell`-metre squares. */
function pointGrid(paths: LatLng[][], step: number, cell: number) {
  const ref = paths.find((p) => p.length)?.[0] ?? { lat: 0, lng: 0 };
  const kx = 111320 * Math.cos(rad(ref.lat));
  const ky = 110540;
  const key = (p: LatLng) => `${Math.floor((p.lng * kx) / cell)},${Math.floor((p.lat * ky) / cell)}`;
  const cells = new Map<string, LatLng[]>();
  for (const path of paths) {
    for (const p of resample(path, step)) {
      const k = key(p);
      const list = cells.get(k);
      if (list) list.push(p);
      else cells.set(k, [p]);
    }
  }
  const near = (p: LatLng, metres: number) => {
    const cx = Math.floor((p.lng * kx) / cell);
    const cy = Math.floor((p.lat * ky) / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const q of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
          const ex = (q.lng - p.lng) * kx;
          const ey = (q.lat - p.lat) * ky;
          if (ex * ex + ey * ey < metres * metres) return true;
        }
      }
    }
    return false;
  };
  return { near };
}

/**
 * Metres of `path` that run along road already in `others` (within 20 m),
 * ignoring anything within `keepOut` metres of the `ends`, where sharing
 * the roads around a stop or home is unavoidable and fine.
 */
export function sharedRoad(path: LatLng[], others: LatLng[][], ends: LatLng[], keepOut = 1500): number {
  const step = 20;
  const grid = pointGrid(others, step, 25);
  let shared = 0;
  for (const p of resample(path, step)) {
    if (ends.some((e) => distance(p, e) < keepOut)) continue;
    if (grid.near(p, 20)) shared += step;
  }
  return shared;
}

/** The average of some points: the middle of a loop, near enough. */
export function centroid(points: LatLng[]): LatLng {
  const n = Math.max(1, points.length);
  return { lat: points.reduce((a, p) => a + p.lat, 0) / n, lng: points.reduce((a, p) => a + p.lng, 0) / n };
}

/**
 * Up to `max` points spread evenly along `paths`, skipping anything within
 * `keepOut` metres of the `ends`: roads for the router to stay off.
 */
export function avoidPoints(paths: LatLng[][], ends: LatLng[], max = 50, keepOut = 1500): LatLng[] {
  const candidates = paths
    .flatMap((p) => resample(p, 200))
    .filter((p) => ends.every((e) => distance(p, e) >= keepOut));
  if (candidates.length <= max) return candidates;
  return Array.from({ length: max }, (_, i) => candidates[Math.floor(((i + 0.5) * candidates.length) / max)]);
}

export function midpointOffset(a: LatLng, b: LatLng, fraction: number): LatLng {
  const d = distance(a, b);
  const brg = bearing(a, b);
  const mid = destination(a, brg, d / 2);
  return destination(mid, (brg + (fraction >= 0 ? 90 : 270)) % 360, Math.abs(fraction) * d);
}

/** Metres in a mile. */
export const MILE = 1609.344;

// Display preferences, set from the rider's settings.
let units: "km" | "mi" = "km";
let clock: "auto" | "24" | "12" = "auto";

export function setDisplayPrefs(p: { units?: "km" | "mi"; clock?: "auto" | "24" | "12" }) {
  if (p.units) units = p.units;
  if (p.clock) clock = p.clock;
}

export const distanceUnits = () => units;

export function formatDistance(m: number): string {
  if (units === "mi") {
    const mi = m / MILE;
    if (mi < 0.1) return `${Math.round((m * 3.28084) / 10) * 10} ft`;
    return mi >= 10 ? `${mi.toFixed(0)} mi` : `${mi.toFixed(1)} mi`;
  }
  return m >= 10000 ? `${(m / 1000).toFixed(0)} km` : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

/** A speed in the rider's units (km/h in, km/h or mph out). */
export const toSpeed = (kmh: number) => (units === "mi" ? kmh / 1.609344 : kmh);
export const speedUnit = () => (units === "mi" ? "mph" : "km/h");

/** A time of day, as "14:05" or "2:05 pm" per the rider's clock setting. */
export function formatTime(t: number | Date): string {
  return new Date(t).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    ...(clock === "auto" ? {} : { hour12: clock === "12" }),
  });
}

export function formatDuration(s: number): string {
  if (s > 0 && s < 30) return "under 1 min";
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m.toString().padStart(2, "0")} min` : `${m} min`;
}

/**
 * Where a new stop fits best among `stops` (in riding order): the gap it
 * adds the least straight-line riding to, or on the end. On a loop the last
 * gap is the ride home. Returns the index to insert at. The start stays first.
 */
export function bestInsertIndex(stops: LatLng[], p: LatLng, loop: boolean): number {
  const n = stops.length;
  if (n < 2) return n;
  let best = n;
  // Riding on from the last stop (not on a loop, which rides home from there).
  let bestCost = loop ? Infinity : distance(stops[n - 1], p);
  const gaps = loop ? n : n - 1;
  for (let i = 0; i < gaps; i++) {
    const a = stops[i];
    const b = stops[(i + 1) % n];
    const cost = distance(a, p) + distance(p, b) - distance(a, b);
    if (cost < bestCost) {
      bestCost = cost;
      best = i + 1;
    }
  }
  return best;
}
