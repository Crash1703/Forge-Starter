import { useEffect, useRef, useState } from "react";
import Icon, { type IconName } from "./Icon";
import { formatDistance, formatDuration } from "../lib/geo";
import type { RouteStyle } from "../lib/routes";
import type { Stop } from "../lib/storage";

export const STYLE_ICONS: Record<RouteStyle, IconName> = { fastest: "motorway", scenic: "road", twisty: "twisty" };

interface Props {
  stops: Stop[];
  loop: boolean;
  styles: { id: RouteStyle; name: string }[];
  /** The route's own style, used by legs without one of their own. */
  routeStyle: RouteStyle;
  /** Distance and time of each leg, when a route has been planned. */
  legs: { distance: number; duration: number }[] | null;
  onReorder: (from: number, to: number) => void;
  onRemove: (id: string) => void;
  onLegStyle: (id: string, style: RouteStyle | undefined) => void;
  /** Add a stop at this position in the list. */
  onInsert: (at: number) => void;
  onShow: (stop: Stop) => void;
  onSetDestination: (id: string) => void;
  onRoundTrip: (stop: Stop) => void;
  /** A menu opened: make room for it. */
  onMenuOpen?: () => void;
}

/** Collapse the stops in between once there are this many. */
const COLLAPSE_AT = 3;

/**
 * The route as a timeline: start, each leg (with its ride style, distance
 * and time, and a + to add a stop there), the stops, and the finish.
 */
