import { describe, expect, it } from "vitest";
import { destination, resample } from "../geo";
import { firstStretch, knownPlaces, placesQuery, rankPlaces } from "../rideStops";

const rider = { lat: -26.7, lng: 152.9 };
const east = (m: number) => destination(rider, 90, m);
const line = resample([0, 5000, 10000, 15000, 20000].map(east), 250);
const el = (id: number, p: { lat: number; lng: number }, tags: Record<string, string> = {}) => ({ type: "node", id, lat: p.lat, lon: p.lng, tags });

describe("stops while riding", () => {
  it("looks along the road ahead the way the planner does, and around the rider", () => {
    const q = placesQuery("cafe", line, rider);
    expect(q).toContain('nwr["amenity"="cafe"](around:200,');
    expect(q).toContain('nwr["shop"="bakery"](around:3000,-26.70000,152.90000)');
    expect(placesQuery("fuel", line, rider)).toContain('nwr["amenity"="fuel"](around:300,');
  });

  it("lists places on the way first, nearest ahead first, then others nearby", () => {
    const places = rankPlaces(
      [
        el(1, destination(east(12000), 0, 300), { amenity: "fuel", brand: "Ampol" }),
        el(2, destination(east(3000), 180, 200), { amenity: "fuel", name: "Shell Beerwah" }),
        el(3, destination(rider, 0, 2500), { amenity: "fuel" }), // nearby, but off the route
        el(2, destination(east(3000), 180, 200), { amenity: "fuel", name: "Shell Beerwah" }),
      ],
      "fuel",
      line,
      rider,
    );
    expect(places.map((p) => p.name)).toEqual(["Shell Beerwah", "Ampol", "Fuel"]);
    expect(Math.round(places[0].ahead! / 1000)).toBe(3);
    expect(places[2].ahead).toBeNull();
    expect(Math.round(places[2].away)).toBe(2500);
  });

  it("takes just the first stretch of a long route", () => {
    const stretch = firstStretch([0, 5000, 10000, 15000].map(east), 7000);
    expect(stretch).toHaveLength(3);
  });
});

describe("places the planner already found", () => {
  const rider = { lat: -26.7, lng: 152.9 };
  const east = (m: number) => destination(rider, 90, m);
  const ahead = [0, 5000, 10000, 20000].map(east);
  const known = [
    { id: "a", kind: "fuel" as const, name: "Behind me", position: destination(rider, 270, 4000), at: 0 },
    { id: "b", kind: "fuel" as const, name: "Ampol", position: destination(east(8000), 0, 150), at: 0 },
    { id: "c", kind: "cafe" as const, name: "Maple 3", position: destination(east(3000), 0, 100), at: 0 },
  ];
  it("lists the ones still ahead, for the right kind", () => {
    expect(knownPlaces(known, "fuel", ahead, rider).map((p) => p.name)).toEqual(["Ampol"]);
    expect(knownPlaces(known, "cafe", ahead, rider).map((p) => p.name)).toEqual(["Maple 3"]);
    expect(knownPlaces(known, "lookout", ahead, rider)).toEqual([]);
  });
});
