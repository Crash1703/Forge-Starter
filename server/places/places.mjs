// Places for the Ride Forge app (fuel, cafés, food, pubs, toilets, lookouts,
// sights, mountain passes), from the Australia map on this server, answered
// as Overpass does for the queries the app asks (see query.mjs). The places
// come from build-places.sh (~/places/places.geojsonseq); this service loads
// them at start. Listens on localhost:8999; the tunnel sends
// https://<route server>/places/... here (POST /places/interpreter, data=…).
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { parseQuery, Places } from "./query.mjs";

const PORT = Number(process.env.PLACES_PORT || 8999);
const FILE = process.env.PLACES_FILE || `${homedir()}/places/places.geojsonseq`;

/** The middle of a feature's outline (Overpass's "center" is the middle of its bounding box). */
function center(g) {
  if (g.type === "Point") return g.coordinates;
  let [w, s, e, n] = [180, 90, -180, -90];
  const walk = (c) => {
    if (typeof c[0] === "number") {
      w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]);
    } else c.forEach(walk);
  };
  walk(g.coordinates);
  return [(w + e) / 2, (s + n) / 2];
}

function load() {
  // A closed way comes out twice (as a line and as an area): keep one, the area.
  const byId = new Map();
  for (const line of readFileSync(FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const f = JSON.parse(line.replace(/^\x1e/, ""));
    const { "@type": type, "@id": id, ...tags } = f.properties;
    const [lon, lat] = center(f.geometry);
    const key = `${type}/${id}`;
    if (byId.has(key) && f.geometry.type === "LineString") continue;
    byId.set(key, { type, id, lat: Math.round(lat * 1e7) / 1e7, lon: Math.round(lon * 1e7) / 1e7, tags });
  }
  return new Places([...byId.values()]);
}

const started = Date.now();
const index = load();
console.log(`places: ${index.places.length} from ${FILE} in ${Date.now() - started} ms`);

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const server = createServer((req, res) => {
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  if (req.method === "GET" && req.url === "/places/health") return res.writeHead(200, cors).end(`ok ${index.places.length}`);
  if (req.method !== "POST" || req.url !== "/places/interpreter") return res.writeHead(404, cors).end();
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 200_000) req.destroy();
  });
  req.on("end", () => {
    const query = new URLSearchParams(body).get("data") ?? "";
    try {
      const elements = index.run(parseQuery(query));
      res.writeHead(200, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify({ version: 0.6, generator: "Ride Forge places", elements }));
    } catch (e) {
      res.writeHead(400, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify({ remark: e.message, elements: [] }));
    }
  });
});
// Keep idle connections longer than the tunnel and apps expect (Node's 5 s default closes them under a reused request).
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.listen(PORT, "127.0.0.1", () => console.log(`places on localhost:${PORT}`));
