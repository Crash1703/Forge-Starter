import { describe, expect, it } from "vitest";
// @ts-expect-error: plain JavaScript on the server, no types
import { hourlyFrom, wmo } from "../../../server/weather/met.mjs";
import { rainAhead, type WeatherPoint } from "../weather";

describe("weather from MET Norway", () => {
  it("reads MET Norway's timeseries as Open-Meteo's hourly arrays", () => {
    const h = hourlyFrom({
      properties: {
        timeseries: [
          { time: "2026-10-01T00:00:00Z", data: { instant: { details: { air_temperature: 21.3, wind_speed: 4 } }, next_1_hours: { summary: { symbol_code: "partlycloudy_day" }, details: { precipitation_amount: 0 } } } },
          { time: "2026-10-01T01:00:00Z", data: { instant: { details: { air_temperature: 19.9, wind_speed: 6.5 } }, next_1_hours: { summary: { symbol_code: "heavyrainshowers_night" }, details: { precipitation_amount: 3.2, probability_of_precipitation: 80 } } } },
          // Further out, 6-hourly: the rain is spread over the hours.
          { time: "2026-10-03T00:00:00Z", data: { instant: { details: { air_temperature: 18, wind_speed: 2 } }, next_6_hours: { summary: { symbol_code: "rain" }, details: { precipitation_amount: 6 } } } },
          // The last point has nothing ahead of it: left out.
          { time: "2026-10-10T00:00:00Z", data: { instant: { details: { air_temperature: 17 } } } },
        ],
      },
    });
    expect(h.time).toEqual([Date.parse("2026-10-01T00:00:00Z") / 1000, Date.parse("2026-10-01T01:00:00Z") / 1000, Date.parse("2026-10-03T00:00:00Z") / 1000]);
    expect(h.temperature_2m).toEqual([21.3, 19.9, 18]);
    expect(h.wind_speed_10m).toEqual([14.4, 23.4, 7.2]);
    expect(h.precipitation).toEqual([0, 3.2, 1]);
    expect(h.precipitation_probability).toEqual([null, 80, null]);
    expect(h.weather_code).toEqual([2, 82, 63]);
  });

  it("gives every MET Norway symbol a sensible WMO code", () => {
    expect(wmo("clearsky_day")).toBe(0);
    expect(wmo("fog")).toBe(45);
    expect(wmo("lightrain")).toBe(61);
    expect(wmo("rainandthunder")).toBe(95);
    expect(wmo("lightssleetshowersandthunder_day")).toBe(95);
    expect(wmo("heavysnow")).toBe(75);
    expect(wmo(undefined)).toBe(3);
  });

  it("warns of rain by the amount when there's no chance given", () => {
    const at = (rain: number): WeatherPoint => ({ at: 0, eta: 0, position: { lat: 0, lng: 0 }, temp: 20, rainChance: null, rain, wind: 10, code: 3 });
    expect(rainAhead([at(0), at(0.2)])).toBeNull();
    expect(rainAhead([at(0), at(1.4)])?.rain).toBe(1.4);
  });
});
