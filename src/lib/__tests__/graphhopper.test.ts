import { afterEach, describe, expect, it, vi } from "vitest";
import { VALHALLA_URL } from "../config";
import { edgesFromKnown, edgesFromMatch, ghRouteRequest, ghSnapRequest, roadsOf, styleModel, tripFromPath, type GhPath, type ValhallaRouteBody } from "../graphhopper";
import { decodePolyline, encodePolyline } from "../polyline";
import { routerFetch, setRouteServer } from "../routeServer";

const decode = (s: string) => decodePolyline(s, 6);
const line = (n: number) => Array.from({ length: n }, (_, i) => ({ lat: -26.8 + i * 0.001, lng: 153.1 }));
const body = (types: ("break" | "through" | "break_through")[], extra: Partial<ValhallaRouteBody> = {}): ValhallaRouteBody => ({
  locations: types.map((type, i) => ({ lat: -26.8 + i * 0.01, lon: 153.1, type })),
  costing: "motorcycle",
  costing_options: { motorcycle: { use_highways: 0, use_tolls: 0.5, use_ferry: 0.5, use_trails: 0 } },
  _rf: { style: "twisty", detour: 0.5 },
  ...extra,
});

describe("asking GraphHopper in Valhalla's terms", () => {
  it("turns the ride style and avoid options into a custom model", () => {
    const twisty = styleModel(body(["break", "break"]));
    const rules = twisty.priority.map((r) => ("if" in r ? r.if : r.else_if));
    expect(rules).toContain("curvature >= 0.98");
    expect(rules).toContain("road_class == MOTORWAY || road_class == TRUNK");
    expect(rules.some((r) => r.startsWith("surface =="))).toBe(true); // dirt avoided
    const fastest = styleModel(body(["break", "break"], {
      _rf: { style: "fastest", detour: 0.5 },
      costing_options: { motorcycle: { use_highways: 1, use_tolls: 0, use_ferry: 0.5, use_trails: 0.5 } },
    }));
    expect(fastest.priority.map((r) => ("if" in r ? r.if : ""))).toEqual(["toll == ALL"]);
    // Everything only lowers priorities (the server's landmarks need that).
    expect(twisty.priority.every((r) => Number(r.multiply_by) <= 1)).toBe(true);
  });

  it("stays off roads Valhalla would have excluded", () => {
    const m = styleModel(body(["break", "break"], { exclude_locations: [{ lat: -26.8, lon: 153.1 }] }));
    expect(m.areas?.features).toHaveLength(1);
    expect(m.priority.at(-1)).toEqual({ if: "in_x0", multiply_by: "0" });
  });

  it("never bans turning round (it makes loops circle blocks), and asks for alternatives between two points", () => {
    expect(ghRouteRequest(body(["break", "through", "break_through", "break"])).pass_through).toBe(false);
    const two = ghRouteRequest(body(["break", "break"], { alternates: 2 }));
    expect(two).toMatchObject({ profile: "motorcycle", algorithm: "alternative_route", "alternative_route.max_paths": 3, points_encoded_multiplier: 1e6 });
    expect(two.points[0]).toEqual([153.1, -26.8]);
  });

  it("snaps points only onto roads of the asked class, as Valhalla's search_filter does", () => {
    const p = { lat: -26.8, lon: 153.1 };
    const through = ghSnapRequest(p, "motorcycle", "tertiary");
    expect(through.points).toEqual([[153.1, -26.8], [153.1, -26.8]]);
    const rule = through.custom_model.priority[0];
    for (const c of ["UNCLASSIFIED", "RESIDENTIAL", "SERVICE", "TRACK"]) expect(rule.if).toContain(`road_class == ${c}`);
    expect(rule.multiply_by).toBe("0");
    expect(ghSnapRequest(p, "motorcycle", "unclassified").custom_model.priority[0].if).not.toContain("UNCLASSIFIED");
    // No filter: any road the profile can ride.
    expect(ghSnapRequest(p, "car").custom_model.priority).toEqual([]);
  });

  it("splits the answer into legs at stops, not at shaping points", () => {
    const pts = line(9);
    const path: GhPath = {
      distance: 800,
      time: 80_000,
      points: encodePolyline(pts, 6),
      instructions: [
        { text: "Continue onto A St", distance: 200, time: 20_000, sign: 0, interval: [0, 2], street_name: "A St" },
        { text: "Waypoint 1", distance: 0, time: 0, sign: 5, interval: [2, 2] }, // shaping point
        { text: "Turn left onto B Rd", distance: 200, time: 20_000, sign: -2, interval: [2, 4], street_name: "B Rd" },
        { text: "Waypoint 2", distance: 0, time: 0, sign: 5, interval: [4, 4] }, // a stop
        { text: "At roundabout, take exit 2", distance: 400, time: 40_000, sign: 6, interval: [4, 8], exit_number: 2 },
        { text: "Arrive at destination", distance: 0, time: 0, sign: 4, interval: [8, 8] },
      ],
    };
    const trip = tripFromPath(path, body(["break", "through", "break_through", "break"]), decode);
    expect(trip.legs).toHaveLength(2);
    expect(trip.summary).toEqual({ length: 0.8, time: 80 });
    expect(decode(trip.legs[0].shape)).toHaveLength(5);
    expect(trip.legs[0].maneuvers.map((m) => m.type)).toEqual([1, 15, 4]); // start, left, arrive at the stop
    expect(trip.legs[1].maneuvers.map((m) => m.type)).toEqual([26, 4]);
    expect(trip.legs[1].maneuvers[0]).toMatchObject({ begin_shape_index: 0, roundabout_exit_count: 2 });
    expect(trip.legs[0].maneuvers[1]).toMatchObject({ street_names: ["B Rd"], begin_shape_index: 2, length: 0.2 });
  });

  it("describes the roads under a path as Valhalla's edges", () => {
    const pts = line(5);
    const shape = pts.map((p) => ({ lat: p.lat, lon: p.lng }));
    const edges = edgesFromMatch(
      {
        paths: [{
          points: encodePolyline(pts, 6),
          details: {
            road_class: [[0, 2, "SECONDARY"], [2, 4, "TERTIARY"]],
            surface: [[0, 2, "ASPHALT"], [2, 4, "GRAVEL"]],
            urban_density: [[0, 4, "RURAL"]],
            max_speed: [[0, 2, 100], [2, 4, null]],
          },
        }],
      },
      shape,
      decode,
    );
    expect(edges.map((e) => [e.road_class, e.unpaved, e.speed_limit, e.begin_shape_index, e.end_shape_index])).toEqual([
      ["secondary", false, 100, 0, 2],
      ["tertiary", true, 0, 2, 4],
    ]);
    expect(edges[0].length).toBeCloseTo(0.221, 2);
  });
});

