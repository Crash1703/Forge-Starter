import { useState } from "react";
import type { ElevationProfile } from "../lib/elevation";
import { formatDistance, type LatLng } from "../lib/geo";

interface Props {
  profile: ElevationProfile;
  onHover: (p: LatLng | null) => void;
}

const W = 320;
const H = 110;
const PAD = { l: 34, r: 6, t: 8, b: 18 };

export default function ElevationChart({ profile, onHover }: Props) {
  const [idx, setIdx] = useState<number | null>(null);
  const { points, min, max } = profile;
  const total = points[points.length - 1]?.at || 1;
  const lo = Math.floor(min / 50) * 50;
  const hi = Math.max(lo + 100, Math.ceil(max / 50) * 50);
  const x = (at: number) => PAD.l + ((W - PAD.l - PAD.r) * at) / total;
  const y = (e: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - (e - lo) / (hi - lo));
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)},${y(p.elevation).toFixed(1)}`).join("");
  const area = `${line}L${x(total)},${H - PAD.b}L${x(0)},${H - PAD.b}Z`;
  const cur = idx != null ? points[idx] : null;

  function move(e: React.PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const fx = ((e.clientX - r.left) / r.width) * W;
    const at = ((fx - PAD.l) / (W - PAD.l - PAD.r)) * total;
    const i = Math.max(0, Math.min(points.length - 1, Math.round((at / total) * (points.length - 1))));
    setIdx(i);
    onHover(points[i].position);
  }

  return (
    <figure className="elevation">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Elevation from ${Math.round(min)} to ${Math.round(max)} metres`}
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
        <text x={PAD.l} y={H - 4} className="tick">0</text>
        <text x={W - PAD.r} y={H - 4} className="tick" textAnchor="end">
          {formatDistance(total)}
        </text>
        {cur && (
          <g>
            <line x1={x(cur.at)} x2={x(cur.at)} y1={PAD.t} y2={H - PAD.b} className="cursor" />
            <circle cx={x(cur.at)} cy={y(cur.elevation)} r={3.5} className="dot" />
          </g>
        )}
      </svg>
      <figcaption>
        {cur ? (
          <>
            {formatDistance(cur.at)} · <strong>{Math.round(cur.elevation)} m</strong>
          </>
        ) : (
          <>
            ↗ {Math.round(profile.ascent)} m · ↘ {Math.round(profile.descent)} m · max {Math.round(max)} m
          </>
        )}
      </figcaption>
    </figure>
  );
}
