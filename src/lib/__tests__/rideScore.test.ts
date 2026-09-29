import { afterEach, describe, expect, it, vi } from "vitest";
import { destination } from "../geo";
import { defaultOptions } from "../routes";
import { rideScore, roadFacts, townWeight } from "../rideScore";

const origin = { lat: -26.76, lng: 152.85 };

/** A road of `arcs` alternating 90° bends at `radius` m, with short straights between. */
function windingRoad(radius: number, arcs: number) {
  const pts = [origin];
  let heading = 0;
  for (let i = 0; i < arcs; i++) {
    const dir = i % 2 ? -1 : 1;
    const stepDeg = (10 / radius) * (180 / Math.PI);
    for (let turned = 0; turned < 90; turned += stepDeg) {
      heading = (heading + dir * stepDeg + 360) % 360;
      pts.push(destination(pts[pts.length - 1], heading, 10));
    }
    for (let k = 0; k < 3; k++) pts.push(destination(pts[pts.length - 1], heading, 20));
  }
  return pts;
}

describe("towns from the router's road density", () => {
  it("counts country roads as rural and suburbs as town", () => {
    // Measured on the public server: Mount Mee Road 1–2, Sunshine Coast suburbs 4–8, inner Brisbane 9–13.
    expect(townWeight(2)).toBe(0);
    expect(townWeight(3)).toBe(0);
    expect(townWeight(5)).toBeCloseTo(0.667, 2);
    expect(townWeight(12)).toBe(1);
    expect(townWeight(undefined)).toBe(0);
  });
});

describe("road facts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("adds up town, motorway and dirt riding along the route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            edges: [
              { length: 6, density: 1, road_class: "secondary", surface: "paved" },
              { length: 2, density: 9, road_class: "primary", surface: "paved" },
              { length: 1, density: 2, road_class: "motorway", surface: "paved" },
              { length: 1, density: 0, road_class: "tertiary", unpaved: true, surface: "gravel" },
            ],
          }),
        ),
      ),
    );
    const f = await roadFacts([origin, destination(origin, 90, 10000)], defaultOptions);
    expect(f).toEqual({ total: 10000, town: 2000, motorway: 1000, dirt: 1000 });
  });
});

describe("RideScore", () => {
  it("rates a twisty country ride well above a town grid", () => {
    const twisty = windingRoad(60, 40);
    const twistyScore = rideScore({ path: twisty, distance: 0, steps: [1, 2, 3] }, { total: 10000, town: 0, motorway: 0, dirt: 0 }, 400);
    // A suburban grid: 400 m blocks, turning at every corner.
    const grid = [origin];
    let heading = 0;
    for (let i = 0; i < 12; i++) {
      for (let k = 0; k < 8; k++) grid.push(destination(grid[grid.length - 1], heading, 50));
      heading = (heading + (i % 2 ? -90 : 90) + 360) % 360;
    }
    const gridScore = rideScore({ path: grid, distance: 0, steps: new Array(13).fill(0) }, { total: 5000, town: 5000, motorway: 0, dirt: 0 }, 10);
    expect(twistyScore.curves).toBeGreaterThan(85);
    expect(twistyScore.rural).toBe(100);
    expect(twistyScore.sealed).toBe(100);
    expect(twistyScore.score).toBeGreaterThan(75);
    expect(gridScore.curves).toBe(0);
    expect(gridScore.rural).toBe(0);
    expect(gridScore.score).toBeLessThan(30);
  });

  it("scores what it knows before the road details arrive", () => {
    const s = rideScore({ path: windingRoad(60, 20), distance: 0, steps: [] }, null, null);
    expect(s.rural).toBeNull();
    expect(s.hills).toBeNull();
    expect(s.sealed).toBeNull();
    expect(s.score).toBeGreaterThan(80);
  });

  it("counts dirt against Sealed and climbing towards Hills", () => {
    const road = [origin, destination(origin, 90, 10000)];
    const s = rideScore({ path: road, distance: 10000, steps: [] }, { total: 10000, town: 0, motorway: 0, dirt: 2500 }, 200);
    expect(s.sealed).toBe(75);
    expect(s.hills).toBe(50); // 20 m/km of 40
  });
});
