import { pathLength, resample, type LatLng } from "./geo";

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

export async function elevationProfile(path: LatLng[], totalMetres: number): Promise<ElevationProfile> {
  // The Elevation service accepts at most 512 path vertices per request.
  const coarse = path.length > 500 ? resample(path, pathLength(path) / 480) : path;
  const samples = 256;
  const { results } = await new google.maps.ElevationService().getElevationAlongPath({ path: coarse, samples });
  const points = results.map((r, i) => ({
    position: { lat: r.location!.lat(), lng: r.location!.lng() },
    elevation: r.elevation,
    at: (totalMetres * i) / (samples - 1),
  }));
  const elev = points.map((p) => p.elevation);
  return { points, ...climbStats(elev), min: Math.min(...elev), max: Math.max(...elev) };
}
