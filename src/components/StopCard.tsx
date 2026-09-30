import { useEffect, useState } from "react";
import Icon from "./Icon";
import { STYLE_ICONS } from "./StopList";
import { bearing, compassName, distance, formatDistance, formatDuration, type LatLng } from "../lib/geo";
import type { RouteStyle } from "../lib/routes";
import type { Stop } from "../lib/storage";

interface Props {
  stop: Stop;
  index: number;
  kind: "start" | "via" | "end";
  /** The stop before this one (whose ride style is the way here). */
  prev: Stop | null;
  routeStyle: RouteStyle;
  styles: { id: RouteStyle; name: string }[];
  /** Distance and time of each leg, when planned. */
  legs: { distance: number; duration: number }[] | null;
  /** Where the rider is, if known. */
  me: LatLng | null;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onRename: (label: string) => void;
  onLegStyle: (style: RouteStyle | undefined) => void;
  onMove: (dir: -1 | 1) => void;
  onSetDestination: (() => void) | null;
  onRoundTrip: () => void;
  onRemove: () => void;
  onClose: () => void;
}

/**
 * What a tapped pin can do: rename it, choose how to ride there, see how
 * far it is, and move, reuse or delete it. Drag the pin to move it.
 */
export default function StopCard(p: Props) {
  const { stop, index, kind } = p;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(stop.label);
  useEffect(() => {
    setEditing(false);
    setName(stop.label);
  }, [stop.id, stop.label]);

  const save = () => {
    const v = name.trim();
    if (v && v !== stop.label) p.onRename(v);
    setEditing(false);
  };
  const style = p.prev ? (p.prev.legStyle ?? p.routeStyle) : null;
  const sofar = p.legs && index > 0 && p.legs.length >= index ? p.legs.slice(0, index) : null;
  const away = p.me ? distance(p.me, stop.position) : null;

  return (
    <div className="sight-card stop-card" role="dialog" aria-label={`Stop: ${stop.label}`}>
      <div className="sight-body">
        <div className="stop-card-head">
          <span className={`tl-badge ${kind}`} aria-hidden>
            {kind === "start" ? <Icon name="navigate" size={16} filled /> : kind === "end" ? <Icon name="flag" size={16} /> : index}
          </span>
          {editing ? (
            <form
              className="stop-rename"
              onSubmit={(e) => {
                e.preventDefault();
                save();
              }}
            >
              <input aria-label="Stop name" value={name} autoFocus maxLength={80} onChange={(e) => setName(e.target.value)} onBlur={save} />
            </form>
          ) : (
            <button className="stop-name" aria-label={`Rename ${stop.label}`} onClick={() => setEditing(true)}>
              <strong>{stop.label}</strong>
              <Icon name="edit" size={16} />
            </button>
          )}
        </div>
        {away != null && away > 50 && (
          <small>
            {formatDistance(away)} away from you, towards the {compassName(bearing(p.me!, stop.position))}
          </small>
        )}
        <small>
          {sofar && (
            <>
              {formatDistance(sofar.reduce((a, l) => a + l.distance, 0))} · {formatDuration(sofar.reduce((a, l) => a + l.duration, 0))} from the start ·{" "}
            </>
          )}
          Drag the pin to move it
        </small>

        {style && (
          <>
            <small className="stop-card-label">Route to here</small>
            <div className="stop-styles" role="radiogroup" aria-label="Ride style to here">
              {p.styles.map((x) => (
                <button key={x.id} role="radio" aria-checked={style === x.id} onClick={() => p.onLegStyle(x.id === p.routeStyle ? undefined : x.id)}>
                  <Icon name={STYLE_ICONS[x.id]} size={18} /> {x.name}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="stop-actions">
          {p.onSetDestination && (
            <button onClick={p.onSetDestination}>
              <Icon name="flag" size={16} /> Destination
            </button>
          )}
          <button onClick={p.onRoundTrip}>
            <Icon name="loop" size={16} /> Round trip
          </button>
          {p.canMoveUp && (
            <button aria-label="Move earlier in the route" onClick={() => p.onMove(-1)}>
              <Icon name="up" size={16} /> Earlier
            </button>
          )}
          {p.canMoveDown && (
            <button aria-label="Move later in the route" onClick={() => p.onMove(1)}>
              <Icon name="down" size={16} /> Later
            </button>
          )}
          <button className="danger-text" aria-label="Delete stop" onClick={p.onRemove}>
            <Icon name="trash" size={16} /> Delete
          </button>
        </div>
      </div>
      <button className="close" aria-label="Close" onClick={p.onClose}>
        ✕
      </button>
    </div>
  );
}
