// Queensland fuel prices for the Ride Forge app, with the token kept here
// on the server: the app asks this instead of the government's API, so no
// rider needs a token of their own and the web app can have prices too.
// Only the three requests the app makes are passed on, each kept for a
// while (stations and fuel types change rarely, prices within minutes), and
// the last good answer is served if the government's API is down.
//
// Token: ~/.config/ride-forge/fuel-token (or FUEL_TOKEN). Listens on
// localhost:8995; the tunnel sends https://<route server>/fuel/... here.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const API = "https://fppdirectapi-prod.fuelpricesqld.com.au";
const PORT = Number(process.env.FUEL_PORT || 8995);
const token = (process.env.FUEL_TOKEN || readFileSync(`${homedir()}/.config/ride-forge/fuel-token`, "utf8")).trim();
const QLD = "countryId=21&geoRegionLevel=3&geoRegionId=1";
const MIN = 60_000;
/** What may be asked for, and how long an answer is kept. */
const ALLOWED = new Map([
  ["/Subscriber/GetCountryFuelTypes?countryId=21", 6 * 60 * MIN],
  [`/Subscriber/GetFullSiteDetails?${QLD}`, 6 * 60 * MIN],
  [`/Price/GetSitesPrices?${QLD}`, 5 * MIN],
]);
/** path → { at, body } */
const kept = new Map();
/** path → the request in flight, so a burst of riders asks the government once. */
const asking = new Map();

async function fetchUpstream(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `FPDAPI SubscriberToken=${token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const body = await res.text();
  JSON.parse(body); // only keep real answers
  kept.set(path, { at: Date.now(), body });
  return kept.get(path);
}

async function answer(path) {
  const have = kept.get(path);
  if (have && Date.now() - have.at < ALLOWED.get(path)) return have;
  if (!asking.has(path)) asking.set(path, fetchUpstream(path).finally(() => asking.delete(path)));
  try {
    return await asking.get(path);
  } catch (e) {
    if (have) return have; // stale beats nothing
    throw e;
  }
}

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };

createServer(async (req, res) => {
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  const path = (req.url ?? "").replace(/^\/fuel/, "");
  if (req.method !== "GET" || !ALLOWED.has(path)) return res.writeHead(404, cors).end();
  try {
    const { at, body } = await answer(path);
    res.writeHead(200, { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=60", "X-Fetched": new Date(at).toISOString() }).end(body);
  } catch (e) {
    console.error(path, e.message);
    res.writeHead(502, cors).end(JSON.stringify({ error: "The fuel price service isn't answering." }));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`fuel prices on localhost:${PORT}`));
