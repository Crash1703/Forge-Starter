import { afterEach, describe, expect, it, vi } from "vitest";
import { destination, distance } from "../geo";
import { costing, defaultOptions, planRoute, planSections, routeVia, snapToRoad, spurWarning, toResult, UTURN_WARNING, type ValhallaTrip } from "../routes";

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

describe("twisty helper points", () => {
  afterEach(() => vi.unstubAllGlobals());

  const start = { lat: 47.0, lng: 11.0 };
  const end = destination(start, 90, 20000);
  const tripAlong = (pts: { lat: number; lng: number }[], km: number) => ({
    summary: { length: km, time: km * 60 },
    legs: [{ shape: encode6(pts.map((p) => [p.lat, p.lng])), summary: { length: km, time: km * 60 } }],
  });

  it("drops a detour that rides up a dead end to reach its helper point", async () => {
    const straight = tripAlong([start, end], 20);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        const via = body.locations.find((l: { type: string }) => l.type === "through");
        if (!via) return new Response(JSON.stringify({ trip: straight }), { status: 200 });
        // Pretend the helper point sits at the top of a 400 m dead end off the main road.
        const tip = { lat: via.lat, lng: via.lon };
        const foot = destination(tip, 180, 400);
        const spurTrip = tripAlong([start, foot, tip, foot, end], 21);
        const cleanTrip = tripAlong([start, tip, end], 22);
        // North-side helpers get the spur, south-side ones a clean route.
        return new Response(JSON.stringify({ trip: via.lat > start.lat ? spurTrip : cleanTrip }), { status: 200 });
      }),
    );
    const routes = await planRoute([{ pos: start }, { pos: end }], { ...defaultOptions, style: "twisty" });
    const detourSides = routes.filter((r) => r.detours.length).map((r) => Math.sign(r.detours[0].lat - start.lat));
    expect(detourSides.length).toBeGreaterThan(0);
    expect(detourSides.every((s) => s < 0)).toBe(true);
  });

  it("asks for two detours at a time", async () => {
    let open = 0;
    let most = 0;
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        open++;
        most = Math.max(most, open);
        await new Promise((r) => setTimeout(r, 5));
        open--;
        return new Response(JSON.stringify({ trip: tripAlong([start, end], 20 + calls) }), { status: 200 });
      }),
    );
    await planRoute([{ pos: start }, { pos: end }], { ...defaultOptions, style: "twisty" });
    expect(calls).toBe(5);
    expect(most).toBe(2);
  });

  it("names a stop the route has to ride up and back to reach", async () => {
    const tip = destination(start, 90, 8000);
    const foot = destination(tip, 180, 500);
    const trip = tripAlong([start, foot, tip, foot, end], 21);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ trip }), { status: 200 })));
    const [r] = await planRoute([{ pos: start }, { pos: tip }, { pos: end }], defaultOptions);
    expect(r.warnings).toEqual([spurWarning(1)]);
  });

  it("snaps generated points to proper roads and says where to move one stuck up a dead end", async () => {
    const tip = destination(start, 90, 8000);
    const foot = destination(tip, 180, 500);
    const trip = tripAlong([start, foot, tip, foot, end], 21);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ trip }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const [r] = await planRoute([{ pos: start }, { pos: tip, movable: true }, { pos: end }], defaultOptions);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.locations[1].search_filter).toEqual({ min_road_class: "unclassified" });
    expect(body.locations[0].search_filter).toBeUndefined();
    expect(r.moves).toHaveLength(1);
    expect(r.moves![0].stop).toBe(1);
    expect(distance(r.moves![0].to, foot)).toBeLessThan(40);
  });

  it("snaps points that only steer the route to through roads, not tracks", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ trip: tripAlong([start, end], 20) }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await planRoute([{ pos: start }, { pos: destination(start, 90, 8000), via: true, radius: 2000, movable: true }, { pos: end }], defaultOptions);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.locations[1].type).toBe("through");
    expect(body.locations[1].search_filter).toEqual({ min_road_class: "tertiary" });
  });

  it("moves a generated point whose dead end stops short of it", async () => {
    // The pin is in a river 800 m past the end of the road the router picked.
    const tip = destination(start, 90, 8000);
    const foot = destination(tip, 180, 2500);
    const pin = destination(tip, 45, 800);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ trip: tripAlong([start, foot, tip, foot, end], 25) }), { status: 200 })));
    const [r] = await planRoute([{ pos: start }, { pos: pin, movable: true }, { pos: end }], defaultOptions);
    expect(r.moves).toHaveLength(1);
    expect(distance(r.moves![0].to, foot)).toBeLessThan(60);
  });

  it("doesn't move the rider's own pins", async () => {
    const tip = destination(start, 90, 8000);
    const foot = destination(tip, 180, 500);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ trip: tripAlong([start, foot, tip, foot, end], 21) }), { status: 200 })));
    const [r] = await planRoute([{ pos: start }, { pos: tip }, { pos: end }], defaultOptions);
    expect(r.moves).toBeUndefined();
  });
});

