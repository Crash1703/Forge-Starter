import { useState } from "react";
import type { LatLng } from "../lib/geo";

export interface ChartPoint {
  at: number; // metres along the ride
  value: number;
  position: LatLng;
}

interface Props {
  points: ChartPoint[];
  /** e.g. "km/h" */
  unit: string;
  /** Shown under the chart when nothing is hovered. */
  caption: string;
  label: string;
  onHover: (p: LatLng | null) => void;
}

const W = 320;
const H = 110;
const PAD = { l: 34, r: 6, t: 8, b: 18 };

/** A value along a ride (speed, say), with a hover that points at the spot on the map. */
export default function LineChart({ points, unit, caption, label, onHover }: Props) {
  const [idx, setIdx] = useState<number | null>(null);
  if (points.length < 2) return null;
  const values = points.map((p) => p.value);
  const step = Math.max(...values) > 120 ? 50 : 20;
  const lo = Math.floor(Math.min(...values) / step) * step;
  const hi = Math.max(lo + step, Math.ceil(Math.max(...values) / step) * step);
  const total = points[points.length - 1].at || 1;
  const x = (at: number) => PAD.l + ((W - PAD.l - PAD.r) * at) / total;
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - lo) / (hi - lo));
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
  const area = `${line}L${x(total)},${H - PAD.b}L${x(0)},${H - PAD.b}Z`;
  const cur = idx != null ? points[idx] : null;

  function move(e: React.PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const at = ((((e.clientX - r.left) / r.width) * W - PAD.l) / (W - PAD.l - PAD.r)) * total;
    let i = 0;
    while (i < points.length - 1 && points[i].at < at) i++;
    setIdx(i);
    onHover(points[i].position);
  }

  return (
    <figure className="elevation">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={label}
        onPointerMove={move}
        onPointerLeave={() => {
          setIdx(null);
          onHover(null);
        }}
      >
        {[lo, (lo + hi) / 2, hi].map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="grid" />
            <text x={PAD.l - 4} y={y(v) + 3} className="tick" textAnchor="end">
              {Math.round(v)}
            </text>
          </g>
        ))}
        <path d={area} className="area" />
        <path d={line} className="line" />
        <text x={PAD.l} y={H - 4} className="tick">
          0
        </text>
        <text x={W - PAD.r} y={H - 4} className="tick" textAnchor="end">
          {(total / 1000).toFixed(0)} km
        </text>
        {cur && (
          <g>
            <line x1={x(cur.at)} x2={x(cur.at)} y1={PAD.t} y2={H - PAD.b} className="cursor" />
            <circle cx={x(cur.at)} cy={y(cur.value)} r={3.5} className="dot" />
          </g>
        )}
      </svg>
      <figcaption>
        {cur ? (
          <>
            {(cur.at / 1000).toFixed(1)} km ·{" "}
            <strong>
              {Math.round(cur.value)} {unit}
            </strong>
          </>
        ) : (
          caption
        )}
      </figcaption>
    </figure>
  );
}
