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
  random?: () => number;
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
 * A new round trip: try several loop shapes with one quick request each,
 * tidy up the most promising (off dead ends, nearer the asked length), and
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
  await inBatches(shapes, async (s) => {
    const ring = roundTripWaypoints(origin, targetMetres * s.scale, s.heading, 5);
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
