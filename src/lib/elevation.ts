import { distance, pathLength, resample, type LatLng } from "./geo";
import { ELEVATION_URL } from "./config";

export interface ElevationProfile {
  points: { position: LatLng; elevation: number; at: number }[]; // `at` = metres from start
  ascent: number;
  descent: number;
  min: number;
  max: number;
}

/** Sum climbs and drops, ignoring wiggles below `threshold` metres (DEM noise). */
export function climbStats(elevations: number[], threshold = 3) {
  let ascent = 0;
  let descent = 0;
  let ref = elevations[0] ?? 0;
  for (const e of elevations) {
    const d = e - ref;
    if (d >= threshold) {
      ascent += d;
      ref = e;
    } else if (d <= -threshold) {
      descent -= d;
      ref = e;
    }
  }
  return { ascent, descent };
}

const SAMPLES = 200;
const PER_REQUEST = 100; // the elevation service's limit on points per call (as Open-Meteo's)

/** Elevation profile from Ride Forge's server (Copernicus 90 m terrain model). */
export async function elevationProfile(path: LatLng[], signal?: AbortSignal): Promise<ElevationProfile> {
  const total = pathLength(path);
  const pts = resample(path, Math.max(total / (SAMPLES - 1), 1)).slice(0, SAMPLES);
  const batches: LatLng[][] = [];
  for (let i = 0; i < pts.length; i += PER_REQUEST) batches.push(pts.slice(i, i + PER_REQUEST));
  const heights = (
    await Promise.all(
      batches.map(async (b) => {
        const q = `latitude=${b.map((p) => p.lat.toFixed(5)).join(",")}&longitude=${b.map((p) => p.lng.toFixed(5)).join(",")}`;
        const res = await fetch(`${ELEVATION_URL}?${q}`, { signal });
        if (!res.ok) throw new Error("Elevation lookup failed");
        return ((await res.json()) as { elevation: number[] }).elevation;
      }),
    )
  ).flat();
  let at = 0;
  const points = pts.map((position, i) => {
    if (i) at += distance(pts[i - 1], position);
    return { position, elevation: heights[i] ?? 0, at };
  });
  const elev = points.map((p) => p.elevation);
  return { points, ...climbStats(elev), min: Math.min(...elev), max: Math.max(...elev) };
}
