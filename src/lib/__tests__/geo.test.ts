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
  outAndBack,
  findSpurs,
  loopLayout,
  loopThrough,
  sharedRoad,
  countBends,
  twistSections,
  twistScore,
  sunElevation,
  isDaylight,
  avoidPoints,
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

describe("outAndBack", () => {
  // A road heading east, with a side road going 600 m north to `tip`.
  const east = (from: LatLng, m: number) => destination(from, 90, m);
  const junction = east(origin, 2000);
  const tip = destination(junction, 0, 600);

  it("measures a dead-end spur ridden up and back", () => {
    const path = [origin, junction, tip, junction, east(junction, 2000)];
    expect(outAndBack(path, tip)).toBeGreaterThan(500);
  });

  it("lists every spur along a route, with its foot", () => {
    const tip2 = destination(east(junction, 1500), 180, 900);
    const path = [origin, junction, tip, junction, east(junction, 1500), tip2, east(junction, 1500), east(junction, 3000)];
    const spurs = findSpurs(path);
    expect(spurs).toHaveLength(2);
    expect(distance(spurs[0].base, junction)).toBeLessThan(60);
    expect(distance(spurs[0].tip, tip)).toBeLessThan(60);
    expect(spurs[0].length).toBeGreaterThan(500);
    expect(distance(spurs[1].base, east(junction, 1500))).toBeLessThan(60);
    expect(findSpurs([origin, junction, east(junction, 2000), destination(east(junction, 2000), 0, 800), tip])).toEqual([]);
  });

  it("finds a spur with a turning circle at the end", () => {
    const circle: LatLng[] = [];
    for (let a = 180; a <= 540; a += 30) circle.push(destination(destination(tip, 0, 25), a, 25));
    const spurs = findSpurs([origin, junction, tip, ...circle, tip, junction, east(junction, 2000)]);
    expect(spurs).toHaveLength(1);
    expect(distance(spurs[0].base, junction)).toBeLessThan(60);
  });

  it("catches a spur that ends in a turning circle", () => {
    const circle: LatLng[] = [];
    for (let a = 180; a <= 540; a += 30) circle.push(destination(destination(tip, 0, 15), a, 15));
    const path = [origin, junction, tip, ...circle, tip, junction, east(junction, 2000)];
    expect(outAndBack(path, tip)).toBeGreaterThan(500);
  });

  it("catches riding on past a stop to turn around and coming back", () => {
    const beyond = destination(tip, 0, 800);
    const path = [origin, junction, tip, beyond, tip, junction, east(junction, 2000)];
    expect(outAndBack(path, tip)).toBeGreaterThan(700);
  });

  it("doesn't flag a long loop that leaves and returns on the same home road", () => {
    // 1 km home road, then a 40 km loop, then the same home road back.
    const gate = destination(origin, 0, 1000);
    const loop = [0, 1, 2, 3].map((k) => destination(gate, 45 + 90 * k, 7000));
    const path = [origin, gate, ...loop, gate, origin];
    const stop = loop[1];
    expect(outAndBack(path, stop)).toBe(0);
  });

  it("ignores a stop the road simply passes through", () => {
    const path = [origin, junction, tip, destination(tip, 45, 3000)];
    expect(outAndBack(path, tip)).toBe(0);
  });

  it("doesn't mistake hairpin switchbacks for a spur", () => {
    // 300 m legs, 40 m apart, joined by tight bends: a mountain pass.
    const pts = [origin];
    let heading = 0;
    for (let i = 0; i < 10; i++) {
      pts.push(destination(pts[pts.length - 1], heading, 300));
      pts.push(destination(pts[pts.length - 1], 90, 40));
      heading = (heading + 180) % 360;
    }
    expect(outAndBack(pts, pts[10])).toBe(0);
  });
});

