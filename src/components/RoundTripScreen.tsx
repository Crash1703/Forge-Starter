import { createPortal } from "react-dom";
import Icon from "./Icon";
import PlaceSearch from "./PlaceSearch";
import { formatDuration, type LatLng } from "../lib/geo";
import type { RouteStyle } from "../lib/routes";

export const COMPASS: { label: string; name: string; deg: number | null }[] = [
  { label: "Any", name: "Any direction", deg: null },
  { label: "N", name: "North", deg: 0 },
  { label: "NE", name: "North-east", deg: 45 },
  { label: "E", name: "East", deg: 90 },
  { label: "SE", name: "South-east", deg: 135 },
  { label: "S", name: "South", deg: 180 },
  { label: "SW", name: "South-west", deg: 225 },
  { label: "W", name: "West", deg: 270 },
  { label: "NW", name: "North-west", deg: 315 },
];

export type LoopStart = "here" | "first" | "home";

interface Props {
  mode: "distance" | "time";
  onMode: (m: "distance" | "time") => void;
  km: number;
  onKm: (km: number) => void;
  minutes: number;
  onMinutes: (m: number) => void;
  style: RouteStyle;
  styles: { id: RouteStyle; name: string }[];
  onStyle: (s: RouteStyle) => void;
  dir: number | null;
  onDir: (d: number | null) => void;
  via: { label: string; position: LatLng } | null;
  onVia: (v: { label: string; position: LatLng } | null) => void;
  start: LoopStart;
  onStart: (s: LoopStart) => void;
  /** The current first stop, offered as a start point. */
  firstStop?: string;
  /** Home's name, when one is set. */
  home?: string;
  near: LatLng;
  busy: boolean;
  onCreate: () => void;
  onClose: () => void;
}

/** A page of its own for planning a loop: how far, from where, which way. */
export default function RoundTripScreen(p: Props) {
  // On the body, above the map and the planner panel.
  return createPortal(
    <div className="screen" role="dialog" aria-modal="true" aria-labelledby="rt-title">
      <header className="screen-head">
        <button className="icon" aria-label="Back to the map" onClick={p.onClose}>
          <Icon name="back" size={24} />
        </button>
        <h2 id="rt-title">Plan a round trip</h2>
      </header>
      <div className="screen-body">
        <div className="segmented two" role="radiogroup" aria-label="Plan the loop by">
          {(["distance", "time"] as const).map((m) => (
            <button key={m} role="radio" aria-checked={p.mode === m} onClick={() => p.onMode(m)}>
              {m === "distance" ? "Length" : "Riding time"}
            </button>
          ))}
        </div>
        <output className="rt-big" htmlFor={p.mode === "distance" ? "loop-km" : "loop-min"}>
          {p.mode === "distance" ? `${p.km} km` : formatDuration(p.minutes * 60)}
        </output>
        {p.mode === "distance" ? (
          <input
            id="loop-km"
            className="rt-range"
            type="range"
            min={20}
            max={500}
            step={10}
            value={p.km}
            onChange={(e) => p.onKm(+e.target.value)}
            aria-label="Round trip length"
          />
        ) : (
          <input
            id="loop-min"
            className="rt-range"
            type="range"
            min={30}
            max={480}
            step={15}
            value={p.minutes}
            onChange={(e) => p.onMinutes(+e.target.value)}
            aria-label="Round trip riding time"
          />
        )}

        <div className="rt-rows">
          <label className="rt-row">
            <span>Start from</span>
            <select id="rt-start" value={p.start} onChange={(e) => p.onStart(e.target.value as LoopStart)}>
              <option value="here">Current location</option>
              {p.home && <option value="home">Home · {p.home}</option>}
              {p.firstStop && <option value="first">A · {p.firstStop}</option>}
            </select>
          </label>
          <label className="rt-row">
            <span>Routing profile</span>
            <select id="rt-style" value={p.style} onChange={(e) => p.onStyle(e.target.value as RouteStyle)}>
              {p.styles.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="rt-row">
            <span>Head towards</span>
            <select
              id="rt-dir"
              value={p.dir ?? "any"}
              disabled={!!p.via}
              onChange={(e) => p.onDir(e.target.value === "any" ? null : +e.target.value)}
            >
              {COMPASS.map((c) => (
                <option key={c.label} value={c.deg ?? "any"}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <div className="rt-row via">
            <span>Via a place</span>
            {p.via ? (
              <span className="chip">
                {p.via.label}
                <button aria-label={`Don't ride via ${p.via.label}`} onClick={() => p.onVia(null)}>
                  <Icon name="close" size={16} />
                </button>
              </span>
            ) : (
              <PlaceSearch near={p.near} placeholder="Optional" onPick={(label, position) => p.onVia({ label, position })} />
            )}
          </div>
        </div>
      </div>
      <footer className="screen-foot">
        <button className="primary big" onClick={p.onCreate} disabled={p.busy || (p.start === "first" && !p.firstStop) || (p.start === "home" && !p.home)}>
          {p.busy ? "Finding you…" : "Create a round trip"}
        </button>
      </footer>
    </div>,
    document.body,
  );
}