describe("snapping and U-turn trade-offs", () => {
  afterEach(() => vi.unstubAllGlobals());

  const start = { lat: 47.0, lng: 11.0 };
  const pin = destination(start, 90, 8000);
  const end = destination(start, 90, 20000);
  const tripAlong = (pts: { lat: number; lng: number }[], km: number) => ({
    summary: { length: km, time: km * 60 },
    legs: [{ shape: encode6(pts.map((p) => [p.lat, p.lng])), summary: { length: km, time: km * 60 } }],
  });

  it("sends each point's search radius to the router", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ trip: tripAlong([start, end], 20) }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await planRoute([{ pos: start }, { pos: pin, radius: 75 }, { pos: end }], { ...defaultOptions, style: "twisty" });
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string));
    expect(bodies[0].locations.map((l: { radius?: number }) => l.radius)).toEqual([undefined, 75, undefined]);
    const helper = bodies.find((b) => b.locations.some((l: { type: string }) => l.type === "through"));
    expect(helper.locations.find((l: { type: string }) => l.type === "through").radius).toBe(1500);
  });

  it("allows a U-turn at a pin when banning it makes the route ride on and back", async () => {
    // No U-turn at the pin: the route rides 1 km past it and comes back.
    const beyond = destination(pin, 90, 1000);
    const lollipop = tripAlong([start, pin, beyond, pin, destination(pin, 180, 3000), end], 26);
    // U-turn allowed: it turns at the pin, riding only a few metres twice.
    const clean = tripAlong([start, pin, destination(pin, 180, 3000), end], 24);
    const types: string[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const t = JSON.parse(init.body as string).locations.map((l: { type: string }) => l.type);
        types.push(t);
        return new Response(JSON.stringify({ trip: t[1] === "break_through" ? lollipop : clean }), { status: 200 });
      }),
    );
    const [r] = await planRoute([{ pos: start }, { pos: pin, noUturn: true }, { pos: start }], {
      ...defaultOptions,
      returnToStart: true,
    });
    expect(types.slice(0, 2)).toEqual([["break", "break_through", "break"], ["break", "break", "break"]]);
    expect(r.distance).toBe(24000);
  });
});

describe("loops come home a different way", () => {
  afterEach(() => vi.unstubAllGlobals());

  const home = { lat: -26.8, lng: 153.1 };
  const town = destination(home, 270, 30000);
  const northArc = [town, destination(destination(home, 270, 15000), 0, 8000), home];
  const leg = (pts: { lat: number; lng: number }[], km: number) => ({
    shape: encode6(pts.map((p) => [p.lat, p.lng])),
    summary: { length: km, time: km * 60 },
    maneuvers: [],
  });

  function stubRouter(legRequest: "ok" | "fail") {
    const bodies: { locations: { type: string }[]; exclude_locations?: { lat: number; lon: number }[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        bodies.push(body);
        if (body.locations.length === 3) {
          // Whole loop: the router rides out and straight back the same road.
          const legs = [leg([home, town], 30), leg([town, home], 30)];
          return new Response(JSON.stringify({ trip: { summary: { length: 60, time: 3600 }, legs } }), { status: 200 });
        }
        if (legRequest === "fail") {
          return new Response(JSON.stringify({ error: "No path could be found for input" }), { status: 400 });
        }
        return new Response(JSON.stringify({ trip: { summary: { length: 36, time: 2400 }, legs: [leg(northArc, 36)] } }), {
          status: 200,
        });
      }),
    );
    return bodies;
  }

  const loopPoints = [{ pos: home }, { pos: town, noUturn: true }, { pos: home }];

  it("re-plans the way home to stay off the roads ridden on the way out", async () => {
    const bodies = stubRouter("ok");
    const [r] = await planRoute(loopPoints, { ...defaultOptions, returnToStart: true });
    const legBody = bodies.find((b) => b.exclude_locations)!;
    expect(legBody.locations.map((l) => l.type)).toEqual(["break", "break"]);
    expect(legBody.exclude_locations!.length).toBeLessThanOrEqual(50);
    expect(r.distance).toBe(66000);
    expect(r.legs).toEqual([{ distance: 30000, duration: 1800 }, { distance: 36000, duration: 2160 }]);
  });

  it("keeps the original way home when there's no other road", async () => {
    stubRouter("fail");
    const [r] = await planRoute(loopPoints, { ...defaultOptions, returnToStart: true });
    expect(r.distance).toBe(60000);
  });

  it("leaves one-way routes alone", async () => {
    const bodies = stubRouter("ok");
    await planRoute(loopPoints, { ...defaultOptions, returnToStart: false });
    expect(bodies.some((b) => b.exclude_locations)).toBe(false);
  });
});

