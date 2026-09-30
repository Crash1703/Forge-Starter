import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { FUEL_PRICES_URL } from "./config";
import { distance, type LatLng } from "./geo";
import type { Poi } from "./pois";

/**
 * Queensland fuel prices, from the Queensland Government's Fuel Price
 * Reporting scheme (stations must report every change within 30 minutes).
 * Asked through Ride Forge's server (FUEL_PRICES_URL), which holds a token;
 * a rider with their own free "data consumer" token from fuelpricesqld.com.au
 * asks the government directly instead.
 *
 * The app calls it natively (no browser cross-site limits); the website
 * tries a plain fetch, which the government's server may refuse (Ride
 * Forge's allows it).
 */
export const FUEL_API = "https://fppdirectapi-prod.fuelpricesqld.com.au";
const QLD = "countryId=21&geoRegionLevel=3&geoRegionId=1";

/** Prices can be shown: through Ride Forge's server, or with the rider's own token. */
export const pricesAvailable = (token: string) => !!token.trim() || !!FUEL_PRICES_URL;

/** Fuels a rider can choose, and how to recognise each in the government's list. */
export const FUEL_CHOICES = [
  { id: "u91", name: "Unleaded 91", match: /^unleaded$|^unleaded 91$|^ulp$/i, fallbackId: 2 },
  { id: "p95", name: "Premium 95", match: /premium.*95|^pulp 95$/i, fallbackId: 5 },
  { id: "p98", name: "Premium 98", match: /premium.*98|^pulp 98$/i, fallbackId: 8 },
  { id: "e10", name: "E10", match: /^e10$|ethanol.*10/i, fallbackId: 12 },
  { id: "diesel", name: "Diesel", match: /^diesel$/i, fallbackId: 3 },
  { id: "lpg", name: "LPG", match: /^lpg$/i, fallbackId: 4 },
] as const;
export type FuelChoice = (typeof FUEL_CHOICES)[number]["id"];

/** One station's price for the chosen fuel. */
export interface FuelPrice {
  /** Cents per litre, e.g. 189.9 */
  cents: number;
  /** When the station last reported it. */
  updated: Date;
  /** The station as the government lists it. */
  site: string;
}

interface Site {
  id: number;
  name: string;
  position: LatLng;
}

export interface Snapshot {
  at: number;
  fuelIds: Map<FuelChoice, number>;
  sites: Site[];
  /** siteId → fuelId → price */
  prices: Map<number, Map<number, { cents: number; updated: Date }>>;
}

/** Prices change a few times a day; check again after this long. */
const KEEP_MS = 15 * 60_000;
let snapshot: { token: string; data: Snapshot } | null = null;

export class FuelPriceError extends Error {}

async function get(path: string, token: string, signal?: AbortSignal): Promise<unknown> {
  const own = !!token.trim();
  const url = `${own ? FUEL_API : FUEL_PRICES_URL}${path}`;
  const headers: Record<string, string> = own ? { Authorization: `FPDAPI SubscriberToken=${token.trim()}`, "Content-Type": "application/json" } : {};
  let status: number;
  let data: unknown;
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.get({ url, headers, connectTimeout: 20_000, readTimeout: 30_000 });
    status = res.status;
    data = typeof res.data === "string" ? JSON.parse(res.data || "null") : res.data;
  } else {
    const res = await fetch(url, { headers, signal });
    status = res.status;
    data = res.ok ? await res.json() : null;
  }
  if (own && (status === 401 || status === 403)) throw new FuelPriceError("The fuel price service didn't accept your token. Check it in Settings.");
  if (status < 200 || status >= 300) throw new FuelPriceError(`The fuel price service isn't answering (${status}). Try again later.`);
  return data;
}

/** The government's fuel ids for each choice, from its own list (with known ids as a fallback). */
export function fuelIdsFrom(list: { FuelId: number; Name: string }[]): Map<FuelChoice, number> {
  const ids = new Map<FuelChoice, number>();
  for (const c of FUEL_CHOICES) {
    const hit = list.find((f) => c.match.test(f.Name.trim()));
    ids.set(c.id, hit?.FuelId ?? c.fallbackId);
  }
  return ids;
}

