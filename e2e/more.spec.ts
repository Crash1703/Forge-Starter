import { expect, test } from "@playwright/test";
import { reports } from "./fakes";
import { noErrors, openApp, planRoute, shot } from "./helpers";

test.beforeEach(async ({ page }) => openApp(page));
test.afterEach(async ({ page }) => noErrors(page));

test("the round-trip page makes a loop from where you are, with loops to choose from", async ({ page }) => {
  await page.locator("button.fab.accent").click();
  await page.screenshot(shot("10-round-trip-page"));
  await page.getByRole("button", { name: "Create a round trip" }).click();
  const choices = page.getByRole("radiogroup", { name: "Loops to choose from" });
  await expect(choices).toBeVisible({ timeout: 60_000 });
  // Up to three (Best balance, Most curvy, Another way); ones that come out the same are dropped.
  expect(await choices.getByRole("radio").count()).toBeGreaterThanOrEqual(2);
  // The loops can show while the chosen one is still being finished: give the summary time.
  await expect(page.locator(".summary-meta")).toContainText("loop", { timeout: 20_000 });
  await page.screenshot(shot("11-round-trip-choices"));
  // Customise · Recalculate · Avoid and Ride · Save · ⋯ fit the phone's width.
  for (const row of [".summary-tools", ".summary-actions"]) {
    const [inner, outer] = await page.locator(row).evaluate((el) => [el.scrollWidth, el.clientWidth]);
    expect(inner, `${row} fits`).toBeLessThanOrEqual(outer);
  }
  // Another shape: the route changes, and the choice is marked.
  const second = choices.getByRole("radio").nth(1);
  await second.click();
  await expect(second).toHaveAttribute("aria-checked", "true");
});

test("save a route, then open it from Saved", async ({ page }) => {
  await planRoute(page);
  await page.locator(".summary-actions").getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Route saved")).toBeVisible();
  await page.getByRole("tab", { name: "Saved" }).click();
  const item = page.locator("ul.saved li").first();
  await expect(item).toBeVisible();
  await page.screenshot(shot("12-saved"));
  await item.locator("button.open").click();
  await expect(page.locator(".pin")).toHaveCount(2);
  await expect(page.locator(".summary-stats")).toContainText("km", { timeout: 20_000 });
});

test("export a route as GPX, and import it back", async ({ page }) => {
  await planRoute(page);
  await page.getByRole("button", { name: "More" }).click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "Export GPX" }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.gpx$/);
  const gpx = await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString());
  expect(gpx).toContain("<gpx");
  expect(gpx).toContain("<trkpt");
  expect(gpx).toContain("Maleny");
  // Back in through Saved → Import GPX.
  await page.getByRole("tab", { name: "Saved" }).click();
  await page.locator('input[type="file"][accept*=".gpx"]').setInputFiles({ name: "ride.gpx", mimeType: "application/gpx+xml", buffer: Buffer.from(gpx) });
  await expect(page.locator(".summary-stats")).toContainText("km", { timeout: 20_000 });
  await expect(page.locator(".pin").first()).toBeVisible();
});

test("record a short ride and find it under Rides", async ({ page, context }) => {
  await page.getByRole("button", { name: "Record a ride" }).click();
  await expect(page.getByRole("button", { name: "Stop recording" })).toBeVisible();
  // Ride about 600 m east along the esplanade, a fix every 100 m.
  for (let i = 1; i <= 6; i++) {
    await context.setGeolocation({ latitude: -26.8036, longitude: 153.1216 + i * 0.001 });
    await page.waitForTimeout(1500);
  }
  await page.screenshot(shot("13-recording"));
  await page.getByRole("button", { name: "Stop recording" }).click();
  await page.getByRole("dialog", { name: "Stop recording?" }).getByRole("button", { name: "Save ride" }).click();
  await expect(page.getByText(/Too short/)).toHaveCount(0);
  await page.getByRole("tab", { name: "Rides" }).click();
  // About 600 m: "595 m" or so.
  await expect(page.getByText(/^(5[5-9]\d|6[0-4]\d) m$/).first()).toBeVisible({ timeout: 10_000 });
  await page.screenshot(shot("14-rides"));
});

test("fuel stations in view show today's price, the cheapest marked", async ({ page }) => {
  await page.getByRole("button", { name: "Show my location" }).click();
  await page.getByRole("button", { name: "Search and map extras" }).click();
  await page.locator(".map-search").getByRole("button", { name: "Fuel" }).click();
  const stations = page.locator(".poi-fuel");
  await expect(stations).toHaveCount(2, { timeout: 20_000 });
  await expect(page.locator(".poi-fuel.priced")).toHaveCount(2, { timeout: 20_000 });
  await expect(page.locator(".poi-fuel.cheapest")).toHaveText("189.9");
  await page.screenshot(shot("15-fuel-prices"));
  // A station's card: add it, ride there, or loop via it.
  await page.locator(".poi-fuel.cheapest").dispatchEvent("click");
  const card = page.getByRole("dialog", { name: "BP Caloundra" });
  await expect(card).toContainText("189.9 c/L");
  await expect(card.getByRole("button", { name: "Ride here" })).toBeVisible();
});

test("Settings: route server choices, and fuel prices without a token", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  const server = page.locator(".rt-rows").filter({ has: page.getByRole("button", { name: "Public server only" }) });
  await expect(server).toContainText("Using Ride Forge's route server (routes.mbcgaming.net)");
  await server.getByRole("button", { name: "Public server only" }).click();
  // (That button goes once chosen, so look for the words on the page.)
  await expect(page.getByText(/Using only the free public server/)).toBeVisible();
  await page.getByRole("button", { name: "Use Ride Forge's server" }).click();
  await expect(page.getByText(/Using Ride Forge's route server/)).toBeVisible();
  await page.getByRole("button", { name: "Check prices" }).click();
  await expect(page.getByText(/Working: 2 stations, 2 with Premium 95 prices/)).toBeVisible();
  await page.screenshot(shot("16-settings"));
});

test("send feedback from Settings", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeDisabled();
  await page.locator("#set-feedback").fill("Reverse didn't flip my loop");
  await send.click();
  await expect(page.getByText("Thanks! Sent.")).toBeVisible();
  await expect(page.locator("#set-feedback")).toHaveValue("");
  const sent = reports.get(page) ?? [];
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ kind: "feedback", message: "Reverse didn't flip my loop", version: "dev", platform: "web" });
  // The app's version and phone, never where the rider is.
  expect(Object.keys(sent[0]).sort()).toEqual(["device", "kind", "message", "platform", "screen", "version"]);
  await page.locator("#set-feedback").scrollIntoViewIfNeeded();
  await page.screenshot(shot("17-feedback"));
});
