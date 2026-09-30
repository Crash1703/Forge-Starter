import { afterEach, describe, expect, it, vi } from "vitest";
import { destination, type LatLng } from "../geo";
import { rainAhead, weatherAlong, weatherIcon, weatherPlaces } from "../weather";
import { fuelGaps, placeAlong, poiQuery, poisIn, poisInQuery, POI_KINDS, type Poi } from "../pois";

const start = { lat: -26.7, lng: 152.9 };
const road = (km: number): LatLng[] => Array.from({ length: km + 1 }, (_, i) => destination(start, 90, i * 1000));

describe("weather along the route", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("checks the start, the finish and about every 25 km, at most 12 places", () => {
    expect(weatherPlaces(road(100)).length).toBe(5);
    const long = weatherPlaces(road(600));
    expect(long.length).toBeLessThanOrEqual(12);
    expect(long[long.length - 1].at).toBeGreaterThan(599000);
  });

  it("reads each place's forecast for the hour you'll get there", async () => {
    const departure = Date.UTC(2026, 8, 28, 0, 0);
    const hours = Array.from({ length: 48 }, (_, h) => departure / 1000 + h * 3600);
    const hourly = (rainFrom: number) => ({
      time: hours,
      temperature_2m: hours.map((_, h) => 15 + h),
      precipitation_probability: hours.map((_, h) => (h >= rainFrom ? 80 : 10)),
      precipitation: hours.map((_, h) => (h >= rainFrom ? 1.2 : 0)),
      wind_speed_10m: hours.map(() => 12),
      weather_code: hours.map((_, h) => (h >= rainFrom ? 61 : 1)),
    });
    let url = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        url = u;
        const n = new URL(u).searchParams.get("latitude")!.split(",").length;
        return new Response(JSON.stringify(Array.from({ length: n }, () => ({ hourly: hourly(2) }))), { status: 200 });
      }),
    );
    // 100 km in 3 hours: the finish is reached at 03:00, when it's raining.
    const pts = await weatherAlong(road(100), 3 * 3600, departure, undefined);
    expect(url).toContain("timeformat=unixtime");
    expect(pts[0].temp).toBe(15);
    expect(pts[0].rainChance).toBe(10);
    expect(pts[pts.length - 1].temp).toBe(18);
    const rain = rainAhead(pts)!;
    expect(rain.eta).toBeGreaterThanOrEqual(departure + 2 * 3600 * 1000 - 30 * 60 * 1000);
    expect(weatherIcon(rain.code)).toBe("🌧️");
  });
});

describe("fuel and cafés", () => {
  const line = road(300);
  const el = (id: number, km: number, tags: Record<string, string>, offset = 150) => {
    const p = destination(line[km], 0, offset);
    return { type: "node", id, lat: p.lat, lon: p.lng, tags };
  };

  it("places stops along the route in riding order, with sensible names", () => {
    const cafes = placeAlong([el(3, 60, { shop: "bakery" }), el(2, 30, { amenity: "cafe", name: "Maple 3 Café" })], line, "cafe");
    expect(cafes.map((p) => [p.kind, p.name, Math.round(p.at / 1000)])).toEqual([
      ["cafe", "Maple 3 Café", 30],
      ["cafe", "Bakery", 60],
    ]);
    const fuel = placeAlong([el(1, 120, { amenity: "fuel", brand: "Ampol" }), el(1, 120, { amenity: "fuel" }), el(4, 10, { amenity: "fuel" })], line, "fuel");
    expect(fuel.map((p) => p.name)).toEqual(["Fuel", "Ampol"]);
    expect(placeAlong([el(5, 5, { amenity: "pub" })], line, "pub")[0].name).toBe("Pub");
  });

  it("asks for one kind at a time, the planner's short distance from the road", () => {
    const q = poiQuery("pub", line.slice(0, 3));
    expect(q).toContain('nwr["amenity"~"^(pub|bar|biergarten)$"](around:200,');
    expect(q).not.toContain("fuel");
    expect(poiQuery("toilets", line.slice(0, 3))).toContain('nwr["amenity"="toilets"](around:300,');
    expect(POI_KINDS.map((k) => k.name)).toEqual(["Fuel", "Cafés", "Food", "Pubs", "Toilets", "Lookouts"]);
  });

  it("finds stretches longer than your tank range with no fuel", () => {
    const fuel = (km: number): Poi => ({ id: String(km), kind: "fuel", name: "", position: start, at: km * 1000 });
    expect(fuelGaps([fuel(120)], 300000, 200000)).toEqual([]);
    expect(fuelGaps([fuel(50)], 300000, 200000)).toEqual([{ from: 50000, to: 300000 }]);
    expect(fuelGaps([], 150000, 200000)).toEqual([]);
  });
});

describe("fuel and toilets in view", () => {
  afterEach(() => vi.unstubAllGlobals());
  const box = { south: -26.9, west: 153.0, north: -26.7, east: 153.2 };

  it("asks for each kind inside the box", () => {
    const q = poisInQuery(["fuel", "toilets"], box);
    expect(q).toContain('nwr["amenity"="fuel"](-26.9000,153.0000,-26.7000,153.2000);');
    expect(q).toContain('nwr["amenity"="toilets"](-26.9000,153.0000,-26.7000,153.2000);');
  });

  it("tells fuel from toilets, names them, and marks them as not along a route", async () => {
    const elements = [
      { type: "node", id: 1, lat: -26.8, lon: 153.1, tags: { amenity: "fuel", brand: "Shell" } },
      { type: "way", id: 2, center: { lat: -26.81, lon: 153.11 }, tags: { amenity: "toilets" } },
      { type: "node", id: 1, lat: -26.8, lon: 153.1, tags: { amenity: "fuel" } },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ elements }))));
    const found = await poisIn(["fuel", "toilets"], box);
    expect(found.map((p) => [p.kind, p.name, p.at])).toEqual([
      ["fuel", "Shell", -1],
      ["toilets", "Toilets", -1],
    ]);
  });
});

describe("weather on a short ride", () => {
  it("still checks the finish", () => {
    const places = weatherPlaces(road(7));
    expect(places.map((p) => Math.round(p.at / 1000))).toEqual([0, 7]);
  });
});
