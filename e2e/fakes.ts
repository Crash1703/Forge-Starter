// Fake versions of every outside service the app talks to, so the screen
// tests run the real app quickly, the same way every time, and without the
// route server: a plain map style, a GraphHopper that rides straight (with a
// wiggle) between the points it's given, and fixed answers for place search,
// place names, elevation, weather, OpenStreetMap lookups and fuel prices.
import type { Page, Route } from "@playwright/test";
import { encodePolyline } from "../src/lib/polyline";

type LngLat = [number, number];
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });

/** Metres between two [lng, lat] points (flat earth: fine for a fake). */
function metres(a: LngLat, b: LngLat) {
  const kx = 111320 * Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110540);
}

/** A GraphHopper /route answer: straight-ish lines between the points, a stop at each. */
export function fakeRoute(points: LngLat[]) {
  const pts: LngLat[] = [points[0]];
  const stopsAt: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const n = Math.max(2, Math.round(metres(a, b) / 300));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      // Each leg bows out to its right (about 1 km), so a loop comes home on
      // a different "road" than it went out on, as real loops do, plus a
      // gentle wiggle so it isn't a ruler line.
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const len = Math.hypot(dx, dy) || 1;
      const bow = 0.01 * Math.sin(t * Math.PI);
      const w = Math.sin(t * Math.PI * 6) * 0.001;
      pts.push([a[0] + dx * t + (dy / len) * bow + w, a[1] + dy * t - (dx / len) * bow - w]);
    }
    stopsAt.push(pts.length - 1);
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + metres(pts[i - 1], pts[i]));
  const instructions = [];
  let from = 0;
  stopsAt.forEach((at, i) => {
    const last = i === stopsAt.length - 1;
    const d = cum[at] - cum[from];
    instructions.push({ text: `Continue onto Test Road ${i + 1}`, street_name: `Test Road ${i + 1}`, sign: 0, interval: [from, at], distance: d, time: (d / 20) * 1000 });
    instructions.push({ text: last ? "Arrive at destination" : "Waypoint", sign: last ? 4 : 5, interval: [at, at], distance: 0, time: 0 });
    from = at;
  });
  const total = cum[cum.length - 1];
  const whole = (v: string | number) => [[0, pts.length - 1, v]];
  return {
    paths: [
      {
        distance: total,
        time: (total / 20) * 1000,
        points: encodePolyline(
          pts.map(([lng, lat]) => ({ lat, lng })),
          6,
        ),
        instructions,
        details: { road_class: whole("secondary"), surface: whole("asphalt"), urban_density: whole("rural"), max_speed: whole(80) },
        snapped_waypoints: { coordinates: points },
      },
    ],
  };
}

/** Places the fake search knows. */
export const PLACES = [
  { name: "Maleny", lat: -26.7603, lng: 152.8503 },
  { name: "Montville", lat: -26.6897, lng: 152.8914 },
  // Near Montville, off to one side: a stop on the way late in the ride,
  // so a preview ride (4× speed, in real time) hasn't passed it before the test is done.
  { name: "Midway Cafe", lat: -26.7010, lng: 152.8740 },
];

/** Two fuel stations near home in Caloundra, with today's Premium 95 price (tenths of a cent). */
export const STATIONS = [
  { id: 1, name: "Shell Caloundra", lat: -26.8002, lng: 153.1178, price: 1999 },
  { id: 2, name: "BP Caloundra", lat: -26.8061, lng: 153.1262, price: 1899 },
];

/** The Queensland fuel price service (through Ride Forge's server), for those stations. */
function fuelAnswer(path: string) {
  if (path.includes("GetCountryFuelTypes")) return { Fuels: [{ FuelId: 2, Name: "Unleaded" }, { FuelId: 5, Name: "Premium Unleaded 95" }] };
  if (path.includes("GetFullSiteDetails")) return { S: STATIONS.map((st) => ({ S: st.id, N: st.name, Lat: st.lat, Lng: st.lng })) };
  return { SitePrices: STATIONS.map((st) => ({ SiteId: st.id, FuelId: 5, Price: st.price, TransactionDateUtc: new Date(Date.now() - 3_600_000).toISOString() })) };
}

/** Answer every outside request the app makes. */
export async function fakeServices(page: Page) {
  await page.route(/./, (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const host = url.hostname;
    // The app itself (the dev server) and its files.
    if (host === "localhost" || host === "127.0.0.1") return route.continue();
    if (url.pathname.startsWith("/styles/")) {
      return json(route, { version: 8, name: "test", sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#e9e6df" } }] });
    }
    // Ride Forge's route server: GraphHopper.
    if (host === "routes.mbcgaming.net") {
      if (url.pathname === "/info") return json(route, { version: "11.0", data_date: "2026-09-29T00:00:00Z", profiles: [{ name: "motorcycle" }, { name: "car" }] });
      if (url.pathname === "/route") {
        const body = JSON.parse(req.postData() ?? "{}") as { points: LngLat[]; points_encoded?: boolean };
        if (body.points_encoded === false) return json(route, { paths: [{ snapped_waypoints: { coordinates: [body.points[0]] } }] });
        return json(route, fakeRoute(body.points));
      }
      if (url.pathname.startsWith("/fuel/")) return json(route, fuelAnswer(url.pathname));
      return json(route, {}, 404);
    }
    // Place search and place names (Photon).
    if (host === "photon.komoot.io") {
      if (url.pathname === "/reverse") {
        return json(route, { features: [{ geometry: { coordinates: [+url.searchParams.get("lon")!, +url.searchParams.get("lat")!] }, properties: { name: "Test Street", city: "Caloundra" } }] });
      }
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const hits = PLACES.filter((p) => p.name.toLowerCase().startsWith(q.slice(0, 3)));
      return json(route, { features: hits.map((p) => ({ geometry: { coordinates: [p.lng, p.lat] }, properties: { name: p.name, state: "Queensland", country: "Australia" } })) });
    }
    if (host === "api.open-meteo.com" && url.pathname.includes("elevation")) {
      const n = (url.searchParams.get("latitude") ?? "").split(",").length;
      return json(route, { elevation: Array.from({ length: n }, (_, i) => 100 + 40 * Math.sin(i / 3)) });
    }
    if (host === "api.open-meteo.com") return json(route, {}, 503);
    // OpenStreetMap lookups: the two fuel stations when fuel is asked for, otherwise nothing.
    if (url.pathname.includes("interpreter")) {
      const query = decodeURIComponent((req.postData() ?? "").replace(/^data=/, "").replace(/\+/g, " "));
      const fuel = query.includes('"amenity"="fuel"');
      return json(route, { elements: fuel ? STATIONS.map((st) => ({ type: "node", id: st.id, lat: st.lat, lon: st.lng, tags: { amenity: "fuel", name: st.name } })) : [] });
    }
    // Anything else (map tiles, Wikidata…): not needed.
    return route.fulfill({ status: 404, body: "" });
  });
}
