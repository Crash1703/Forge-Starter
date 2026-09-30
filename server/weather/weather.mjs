// Weather for the Ride Forge app, from MET Norway (api.met.no: free, also
// for commercial use, with credit; data CC BY 4.0), answered in the shape
// Open-Meteo uses, which the app reads (hourly temperature_2m,
// precipitation_probability, precipitation, wind_speed_10m, weather_code).
// MET Norway asks for a User-Agent naming the app with a contact, and for
// answers to be kept until they expire: both done here, so the app never
// asks them directly. Listens on localhost:8997; the tunnel sends
// https://<route server>/weather/... here.
import { createServer } from "node:http";
import { hourlyFrom } from "./met.mjs";

const PORT = Number(process.env.WEATHER_PORT || 8997);
const MET = "https://api.met.no/weatherapi/locationforecast/2.0/complete";
const USER_AGENT = "RideForge/1.0 (https://crash1703.github.io/Forge-Starter/; support@mbcgaming.net)";
/** Places per request, as the app asks (start, finish and every ~25 km: at most 12). */
const MAX_PLACES = 12;
/** place ("lat,lon", 2 decimals: about 1 km) → { expires, lastModified, hourly } */
const kept = new Map();
const asking = new Map();

/** The forecast for one place: kept until MET Norway says it expires, then asked again (politely). */
async function forecast(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const have = kept.get(key);
  if (have && Date.now() < have.expires) return have.hourly;
  if (!asking.has(key)) {
    const headers = { "User-Agent": USER_AGENT, ...(have?.lastModified ? { "If-Modified-Since": have.lastModified } : {}) };
    const p = fetch(`${MET}?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`, { headers, signal: AbortSignal.timeout(20_000) })
      .then(async (res) => {
        const expires = Date.parse(res.headers.get("expires") ?? "") || Date.now() + 30 * 60_000;
        if (res.status === 304 && have) return kept.set(key, { ...have, expires }).get(key).hourly;
        if (!res.ok) throw new Error(`MET Norway ${res.status}`);
        const hourly = hourlyFrom(await res.json());
        kept.set(key, { expires, lastModified: res.headers.get("last-modified"), hourly });
        return hourly;
      })
      .finally(() => asking.delete(key));
    asking.set(key, p);
  }
  try {
    return await asking.get(key);
  } catch (e) {
    if (have) return have.hourly; // an old forecast beats none
    throw e;
  }
}

// Don't let the memory grow without end: forget forecasts a day past expiry.
setInterval(() => {
  for (const [k, v] of kept) if (Date.now() - v.expires > 24 * 3_600_000) kept.delete(k);
}, 3_600_000);

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };
const json = (res, status, body) => res.writeHead(status, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify(body));

createServer(async (req, res) => {
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/weather/health") return res.writeHead(200, cors).end("ok");
  if (req.method !== "GET" || url.pathname !== "/weather/forecast") return res.writeHead(404, cors).end();
  const lats = (url.searchParams.get("latitude") ?? "").split(",").map(Number);
  const lons = (url.searchParams.get("longitude") ?? "").split(",").map(Number);
  const ok = lats.length === lons.length && lats.length >= 1 && lats.length <= MAX_PLACES && [...lats, ...lons].every(Number.isFinite) && lats.every((l) => Math.abs(l) <= 90) && lons.every((l) => Math.abs(l) <= 180);
  if (!ok) return json(res, 400, { error: `latitude and longitude: 1 to ${MAX_PLACES} places` });
  try {
    const all = await Promise.all(lats.map((lat, i) => forecast(lat, lons[i])));
    const out = all.map((hourly, i) => ({ latitude: lats[i], longitude: lons[i], hourly }));
    json(res, 200, out.length === 1 ? out[0] : out);
  } catch (e) {
    console.error(e.message);
    json(res, 502, { error: "The weather forecast isn't available just now." });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`weather on localhost:${PORT}`));
