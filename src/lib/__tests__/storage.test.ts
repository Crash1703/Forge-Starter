import { describe, expect, it } from "vitest";
import { decodeShare, encodeShare, normalizeLoop, reverseStops, routePoints } from "../storage";
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

describe("shaping points", () => {
  const p = (lat: number, lng: number) => ({ lat, lng });
  const home = { id: "h", label: "Home", position: p(47, 11), shape: [p(47.1, 11)] };
  const a = { id: "a", label: "A", position: p(47.2, 11.1), shape: [p(47.2, 11.2)], legStyle: "twisty" as const };
  const b = { id: "b", label: "B", position: p(47.1, 11.3), shape: [p(47.05, 11.2)] };

  it("lists every point to route through, shaping points after their stop", () => {
    const loop = routePoints([home, a, b], true);
    expect(loop.map((x) => `${x.stop.id}${x.shape}`)).toEqual(["h-1", "h0", "a-1", "a0", "b-1", "b0", "h-1"]);
    // One-way: the last stop's shaping points would lead nowhere.
    expect(routePoints([home, a, b], false).map((x) => `${x.stop.id}${x.shape}`)).toEqual(["h-1", "h0", "a-1", "a0", "b-1"]);
  });

  it("reverses a loop with each leg's shaping points and style", () => {
    const r = reverseStops([home, a, b], true);
    expect(r.map((s) => s.id)).toEqual(["h", "b", "a"]);
    // Home -> B was B -> home, shaped by B's points.
    expect(r[0].shape).toEqual(b.shape);
    // A -> home was home -> A.
    expect(r[2].shape).toEqual(home.shape);
    // B -> A was A -> B, ridden twisty.
    expect(r[1]).toMatchObject({ shape: a.shape, legStyle: "twisty" });
    const flat = routePoints(r, true).map((x) => x.position);
    expect(flat).toEqual(routePoints([home, a, b], true).map((x) => x.position).reverse());
  });

  it("keeps shaping points in share links", () => {
    const back = decodeShare(encodeShare([home, a, b], { ...defaultOptions, returnToStart: true }))!;
    expect(back.stops.map((s) => s.shape)).toEqual([home.shape, a.shape, b.shape]);
    expect(back.stops[1].legStyle).toBe("twisty");
  });
});
