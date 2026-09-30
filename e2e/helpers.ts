import { expect, type Page } from "@playwright/test";
import { fakeServices } from "./fakes";

export const shot = (name: string) => ({ path: `e2e/screenshots/${name}.png` });

/** Errors the app threw, per page (see openApp and noErrors). */
const errors = new WeakMap<Page, string[]>();

/** The app, with every outside service faked, once the map is up. Errors it throws are kept for noErrors. */
export async function openApp(page: Page) {
  const seen: string[] = [];
  errors.set(page, seen);
  page.on("pageerror", (e) => seen.push(`${e.message}\n${(e.stack ?? "").split("\n").slice(1, 6).join("\n")}`));
  await fakeServices(page);
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
}

/** Fail the test if the app threw anything. */
export function noErrors(page: Page) {
  expect(errors.get(page) ?? [], "errors thrown by the app").toEqual([]);
}

/** Add a stop through the map's search pop-out. */
export async function addBySearch(page: Page, text: string, name: string) {
  const open = page.getByRole("button", { name: "Search and map extras" });
  if (await open.isVisible()) await open.click();
  await page.locator(".map-search input").fill(text);
  await page.locator(".map-search .suggestions li", { hasText: name }).first().click();
  await expect(page.locator(".map-search")).toHaveCount(0);
}

/** Maleny to Montville, planned. */
export async function planRoute(page: Page) {
  await addBySearch(page, "Mal", "Maleny");
  await addBySearch(page, "Mon", "Montville");
  await expect(page.locator(".summary-stats")).toContainText("km", { timeout: 20_000 });
}

/** The direction arrows' line (the way the route runs), from the map's own layer, as text. */
export async function arrowsLine(page: Page) {
  return page.evaluate(() => {
    type Src = { serialize(): { data: { features: { geometry: { coordinates: number[][] } }[] } } };
    const m = (window as unknown as { forgeMap: { getSource(id: string): Src } }).forgeMap;
    const c = m.getSource("direction").serialize().data.features[0]?.geometry.coordinates ?? [];
    return c.map((p) => p.map((x) => x.toFixed(4)).join(",")).join(" ");
  });
}
