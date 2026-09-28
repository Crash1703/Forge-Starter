import { describe, expect, it } from "vitest";
import { destination, type LatLng } from "../geo";
import { leanEstimate, Recorder, rideStats, twistiestStretch, type TrackPoint } from "../recorder";

const start = { lat: -26.7, lng: 152.9 };
const fix = (position: LatLng, t: number, speed: number | null = 20, accuracy = 5) => ({
  position,
  speed,
  heading: null,
  accuracy,
  time: t * 1000,
});

describe("Recorder", () => {
  it("keeps good fixes about every 8 m, and drops poor ones and glitches", () => {
    const r = new Recorder(0);
    expect(r.add(fix(start, 0))).toBe(true);
    expect(r.add(fix(destination(start, 90, 3), 1))).toBe(false); // too close, too soon
    expect(r.add(fix(destination(start, 90, 20), 1, 20, 80))).toBe(false); // poor accuracy
    expect(r.add(fix(destination(start, 90, 20), 1))).toBe(true);
    expect(r.add(fix(destination(start, 90, 5000), 2))).toBe(false); // 5 km in a second
    expect(r.add(fix(destination(start, 90, 22), 12))).toBe(true); // stopped, but 10 s passed
    expect(r.points.length).toBe(3);
    expect(r.distance).toBeGreaterThan(21);
    expect(r.points[1]).toEqual([expect.any(Number), expect.any(Number), 1, 72]);
  });
});

/** A ride at `mps` along `path`, one point per second, with an optional stop in the middle. */
function ride(path: LatLng[], mps: number, stopSeconds = 0): TrackPoint[] {
  const out: TrackPoint[] = [];
  let t = 0;
  path.forEach((p, i) => {
    out.push([p.lat, p.lng, t, Math.round(mps * 3.6)]);
    if (i === Math.floor(path.length / 2) && stopSeconds) {
      for (let s = 0; s < stopSeconds; s += 10) out.push([p.lat, p.lng, (t += 10), 0]);
    }
    t += 1;
  });
  return out;
}

const line = (from: LatLng, heading: number, metres: number, step: number) =>
  Array.from({ length: Math.floor(metres / step) + 1 }, (_, i) => destination(from, heading, i * step));

describe("rideStats", () => {
  it("measures distance, moving time and speeds, ignoring a stop", () => {
    const s = rideStats(ride(line(start, 90, 10000, 20), 20, 60));
    expect(s.distance).toBeGreaterThan(9950);
    expect(s.distance).toBeLessThan(10050);
    expect(s.movingTime).toBeGreaterThan(480);
    expect(s.movingTime).toBeLessThan(520);
    expect(s.totalTime).toBeGreaterThan(550);
    expect(Math.round(s.avgSpeed)).toBe(72);
    expect(Math.round(s.maxSpeed)).toBe(72);
    expect(s.lean).toBeNull(); // no bends on a straight road
  });

  it("estimates lean from speed and bend radius", () => {
    // Round a 100 m radius bend at 72 km/h: atan(20² / (100 × 9.81)) ≈ 22°.
    const centre = destination(start, 0, 100);
    const arc = Array.from({ length: 60 }, (_, i) => destination(centre, (180 + i * 5) % 360, 100));
    const lean = leanEstimate(ride(arc, 20));
    expect(lean).toBeGreaterThanOrEqual(19);
    expect(lean).toBeLessThanOrEqual(25);
  });

  it("finds the twistiest stretch", () => {
    const straight = line(start, 90, 8000, 50);
    const end = straight[straight.length - 1];
    const wiggle: LatLng[] = [end];
    let h = 90;
    for (let i = 0; i < 60; i++) {
      wiggle.push(destination(wiggle[wiggle.length - 1], h, 100));
      h = (h + (i % 2 ? -50 : 50) + 360) % 360;
    }
    const best = twistiestStretch([...straight, ...wiggle.slice(1)])!;
    expect(best.from).toBeGreaterThan(6000);
    expect(best.score).toBeGreaterThan(5);
  });
});
