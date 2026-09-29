import { distance, findSpurs, roundTripWaypoints, type LatLng } from "./geo";
import { loopShapes, pickLoops, scoreLoop, type LoopChoice, type LoopShape, type ScoredLoop } from "./loopChoice";
import type { RouteResult } from "./routes";

/** Dead ends shorter than this are left alone (a turning bay, a roundabout's approach). */
const SPUR_M = 300;
/** Out and back counts as the same road within this many metres (the two sides of a divided road). */
const SPUR_TOLERANCE_M = 40;
/** A loop point this close to a dead end's tip is taken to be what led the route up it. */
const BLAME_M = 3500;
/** Loops tidied up after the first look (the best few, so it stays quick). */
const REPAIR = 4;
/** A loop point with a through road this close moves onto it. */
const ON_ROAD_M = 1500;
/** How far a point with no road near moves towards the loop's middle, each try. */
const PULL = 0.35;

/** A candidate loop together with the points it was planned through. */
export interface FoundLoop extends ScoredLoop {
  ring: LatLng[];
}

export interface FindLoopsInput {
  origin: LatLng;
  targetMetres: number;
  /** Compass heading to go out on, or null for any. */
  heading: number | null;
  /** How many shapes to try. */
  count: number;
  /** Requests to send at once. */
  atOnce: number;
  /** A quick route round the loop through `ring` (null if there's none). */
  plan: (ring: LatLng[]) => Promise<RouteResult | null>;
  /** The nearest through road to each point, or null (see throughRoadsNear). */
  locate?: (points: LatLng[]) => Promise<(LatLng | null)[]>;
  random?: () => number;
}

/**
 * Loop points put on proper roads before planning. Each point moves onto a
 * through road nearby; one out in the sea or deep in a forest moves towards
 * the loop's middle (twice at most) until there is one. Without this, such
 * a point snaps to whatever road is nearest, often an island or peninsula
 * road the loop then rides out and back along.
 */
export async function onRoads(
  rings: LatLng[][],
  origin: LatLng,
  locate: (points: LatLng[]) => Promise<(LatLng | null)[]>,
): Promise<LatLng[][]> {
  const out = rings.map((r) => r.slice());
  // The start and the ring points are evenly spaced round the circle, so their average is its middle.
  const middles = rings.map((r) => {
    const all = [origin, ...r];
    return { lat: all.reduce((a, p) => a + p.lat, 0) / all.length, lng: all.reduce((a, p) => a + p.lng, 0) / all.length };
  });
  let pending = rings.flatMap((r, i) => r.map((_, k) => [i, k] as const));
  const stranded: (readonly [number, number])[] = [];
  for (let round = 0; round < 3 && pending.length; round++) {
    const found = await locate(pending.map(([i, k]) => out[i][k]));
    // No answer at all (offline, server busy): plan from the points as they are.
    if (round === 0 && found.every((q) => !q)) return rings;
    const next: (readonly [number, number])[] = [];
    pending.forEach(([i, k], j) => {
      const p = out[i][k];
      const q = found[j];
      if (q && distance(p, q) <= ON_ROAD_M) out[i][k] = q;
      else if (round < 2) {
        out[i][k] = { lat: p.lat + (middles[i].lat - p.lat) * PULL, lng: p.lng + (middles[i].lng - p.lng) * PULL };
        next.push([i, k]);
      }
      // Still nothing (well out to sea): see below.
      else stranded.push([i, k]);
    });
    pending = next;
  }
  // A point with no road anywhere near takes the nearest of its loop's
  // points that found one, rather than staying where no route can reach.
  for (const [i, k] of stranded) {
    const onRoad = out[i].filter((_, j) => !stranded.some(([si, sk]) => si === i && sk === j));
    if (!onRoad.length) continue;
    out[i][k] = onRoad.reduce((a, b) => (distance(b, out[i][k]) < distance(a, out[i][k]) ? b : a));
  }
  return out;
}

