import { describe, expect, it } from "vitest";
import { decodePolyline } from "../polyline";

describe("decodePolyline", () => {
  it("decodes Google's documented example", () => {
    const pts = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(pts).toEqual([
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ]);
  });

  it("decodes precision 6 (Valhalla)", () => {
    // Same geometry as above, scaled to six decimal places.
    expect(decodePolyline("_izlhA~rlgdF_{geC~ywl@_kwzCn`{nI", 6)).toEqual([
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ]);
  });

  it("returns nothing for an empty string", () => {
    expect(decodePolyline("")).toEqual([]);
  });
});