describe("ride helpers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps speed limits back onto every point of a thinned route", async () => {
    const path = Array.from({ length: 3001 }, (_, i) => ({ lat: -26.6, lng: 152.9 + i * 0.0001 }));
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.shape.length).toBeLessThanOrEqual(1501);
      const half = Math.floor(body.shape.length / 2);
      const edges = [
        { speed_limit: 60, begin_shape_index: 0, end_shape_index: half },
        { speed_limit: 0, begin_shape_index: half, end_shape_index: body.shape.length - 1 },
      ];
      return new Response(JSON.stringify({ edges }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { speedLimits } = await import("../routes");
    const limits = await speedLimits(path, defaultOptions);
    expect(limits.length).toBe(3001);
    expect(limits[0]).toBe(60);
    expect(limits[1400]).toBe(60);
    expect(limits[3000]).toBeNull();
  });

  it("asks for a way back that starts in the rider's direction", async () => {
    const trip = { summary: { length: 1, time: 60 }, legs: [{ shape: "", summary: { length: 1, time: 60 } }] };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ trip }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { routeBack } = await import("../routes");
    await routeBack({ lat: -26.6, lng: 152.9 }, 271.6, { lat: -26.61, lng: 152.91 }, { ...defaultOptions, returnToStart: true });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.locations[0]).toMatchObject({ heading: 272, heading_tolerance: 60 });
    expect(body.locations[1].heading).toBeUndefined();
  });
});

describe("per-section ride styles", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("plans each section with its own style and joins them into one route", async () => {
    const a = { lat: -26.6, lng: 152.9 };
    const b = destination(a, 90, 20000);
    const c = destination(b, 180, 20000);
    const bodies: { locations: { lat: number; lon: number }[]; costing_options: { motorcycle: { use_highways: number } } }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        bodies.push(body);
        const [from, to] = [body.locations[0], body.locations[body.locations.length - 1]];
        const trip = {
          summary: { length: 20, time: 1200 },
          legs: [
            {
              shape: encode6([[from.lat, from.lon], [to.lat, to.lon]]),
              summary: { length: 20, time: 1200 },
              maneuvers: [
                { type: 1, instruction: "Head off.", length: 20, begin_shape_index: 0 },
                { type: 4, instruction: "Arrive.", length: 0, begin_shape_index: 1 },
              ],
            },
          ],
        };
        return new Response(JSON.stringify({ trip }), { status: 200 });
      }),
    );
    const [r] = await planSections([{ pos: a }, { pos: b }, { pos: c }], ["fastest", "scenic"], defaultOptions);
    const sectionRequests = bodies.filter((x) => x.locations.length === 2);
    expect(sectionRequests[0].costing_options.motorcycle.use_highways).toBe(1);
    expect(sectionRequests[sectionRequests.length - 1].costing_options.motorcycle.use_highways).toBe(0);
    expect(r.path).toHaveLength(3);
    expect(r.distance).toBe(40000);
    expect(r.steps.map((s) => [s.instruction, s.at])).toEqual([
      ["Head off.", 0],
      ["Stop 1", 1],
      ["Arrive.", 2],
    ]);
    expect(r.legs).toHaveLength(2);
  });
});

