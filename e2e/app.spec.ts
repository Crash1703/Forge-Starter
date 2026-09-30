import { expect, test } from "@playwright/test";
import { addBySearch, arrowsLine, noErrors, openApp, shot } from "./helpers";

test.beforeEach(async ({ page }) => openApp(page));
test.afterEach(async ({ page }) => noErrors(page));

test("the map loads with just the search button, which pops out", async ({ page }) => {
  const search = page.getByRole("button", { name: "Search and map extras" });
  await expect(search).toBeVisible();
  // Closed: no search box or chips on the map.
  await expect(page.locator(".map-search")).toHaveCount(0);
  await page.screenshot(shot("01-map"));
  await search.click();
  const panel = page.locator(".map-search");
  await expect(panel).toBeVisible();
  for (const name of ["Sights", "Passes", "Fuel", "Toilets"]) await expect(panel.getByRole("button", { name })).toBeVisible();
  await page.screenshot(shot("02-search-open"));
  await page.getByRole("button", { name: "Close search" }).click();
  await expect(panel).toHaveCount(0);
});

test("plan a route from two searched places", async ({ page }) => {
  await addBySearch(page, "Mal", "Maleny");
  await addBySearch(page, "Mon", "Montville");
  const summary = page.locator(".summary-stats");
  await expect(summary).toContainText("km", { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Ride", exact: true })).toBeVisible();
  await page.screenshot(shot("03-route"));
});

test("set home in Settings, then start from home on the map", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Where I am now" }).click();
  await expect(page.locator(".home-set strong").first()).toHaveText("Home");
  await page.screenshot(shot("04-settings-home"));
  await page.getByRole("button", { name: "Back to the map" }).click();
  const house = page.getByRole("button", { name: "Home", exact: true });
  await expect(house).toBeVisible();
  await house.click();
  const card = page.getByRole("dialog", { name: "Home" });
  await expect(card.getByRole("button", { name: "Start from home" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Ride home" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Loop from home" })).toBeVisible();
  await page.screenshot(shot("05-home-card"));
  await card.getByRole("button", { name: "Start from home" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator(".pin-start")).toHaveCount(1);
});

test("a pin's Round trip goes there and back, with no length to pick", async ({ page }) => {
  await addBySearch(page, "Mal", "Maleny");
  await addBySearch(page, "Mon", "Montville");
  await expect(page.locator(".summary-stats")).toContainText("km", { timeout: 20_000 });
  await page.locator(".pin-end").click();
  await page.getByRole("button", { name: "Round trip", exact: true }).click();
  // Straight back to the map with a loop: no round-trip page.
  await expect(page.locator(".summary-meta")).toContainText("loop", { timeout: 20_000 });
  await expect(page.locator(".pin")).toHaveCount(2);
  await page.screenshot(shot("06-pin-round-trip"));
  // Reverse: the same two stops, ridden the other way round (the arrows' line changes).
  const before = await arrowsLine(page);
  await page.getByRole("button", { name: "Reverse" }).click();
  await expect.poll(() => arrowsLine(page), { timeout: 20_000 }).not.toBe(before);
});

test("in a preview ride, add a stop, see its pin, then remove it", async ({ page }) => {
  await addBySearch(page, "Mal", "Maleny");
  await addBySearch(page, "Mon", "Montville");
  await expect(page.locator(".summary-stats")).toContainText("km", { timeout: 20_000 });
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Preview ride" }).click();
  await expect(page.getByRole("region", { name: "Ride mode" })).toBeVisible();
  // Wait for the ride to know where it is (the preview "rides" at 4× speed).
  await expect(page.locator(".ride-eta span")).not.toHaveText("starting…", { timeout: 15_000 });
  await page.getByRole("button", { name: "Add a stop" }).click();
  const panel = page.getByRole("dialog", { name: "Add a stop" });
  await panel.locator("input").fill("Mid");
  await panel.locator(".suggestions li", { hasText: "Midway Cafe" }).first().click();
  await panel.getByRole("button", { name: "Stop on the way" }).click();
  await expect(panel).toHaveCount(0, { timeout: 20_000 });
  const pin = page.locator(".ride-stop");
  await expect(pin).toHaveCount(1);
  // The map follows the moving rider, so the pin never stands still: tap it as it is.
  await pin.dispatchEvent("click");
  const again = page.getByRole("dialog", { name: "Add a stop" });
  await expect(again.getByRole("list", { name: "Your stops" })).toContainText("Midway Cafe");
  await page.screenshot(shot("07-ride-your-stops"));
  await again.getByRole("button", { name: "Remove Midway Cafe" }).click();
  await expect(page.locator(".ride-stop")).toHaveCount(0, { timeout: 20_000 });
});
