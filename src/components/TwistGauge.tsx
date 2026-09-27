import { curvinessLabel, twistScore } from "../lib/geo";
import { TWIST_COLOURS } from "./MapView";

interface Props {
  /** Degrees of turning per km. */
  curviness: number;
  size?: "small" | "large";
}

/**
 * A 0–10 twistiness dial: an arc that fills and changes colour with the
 * score, the same colours the route line uses.
 */
export default function TwistGauge({ curviness, size = "large" }: Props) {
  const score = twistScore(curviness);
  const level = score >= 9 ? 3 : score >= 5 ? 2 : score >= 2.25 ? 1 : 0;
  const r = 34;
  const arc = Math.PI * r; // half circle
  const filled = (score / 10) * arc;
  const label = curvinessLabel(curviness);
  return (
    <figure className={`gauge gauge-${size}`} aria-label={`Twistiness ${score.toFixed(1)} out of 10: ${label}`}>
      <svg viewBox="0 0 84 48" aria-hidden="true">
        <path d="M 8 44 A 34 34 0 0 1 76 44" className="gauge-track" />
        <path
          d="M 8 44 A 34 34 0 0 1 76 44"
          className="gauge-fill"
          style={{ stroke: TWIST_COLOURS[level], strokeDasharray: `${filled} ${arc}` }}
        />
        <text x="42" y="42" textAnchor="middle" className="gauge-value">
          {score.toFixed(1)}
        </text>
      </svg>
      <figcaption>{label}</figcaption>
    </figure>
  );
}