describe("loops don't cross themselves", () => {
  afterEach(() => vi.unstubAllGlobals());
  const A = { lat: -26.8, lng: 153.0 };
  const at = (e: number, n: number) => destination(destination(A, 90, e * 1000), 0, n * 1000);
  const P1 = at(10, 0);
  const P2 = at(10, 10);
  const leg = (pts: { lat: number; lng: number }[], km: number) => ({
    shape: encode6(pts.map((p) => [p.lat, p.lng])),
    summary: { length: km, time: km * 60 },
  });
  const out = leg([A, P1], 10);
  const across = leg([P2, at(5, -3), A], 24); // home across the way out
  const around = leg([P2, at(0, 10), A], 20); // home round the other side
  const trip = (legs: ReturnType<typeof leg>[]) => ({
    summary: { length: legs.reduce((a, l) => a + l.summary.length, 0), time: legs.reduce((a, l) => a + l.summary.time, 0) },
    legs,
  });

  it("re-plans a leg home that crosses the way out", async () => {
    const bodies: { locations: { lat: number }[]; alternates?: number }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        bodies.push(body);
        if (body.locations.length === 4) return new Response(JSON.stringify({ trip: trip([out, leg([P1, P2], 10), across]) }));
        // The way home: the router's first choice crosses; its alternative doesn't.
        if (Math.abs(body.locations[0].lat - P2.lat) < 1e-6) {
          return new Response(JSON.stringify({ trip: trip([across]), alternates: body.alternates ? [{ trip: trip([around]) }] : [] }));
        }
        // The way out has no other road.
        return new Response(JSON.stringify({ trip: trip([out]) }));
      }),
    );
    const [r] = await planRoute([{ pos: A }, { pos: P1 }, { pos: P2 }, { pos: A }], { ...defaultOptions, returnToStart: true });
    expect(r.distance).toBe(40000);
    expect(bodies.some((b) => b.locations.length === 2 && b.alternates === 2)).toBe(true);
  });

  it("keeps a crossing when every other way is much slower", async () => {
    const slow = leg([P2, at(0, 10), A], 60);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        if (body.locations.length === 4) return new Response(JSON.stringify({ trip: trip([out, leg([P1, P2], 10), across]) }));
        if (Math.abs(body.locations[0].lat - P2.lat) < 1e-6) {
          return new Response(JSON.stringify({ trip: trip([across]), alternates: body.alternates ? [{ trip: trip([slow]) }] : [] }));
        }
        return new Response(JSON.stringify({ trip: trip([out]) }));
      }),
    );
    const [r] = await planRoute([{ pos: A }, { pos: P1 }, { pos: P2 }, { pos: A }], { ...defaultOptions, returnToStart: true });
    expect(r.distance).toBe(44000);
  });
});

describe("twisty loops stay loops", () => {
  afterEach(() => vi.unstubAllGlobals());
  const home = { lat: -26.8, lng: 153.13 };
  const place = destination(home, 250, 27000);
  const out = destination(destination(home, 250, 13500), 340, 4000);
  const back = destination(destination(home, 250, 13500), 160, 4000);
  const straight = (locs: { lat: number; lon: number; type?: string }[]) => {
    const pts = locs.map((l) => [l.lat, l.lon] as [number, number]);
    const legs: { shape: string; summary: { length: number; time: number } }[] = [];
    let cur = [pts[0]];
    locs.slice(1).forEach((l, i) => {
      cur.push(pts[i + 1]);
      if (l.type !== "through") {
        legs.push({ shape: encode6(cur), summary: { length: 20, time: 1200 } });
        cur = [pts[i + 1]];
      }
    });
    return { summary: { length: 20 * legs.length, time: 1200 * legs.length }, legs };
  };

  it("only tries detours on the outside of the loop", async () => {
    const helpers: { lat: number; lng: number }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        for (const l of body.locations) if (l.radius === 1500) helpers.push({ lat: l.lat, lng: l.lon });
        return new Response(JSON.stringify({ trip: straight(body.locations) }));
      }),
    );
    const pts = [{ pos: home }, { pos: out, via: true }, { pos: place }, { pos: back, via: true }, { pos: home }];
    await planRoute(pts, { ...defaultOptions, style: "twisty", returnToStart: true });
    const middle = { lat: (home.lat * 2 + out.lat + place.lat + back.lat) / 5, lng: (home.lng * 2 + out.lng + place.lng + back.lng) / 5 };
    expect(helpers.length).toBeGreaterThan(0);
    expect(helpers.length).toBeLessThan(4);
    // Every detour lies further from the loop's middle than the way it bends.
    for (const h of helpers) expect(distance(h, middle)).toBeGreaterThan(5000);
  });

  it("with a style per stop, keeps each section off the ones before it", async () => {
    const A = { lat: -26.8, lng: 153.0 };
    const at = (e: number, n: number) => destination(destination(A, 90, e * 1000), 0, n * 1000);
    const P = at(10, 10);
    const outLeg = { shape: encode6([A, at(10, 0), P].map((p) => [p.lat, p.lng])), summary: { length: 20, time: 1200 } };
    const across = { shape: encode6([P, at(5, -3), A].map((p) => [p.lat, p.lng])), summary: { length: 22, time: 1300 } };
    const around = { shape: encode6([P, at(0, 10), A].map((p) => [p.lat, p.lng])), summary: { length: 21, time: 1260 } };
    const trip = (l: typeof outLeg) => ({ summary: l.summary, legs: [l] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        const homeward = Math.abs(body.locations[0].lat - P.lat) < 1e-6;
        if (!homeward) return new Response(JSON.stringify({ trip: trip(outLeg) }));
        // The twistiest way home crosses the way out; another doesn't.
        return new Response(JSON.stringify({ trip: trip(across), alternates: body.alternates ? [{ trip: trip(around) }] : [] }));
      }),
    );
    const [r] = await planSections([{ pos: A }, { pos: P }, { pos: A }], ["scenic", "twisty"], { ...defaultOptions, returnToStart: true });
    expect(r.distance).toBe(41000);
  });
});

