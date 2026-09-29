import { describe, expect, it } from "vitest";
import { destination, distance, type LatLng } from "../geo";
import { findLoops, moveOffDeadEnds, resized } from "../loopFinder";
import type { RouteResult } from "../routes";

const home = { lat: -26.8, lng: 153.13 };
const route = (path: LatLng[], metres: number): RouteResult => ({
  id: "r", label: "", path, distance: metres, duration: metres / 20, curviness: 0, legs: [], steps: [], detours: [], warnings: [],
});
/** A straight road east with, halfway, a 2 km dead end north ridden up and back. */
function withDeadEnd(footMetres = 10000) {
  const foot = destination(home, 90, footMetres);
  const tip = destination(foot, 0, 2000);
  const line = (a: LatLng, b: LatLng, n = 40) => Array.from({ length: n + 1 }, (_, i) => ({ lat: a.lat + ((b.lat - a.lat) * i) / n, lng: a.lng + ((b.lng - a.lng) * i) / n }));
  const path = [...line(home, foot), ...line(foot, tip).slice(1), ...line(tip, foot).slice(1), ...line(foot, destination(home, 90, 20000)).slice(1)];
  return { foot, tip, path };
}

describe("tidying a loop", () => {
  it("moves the loop point that led up a dead end to the foot of it", () => {
    const { foot, tip, path } = withDeadEnd();
    // Point 1 was out in the water past the dead end's tip.
    const ring = [destination(home, 90, 5000), destination(tip, 0, 1500), destination(home, 90, 18000)];
    const moved = moveOffDeadEnds(ring, route(path, 24000))!;
    expect(moved).not.toBeNull();
    expect(distance(moved[1], foot)).toBeLessThan(60);
    expect(moved[0]).toBe(ring[0]);
    expect(moved[2]).toBe(ring[2]);
  });

  it("leaves a loop without dead ends alone", () => {
    const path = [home, destination(home, 90, 10000), destination(home, 90, 20000)];
    expect(moveOffDeadEnds([destination(home, 90, 10000)], route(path, 20000))).toBeNull();
  });

  it("grows or shrinks the loop about the start, within limits", () => {
    const p = destination(home, 180, 10000);
    expect(distance(home, resized([p], home, 0.8)[0])).toBeCloseTo(8000, -2);
    expect(distance(home, resized([p], home, 3)[0])).toBeCloseTo(13000, -2);
  });

  it("re-plans the best loops off their dead ends and keeps the better version", async () => {
    // The dead end starts 3 km out, among the loop's points.
    const { path } = withDeadEnd(3000);
    let calls = 0;
    const { choices, loops } = await findLoops({
      origin: home, targetMetres: 24000, heading: 90, count: 1, atOnce: 2, random: () => 0.5,
      // First look: a dead end; the tidied ring comes back clean.
      plan: async () => (calls++ === 0 ? route(path, 24000) : route(path.filter((_, i) => i <= 40 || i > 120), 20000)),
    });
    expect(calls).toBe(2);
    expect(loops[0].deadEnds).toBe(0);
    expect(choices[0].label).toBe("Best balance");
  });
});