/** Stations from GetFullSiteDetails (short field names: S id, N name, Lat, Lng). */
export function sitesFrom(json: { S?: { S: number; N: string; Lat: number; Lng: number }[] }): Site[] {
  return (json.S ?? [])
    .filter((s) => Number.isFinite(s.Lat) && Number.isFinite(s.Lng))
    .map((s) => ({ id: s.S, name: s.N, position: { lat: s.Lat, lng: s.Lng } }));
}

/**
 * Prices from GetSitesPrices. The API gives tenths of a cent (1899 = 189.9¢);
 * 9999 means the fuel isn't available there.
 */
export function pricesFrom(json: { SitePrices?: { SiteId: number; FuelId: number; Price: number; TransactionDateUtc: string }[] }) {
  const prices = new Map<number, Map<number, { cents: number; updated: Date }>>();
  for (const p of json.SitePrices ?? []) {
    if (!Number.isFinite(p.Price) || p.Price <= 0 || p.Price >= 9999) continue;
    const date = new Date(/Z|[+-]\d\d:?\d\d$/.test(p.TransactionDateUtc) ? p.TransactionDateUtc : `${p.TransactionDateUtc}Z`);
    let bySite = prices.get(p.SiteId);
    if (!bySite) prices.set(p.SiteId, (bySite = new Map()));
    bySite.set(p.FuelId, { cents: Math.round(p.Price) / 10, updated: date });
  }
  return prices;
}

/** Fetch (or reuse) today's Queensland stations and prices. */
export async function loadFuelPrices(token: string, signal?: AbortSignal): Promise<Snapshot> {
  if (!pricesAvailable(token)) throw new FuelPriceError("Add your fuel price token in Settings.");
  if (snapshot && snapshot.token === token && Date.now() - snapshot.data.at < KEEP_MS) return snapshot.data;
  const [types, sites, prices] = await Promise.all([
    get("/Subscriber/GetCountryFuelTypes?countryId=21", token, signal),
    get(`/Subscriber/GetFullSiteDetails?${QLD}`, token, signal),
    get(`/Price/GetSitesPrices?${QLD}`, token, signal),
  ]);
  const data: Snapshot = {
    at: Date.now(),
    fuelIds: fuelIdsFrom((types as { Fuels?: { FuelId: number; Name: string }[] })?.Fuels ?? []),
    sites: sitesFrom(sites as Parameters<typeof sitesFrom>[0]),
    prices: pricesFrom(prices as Parameters<typeof pricesFrom>[0]),
  };
  if (!data.sites.length) throw new FuelPriceError("The fuel price service sent no stations. Try again later.");
  snapshot = { token, data };
  return data;
}

/** Stations on the map (OpenStreetMap) and the government's list rarely share ids: match by place. */
const SAME_STATION_M = 150;

/** The price of `fuel` at the listed station at `position` (within 150 m), if it reports one. */
export function priceNear(position: LatLng, data: Snapshot, fuel: FuelChoice): FuelPrice | null {
  const fuelId = data.fuelIds.get(fuel);
  if (fuelId == null) return null;
  let best: Site | null = null;
  let bestD = SAME_STATION_M;
  for (const s of data.sites) {
    // Cheap pre-check: ~0.01° is about a kilometre.
    if (Math.abs(s.position.lat - position.lat) > 0.01 || Math.abs(s.position.lng - position.lng) > 0.01) continue;
    const d = distance(s.position, position);
    if (d < bestD) {
      best = s;
      bestD = d;
    }
  }
  const price = best && data.prices.get(best.id)?.get(fuelId);
  return best && price ? { ...price, site: best.name } : null;
}

/** Each fuel station's price for `fuel`, keyed by the station's id. */
export function pricesForStations(stations: Poi[], data: Snapshot, fuel: FuelChoice): Map<string, FuelPrice> {
  const out = new Map<string, FuelPrice>();
  for (const st of stations) {
    if (st.kind !== "fuel") continue;
    const p = priceNear(st.position, data, fuel);
    if (p) out.set(st.id, p);
  }
  return out;
}

/** "189.9¢" */
export const formatPrice = (p: FuelPrice) => `${p.cents.toFixed(1)}¢`;

/** "updated 2 h ago" */
export function priceAge(p: FuelPrice, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - p.updated.getTime()) / 60_000));
  if (min < 60) return `updated ${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `updated ${h} h ago`;
  return `updated ${Math.round(h / 24)} days ago`;
}

/** Forget fetched prices (a new token, or tests). */
export function clearFuelPrices() {
  snapshot = null;
}
