import { useEffect, useRef, useState, type ReactNode } from "react";

export type Snap = "peek" | "half" | "full";

interface Props {
  snap: Snap;
  onSnap: (s: Snap) => void;
  /** Reports how many pixels of the screen the panel covers, so the map can keep clear of it. */
  onCover: (px: number) => void;
  children: ReactNode;
}

const PEEK = 148;
const phoneQuery = "(max-width: 760px)";

function useIsPhone() {
  const [phone, setPhone] = useState(() => window.matchMedia(phoneQuery).matches);
  useEffect(() => {
    const mq = window.matchMedia(phoneQuery);
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

function useViewportHeight() {
  const [h, setH] = useState(window.innerHeight);
  useEffect(() => {
    const on = () => setH(window.innerHeight);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return h;
}

/**
 * The planner. On desktop, a side panel. On phones, a panel over a
 * full-screen map that rests at three heights (a peek at the summary, half,
 * or nearly full) and follows your finger when you drag its handle.
 */
export default function BottomSheet({ snap, onSnap, onCover, children }: Props) {
  const phone = useIsPhone();
  const vh = useViewportHeight();
  const heights: Record<Snap, number> = { peek: PEEK, half: Math.round(vh * 0.5), full: vh - 64 };
  const [drag, setDrag] = useState<number | null>(null); // px dragged up (+) or down (-)
  const start = useRef<{ y: number; t: number; moved: boolean } | null>(null);

  const visible = Math.min(heights.full, Math.max(PEEK, heights[snap] + (drag ?? 0)));

  useEffect(() => {
    onCover(phone ? heights[snap] : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone, snap, vh]);

  if (!phone) return <aside className="panel">{children}</aside>;

  const onDown = (e: React.PointerEvent) => {
    start.current = { y: e.clientY, t: performance.now(), moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    const dy = start.current.y - e.clientY;
    if (Math.abs(dy) > 6) start.current.moved = true;
    if (start.current.moved) setDrag(dy);
  };
  const onUp = (e: React.PointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    if (!s.moved) {
      // A tap on the handle steps up, and from full back down to the peek.
      onSnap(snap === "peek" ? "half" : snap === "half" ? "full" : "peek");
      setDrag(null);
      return;
    }
    const dy = s.y - e.clientY;
    const speed = dy / Math.max(1, performance.now() - s.t); // px per ms, + is up
    const target = heights[snap] + dy + speed * 250; // a flick carries on a little
    const order: Snap[] = ["peek", "half", "full"];
    const nearest = order.reduce((a, b) => (Math.abs(heights[b] - target) < Math.abs(heights[a] - target) ? b : a));
    setDrag(null);
    onSnap(nearest);
  };

  return (
    <aside
      className={`panel sheet${drag != null ? " dragging" : ""}`}
      style={{ height: heights.full, transform: `translateY(${heights.full - visible}px)` }}
      aria-label="Route planner"
    >
      <div
        className="sheet-handle"
        role="button"
        tabIndex={0}
        aria-label={snap === "full" ? "Collapse planner" : "Expand planner"}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => {
          start.current = null;
          setDrag(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSnap(snap === "full" ? "peek" : snap === "peek" ? "half" : "full");
          }
        }}
      >
        <span />
      </div>
      {children}
    </aside>
  );
}