describe("remembering the roads under planned paths", () => {
  it("answers road questions about a planned path without asking the server again", () => {
    const pts = line(5);
    const path: GhPath = {
      distance: 440, time: 30_000, points: encodePolyline(pts, 6), instructions: [],
      details: { road_class: [[0, 4, "SECONDARY"]], surface: [[0, 3, "ASPHALT"], [3, 4, "DIRT"]], urban_density: [[0, 4, "CITY"]], max_speed: [[0, 4, 60]] },
    };
    const known = new Map(roadsOf(path, decode));
    // The app thins long paths before asking: every other point here.
    const shape = [pts[0], pts[2], pts[3], pts[4]].map((p) => ({ lat: p.lat, lon: p.lng }));
    const edges = edgesFromKnown(shape, (k) => known.get(k))!;
    expect(edges.map((e) => [e.surface, e.unpaved, e.density, e.speed_limit, e.begin_shape_index, e.end_shape_index])).toEqual([
      ["asphalt", false, 10, 60, 0, 2],
      ["dirt", true, 10, 60, 2, 3],
    ]);
    // A path it never planned (a recorded ride, say): not known.
    expect(edgesFromKnown([{ lat: 1, lon: 2 }, { lat: 1.001, lon: 2 }], (k) => known.get(k))).toBeNull();
  });
});

describe("the rider's GraphHopper server", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setRouteServer("");
  });

  it("is recognised and asked in its own terms, and the public server never sees the app's hints", async () => {
    setRouteServer("https://gh.example.com");
    const pts = line(3);
    const sent: { url: string; body?: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({ url, body: init?.body as string | undefined });
      if (url.endsWith("/info")) return new Response(JSON.stringify({ profiles: [{ name: "motorcycle" }], version: "11.0" }));
      return new Response(JSON.stringify({
        paths: [{ distance: 220, time: 20_000, points: encodePolyline(pts, 6), instructions: [
          { text: "Continue", distance: 220, time: 20_000, sign: 0, interval: [0, 2] },
          { text: "Arrive", distance: 0, time: 0, sign: 4, interval: [2, 2] },
        ] }],
      }));
    }));
    const res = await routerFetch("/route", body(["break", "break"]));
    const json = await res.json();
    expect(sent.map((s) => s.url)).toEqual(["https://gh.example.com/info", "https://gh.example.com/route"]);
    expect(JSON.parse(sent[1].body!).custom_model.priority.length).toBeGreaterThan(0);
    expect(json.trip.legs[0].maneuvers.map((m: { type: number }) => m.type)).toEqual([1, 4]);

    setRouteServer("");
    await routerFetch("/route", body(["break", "break"]));
    expect(sent.at(-1)!.url).toBe(`${VALHALLA_URL}/route`);
    expect(JSON.parse(sent.at(-1)!.body!)._rf).toBeUndefined();
  });
});
