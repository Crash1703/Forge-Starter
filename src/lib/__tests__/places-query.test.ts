import { describe, expect, it } from "vitest";
// @ts-expect-error: plain JavaScript on the server, no types
import { parseQuery, Places } from "../../../server/places/query.mjs";
import { destination } from "../geo";
import { poiQuery, poisInQuery } from "../pois";
import { sightsQuery } from "../sights";

const at = { lat: -26.8, lng: 153.1 };
const near = (m: number, bearing = 0) => destination(at, bearing, m);
type P = { type: string; id: number; lat: number; lon: number; tags: Record<string, string> };
const place = (id: number, p: { lat: number; lng: number }, tags: Record<string, string>, type = "node"): P => ({ type, id, lat: p.lat, lon: p.lng, tags });

const places = new Places([
  place(1, near(100), { amenity: "fuel", name: "Close Fuel" }),
  place(2, near(900), { amenity: "fuel", name: "Far Fuel" }),
  place(3, near(150, 90), { amenity: "cafe", name: "Corner Café" }),
  place(4, near(120, 180), { shop: "bakery" }, "way"),
  place(5, near(200, 270), { amenity: "toilets" }),
  place(6, near(300, 45), { tourism: "attraction" }), // no name: not a sight
  place(7, near(320, 45), { tourism: "museum", name: "Museum" }),
  place(8, near(400, 135), { mountain_pass: "yes" }, "way"), // passes are nodes only
  place(9, near(450, 135), { mountain_pass: "yes", name: "The Gap" }),
]);
const ids = (q: string) => places.run(parseQuery(q)).map((e: { id: number }) => e.id).sort((a: number, b: number) => a - b);

describe("places: the app's Overpass queries", () => {
  it("finds a kind of place along a line, within its distance", () => {
    const line = [near(500, 270), near(500, 90)]; // an east–west road through `at`
    expect(ids(poiQuery("fuel", line))).toEqual([1]); // 100 m off the road; 900 m is too far (300 m)
    expect(ids(poiQuery("cafe", line))).toEqual([3, 4]); // a café and a bakery
  });

  it("also looks around a point (the rider), as well as along the road ahead", () => {
    expect(ids(poiQuery("fuel", [near(5000, 0), near(6000, 0)], { at, radius: 1000 }))).toEqual([1, 2]);
  });

  it("finds kinds in a box, and sights only with a name, passes only as nodes", () => {
    const box = { south: at.lat - 0.02, west: at.lng - 0.02, north: at.lat + 0.02, east: at.lng + 0.02 };
    expect(ids(poisInQuery(["fuel", "toilets"], box))).toEqual([1, 2, 5]);
    expect(ids(sightsQuery(box, { sights: true, passes: false }))).toEqual([7]);
    expect(ids(sightsQuery(box, { sights: false, passes: true }))).toEqual([9]);
  });

  it("answers as Overpass does: nodes with lat/lon, ways with a centre, and a limit", () => {
    const box = { south: at.lat - 0.02, west: at.lng - 0.02, north: at.lat + 0.02, east: at.lng + 0.02 };
    const out = places.run(parseQuery(poiQuery("cafe", [near(500, 270), near(500, 90)])));
    expect(out.find((e: { id: number }) => e.id === 3)).toMatchObject({ type: "node", lat: expect.any(Number), lon: expect.any(Number) });
    expect(out.find((e: { id: number }) => e.id === 4)).toMatchObject({ type: "way", center: { lat: expect.any(Number), lon: expect.any(Number) } });
    const limited = parseQuery(poisInQuery(["fuel", "toilets"], box).replace("out center tags 400;", "out center tags 2;"));
    expect(places.run(limited)).toHaveLength(2);
  });

  it("refuses what it doesn't understand", () => {
    expect(() => parseQuery("[out:json];node(1);out;")).toThrow();
    expect(() => parseQuery('[out:json];(nwr["a"="b"](poly:"1 2 3"););out;')).toThrow();
  });
});
