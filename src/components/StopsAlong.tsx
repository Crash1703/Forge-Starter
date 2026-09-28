import { useEffect, useState } from "react";
import { formatDistance, type LatLng } from "../lib/geo";
import type { RouteResult } from "../lib/routes";
import { fuelGaps, poisAlong, type Poi } from "../lib/pois";

interface Props {
  route: RouteResult;
  /** What to mark on the map. */
  onPois: (pois: Poi[]) => void;
  onFocus: (p: LatLng) => void;
}

const RANGE_KEY = "forge.tankRange";
const loadRange = () => {
  try {
    return Number(localStorage.getItem(RANGE_KEY)) || 200;
  } catch {
    return 200;
  }
};

/**
 * Fuel and cafés along the route, looked up on request (the map data server
 * is free and shared), with a warning for long stretches without fuel.
 */
export default function StopsAlong({ route, onPois, onFocus }: Props) {
  const [pois, setPois] = useState<Poi[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [range, setRange] = useState(loadRange);
  const [show, setShow] = useState<"all" | "fuel" | "cafe">("all");

  // A different route: the old stops no longer apply.
  useEffect(() => {
    setPois(null);
    setError("");
    onPois([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  async function find() {
    setBusy(true);
    setError("");
    try {
      const found = await poisAlong(route.path);
      setPois(found);
      onPois(found);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const gaps = pois ? fuelGaps(pois, route.distance, range * 1000) : [];
  const shown = (pois ?? []).filter((p) => show === "all" || p.kind === show);
  const fuelCount = pois?.filter((p) => p.kind === "fuel").length ?? 0;

  return (
    <div className="along">
      <h2>Fuel &amp; cafés on the way</h2>
      {!pois ? (
        <>
          <button className="wide" onClick={find} disabled={busy}>
            {busy ? "Looking along the route…" : "⛽ Find fuel & cafés"}
          </button>
          {error && <p className="error">{error}</p>}
        </>
      ) : (
        <>
          <div className="along-head">
            <div className="segmented three" role="radiogroup" aria-label="Show">
              {(["all", "fuel", "cafe"] as const).map((k) => (
                <button key={k} role="radio" aria-checked={show === k} onClick={() => setShow(k)}>
                  {k === "all" ? "All" : k === "fuel" ? `⛽ ${fuelCount}` : `☕ ${pois.length - fuelCount}`}
                </button>
              ))}
            </div>
            <label className="range">
              Tank range
              <input
                id="tank-range"
                type="number"
                min={50}
                max={800}
                step={10}
                value={range}
                onChange={(e) => {
                  const v = Math.max(50, Math.min(800, +e.target.value || 200));
                  setRange(v);
                  try {
                    localStorage.setItem(RANGE_KEY, String(v));
                  } catch {
                    /* remembered for this visit */
                  }
                }}
              />
              km
            </label>
          </div>
          {gaps.map((g) => (
            <p key={g.from} className="warning">
              ⛽ No fuel for {formatDistance(g.to - g.from)}
              {g.from < 1000 ? " from the start" : ` after ${formatDistance(g.from)}`}. Fill up before then.
            </p>
          ))}
          {shown.length === 0 ? (
            <p className="hint">Nothing found within a few hundred metres of the route.</p>
          ) : (
            <ol className="along-list">
              {shown.map((p) => (
                <li key={p.id}>
                  <button onClick={() => onFocus(p.position)}>
                    <span aria-hidden>{p.kind === "fuel" ? "⛽" : "☕"}</span>
                    <strong>{p.name}</strong>
                    <small>{formatDistance(p.at)}</small>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
