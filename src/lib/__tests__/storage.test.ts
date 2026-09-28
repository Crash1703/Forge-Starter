import { describe, expect, it } from "vitest";
import { decodeShare, encodeShare, normalizeLoop } from "../storage";
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

describe("loops", () => {
  const home = { id: "h", label: "Home", position: { lat: 47.26921, lng: 11.4041 } };
  const a = { id: "a", label: "Seefeld", position: { lat: 47.33, lng: 11.19 } };
  const b = { id: "b", label: "Telfs", position: { lat: 47.3, lng: 11.07 } };

  it("keeps the return-to-start flag in share links", () => {
    const opts = { ...defaultOptions, returnToStart: true };
    const back = decodeShare(encodeShare([home, a, b], opts))!;
    expect(back.options.returnToStart).toBe(true);
    expect(back.stops.map((s) => s.label)).toEqual(["Home", "Seefeld", "Telfs"]);
  });

  it("reads old links without the flag as one-way routes", () => {
    const back = decodeShare("#r=scenic.motorcycle.000~47.1,11.1,A~47.2,11.2,B")!;
    expect(back.options.returnToStart).toBe(false);
  });

  it("turns an old copied finish into the return-to-start option", () => {
    const copy = { ...home, id: "h2", position: { lat: 47.2693, lng: 11.4042 } }; // ~15 m away
    const plan = normalizeLoop([home, a, b, copy], defaultOptions);
    expect(plan.stops.map((s) => s.id)).toEqual(["h", "a", "b"]);
    expect(plan.options.returnToStart).toBe(true);
  });

  it("leaves a one-way route alone", () => {
    const plan = normalizeLoop([home, a, b], defaultOptions);
    expect(plan.stops).toHaveLength(3);
    expect(plan.options.returnToStart).toBe(false);
  });
});

describe("section styles in share links", () => {
  it("round-trips a section's own style and leaves others alone", () => {
    const stops = [
      { id: "1", label: "Home", position: { lat: -26.65, lng: 153.05 }, legStyle: "fastest" as const },
      { id: "2", label: "Maleny", position: { lat: -26.76, lng: 152.85 }, legStyle: "twisty" as const },
      { id: "3", label: "Kenilworth", position: { lat: -26.6, lng: 152.73 } },
    ];
    const back = decodeShare(encodeShare(stops, defaultOptions))!;
    expect(back.stops.map((s) => s.legStyle)).toEqual(["fastest", "twisty", undefined]);
  });
});