describe("sharedRoad and avoidPoints", () => {
  const home = origin;
  const town = destination(home, 90, 30000);
  const straight = [home, town];
  const northArc = [town, destination(destination(home, 90, 15000), 0, 8000), home];

  it("measures road a return leg shares with the way out, away from the ends", () => {
    const back = [town, home];
    // 30 km of shared road minus 1.5 km kept clear at each end.
    expect(sharedRoad(back, [straight], [town, home])).toBeGreaterThan(26000);
    expect(sharedRoad(northArc, [straight], [town, home])).toBeLessThan(500);
  });

  it("spreads at most 50 avoid points along earlier roads, clear of the ends", () => {
    const pts = avoidPoints([straight], [town, home]);
    expect(pts.length).toBe(50);
    expect(pts.every((p) => distance(p, home) >= 1500 && distance(p, town) >= 1500)).toBe(true);
    // Evenly spread: first and last points near each end of the allowed stretch.
    expect(distance(pts[0], home)).toBeLessThan(2500);
    expect(distance(pts[49], town)).toBeLessThan(2500);
  });
});

describe("bends and sections", () => {
  it("counts each bend of a winding road, and none on a straight", () => {
    expect(countBends([origin, destination(origin, 30, 10000)])).toBe(0);
    // 8 alternating 60° bends, 300 m apart.
    const pts = [origin];
    let heading = 0;
    for (let i = 0; i < 8; i++) {
      for (let k = 0; k < 6; k++) pts.push(destination(pts[pts.length - 1], heading, 50));
      heading = (heading + (i % 2 ? -60 : 60) + 360) % 360;
    }
    for (let k = 0; k < 6; k++) pts.push(destination(pts[pts.length - 1], heading, 50));
    expect(countBends(pts)).toBe(8);
  });

  it("scores twistiness from 0 to 10", () => {
    expect(twistScore(0)).toBe(0);
    expect(twistScore(100)).toBe(5);
    expect(twistScore(500)).toBe(10);
  });

  it("tags straight and twisty stretches differently and covers the whole route", () => {
    const straight = [origin, destination(origin, 90, 3000)];
    const wiggle = zigzag(60, 150, 3).map((p) => destination(p, 90, 3000));
    const sections = twistSections([...straight, ...wiggle]);
    expect(sections[0].level).toBe(0);
    expect(sections[sections.length - 1].level).toBeGreaterThanOrEqual(2);
    const covered = sections.reduce((s, x) => s + pathLength(x.path), 0);
    expect(covered).toBeGreaterThan(5500);
  });
});

describe("sun", () => {
  const brisbane = { lat: -27.47, lng: 153.03 };
  it("is up at noon and down at midnight in Brisbane (UTC+10)", () => {
    expect(sunElevation(brisbane, new Date("2026-09-27T02:00:00Z"))).toBeGreaterThan(50);
    expect(isDaylight(brisbane, new Date("2026-09-27T14:00:00Z"))).toBe(false);
    expect(isDaylight(brisbane, new Date("2026-09-27T02:00:00Z"))).toBe(true);
  });
});

describe("loopThrough", () => {
  const home = { lat: -26.65, lng: 153.05 };
  const maleny = { lat: -26.76, lng: 152.85 };

  it("puts the chosen place on the loop and keeps it about the asked length", () => {
    const { waypoints, viaIndex } = loopThrough(home, maleny, 120000, 1);
    expect(waypoints[viaIndex]).toEqual(maleny);
    const loop = pathLength([home, ...waypoints, home]);
    expect(loop).toBeGreaterThan((120000 / 1.35) * 0.8);
    expect(loop).toBeLessThan((120000 / 1.35) * 1.1);
  });

  it("grows the loop when the place is too far for the asked length", () => {
    const { waypoints } = loopThrough(home, maleny, 20000, 1);
    // The place is ~23 km away, so the loop must be at least ~46 km in a straight line.
    expect(pathLength([home, ...waypoints, home])).toBeGreaterThan(46000);
  });

  it("goes round either way", () => {
    const left = loopThrough(home, maleny, 120000, 1).waypoints;
    const right = loopThrough(home, maleny, 120000, -1).waypoints;
    expect(distance(left[0], right[0])).toBeGreaterThan(5000);
  });
});

describe("loopLayout", () => {
  it("keeps a few points as pins and the rest as shaping points after them", () => {
    const ring = [0, 1, 2, 3, 4].map((i) => ({ lat: 47 + i / 10, lng: 11 }));
    const { startShape, stops } = loopLayout(ring, [1, 3]);
    expect(startShape).toEqual([ring[0]]);
    expect(stops.map((s) => s.index)).toEqual([1, 3]);
    expect(stops[0].shape).toEqual([ring[2]]);
    expect(stops[1].shape).toEqual([ring[4]]);
  });
});
