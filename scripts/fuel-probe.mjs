// Temporary: do the Queensland fuel price endpoints exist? (No token: expect 401/403, not 404.)
const base = "https://fppdirectapi-prod.fuelpricesqld.com.au";
for (const path of [
  "/Subscriber/GetCountryFuelTypes?countryId=21",
  "/Subscriber/GetCountryBrands?countryId=21",
  "/Subscriber/GetFullSiteDetails?countryId=21&geoRegionLevel=3&geoRegionId=1",
  "/Price/GetSitesPrices?countryId=21&geoRegionLevel=3&geoRegionId=1",
  "/Price/DoesNotExist?countryId=21",
]) {
  for (const auth of [undefined, "FPDAPI SubscriberToken=00000000-0000-0000-0000-000000000000"]) {
    try {
      const r = await fetch(base + path, { headers: auth ? { Authorization: auth } : {} });
      const t = await r.text();
      console.log(`${r.status} ${auth ? "bad-token" : "no-token "} ${path}  ${t.replace(/\s+/g, " ").slice(0, 120)}`);
    } catch (e) {
      console.log(`ERR ${path} ${e.message}`);
    }
  }
}