describe("adding a stop while riding", () => {
  afterEach(() => vi.unstubAllGlobals());
  const from = { lat: -26.7, lng: 152.9 };
  const stop = { name: "Shell Beerwah", position: destination(from, 90, 3000) };
  const rejoin = destination(from, 90, 8000);
  const legTo = (a: { lat: number; lng: number }, b: { lat: number; lng: number }, last: boolean) => ({
    shape: encode6([[a.lat, a.lng], [b.lat, b.lng]]),
    summary: { length: 3, time: 180 },
    maneuvers: [
      { type: 1, instruction: "Head east.", length: 3, begin_shape_index: 0 },
      { type: last ? 4 : 5, instruction: "You have arrived.", length: 0, begin_shape_index: 1 },
    ],
  });

  it("goes via the stop and back to the route, naming the stop", async () => {
    const bodies: { locations: { heading?: number; radius?: number }[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        return new Response(JSON.stringify({ trip: { summary: { length: 8, time: 480 }, legs: [legTo(from, stop.position, false), legTo(stop.position, rejoin, true)] } }));
      }),
    );
    const r = await routeVia(from, 90, stop, rejoin, defaultOptions);
    expect(bodies[0].locations).toHaveLength(3);
    expect(bodies[0].locations[0].heading).toBe(90);
    expect(bodies[0].locations[1].radius).toBe(50);
    const named = r.steps.find((s) => s.instruction === "Shell Beerwah");
    expect(named?.verbal).toBe("You've reached Shell Beerwah.");
  });

  it("can finish at the stop instead", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ trip: { summary: { length: 3, time: 180 }, legs: [legTo(from, stop.position, true)] } })));
    vi.stubGlobal("fetch", fetchMock);
    const r = await routeVia(from, null, stop, null, defaultOptions);
    const body = JSON.parse(((fetchMock.mock.calls[0] as unknown) as [string, RequestInit])[1].body as string);
    expect(body.locations).toHaveLength(2);
    expect(r.distance).toBe(3000);
  });
});

describe("snapping a pin to the road", () => {
  afterEach(() => vi.unstubAllGlobals());
  const paddock = { lat: -26.86, lng: 152.97 };
  const locate = (pts: { lat: number; lng: number }[]) =>
    new Response(JSON.stringify([{ input_lat: paddock.lat, input_lon: paddock.lng, edges: pts.map((q) => ({ correlated_lat: q.lat, correlated_lon: q.lng })), nodes: [] }]));

  it("moves the pin to the nearest road the router knows", async () => {
    const road = { lat: -26.85929, lng: 152.969123 };
    const fetchMock = vi.fn(async () => locate([destination(paddock, 0, 600), road]));
    vi.stubGlobal("fetch", fetchMock);
    expect(await snapToRoad(paddock, defaultOptions)).toEqual(road);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/locate$/);
    expect(JSON.parse(init.body as string)).toMatchObject({ costing: "motorcycle", locations: [{ lat: paddock.lat, lon: paddock.lng }] });
  });

  it("leaves the pin where it is when the nearest road is far away, or the router doesn't answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => locate([destination(paddock, 90, 3000)])));
    expect(await snapToRoad(paddock, defaultOptions)).toEqual(paddock);
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    expect(await snapToRoad(paddock, defaultOptions)).toEqual(paddock);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
    expect(await snapToRoad(paddock, defaultOptions)).toEqual(paddock);
  });
});
