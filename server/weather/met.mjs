// MET Norway's Locationforecast, as the hourly arrays Open-Meteo gives (see weather.mjs).

/** MET Norway's symbol codes as the WMO weather codes the app understands. */
const WMO = [
  [/^clearsky/, 0], [/^fair/, 1], [/^partlycloudy/, 2], [/^cloudy/, 3], [/^fog/, 45],
  [/thunder/, 95],
  [/^heavyrainshowers/, 82], [/^rainshowers/, 81], [/^lightrainshowers/, 80],
  [/^heavyrain/, 65], [/^rain/, 63], [/^lightrain/, 61],
  [/sleet/, 67],
  [/^heavysnowshowers/, 86], [/snowshowers/, 85],
  [/^heavysnow/, 75], [/^snow/, 73], [/^lightsnow/, 71],
];
export const wmo = (symbol) => (symbol ? (WMO.find(([re]) => re.test(symbol))?.[1] ?? 3) : 3);

/** MET Norway's timeseries as Open-Meteo's hourly arrays. */
export function hourlyFrom(json) {
  const h = { time: [], temperature_2m: [], precipitation_probability: [], precipitation: [], wind_speed_10m: [], weather_code: [] };
  for (const t of json.properties?.timeseries ?? []) {
    const now = t.data?.instant?.details ?? {};
    const next = t.data?.next_1_hours ?? t.data?.next_6_hours;
    const hours = t.data?.next_1_hours ? 1 : 6;
    if (now.air_temperature == null || !next) continue;
    h.time.push(Math.round(Date.parse(t.time) / 1000));
    h.temperature_2m.push(now.air_temperature);
    h.wind_speed_10m.push(Math.round((now.wind_speed ?? 0) * 3.6 * 10) / 10);
    h.precipitation.push(Math.round(((next.details?.precipitation_amount ?? 0) / hours) * 10) / 10);
    h.precipitation_probability.push(next.details?.probability_of_precipitation ?? null);
    h.weather_code.push(wmo(next.summary?.symbol_code));
  }
  return h;
}