/**
 * The loop through `ring` with each dead end it rides up and back taken
 * out: the loop point that led it there moves to the foot of the dead end,
 * where the route leaves the through road. Loop points are placed on a
 * circle, so on a coast or by a national park some land in the sea or the
 * bush and snap to the nearest road, often an island or a peninsula road
 * that only goes there and back.
 */
export function moveOffDeadEnds(ring: LatLng[], route: RouteResult): LatLng[] | null {
  const moved = ring.slice();
  let changed = false;
  for (const spur of findSpurs(route.path, SPUR_M, SPUR_TOLERANCE_M)) {
    let best = -1;
    ring.forEach((p, i) => {
      const d = distance(p, spur.tip);
      if (d < BLAME_M && (best < 0 || d < distance(ring[best], spur.tip))) best = i;
    });
    if (best >= 0 && moved[best] === ring[best]) {
      moved[best] = spur.base;
      changed = true;
    }
  }
  return changed ? moved : null;
}

/**
 * The ring grown or shrunk about the start so the loop comes out nearer the
 * asked length. Roads wind more in some places than others (round a range,
 * along a coast), so the first try is often well off.
 */
export function resized(ring: LatLng[], origin: LatLng, factor: number): LatLng[] {
  const f = Math.min(1.3, Math.max(0.6, factor));
  return ring.map((p) => ({ lat: origin.lat + (p.lat - origin.lat) * f, lng: origin.lng + (p.lng - origin.lng) * f }));
}

/**
 * A new round trip: put several loop shapes' points on proper roads, try
 * each with one quick request, tidy up the most promising (off dead ends, nearer the asked length), and
 * offer the best balance, the curviest and one heading another way.
 */
export async function findLoops(input: FindLoopsInput, signal?: AbortSignal): Promise<{ choices: LoopChoice[]; loops: FoundLoop[] }> {
  const { origin, targetMetres, heading, count, atOnce, plan } = input;
  const shapes = loopShapes(count, heading, input.random);
  const loops: FoundLoop[] = [];
  const score = (s: LoopShape, ring: LatLng[], r: RouteResult): FoundLoop => ({ ...scoreLoop(s, r, targetMetres, origin, [origin, ...ring]), ring });
  const inBatches = async <T>(items: T[], each: (item: T) => Promise<void>) => {
    for (let i = 0; i < items.length && !signal?.aborted; i += atOnce) await Promise.all(items.slice(i, i + atOnce).map(each));
  };
  let rings = shapes.map((s) => roundTripWaypoints(origin, targetMetres * s.scale, s.heading, 5));
  if (input.locate) rings = await onRoads(rings, origin, input.locate);
  await inBatches(shapes, async (s) => {
    const ring = rings[shapes.indexOf(s)];
    const r = await plan(ring);
    if (r) loops.push(score(s, ring, r));
  });
  // Tidy up the best few: one more request each.
  const worth = [...loops].sort((a, b) => b.balance - a.balance).slice(0, REPAIR);
  await inBatches(worth, async (l) => {
    const offDeadEnds = moveOffDeadEnds(l.ring, l.route);
    const lengthOff = Math.abs(l.route.distance - targetMetres) / targetMetres > 0.1;
    if (!offDeadEnds && !lengthOff) return;
    let ring = offDeadEnds ?? l.ring;
    // The dead ends added length too; judge the size without them.
    if (lengthOff) {
      const spurs = findSpurs(l.route.path, SPUR_M, SPUR_TOLERANCE_M).reduce((a, s) => a + 2 * s.length, 0);
      ring = resized(ring, origin, targetMetres / Math.max(1, l.route.distance - spurs));
    }
    const r = await plan(ring);
    if (!r) return;
    const better = score(l, ring, r);
    if (better.balance > l.balance) loops[loops.indexOf(l)] = better;
  });
  return { choices: pickLoops(loops), loops };
}
