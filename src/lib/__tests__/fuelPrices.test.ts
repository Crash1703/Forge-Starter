import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { destination } from "../geo";
import {
  clearFuelPrices,
  FUEL_API,
  fuelIdsFrom,
  loadFuelPrices,
  priceAge,
  priceNear,
  pricesForStations,
  pricesFrom,
  sitesFrom,
} from "../fuelPrices";

const here = { lat: -26.8, lng: 153.1 };
const FUELS = { Fuels: [{ FuelId: 2, Name: "Unleaded" }, { FuelId: 5, Name: "Premium Unleaded 95" }, { FuelId: 8, Name: "Premium Unleaded 98" }, { FuelId: 3, Name: "Diesel" }, { FuelId: 12, Name: "e10" }] };
const SITES = {
  S: [
    { S: 101, N: "Ampol Caloundra", Lat: here.lat, Lng: here.lng },
    { S: 102, N: "Shell Beerwah", Lat: destination(here, 0, 5000).lat, Lng: here.lng },
  ],
};
const PRICES = {
  SitePrices: [
    { SiteId: 101, FuelId: 5, Price: 1999, TransactionDateUtc: "2026-09-28T01:00:00" },
    { SiteId: 102, FuelId: 5, Price: 1899, TransactionDateUtc: "2026-09-28T02:00:00" },
    { SiteId: 102, FuelId: 3, Price: 9999, TransactionDateUtc: "2026-09-28T02:00:00" },
  ],
};

describe("Queensland fuel prices", () => {
  beforeEach(() => clearFuelPrices());
  afterEach(() => vi.unstubAllGlobals());

  it("reads fuel ids by name, falling back to the known ids", () => {
    const ids = fuelIdsFrom(FUELS.Fuels);
    expect(ids.get("u91")).toBe(2);
    expect(ids.get("p95")).toBe(5);
    expect(ids.get("p98")).toBe(8);
    expect(ids.get("e10")).toBe(12);
    expect(fuelIdsFrom([]).get("diesel")).toBe(3);
  });

  it("reads prices in tenths of a cent, skipping 'not available'", () => {
    const prices = pricesFrom(PRICES);
    expect(prices.get(101)?.get(5)?.cents).toBe(199.9);
    expect(prices.get(102)?.get(3)).toBeUndefined();
    expect(prices.get(102)?.get(5)?.updated.toISOString()).toBe("2026-09-28T02:00:00.000Z");
    expect(sitesFrom(SITES)).toHaveLength(2);
  });

  it("finds a map station's price by place", () => {
    const data = { at: 0, fuelIds: fuelIdsFrom(FUELS.Fuels), sites: sitesFrom(SITES), prices: pricesFrom(PRICES) };
    expect(priceNear(destination(here, 90, 60), data, "p95")).toMatchObject({ cents: 199.9, site: "Ampol Caloundra" });
    expect(priceNear(destination(here, 90, 600), data, "p95")).toBeNull();
    expect(priceNear(here, data, "diesel")).toBeNull();
    const stations = [
      { id: "a", kind: "fuel" as const, name: "Ampol", position: here, at: 0 },
      { id: "b", kind: "fuel" as const, name: "Shell", position: destination(here, 0, 5020), at: 5000 },
      { id: "c", kind: "cafe" as const, name: "Café", position: here, at: 0 },
    ];
    expect([...pricesForStations(stations, data, "p95").entries()].map(([id, p]) => [id, p.cents])).toEqual([
      ["a", 199.9],
      ["b", 189.9],
    ]);
  });

  it("says how old a price is", () => {
    const p = { cents: 190, updated: new Date("2026-09-28T00:00:00Z"), site: "x" };
    expect(priceAge(p, Date.parse("2026-09-28T00:20:00Z"))).toBe("updated 20 min ago");
    expect(priceAge(p, Date.parse("2026-09-28T03:00:00Z"))).toBe("updated 3 h ago");
    expect(priceAge(p, Date.parse("2026-10-01T00:00:00Z"))).toBe("updated 3 days ago");
  });

  it("loads with the rider's token, and remembers for a while", async () => {
    const f = vi.fn(async (url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe("FPDAPI SubscriberToken=abc-123");
      const body = url.includes("FuelTypes") ? FUELS : url.includes("SiteDetails") ? SITES : PRICES;
      return new Response(JSON.stringify(body));
    });
    vi.stubGlobal("fetch", f);
    const data = await loadFuelPrices(" abc-123 ");
    expect(f.mock.calls.map((c) => String(c[0]).replace(FUEL_API, ""))).toEqual([
      "/Subscriber/GetCountryFuelTypes?countryId=21",
      "/Subscriber/GetFullSiteDetails?countryId=21&geoRegionLevel=3&geoRegionId=1",
      "/Price/GetSitesPrices?countryId=21&geoRegionLevel=3&geoRegionId=1",
    ]);
    expect(data.sites).toHaveLength(2);
    await loadFuelPrices(" abc-123 ");
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("explains a refused token or a missing one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    await expect(loadFuelPrices("wrong")).rejects.toThrow(/didn't accept your token/);
    await expect(loadFuelPrices("")).rejects.toThrow(/Add your fuel price token/);
  });
});
