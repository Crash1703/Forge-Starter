import type { LatLng } from "./geo";
import { PHOTON_URL } from "./config";

export interface Suggestion {
  id: string;
  main: string;
  secondary: string;
  position: LatLng;
}

/** The parts of a Photon GeoJSON feature we use. */
interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    osm_type?: string;
    osm_id?: number;
    name?: string;
    street?: string;
    housenumber?: string;
    city?: string;
    district?: string;
    county?: string;
    state?: string;
    country?: string;
  };
}

export function toSuggestion(f: PhotonFeature): Suggestion {
  const p = f.properties;
  const street = [p.street, p.housenumber].filter(Boolean).join(" ");
  const main = p.name || street || p.city || p.county || "Unnamed place";
  const secondary = [p.name && street, p.city !== main && p.city, p.state, p.country].filter(Boolean).join(", ");
  const [lng, lat] = f.geometry.coordinates;
  return { id: `${p.osm_type}${p.osm_id}-${lat},${lng}`, main, secondary, position: { lat, lng } };
}

/** Photon (Komoot) search-as-you-type, biased towards `near` when given. */
export async function autocomplete(input: string, near?: LatLng, signal?: AbortSignal): Promise<Suggestion[]> {
  const q = new URLSearchParams({ q: input, limit: "6" });
  if (near) {
    q.set("lat", near.lat.toFixed(4));
    q.set("lon", near.lng.toFixed(4));
  }
  const res = await fetch(`${PHOTON_URL}/api/?${q}`, { signal });
  if (!res.ok) throw new Error(res.status === 429 ? "Search is busy, try again in a moment" : "Place search failed");
  const json: { features?: PhotonFeature[] } = await res.json();
  return (json.features ?? []).map(toSuggestion);
}

/** Best-effort short name for a clicked point. */
export async function reverseGeocode(p: LatLng): Promise<string> {
  const fallback = `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;
  try {
    const res = await fetch(`${PHOTON_URL}/reverse?lat=${p.lat}&lon=${p.lng}&limit=1`, {
      signal: AbortSignal.timeout(8000),
    });
    const json: { features?: PhotonFeature[] } = await res.json();
    const f = json.features?.[0];
    if (!f) return fallback;
    const { street, name, city, district, county } = f.properties;
    return [street ?? name, city ?? district ?? county].filter(Boolean).join(", ") || fallback;
  } catch {
    return fallback;
  }
}

const RECENT_KEY = "forge.searches";
const MAX_RECENT = 8;
let keepRecent = true;

/** Remember picked places (on by default; a setting turns it off). */
export function setKeepRecentSearches(on: boolean) {
  keepRecent = on;
}

export function recentSearches(): Suggestion[] {
  if (!keepRecent) return [];
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((s) => s?.main && Number.isFinite(s.position?.lat)) : [];
  } catch {
    return [];
  }
}

export function rememberSearch(s: Suggestion) {
  if (!keepRecent) return;
  const list = [s, ...recentSearches().filter((r) => r.id !== s.id && r.main !== s.main)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* not kept; fine */
  }
}

export function clearRecentSearches() {
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {
    /* nothing to clear */
  }
}
