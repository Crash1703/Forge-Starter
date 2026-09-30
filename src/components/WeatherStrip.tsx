import { useEffect, useState } from "react";
import { formatDistance, formatTime, speedUnit, toSpeed, type LatLng } from "../lib/geo";
import type { RouteResult } from "../lib/routes";
import { rainAhead, weatherAlong, weatherIcon, type WeatherPoint } from "../lib/weather";

interface Props {
  route: RouteResult;
  onHover: (p: LatLng | null) => void;
}

const LEAVING = [
  { label: "Now", hours: 0 },
  { label: "In 1 hour", hours: 1 },
  { label: "In 2 hours", hours: 2 },
  { label: "In 3 hours", hours: 3 },
  { label: "Tomorrow 8 am", hours: -1 },
];

const clock = (t: number) => formatTime(t);

function departureTime(hours: number): number {
  if (hours >= 0) return Date.now() + hours * 3600_000;
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.getTime();
}

/** The forecast for when you'll reach each part of the route, with a rain warning. */
export default function WeatherStrip({ route, onHover }: Props) {
  const [leaving, setLeaving] = useState(0);
  const [points, setPoints] = useState<WeatherPoint[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setPoints(null);
    setError("");
    const ctrl = new AbortController();
    // Wait a moment: routes change quickly while stops are being dragged.
    const t = window.setTimeout(() => {
      weatherAlong(route.path, route.duration, departureTime(LEAVING[leaving].hours), ctrl.signal)
        .then(setPoints)
        .catch((e: Error) => e.name !== "AbortError" && setError("Weather forecast unavailable right now."));
    }, 600);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [route, leaving]);

  const rain = points ? rainAhead(points) : null;
  return (
    <div className="weather">
      <div className="weather-head">
        <h2>Weather on the way</h2>
        <select id="leaving" aria-label="Leaving" value={leaving} onChange={(e) => setLeaving(+e.target.value)}>
          {LEAVING.map((l, i) => (
            <option key={l.label} value={i}>
              Leaving {l.label.toLowerCase()}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="hint">{error}</p>}
      {!points && !error && <p className="hint">Checking the forecast…</p>}
      {rain && (
        <p className="warning">
          🌧️ Rain likely{" "}
          {rain.at < 1000 ? "at the start" : rain.at >= route.distance - 1000 ? "near the finish" : `about ${formatDistance(rain.at)} in`}{" "}
          (around {clock(rain.eta)}):{" "}
          {[rain.rainChance != null ? `${rain.rainChance}% chance` : "", rain.rain >= 0.1 ? `${rain.rain.toFixed(1)} mm an hour` : ""].filter(Boolean).join(", ")}.
        </p>
      )}
      {points && (
        <ol className="weather-strip">
          {points.map((p) => (
            <li
              key={p.at}
              onPointerEnter={() => onHover(p.position)}
              onPointerLeave={() => onHover(null)}
              className={(p.rainChance ?? 0) >= 50 || p.rain >= 0.5 ? "wet" : undefined}
            >
              <small>{p.at < 1000 ? "Start" : formatDistance(p.at)}</small>
              <span className="w-icon" aria-hidden>
                {weatherIcon(p.code)}
              </span>
              <strong>{Math.round(p.temp)}°</strong>
              <small>{clock(p.eta)}</small>
              {p.rainChance != null ? (
                <small aria-label={`${p.rainChance}% chance of rain`}>💧{p.rainChance}%</small>
              ) : (
                <small aria-label={`${p.rain.toFixed(1)} mm of rain an hour`}>💧{p.rain >= 0.1 ? p.rain.toFixed(1) : "0"}mm</small>
              )}
              <small aria-label={`Wind ${Math.round(toSpeed(p.wind))} ${speedUnit()}`}>🌬{Math.round(toSpeed(p.wind))}</small>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
