import { bearing, curviness, distance, pathLength, resample, turnAngle, twistScore, type LatLng } from "./geo";
import type { Fix } from "./navigation";

/** One recorded position: [lat, lng, seconds since start, speed km/h or -1 if unknown]. Compact for storage. */
export type TrackPoint = [number, number, number, number];

export interface RideStats {
  distance: number; // m
  totalTime: number; // s, first to last point
  movingTime: number; // s, above walking pace
  avgSpeed: number; // km/h over moving time
  maxSpeed: number; // km/h, 5-second rolling average (GPS spikes don't count)
  curviness: number; // deg/km over the whole ride
  bends: number;
  /** The twistiest ~5 km: where it starts and ends (m from the start) and its 0–10 score. */
  twistiest: { from: number; to: number; score: number } | null;
  /** Estimated lean angle (degrees): a high percentile across bends, so one GPS glitch can't claim 60°. */
  lean: number | null;
}

export interface RideRecord {
  id: string;
  name: string;
  startedAt: number; // epoch ms
  points: TrackPoint[];
  stats: RideStats;
}

const MOVING = 1.5; // m/s: below this you're stopped (lights, fuel, photos)

/**
 * Collects GPS fixes into a clean track: drops poor fixes and keeps a point
 * every 8 m or 10 s, which is plenty to redraw a ride and keeps storage small.
 */
export class Recorder {
  readonly points: TrackPoint[] = [];
  distance = 0;

  constructor(readonly startedAt: number = Date.now(), points: TrackPoint[] = []) {
    this.points.push(...points);
    for (let i = 1; i < points.length; i++) this.distance += distance(pos(points[i - 1]), pos(points[i]));
  }

  /** Returns true if the fix was kept. */
  add(fix: Fix): boolean {
    if (fix.accuracy > 40) return false;
    const t = Math.max(0, (fix.time - this.startedAt) / 1000);
    const last = this.points[this.points.length - 1];
    if (last) {
      const moved = distance(pos(last), fix.position);
      if (moved < 8 && t - last[2] < 10) return false;
      // A jump faster than 300 km/h is a GPS glitch, not a ride.
      if (t > last[2] && moved / (t - last[2]) > 83) return false;
      this.distance += moved;
    }
    this.points.push([
      round(fix.position.lat, 6),
      round(fix.position.lng, 6),
      Math.round(t * 10) / 10,
      fix.speed != null && fix.speed >= 0 ? Math.round(fix.speed * 3.6) : -1,
    ]);
    return true;
  }

  get elapsed() {
    const last = this.points[this.points.length - 1];
    return last ? last[2] : 0;
  }
}

const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp;
export const pos = (p: TrackPoint): LatLng => ({ lat: p[0], lng: p[1] });
export const trackPath = (points: TrackPoint[]) => points.map(pos);

/** Speed at each point in m/s: the GPS's own reading, or worked out from the neighbours. */
export function speeds(points: TrackPoint[]): number[] {
  return points.map((p, i) => {
    if (p[3] >= 0) return p[3] / 3.6;
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const dt = b[2] - a[2];
    return dt > 0 ? distance(pos(a), pos(b)) / dt : 0;
  });
}

export function rideStats(points: TrackPoint[]): RideStats {
  const path = trackPath(points);
  const v = speeds(points);
  let dist = 0;
  let moving = 0;
  for (let i = 1; i < points.length; i++) {
    const d = distance(path[i - 1], path[i]);
    const dt = points[i][2] - points[i - 1][2];
    dist += d;
    if (dt > 0 && d / dt > MOVING) moving += dt;
  }
  // Top speed: the best 5-second average.
  let maxSpeed = 0;
  for (let i = 0; i < points.length; i++) {
    let j = i;
    while (j < points.length - 1 && points[j][2] - points[i][2] < 5) j++;
    const dt = points[j][2] - points[i][2];
    if (dt >= 4) maxSpeed = Math.max(maxSpeed, pathLength(path.slice(i, j + 1)) / dt);
  }
  const totalTime = points.length ? points[points.length - 1][2] - points[0][2] : 0;
  return {
    distance: dist,
    totalTime,
    movingTime: moving,
    avgSpeed: moving > 0 ? (dist / moving) * 3.6 : 0,
    maxSpeed: maxSpeed * 3.6,
    curviness: curviness(path),
    bends: 0, // filled in by the caller with geo.countBends (kept out of here to stay cheap)
    twistiest: twistiestStretch(path),
    lean: leanEstimate(points, v),
  };
}

/** The twistiest ~5 km window of a ride. */
export function twistiestStretch(path: LatLng[], window = 5000): RideStats["twistiest"] {
  const pts = resample(path, 50);
  const per = Math.round(window / 50);
  if (pts.length < per + 1) return null;
  // Compare raw curviness: the 0–10 score tops out, which would stop at the first very twisty window.
  let best = { from: 0, to: 0, c: -1 };
  for (let i = 0; i + per < pts.length; i += 4) {
    const c = curviness(pts.slice(i, i + per + 1));
    if (c > best.c) best = { from: i * 50, to: (i + per) * 50, c };
  }
  return best.c >= 0 ? { from: best.from, to: best.to, score: twistScore(best.c) } : null;
}

/**
 * Lean angle from physics: leaning into a bend of radius r at speed v takes
 * atan(v² / (r·g)). The radius comes from how fast the heading changes along
 * the track, so this is an estimate: GPS smooths tight bends out, which errs
 * on the low side. Reported as the 95th percentile of the bends ridden.
 */
export function leanEstimate(points: TrackPoint[], v: number[] = speeds(points)): number | null {
  if (points.length < 5) return null;
  const path = trackPath(points);
  const step = 20;
  const pts = resample(path, step);
  // Speed at each resampled point: from the nearest recorded point.
  const cum: number[] = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + distance(path[i - 1], path[i]));
  const leans: number[] = [];
  let k = 0;
  for (let i = 2; i < pts.length; i++) {
    const turn = Math.abs(turnAngle(bearing(pts[i - 2], pts[i - 1]), bearing(pts[i - 1], pts[i])));
    if (turn < 3 || turn > 90) continue; // straight, or a junction / U-turn
    const along = (i - 1) * step;
    while (k < cum.length - 1 && cum[k + 1] < along) k++;
    const speed = v[k] ?? 0;
    if (speed < 5) continue; // under 18 km/h, lean is small and GPS wander dominates
    const radius = step / ((turn * Math.PI) / 180);
    leans.push(Math.min(60, (Math.atan((speed * speed) / (radius * 9.81)) * 180) / Math.PI));
  }
  if (leans.length < 3) return null;
  leans.sort((a, b) => a - b);
  return Math.round(leans[Math.floor(leans.length * 0.95)]);
}

/** A name for a ride from its start time, e.g. "Sunday morning ride". */
export function rideName(startedAt: number): string {
  const d = new Date(startedAt);
  const h = d.getHours();
  const part = h < 5 ? "night" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night";
  return `${d.toLocaleDateString(undefined, { weekday: "long" })} ${part} ride`;
}
