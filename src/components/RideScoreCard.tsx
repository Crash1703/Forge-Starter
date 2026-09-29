import type { RideScore } from "../lib/rideScore";

interface Props {
  score: RideScore;
  /** Still fetching road details (town, surface). */
  loading?: boolean;
}

const PARTS: { key: "curves" | "flow" | "rural" | "hills" | "sealed"; name: string; hint: string }[] = [
  { key: "curves", name: "Curves", hint: "Good bends per km (street corners don't count)" },
  { key: "flow", name: "Flow", hint: "Few junctions, turns and towns" },
  { key: "rural", name: "Rural", hint: "Out of towns" },
  { key: "hills", name: "Hills", hint: "Climbing per km" },
  { key: "sealed", name: "Sealed", hint: "On sealed roads" },
];

/**
 * RideScore: how good the route is to ride, 0–100, with what makes it up,
 * so the rider can see why one route beats another.
 */
export default function RideScoreCard({ score, loading }: Props) {
  return (
    <section className="ride-score" aria-label={`RideScore ${score.score} out of 100`}>
      <div className="ride-score-head">
        <strong>{score.score}</strong>
        <span>
          RideScore
          <small>{loading ? "Checking the roads…" : "out of 100"}</small>
        </span>
      </div>
      <dl>
        {PARTS.map((p) => {
          const v = score[p.key];
          return (
            <div key={p.key} title={p.hint}>
              <dt>{p.name}</dt>
              <dd>
                <span className="bar" aria-hidden>
                  <span style={{ width: `${v ?? 0}%` }} />
                </span>
                <span className="num">{v ?? "–"}</span>
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
