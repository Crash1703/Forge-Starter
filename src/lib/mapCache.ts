import type { RequestParameters, ResourceType, StyleSpecification } from "maplibre-gl";
import type { LatLng } from "./geo";

/**
 * Faster map starts. Before drawing anything, the map needs its style, then
 * the tile list that style points to, then the tiles: three trips to the map
 * server, one after another. So:
 *
 * - the style comes from the phone, with its tile list already filled in,
 *   and is refreshed quietly for next time;
 * - map tiles and fonts, once downloaded, are kept on the phone (only
 *   versioned tiles, which never change: a new map version has new URLs);
 * - the map opens where it was last left.
 */

const STYLE_KEY = "forge.mapStyle:";
const VIEW_KEY = "forge.mapView";
const CACHE = "forge-map-v1";
/** Roughly 100–200 MB of tiles at most; the oldest go first. */
const MAX_ENTRIES = 4000;
const PROTOCOL = "forgecache";

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* full or blocked: the map just loads the slower way */
    }
  },
};

type TileJson = { tiles?: string[]; minzoom?: number; maxzoom?: number; bounds?: number[]; attribution?: string };

/** The style with each source's tile list written in, so the map can ask for tiles straight away. */
export async function fetchStyle(url: string, signal?: AbortSignal): Promise<StyleSpecification> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Map style: HTTP ${res.status}`);
  const style = (await res.json()) as StyleSpecification;
  await Promise.all(
    Object.values(style.sources).map(async (src) => {
      if (!("url" in src) || !src.url) return;
      const r = await fetch(new URL(src.url, url), { signal });
      if (!r.ok) throw new Error(`Map tiles: HTTP ${r.status}`);
      const tj = (await r.json()) as TileJson;
      if (!tj.tiles?.length) throw new Error("Map tiles: no tile list");
      const s = src as Record<string, unknown>;
      delete s.url;
      s.tiles = tj.tiles;
      for (const k of ["minzoom", "maxzoom", "bounds", "attribution"] as const) if (tj[k] != null && s[k] == null) s[k] = tj[k];
    }),
  );
  return style;
}

/** The style as last saved on this phone, if any. */
export function savedStyle(url: string): StyleSpecification | null {
  const raw = store.get(STYLE_KEY + url);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StyleSpecification;
  } catch {
    return null;
  }
}

/**
 * What to hand the map: the saved style if there is one (instant), or the
 * style's address. Either way a fresh copy is fetched and saved; if it
 * differs from what the map was given, `onNewer` gets it.
 */
export function styleFast(url: string, onNewer?: (style: StyleSpecification) => void): StyleSpecification | string {
  const saved = savedStyle(url);
  fetchStyle(url)
    .then((fresh) => {
      const json = JSON.stringify(fresh);
      store.set(STYLE_KEY + url, json);
      if (saved && json !== JSON.stringify(saved)) onNewer?.(fresh);
    })
    .catch(() => {
      /* offline or the server is down: keep what we have */
    });
  return saved ?? url;
}

/** Tiles in a dated map version (OpenFreeMap's `.../20250101_001001_pt/...`), or fonts: these never change. */
export function keepable(url: string, type?: ResourceType | string): boolean {
  if (!/^https:\/\//.test(url)) return false;
  if (type === "Glyphs") return true;
  if (type && type !== "Tile") return false;
  return /\/\d{8}_\d{6}_[a-z]+\//.test(url);
}

let registered = false;
let puts = 0;

/** Send keepable tiles and fonts through the on-phone cache. */
export function transformRequest(url: string, type?: ResourceType): RequestParameters {
  return { url: registered && keepable(url, type) ? `${PROTOCOL}://${url.slice("https://".length)}` : url };
}

async function trim(cache: Cache) {
  const keys = await cache.keys();
  // Keys come back oldest first.
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await cache.delete(k);
}

/** Set up the on-phone tile cache for a MapLibre library (call once, before the first map). */
export function registerMapCache(lib: { addProtocol: (name: string, fn: (p: RequestParameters, c: AbortController) => Promise<{ data: ArrayBuffer }>) => void }) {
  if (registered || typeof caches === "undefined") return;
  registered = true;
  lib.addProtocol(PROTOCOL, async (params, ctrl) => {
    const url = `https://${params.url.slice(PROTOCOL.length + 3)}`;
    let cache: Cache | null = null;
    try {
      cache = await caches.open(CACHE);
      const hit = await cache.match(url);
      if (hit) return { data: await hit.arrayBuffer() };
    } catch {
      cache = null;
    }
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const data = await res.arrayBuffer();
    if (cache) {
      const c = cache;
      c.put(url, new Response(data.slice(0), { headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/octet-stream" } }))
        .then(() => {
          if (++puts % 200 === 0) return trim(c);
        })
        .catch(() => {
          /* storage full: fine, the map still works */
        });
    }
    return { data };
  });
}

/** Delete kept tiles and saved styles (Settings). */
export async function clearMapCache() {
  try {
    await caches?.delete(CACHE);
  } catch {
    /* nothing kept */
  }
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(STYLE_KEY)) localStorage.removeItem(k);
  } catch {
    /* nothing kept */
  }
}

export interface MapViewState {
  center: LatLng;
  zoom: number;
}

/** Where the map was last left. */
export function loadMapView(): MapViewState | null {
  try {
    const v = JSON.parse(store.get(VIEW_KEY) ?? "null");
    if (v && Number.isFinite(v.center?.lat) && Number.isFinite(v.center?.lng) && Number.isFinite(v.zoom)) return v;
  } catch {
    /* none saved */
  }
  return null;
}

export function storeMapView(v: MapViewState) {
  store.set(VIEW_KEY, JSON.stringify({ center: { lat: +v.center.lat.toFixed(5), lng: +v.center.lng.toFixed(5) }, zoom: +v.zoom.toFixed(2) }));
}
