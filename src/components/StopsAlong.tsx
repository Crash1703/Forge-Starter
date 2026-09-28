import { useEffect, useRef, useState } from "react";
import Icon, { POI_ICONS } from "./Icon";
import { formatDistance, type LatLng } from "../lib/geo";
import type { RouteResult } from "../lib/routes";
import { fuelGaps, poisAlong, POI_KINDS, type Poi, type PoiKind } from "../lib/pois";

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

type Lookup = { state: "busy" } | { state: "done"; pois: Poi[] } | { state: "failed"; message: string };

/**
 * Places along the route by kind (fuel, cafés, food, pubs, toilets,
 * lookouts): tap a kind to look it up and mark it on the map, tap again to
 * hide it. Each kind is its own small lookup (the map data server is free
 * and shared), with a warning for long stretches without fuel.
 */
export default function StopsAlong({ route, onPois, onFocus }: Props) {
  const [on, setOn] = useState<PoiKind[]>([]);
  const [found, setFound] = useState<Partial<Record<PoiKind, Lookup>>>({});
  const [range, setRange] = useState(loadRange);
  const ctrls = useRef(new Map<PoiKind, AbortController>());

  // A different route: the old stops no longer apply.
  useEffect(() => {
    ctrls.current.forEach((c) => c.abort());
    ctrls.current.clear();
    setOn([]);
    setFound({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  // Mark what's switched on.
  const shown = on.flatMap((k) => {
    const f = found[k];
    return f?.state === "done" ? f.pois : [];
  });
  const shownKey = shown.map((p) => p.id).join("|");
  useEffect(() => {
    onPois(shown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey]);

  function look(kind: PoiKind) {
    ctrls.current.get(kind)?.abort();
    const ctrl = new AbortController();
    ctrls.current.set(kind, ctrl);
    setFound((f) => ({ ...f, [kind]: { state: "busy" } }));
    poisAlong(route.path, kind, ctrl.signal)
      .then((pois) => setFound((f) => ({ ...f, [kind]: { state: "done", pois } })))
      .catch((e: Error) => e.name !== "AbortError" && setFound((f) => ({ ...f, [kind]: { state: "failed", message: e.message } })));
  }

  function toggle(kind: PoiKind) {
    const f = found[kind];
    if (on.includes(kind) && f?.state !== "failed") {
      setOn((o) => o.filter((k) => k !== kind));
      return;
    }
    if (!on.includes(kind)) setOn((o) => [...o, kind]);
    // Look it up the first time, or again after a failure.
    if (!f || f.state === "failed") look(kind);
  }

  const fuel = found.fuel?.state === "done" && on.includes("fuel") ? found.fuel.pois : null;
  const gaps = fuel ? fuelGaps(fuel, route.distance, range * 1000) : [];
  const list = shown.slice().sort((a, b) => a.at - b.at);
  const failed = on.filter((k) => found[k]?.state === "failed");
  const busy = on.filter((k) => found[k]?.state === "busy");
  const kindName = (k: PoiKind) => POI_KINDS.find((x) => x.kind === k)!.name;

  return (
    <div className="along">
      <h2>On the way</h2>
      <div className="along-kinds" role="group" aria-label="Show along the route">
        {POI_KINDS.map((k) => {
          const f = found[k.kind];
          const count = f?.state === "done" ? f.pois.length : null;
          return (
            <button
              key={k.kind}
              className={`along-kind${f?.state === "busy" ? " busy" : ""}${f?.state === "failed" ? " failed" : ""}`}
              aria-pressed={on.includes(k.kind)}
              onClick={() => toggle(k.kind)}
            >
              <Icon name={POI_ICONS[k.kind]} size={18} />
              {k.name}
              {count != null && on.includes(k.kind) && <small>{count}</small>}
            </button>
          );
        })}
      </div>
      {busy.length > 0 && (
        <p className="hint" role="status">
          Looking for {busy.map((k) => kindName(k).toLowerCase()).join(", ")} along the route…
        </p>
      )}
      {failed.map((k) => (
        <p key={k} className="error">
          {kindName(k)}: {(found[k] as { message: string }).message}{" "}
          <button className="link" onClick={() => look(k)}>
            Try again
          </button>
        </p>
      ))}
      {fuel && (
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
      )}
      {gaps.map((g) => (
        <p key={g.from} className="warning">
          <Icon name="fuel" size={16} /> No fuel for {formatDistance(g.to - g.from)}
          {g.from < 1000 ? " from the start" : ` after ${formatDistance(g.from)}`}. Fill up before then.
        </p>
      ))}
      {on.length > 0 && busy.length === 0 && list.length === 0 && failed.length === 0 && (
        <p className="hint">Nothing found within a few hundred metres of the route.</p>
      )}
      {list.length > 0 && (
        <ol className="along-list">
          {list.map((p) => (
            <li key={p.id}>
              <button onClick={() => onFocus(p.position)}>
                <Icon name={POI_ICONS[p.kind]} size={18} />
                <strong>{p.name}</strong>
                <small>{formatDistance(p.at)}</small>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
