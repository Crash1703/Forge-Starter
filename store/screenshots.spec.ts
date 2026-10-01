// Screenshots for the Google Play listing (see store/README.md), taken from
// the real app with real maps and routes: a twisty loop from Caloundra, its
// choices and score, a preview ride, fuel prices, and the weather and climb.
import { expect, test, type Page } from "@playwright/test";

const shot = (page: Page, n: number, name: string) => page.screenshot({ path: `store/screenshots/${n}-${name}.png` });
/** Let the map draw its tiles (drawn without a graphics card here, so slowly). */
const settle = (page: Page, ms = 8000) => page.waitForTimeout(ms);

test("store screenshots", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await page.getByRole("button", { name: "Show my location" }).click();
  await settle(page);

  // 1. A twisty loop from where you are.
  await page.locator("button.fab.accent").click();
  await page.getByRole("button", { name: "Create a round trip" }).click();
  const choices = page.getByRole("radiogroup", { name: "Loops to choose from" });
  await expect(choices).toBeVisible({ timeout: 180_000 });
  await expect(page.locator(".summary-meta")).toContainText("loop", { timeout: 60_000 });
  await settle(page, 15000);
  await shot(page, 1, "twisty-loop");

  // 2. The loops to choose from, and how twisty each is.
  await page.getByRole("button", { name: "Expand planner" }).click().catch(() => undefined);
  await settle(page, 4000);
  await shot(page, 2, "loop-choices");

  // 3. Weather and climb along the way (further down the planner).
  const weather = page.locator(".weather-strip").first();
  if (await weather.count()) {
    await weather.scrollIntoViewIfNeeded();
    await settle(page, 3000);
    await shot(page, 3, "weather-and-climb");
  }
  await page.getByRole("button", { name: "Collapse planner" }).click().catch(() => undefined);

  // 4. Riding it: turn by turn, with speed and limits.
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Preview ride" }).click();
  await expect(page.getByRole("region", { name: "Ride mode" })).toBeVisible();
  // Wait for an open road (limit 80 or more), so the shot isn't 70 in a 50 zone.
  for (let i = 0; i < 40; i++) {
    const limit = Number((await page.locator(".ride-limit").textContent().catch(() => "0")) ?? 0);
    if (limit >= 80 && !(await page.locator(".ride-speed.over").count())) break;
    await page.waitForTimeout(3000);
  }
  await settle(page, 4000);
  await shot(page, 4, "ride");
});

test("store screenshot: fuel prices", async ({ page }) => {
  // 5. Fuel prices on the map around Caloundra, the cheapest marked.
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await page.getByRole("button", { name: "Show my location" }).click();
  await settle(page, 8000);
  await page.getByRole("button", { name: "Search and map extras" }).click();
  await page.locator(".map-search").getByRole("button", { name: "Fuel" }).click();
  await page.getByRole("button", { name: "Close search" }).click();
  await expect(page.locator(".poi-fuel.priced").first()).toBeVisible({ timeout: 120_000 });
  // In close on Caloundra, so the prices read.
  await page.evaluate(() => (window as unknown as { forgeMap: { easeTo(o: object): void } }).forgeMap.easeTo({ center: [153.122, -26.795], zoom: 13.6, duration: 0 }));
  await settle(page, 12000);
  await shot(page, 5, "fuel-prices");
});
