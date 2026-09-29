import { bendAnalysis, crossings, pathLength, sharedRoad, type LatLng } from "./geo";
import type { RouteResult } from "./routes";

/** A loop shape to try: which way it heads and how big it is (1 = the asked length). */
export interface LoopShape {
  heading: number;
  scale: number;
}

export interface ScoredLoop extends LoopShape {
  route: RouteResult;
  /** 0–100 bend quality (bendAnalysis). */
  curves: number;
  /** 0–100: 100 when the length is spot on, 0 at 30% out. */
  accuracy: number;
  /** Share of the loop ridden twice (the way home on the way out's road), 0–1. */
  overlap: number;
  crossings: number;
  /** Overall, for "Best balance". */
  balance: number;
}

/**
 * Shapes to try for a loop: spread round the compass when any direction
 * will do (from a random start, so each go differs), or fanned either side
 * of the chosen direction; sizes alternate a little either side of the asked
 * length so one of them lands close.
 */
export function loopShapes(count: number, heading: number | null, random = Math.random): LoopShape[] {
  const scales = [1, 0.88, 1.12];
  const start = random() * 360;
  return Array.from({ length: count }, (_, i) => {
    const h =
      heading == null
        ? start + (360 * i) / count
        : heading + (i === 0 ? 0 : Math.ceil(i / 2) * (i % 2 ? 1 : -1) * 18) + (random() * 10 - 5);
    return { heading: ((h % 360) + 360) % 360, scale: scales[i % scales.length] };
  });
}

const clamp = (v: number) => Math.min(100, Math.max(0, v));

/** How good a candidate loop is: bends, length, and no riding the same road twice or crossing over. */
export function scoreLoop(shape: LoopShape, route: RouteResult, targetMetres: number, origin: LatLng, stops: LatLng[]): ScoredLoop {
  const curves = bendAnalysis(route.path).score;
  const accuracy = clamp(100 * (1 - Math.abs(route.distance - targetMetres) / targetMetres / 0.3));
  const half = Math.floor(route.path.length / 2);
  const total = Math.max(1, pathLength(route.path));
  const overlap = Math.min(1, sharedRoad(route.path.slice(half), [route.path.slice(0, half + 1)], [origin]) / total);
  const cross = crossings(route.path, null, stops).length;
  const balance = 0.55 * curves + 0.45 * accuracy - overlap * 150 - cross * 12;
  return { ...shape, route, curves, accuracy, overlap, crossings: cross, balance };
}

export interface LoopChoice {
  label: "Best balance" | "Most curvy" | "Another way";
  loop: ScoredLoop;
}

/** Headings this close count as the same way out. */
const SAME_WAY = 40;
const apart = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

/**
 * Up to three genuinely different loops: the best balance of bends and
 * length, the curviest that's still near the asked length, and the best of
 * the rest heading another way.
 */
export function pickLoops(scored: ScoredLoop[]): LoopChoice[] {
  if (!scored.length) return [];
  const byBalance = [...scored].sort((a, b) => b.balance - a.balance);
  const best = byBalance[0];
  const out: LoopChoice[] = [{ label: "Best balance", loop: best }];
  const curvy = [...scored]
    .filter((s) => s !== best && s.accuracy >= 30 && s.overlap < 0.25)
    .sort((a, b) => b.curves - 0.5 * b.crossings * 12 - (a.curves - 0.5 * a.crossings * 12))[0];
  if (curvy && curvy.curves > best.curves) out.push({ label: "Most curvy", loop: curvy });
  const taken = out.map((c) => c.loop);
  const other = byBalance.find((s) => !taken.includes(s) && taken.every((t) => apart(t.heading, s.heading) >= SAME_WAY));
  if (other) out.push({ label: "Another way", loop: other });
  return out;
}