export default function StopList(p: Props) {
  const { stops, loop } = p;
  const vias = stops.length - (loop ? 1 : 2);
  const [open, setOpen] = useState(vias < COLLAPSE_AT);
  const [menu, setMenu] = useState<string | null>(null);
  const drag = useRef<number | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // A whole new set of stops (a new loop, a saved route) starts collapsed if
  // long; adding or removing one keeps the rider's choice. Few stops: open.
  const seen = useRef(new Set(stops.map((s) => s.id)));
  const ids = stops.map((s) => s.id).join("|");
  useEffect(() => {
    const kept = stops.filter((s) => seen.current.has(s.id)).length;
    if (vias < COLLAPSE_AT) setOpen(true);
    else if (kept <= 1) setOpen(false);
    seen.current = new Set(stops.map((s) => s.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

  // An opened menu may start below the fold: bring it into view.
  useEffect(() => {
    if (menu) p.onMenuOpen?.();
    if (menu) root.current?.querySelector(".tl-menu-wrap .menu")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [menu]);

  // A tap outside an open menu closes it.
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => !(e.target as Element).closest?.(".tl-menu-wrap") && setMenu(null);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);

  if (!stops.length) return null;
  const last = stops.length - 1;
  const finishIsStop = !loop && stops.length > 1;
  // Legs run from each stop to the next, and home again on a loop.
  const legCount = loop ? stops.length : stops.length - 1;

  const card = (s: Stop, i: number) => {
    const kind = i === 0 ? "start" : i === last && finishIsStop ? "end" : "via";
    const id = `m-${s.id}`;
    return (
      <li
        key={s.id}
        className={`tl-stop ${kind}`}
        draggable
        onDragStart={() => (drag.current = i)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => {
          if (drag.current != null) p.onReorder(drag.current, i);
          drag.current = null;
        }}
      >
        <span className="tl-grip" aria-hidden>
          <Icon name="grip" size={18} />
        </span>
        <span className={`tl-badge ${kind}`} aria-label={kind === "start" ? "Start" : kind === "end" ? "Finish" : `Stop ${i}`}>
          {kind === "start" ? <Icon name="navigate" size={16} filled /> : kind === "end" ? <Icon name="flag" size={16} /> : i}
        </span>
        <span className="label" title={s.label}>
          {s.label}
        </span>
        <div className="tl-menu-wrap">
          <button className="tl-more" aria-label={`Options for ${s.label}`} aria-expanded={menu === id} onClick={() => setMenu(menu === id ? null : id)}>
            <Icon name="more" size={22} />
          </button>
          {menu === id && (
            <div className="menu" role="menu">
              <button role="menuitem" onClick={() => (setMenu(null), p.onShow(s))}>
                <Icon name="pin" size={18} /> Show on map
              </button>
              {i !== last && (
                <button role="menuitem" onClick={() => (setMenu(null), p.onSetDestination(s.id))}>
                  <Icon name="flag" size={18} /> Set as destination
                </button>
              )}
              <button role="menuitem" onClick={() => (setMenu(null), p.onRoundTrip(s))}>
                <Icon name="loop" size={18} /> {i > 0 ? "Round trip to here" : "Start round trip here"}
              </button>
              {i > 0 && (
                <button role="menuitem" onClick={() => (setMenu(null), p.onReorder(i, i - 1))}>
                  <Icon name="up" size={18} /> Move up
                </button>
              )}
              {i < last && (
                <button role="menuitem" onClick={() => (setMenu(null), p.onReorder(i, i + 1))}>
                  <Icon name="down" size={18} /> Move down
                </button>
              )}
              <button role="menuitem" className="danger-text" aria-label="Remove stop" onClick={() => (setMenu(null), p.onRemove(s.id))}>
                <Icon name="trash" size={18} /> Remove {i === 0 ? "start" : "stop"}
              </button>
            </div>
          )}
        </div>
      </li>
    );
  };

  const leg = (i: number) => {
    const from = stops[i];
    const style = from.legStyle ?? p.routeStyle;
    const info = p.legs?.[i];
    const id = `l-${from.id}`;
    return (
      <li key={`leg-${from.id}`} className="tl-leg">
        <button className="tl-add" aria-label={`Add a stop after ${from.label}`} onClick={() => p.onInsert(i + 1)}>
          <Icon name="plusCircle" size={22} />
        </button>
        <div className="tl-menu-wrap">
          <button
            className={`tl-style${from.legStyle ? " own" : ""}`}
            aria-label={`Ride style from ${from.label}: ${p.styles.find((x) => x.id === style)?.name}`}
            aria-expanded={menu === id}
            onClick={() => setMenu(menu === id ? null : id)}
          >
            <Icon name={STYLE_ICONS[style]} size={18} /> {p.styles.find((x) => x.id === style)?.name}
            <Icon name="chevronDown" size={16} />
          </button>
          {menu === id && (
            <div className="menu" role="menu">
              {p.styles.map((x) => (
                <button
                  key={x.id}
                  role="menuitemradio"
                  aria-checked={style === x.id}
                  onClick={() => {
                    setMenu(null);
                    p.onLegStyle(from.id, x.id === p.routeStyle ? undefined : x.id);
                  }}
                >
                  <Icon name={STYLE_ICONS[x.id]} size={18} /> {x.name}
                  {style === x.id && <Icon name="check" size={16} className="tick" />}
                </button>
              ))}
            </div>
          )}
        </div>
        {info && (
          <span className="tl-info">
            {formatDistance(info.distance)} · {formatDuration(info.duration)}
          </span>
        )}
      </li>
    );
  };

  const items: React.ReactNode[] = [];
  const middle = stops.slice(1, finishIsStop ? last : undefined);
  items.push(card(stops[0], 0));
  if (!open) {
    items.push(
      <li key="collapsed" className="tl-collapsed">
        <button onClick={() => setOpen(true)}>
          <Icon name="pin" size={18} /> {middle.length} via points
        </button>
      </li>,
    );
  } else {
    for (let i = 0; i < legCount; i++) {
      items.push(leg(i));
      const next = i + 1;
      if (next <= last && !(next === last && finishIsStop)) items.push(card(stops[next], next));
    }
    if (vias >= COLLAPSE_AT) {
      items.push(
        <li key="hide" className="tl-collapsed">
          <button onClick={() => setOpen(false)}>Hide via points</button>
        </li>,
      );
    }
  }
  if (finishIsStop) items.push(card(stops[last], last));
  else if (loop && stops.length > 1)
    items.push(
      <li key="home" className="tl-stop end finish-row">
        <span className="tl-grip" aria-hidden />
        <span className="tl-badge end" aria-label="Finish">
          <Icon name="flag" size={16} />
        </span>
        <span className="label">Back to {stops[0].label}</span>
      </li>,
    );

  return (
    <div className="timeline" ref={root}>
      <ol className="stops">{items}</ol>
    </div>
  );
}
