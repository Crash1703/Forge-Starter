import { afterEach, describe, expect, it, vi } from "vitest";
import { costing, defaultOptions, planRoute, toResult, UTURN_WARNING, type ValhallaTrip } from "../routes";

/** Encode points as a precision-6 polyline, the format Valhalla returns. */
function encode6(pts: [number, number][]): string {
  let out = "";
  let pLat = 0;
  let pLng = 0;
  const enc = (v: number) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lat, lng] of pts) {
    const a = Math.round(lat * 1e6);
    const b = Math.round(lng * 1e6);
    out += enc(a - pLat) + enc(b - pLng);
    pLat = a;
    pLng = b;
  }
  return out;
}

describe("costing", () => {
  it("maps options to Valhalla motorcycle costing", () => {
    expect(costing(defaultOptions)).toEqual({
      costing: "motorcycle",
      costing_options: { motorcycle: { use_highways: 0, use_tolls: 0.5, use_ferry: 0.5, use_trails: 0 } },
    });
  });

  it("allows motorways only for the fastest style unless avoided", () => {
    const fast = { ...defaultOptions, style: "fastest" as const, vehicle: "car" as const, avoidTolls: true };
    expect(costing(fast)).toEqual({
      costing: "auto",
      costing_options: { auto: { use_highways: 1, use_tolls: 0, use_ferry: 0.5 } },
    });
    expect(costing({ ...fast, avoidHighways: true }).costing_options).toMatchObject({ auto: { use_highways: 0 } });
  });
});

describe("toResult", () => {
  it("joins legs, converts units and collects directions", () => {
    const trip: ValhallaTrip = {
      summary: { length: 12.5, time: 900 },
      legs: [
        {
          shape: encode6([[47.1, 11.1], [47.15, 11.12], [47.2, 11.2]]),
          summary: { length: 5, time: 400 },
          maneuvers: [{ instruction: "Drive north on B171.", length: 5, type: 1 }],
        },
        {
          shape: encode6([[47.2, 11.2], [47.3, 11.3]]),
          summary: { length: 7.5, time: 500 },
          maneuvers: [{ instruction: "You have arrived.", length: 0, type: 4 }],
        },
      ],
    };
    const r = toResult(trip, "Recommended", []);
    expect(r.path).toEqual([
      { lat: 47.1, lng: 11.1 },
      { lat: 47.15, lng: 11.12 },
      { lat: 47.2, lng: 11.2 },
      { lat: 47.3, lng: 11.3 },
    ]);
    expect(r.distance).toBe(12500);
    expect(r.duration).toBe(900);
    expect(r.legs).toEqual([{ distance: 5000, duration: 400 }, { distance: 7500, duration: 500 }]);
    expect(r.steps.map((s) => s.instruction)).toEqual(["Drive north on B171.", "You have arrived."]);
  });
});

describe("planRoute", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("forbids U-turns only at generated loop points", async () => {
    const trip = { summary: { length: 1, time: 60 }, legs: [{ shape: "", summary: { length: 1, time: 60 } }] };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ trip }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const home = { lat: 47.26, lng: 11.4 };
    await planRoute(
      [{ pos: home }, { pos: { lat: 47.3, lng: 11.2 }, noUturn: true }, { pos: { lat: 47.1, lng: 11.3 } }, { pos: home }],
      { ...defaultOptions, returnToStart: true },
    );
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.locations.map((l: { type: string }) => l.type)).toEqual(["break", "break_through", "break", "break"]);
    expect(body.locations[3]).toMatchObject({ lat: home.lat, lon: home.lng });
  });
});

describe("planRoute on a dead end", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("allows turning around when a stop can't be reached otherwise, and warns", async () => {
    const trip = { summary: { length: 1, time: 60 }, legs: [{ shape: "", summary: { length: 1, time: 60 } }] };
    const types: string[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        const t = body.locations.map((l: { type: string }) => l.type);
        types.push(t);
        return t.includes("break_through")
          ? new Response(JSON.stringify({ error_code: 442, error: "No path could be found for input" }), { status: 400 })
          : new Response(JSON.stringify({ trip }), { status: 200 });
      }),
    );
    const home = { lat: 47.26, lng: 11.4 };
    const [r] = await planRoute([{ pos: home }, { pos: { lat: 47.3, lng: 11.2 }, noUturn: true }, { pos: home }], {
      ...defaultOptions,
      returnToStart: true,
    });
    expect(types).toEqual([["break", "break_through", "break"], ["break", "break", "break"]]);
    expect(r.warnings).toEqual([UTURN_WARNING]);
  });

  it("doesn't retry when the server is busy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 429 })));
    await expect(
      planRoute([{ pos: { lat: 1, lng: 1 } }, { pos: { lat: 2, lng: 2 }, noUturn: true }, { pos: { lat: 1, lng: 1 } }], defaultOptions),
    ).rejects.toThrow(/busy/);
  });
});
