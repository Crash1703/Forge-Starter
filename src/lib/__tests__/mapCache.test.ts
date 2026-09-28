// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStyle, keepable, loadMapView, savedStyle, storeMapView, styleFast } from "../mapCache";

const STYLE = "https://tiles.example.org/styles/liberty";
const style = {
  version: 8,
  sources: { ofm: { type: "vector", url: "https://tiles.example.org/planet" } },
  glyphs: "https://tiles.example.org/fonts/{fontstack}/{range}.pbf",
  layers: [],
};
const tileJson = { tiles: ["https://tiles.example.org/planet/20250101_001001_pt/{z}/{x}/{y}.pbf"], maxzoom: 14 };

function stubServer(tiles = tileJson) {
  const fetchMock = vi.fn(async (url: string | URL) =>
    new Response(JSON.stringify(String(url).endsWith("/planet") ? tiles : style), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("map style on the phone", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("writes the tile list into the style, so tiles can load straight away", async () => {
    stubServer();
    const s = await fetchStyle(STYLE);
    expect(s.sources.ofm).toEqual({ type: "vector", tiles: tileJson.tiles, maxzoom: 14 });
  });

  it("uses the address the first time, then the saved style", async () => {
    stubServer();
    expect(styleFast(STYLE)).toBe(STYLE);
    await vi.waitFor(() => expect(savedStyle(STYLE)).not.toBeNull());
    const second = styleFast(STYLE);
    expect(typeof second).toBe("object");
  });

  it("hands over a newer style when the map server has moved on", async () => {
    stubServer();
    styleFast(STYLE);
    await vi.waitFor(() => expect(savedStyle(STYLE)).not.toBeNull());
    stubServer({ ...tileJson, tiles: ["https://tiles.example.org/planet/20250201_001001_pt/{z}/{x}/{y}.pbf"] });
    const newer = vi.fn();
    styleFast(STYLE, newer);
    await vi.waitFor(() => expect(newer).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(newer.mock.calls[0][0])).toContain("20250201");
  });

  it("keeps the saved style when the server can't be reached", async () => {
    stubServer();
    styleFast(STYLE);
    await vi.waitFor(() => expect(savedStyle(STYLE)).not.toBeNull());
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    const newer = vi.fn();
    expect(typeof styleFast(STYLE, newer)).toBe("object");
    await new Promise((r) => setTimeout(r, 10));
    expect(newer).not.toHaveBeenCalled();
  });
});

describe("what's kept on the phone", () => {
  it("keeps dated map tiles and fonts, not tiles that may change", () => {
    expect(keepable("https://tiles.openfreemap.org/planet/20250101_001001_pt/10/940/590.pbf", "Tile")).toBe(true);
    expect(keepable("https://tiles.openfreemap.org/fonts/Noto%20Sans/0-255.pbf", "Glyphs")).toBe(true);
    expect(keepable("https://a.tile.opentopomap.org/10/940/590.png", "Tile")).toBe(false);
    expect(keepable("https://tiles.openfreemap.org/planet/20250101_001001_pt/10/940/590.pbf", "Style")).toBe(false);
  });
});

describe("where the map was left", () => {
  beforeEach(() => localStorage.clear());

  it("remembers the last view", () => {
    expect(loadMapView()).toBeNull();
    storeMapView({ center: { lat: -26.712345678, lng: 152.9 }, zoom: 11.234567 });
    expect(loadMapView()).toEqual({ center: { lat: -26.71235, lng: 152.9 }, zoom: 11.23 });
  });
});
