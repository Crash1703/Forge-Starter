// Elevation for the Ride Forge app, from the Copernicus 90 m terrain model on
// this server (fetch-dem.mjs puts it in ~/dem), answered as Open-Meteo's
// elevation API does: GET /elevation?latitude=a,b,…&longitude=c,d,… (up to
// 100 points) → { "elevation": [m, m, …] }. Heights are blended from the four
// nearest grid points; the sea (no tile) is 0. Listens on localhost:8998;
// the tunnel sends https://<route server>/elevation here.
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";

const PORT = Number(process.env.ELEVATION_PORT || 8998);
const DIR = process.env.DEM_DIR || `${homedir()}/dem`;
const SIZE = 1200;
const MAX_POINTS = 100;

/** Tiles in memory (2.9 MB each), the most recently used kept: plenty for a state's rides. */
const tiles = new Map();
const KEEP = 64;
const name = (lat, lon) => `${lat < 0 ? "S" : "N"}${String(Math.abs(lat)).padStart(2, "0")}${lon < 0 ? "W" : "E"}${String(Math.abs(lon)).padStart(3, "0")}`;

/** The heights of the 1° tile whose south-west corner is (lat, lon), or null for sea. */
function tile(lat, lon) {
  const key = name(lat, lon);
  if (tiles.has(key)) {
    const t = tiles.get(key);
    tiles.delete(key);
    tiles.set(key, t); // most recently used last
    return t;
  }
  const file = `${DIR}/${key}.i16`;
  let t = null;
  if (existsSync(file)) {
    const buf = Buffer.alloc(SIZE * SIZE * 2);
    const fd = openSync(file, "r");
    readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    t = new Int16Array(buf.buffer, buf.byteOffset, SIZE * SIZE);
  }
  tiles.set(key, t);
  if (tiles.size > KEEP) tiles.delete(tiles.keys().next().value);
  return t;
}

/** Height in metres at a point, blended from the four grid points around it. */
export function heightAt(lat, lon) {
  const t = tile(Math.floor(lat), Math.floor(lon));
  if (!t) return 0;
  // Row 0 is the tile's north edge; column 0 its west edge.
  const y = (Math.ceil(lat) - lat) * SIZE - 0.5;
  const x = (lon - Math.floor(lon)) * SIZE - 0.5;
  const at = (r, c) => t[Math.min(SIZE - 1, Math.max(0, r)) * SIZE + Math.min(SIZE - 1, Math.max(0, c))];
  const r0 = Math.floor(y);
  const c0 = Math.floor(x);
  const fy = y - r0;
  const fx = x - c0;
  const top = at(r0, c0) * (1 - fx) + at(r0, c0 + 1) * fx;
  const bottom = at(r0 + 1, c0) * (1 - fx) + at(r0 + 1, c0 + 1) * fx;
  return Math.round((top * (1 - fy) + bottom * fy) * 10) / 10;
}

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };
const json = (res, status, body) => res.writeHead(status, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify(body));

if (process.argv[1]?.endsWith("elevation.mjs")) {
  createServer((req, res) => {
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/elevation/health") return res.writeHead(200, cors).end("ok");
    if (req.method !== "GET" || url.pathname !== "/elevation") return res.writeHead(404, cors).end();
    const lats = (url.searchParams.get("latitude") ?? "").split(",").map(Number);
    const lons = (url.searchParams.get("longitude") ?? "").split(",").map(Number);
    const ok = lats.length === lons.length && lats.length >= 1 && lats.length <= MAX_POINTS && [...lats, ...lons].every(Number.isFinite) && lats.every((l) => Math.abs(l) < 90) && lons.every((l) => Math.abs(l) <= 180);
    if (!ok) return json(res, 400, { error: `latitude and longitude: 1 to ${MAX_POINTS} points` });
    json(res, 200, { elevation: lats.map((lat, i) => heightAt(lat, lons[i])) });
  }).listen(PORT, "127.0.0.1", () => console.log(`elevation on localhost:${PORT}, tiles in ${DIR}`));
}
