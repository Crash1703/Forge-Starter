import { distance, pathLength, resample, type LatLng } from "./geo";
import { FORECAST_URL } from "./config";

/** The forecast for a point on the route, at the time you'll get there. */
export interface WeatherPoint {
  at: number; // metres along the route
  eta: number; // epoch ms
  position: LatLng;
  temp: number; // °C
  rainChance: number; // %
  rain: number; // mm in that hour
  wind: number; // km/h
  code: number; // WMO weather code
}

interface Hourly {
  time: number[]; // unix seconds
  temperature_2m: number[];
  precipitation_probability: (number | null)[];
  precipitation: number[];
  wind_speed_10m: number[];
  weather_code: number[];
}

/**
 * Where to check the weather: the start, the finish, and about every 25 km
 * between (at most 12 places, so one request covers any ride).
 */
export function weatherPlaces(path: LatLng[]): { at: number; position: LatLng }[] {
  const total = pathLength(path);
  if (total === 0) return path.length ? [{ at: 0, position: path[0] }] : [];
  const step = Math.max(25000, total / 11);
  const pts = resample(path, step);
  const out: { at: number; position: LatLng }[] = pts.map((position, i) => ({ at: Math.min(total, i * step), position }));
  const last = path[path.length - 1];
  // Always include the finish, unless the last check is already next to it.
  if (distance(out[out.length - 1].position, last) > 2000) out.push({ at: total, position: last });
  return out;
}

/** Forecast along a route leaving at `departure`, riding it in `durationSec`. */
export async function weatherAlong(
  path: LatLng[],
  durationSec: number,
  departure: number,
  signal?: AbortSignal,
): Promise<WeatherPoint[]> {
  const places = weatherPlaces(path);
  const total = pathLength(path) || 1;
  const q = new URLSearchParams({
    latitude: places.map((p) => p.position.lat.toFixed(3)).join(","),
    longitude: places.map((p) => p.position.lng.toFixed(3)).join(","),
    hourly: "temperature_2m,precipitation_probability,precipitation,wind_speed_10m,weather_code",
    timeformat: "unixtime",
    forecast_days: "3",
  });
  const res = await fetch(`${FORECAST_URL}?${q}`, { signal });
  if (!res.ok) throw new Error("Weather forecast unavailable");
  const json = await res.json();
  // One place comes back as an object, several as an array.
  const list: { hourly: Hourly }[] = Array.isArray(json) ? json : [json];
  return places.map((p, i) => {
    const h = list[i]?.hourly ?? list[0].hourly;
    const eta = departure + (durationSec * 1000 * p.at) / total;
    let k = 0;
    for (let j = 1; j < h.time.length; j++) if (Math.abs(h.time[j] * 1000 - eta) < Math.abs(h.time[k] * 1000 - eta)) k = j;
    return {
      at: p.at,
      eta,
      position: p.position,
      temp: h.temperature_2m[k],
      rainChance: h.precipitation_probability[k] ?? 0,
      rain: h.precipitation[k],
      wind: h.wind_speed_10m[k],
      code: h.weather_code[k],
    };
  });
}

/** Rain is likely somewhere on the way: the first such place, or null. */
export function rainAhead(points: WeatherPoint[]): WeatherPoint | null {
  return points.find((p) => p.rainChance >= 50 || p.rain >= 0.5) ?? null;
}

/** A symbol for a WMO weather code. */
export function weatherIcon(code: number): string {
  if (code === 0) return "☀️";
  if (code <= 2) return "🌤️";
  if (code === 3) return "☁️";
  if (code <= 48) return "🌫️";
  if (code <= 67 || (code >= 80 && code <= 82)) return "🌧️";
  if (code <= 77 || code === 85 || code === 86) return "🌨️";
  return "⛈️";
}
