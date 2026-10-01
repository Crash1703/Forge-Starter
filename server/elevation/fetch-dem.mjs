// Download the Copernicus GLO-90 terrain model (90 m) for Australia and
// store each 1° × 1° tile as raw heights for elevation.mjs: 1200 × 1200
// 16-bit whole metres, north row first, in ~/dem/<S27E153>.i16. Tiles that
// don't exist (all sea) are skipped. Run once (a few GB; resumable):
//   node server/elevation/fetch-dem.mjs
// Copernicus DEM: © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH
// 2014-2018 provided under COPERNICUS by the European Union and ESA; free for
// any use, including commercial.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fromArrayBuffer } from "geotiff";

const DIR = process.env.DEM_DIR || `${homedir()}/dem`;
const BASE = "https://copernicus-dem-90m.s3.amazonaws.com";
// Australia with Tasmania and nearby islands: tiles by their south-west corner.
const LATS = { from: -44, to: -10 };
const LONS = { from: 112, to: 153 };
const SIZE = 1200;
mkdirSync(DIR, { recursive: true });

const name = (lat, lon) => `${lat < 0 ? "S" : "N"}${String(Math.abs(lat)).padStart(2, "0")}${lon < 0 ? "W" : "E"}${String(Math.abs(lon)).padStart(3, "0")}`;
const url = (lat, lon) => {
  const id = `Copernicus_DSM_COG_30_${lat < 0 ? "S" : "N"}${String(Math.abs(lat)).padStart(2, "0")}_00_${lon < 0 ? "W" : "E"}${String(Math.abs(lon)).padStart(3, "0")}_00_DEM`;
  return `${BASE}/${id}/${id}.tif`;
};

async function tile(lat, lon) {
  const out = `${DIR}/${name(lat, lon)}.i16`;
  if (existsSync(out) || existsSync(`${out}.none`)) return "kept";
  const res = await fetch(url(lat, lon));
  if (res.status === 404 || res.status === 403) {
    writeFileSync(`${out}.none`, ""); // all sea: nothing to fetch next time
    return "sea";
  }
  if (!res.ok) throw new Error(`${name(lat, lon)}: HTTP ${res.status}`);
  const image = await (await fromArrayBuffer(await res.arrayBuffer())).getImage();
  if (image.getWidth() !== SIZE || image.getHeight() !== SIZE) throw new Error(`${name(lat, lon)}: ${image.getWidth()}×${image.getHeight()}`);
  const [heights] = await image.readRasters();
  const raw = new Int16Array(SIZE * SIZE);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.round(heights[i]);
  writeFileSync(out, Buffer.from(raw.buffer));
  return "fetched";
}

const jobs = [];
for (let lat = LATS.from; lat <= LATS.to; lat++) for (let lon = LONS.from; lon <= LONS.to; lon++) jobs.push([lat, lon]);
const count = { fetched: 0, sea: 0, kept: 0, failed: 0 };
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const [lat, lon] = jobs[next++];
    try {
      count[await tile(lat, lon)]++;
    } catch (e) {
      count.failed++;
      console.error(e.message);
    }
    const done = count.fetched + count.sea + count.kept + count.failed;
    if (done % 100 === 0) console.log(`${done}/${jobs.length}`, JSON.stringify(count));
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
console.log("done", JSON.stringify(count));
if (count.failed) process.exit(1);
