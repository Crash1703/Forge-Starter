import { describe, expect, it } from "vitest";
import {
  bearing,
  curviness,
  curvinessLabel,
  destination,
  distance,
  formatDistance,
  formatDuration,
  midpointOffset,
  pathLength,
  resample,
  roundTripWaypoints,
  turnAngle,
  type LatLng,
} from "../geo";

const origin = { lat: 47, lng: 11 };

describe("geo basics", () => {
  it("measures one degree of latitude as ~111 km", () => {
    expect(distance({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111195, -2);
  });

  it("round-trips destination and bearing", () => {
    const p = destination(origin, 60, 5000);
    expect(distance(origin, p)).toBeCloseTo(5000, 0);
    expect(bearing(origin, p)).toBeCloseTo(60, 1);
  });

  it("normalises turn angles", () => {
    expect(turnAngle(350, 10)).toBe(20);
    expect(turnAngle(10, 350)).toBe(-20);
    expect(turnAngle(0, 180)).toBe(180);
  });

  it("resamples at an even spacing and keeps the length", () => {
    const line = [origin, destination(origin, 90, 1000)];
    const pts = resample(line, 100);
    expect(pts.length).toBe(11);
    expect(pathLength(pts)).toBeCloseTo(1000, 0);
  });

  it("offsets a midpoint sideways", () => {
    const b = destination(origin, 0, 10000);
    const left = midpointOffset(origin, b, -0.2);
    const right = midpointOffset(origin, b, 0.2);
    expect(left.lng).toBeLessThan(origin.lng);
    expect(right.lng).toBeGreaterThan(origin.lng);
    expect(distance(left, right)).toBeCloseTo(4000, -1);
  });
});

/** A zig-zag with the given turn every `every` metres. */
function zigzag(turn: number, every: number, km: number): LatLng[] {
  const pts = [origin];
  let heading = 0;
  let sign = 1;
  for (let d = 0; d < km * 1000; d += every) {
    pts.push(destination(pts[pts.length - 1], heading, every));
    heading = (heading + sign * turn + 360) % 360;
    sign = -sign;
  }
  return pts;
}

describe("curviness", () => {
  it("scores a straight road near zero", () => {
    expect(curviness([origin, destination(origin, 30, 20000)])).toBeLessThan(1);
  });

  it("ranks twistier roads higher", () => {
    const gentle = curviness(zigzag(15, 500, 10));
    const twisty = curviness(zigzag(60, 150, 10));
    expect(twisty).toBeGreaterThan(gentle * 3);
    expect(curvinessLabel(gentle)).not.toBe(curvinessLabel(twisty));
  });

  it("keeps a single U-turn from dominating", () => {
    const out = destination(origin, 0, 5000);
    expect(curvinessLabel(curviness([origin, out, origin]))).toBe("Straight");
  });

  it("counts mountain-pass hairpins", () => {
    // Switchbacks: 400 m straights joined by tight 180° bends.
    const pts = [origin];
    let heading = 0;
    for (let i = 0; i < 12; i++) {
      pts.push(destination(pts[pts.length - 1], heading, 400));
      pts.push(destination(pts[pts.length - 1], (heading + 90) % 360, 20));
      heading = (heading + 180) % 360;
    }
    expect(curvinessLabel(curviness(pts))).toMatch(/twisty/i);
  });
});

describe("round trip", () => {
  it("places waypoints on a loop of roughly the right size", () => {
    const target = 100000;
    const pts = roundTripWaypoints(origin, target, 45);
    expect(pts).toHaveLength(3);
    const loop = pathLength([origin, ...pts, origin]);
    // A polygon through the circle is a bit shorter than its circumference.
    expect(loop).toBeGreaterThan((target / 1.35) * 0.8);
    expect(loop).toBeLessThan(target / 1.35);
  });
});

describe("formatting", () => {
  it("formats distances and durations", () => {
    expect(formatDistance(850)).toBe("850 m");
    expect(formatDistance(1500)).toBe("1.5 km");
    expect(formatDistance(123456)).toBe("123 km");
    expect(formatDuration(45 * 60)).toBe("45 min");
    expect(formatDuration(3 * 3600 + 5 * 60)).toBe("3 h 05 min");
  });
});
