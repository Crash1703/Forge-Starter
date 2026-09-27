import { describe, expect, it } from "vitest";
import { decodeShare, encodeShare } from "../storage";
import { defaultOptions } from "../routes";

describe("share links", () => {
  it("round-trips stops and options", () => {
    const stops = [
      { id: "1", label: "Innsbruck, Tirol", position: { lat: 47.26921, lng: 11.40410 } },
      { id: "2", label: "Stelvio~Pass", position: { lat: 46.52853, lng: 10.45297 } },
    ];
    const opts = { ...defaultOptions, style: "twisty" as const, avoidTolls: true };
    const back = decodeShare(encodeShare(stops, opts))!;
    expect(back.options).toEqual(opts);
    expect(back.stops.map((s) => [s.label, s.position])).toEqual(stops.map((s) => [s.label, s.position]));
  });

  it("ignores unrelated hashes", () => {
    expect(decodeShare("#foo")).toBeNull();
    expect(decodeShare("#r=scenic.car.000~1,2,a")).toBeNull();
  });
});
