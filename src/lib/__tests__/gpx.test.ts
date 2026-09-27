// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { parseGpx, sampleStops, toGpx } from "../gpx";

const a = { lat: 47.1, lng: 11.2 };
const b = { lat: 47.3, lng: 11.5 };
const c = { lat: 47.6, lng: 11.9 };

describe("gpx", () => {
  it("round-trips a route and track", () => {
    const xml = toGpx({ name: "Pass <run> & back", waypoints: [a, c], track: [a, b, c] });
    expect(xml).toContain("Pass &lt;run&gt; &amp; back");
    const back = parseGpx(xml);
    expect(back.name).toBe("Pass <run> & back");
    expect(back.waypoints).toEqual([a, c]);
    expect(back.track).toEqual([a, b, c]);
  });

  it("samples stops from a track-only file", () => {
    const trk = Array.from({ length: 50 }, (_, i) => ({ lat: 47 + i / 100, lng: 11 }));
    const xml = `<gpx><trk><trkseg>${trk.map((p) => `<trkpt lat="${p.lat}" lon="${p.lng}"/>`).join("")}</trkseg></trk></gpx>`;
    const g = parseGpx(xml);
    expect(g.waypoints).toHaveLength(10);
    expect(g.waypoints[0]).toEqual(trk[0]);
    expect(g.waypoints[9]).toEqual(trk[49]);
  });

  it("rejects files without points", () => {
    expect(() => parseGpx("<gpx></gpx>")).toThrow();
    expect(() => parseGpx("not xml <")).toThrow();
  });

  it("keeps short tracks as-is when sampling", () => {
    expect(sampleStops([a, b], 10)).toEqual([a, b]);
  });
});
