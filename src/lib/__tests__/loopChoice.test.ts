import { describe, expect, it } from "vitest";
import { destination, type LatLng } from "../geo";
import { loopShapes, pickLoops, scoreLoop, type LoopShape, type ScoredLoop } from "../loopChoice";
import type { RouteResult } from "../routes";

const home = { lat: -26.8, lng: 153.13 };

/** A loop route round a circle of `km` circumference, with `wiggle` bends added. */
function circleRoute(km: number, heading: number, wiggle = 0): RouteResult {
  const r = (km * 1000) / (2 * Math.PI);
  const centre = destination(home, heading, r);
  const back = (heading + 180) % 360;
  const path: LatLng[] = [];
  for (let i = 0; i <= 360; i += 2) {
    const p = destination(centre, (back + i) % 360, r + (wiggle ? wiggle * Math.sin((i * Math.PI) / 6) : 0));
    path.push(p);
  }
  return { id: String(heading), label: "", path, distance: km * 1000, duration: km * 60, curviness: 0, legs: [], steps: [], detours: [], warnings: [] };
}

const shape = (heading: number, scale = 1): LoopShape => ({ heading, scale });

describe("loop shapes to try", () => {
  it("spreads round the compass when any direction will do", () => {
    const shapes = loopShapes(6, null, () => 0);
    expect(shapes.map((s) => Math.round(s.heading))).toEqual([0, 60, 120, 180, 240, 300]);
    expect(new Set(shapes.map((s) => s.scale)).size).toBe(3);
  });

  it("fans either side of a chosen direction", () => {
    const shapes = loopShapes(5, 270, () => 0.5);
    expect(shapes.map((s) => Math.round(s.heading))).toEqual([270, 288, 252, 306, 234]);
  });
});

describe("scoring and picking loops", () => {
  it("prefers a loop near the asked length that doesn't ride the same road twice", () => {
    const good = scoreLoop(shape(0), circleRoute(100, 0), 100000, home, [home]);
    const long = scoreLoop(shape(90), circleRoute(140, 90), 100000, home, [home]);
    // Out and back on the same road: the second half retraces the first.
    const out = [home, destination(home, 180, 50000)];
    const outAndBack: RouteResult = { ...circleRoute(100, 180), path: [...out, home] };
    const retrace = scoreLoop(shape(180), outAndBack, 100000, home, [home]);
    expect(good.accuracy).toBe(100);
    expect(long.accuracy).toBe(0);
    expect(retrace.overlap).toBeGreaterThan(0.4);
    expect(good.balance).toBeGreaterThan(long.balance);
    expect(good.balance).toBeGreaterThan(retrace.balance);
  });

  it("offers three different loops: best balance, most curvy, another way", () => {
    const scored: ScoredLoop[] = [
      { ...shape(0), route: circleRoute(100, 0), curves: 40, accuracy: 100, overlap: 0, crossings: 0, balance: 67 },
      { ...shape(20), route: circleRoute(100, 20), curves: 80, accuracy: 60, overlap: 0.05, crossings: 0, balance: 63 },
      { ...shape(10), route: circleRoute(100, 10), curves: 35, accuracy: 95, overlap: 0, crossings: 0, balance: 62 },
      { ...shape(180), route: circleRoute(100, 180), curves: 30, accuracy: 90, overlap: 0, crossings: 0, balance: 57 },
    ];
    const picked = pickLoops(scored);
    expect(picked.map((c) => c.label)).toEqual(["Best balance", "Most curvy", "Another way"]);
    expect(picked.map((c) => c.loop.heading)).toEqual([0, 20, 180]);
  });

  it("doesn't offer a 'most curvy' that isn't curvier, or one far off the length", () => {
    const scored: ScoredLoop[] = [
      { ...shape(0), route: circleRoute(100, 0), curves: 70, accuracy: 100, overlap: 0, crossings: 0, balance: 80 },
      { ...shape(90), route: circleRoute(100, 90), curves: 95, accuracy: 10, overlap: 0, crossings: 0, balance: 50 },
    ];
    const picked = pickLoops(scored);
    expect(picked.map((c) => c.label)).toEqual(["Best balance", "Another way"]);
    expect(pickLoops([])).toEqual([]);
  });
});
