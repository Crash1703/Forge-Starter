import { useEffect, useMemo, useState } from "react";
import ElevationChart from "./ElevationChart";
import Icon from "./Icon";
import LineChart, { type ChartPoint } from "./LineChart";
import { distance, formatDistance, formatDuration, formatTime, speedUnit, toSpeed, type LatLng } from "../lib/geo";
import { elevationProfile, type ElevationProfile } from "../lib/elevation";
import { speeds, trackPath, type RideRecord } from "../lib/recorder";

interface Props {
  rides: RideRecord[];
  selected: RideRecord | null;
  showHistory: boolean;
  onToggleHistory: (on: boolean) => void;
  onSelect: (ride: RideRecord | null) => void;
  onDelete: (ride: RideRecord) => void;
  onPlanAgain: (ride: RideRecord) => void;
  onExport: (ride: RideRecord) => void;
  onHover: (p: LatLng | null) => void;
}

const date = (t: number) =>
  new Date(t).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });

/** The logbook: every recorded ride, and the details of one. */
export default function RidesPanel(props: Props) {
  const { rides, selected } = props;
  if (selected) return <RideDetail {...props} ride={selected} />;
  return (
    <div className="scroll">
      <section>
        <label className="check">
          <input
            id="show-history"
            type="checkbox"
            checked={props.showHistory}
            onChange={(e) => props.onToggleHistory(e.target.checked)}
          />
          Show my rides on the map
        </label>
        <p className="hint">Tap the red record button on the map to record a ride. Rides in Ride mode are recorded automatically.</p>
      </section>
      {rides.length === 0 ? (
        <p className="empty">No rides yet. Your recorded rides will appear here.</p>
      ) : (
        <ul className="saved">
          {rides.map((r) => (
            <li key={r.id}>
              <button className="open" onClick={() => props.onSelect(r)}>
                <strong>{r.name}</strong>
                <span>
                  {formatDistance(r.stats.distance)} · {formatDuration(r.stats.movingTime)} · top {Math.round(toSpeed(r.stats.maxSpeed))} {speedUnit()}
                </span>
                <small>{date(r.startedAt)}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RideDetail({ ride, onSelect, onDelete, onPlanAgain, onExport, onHover }: Props & { ride: RideRecord }) {
  const s = ride.stats;
  const [profile, setProfile] = useState<ElevationProfile | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const path = useMemo(() => trackPath(ride.points), [ride]);

  useEffect(() => {
    setProfile(null);
    const ctrl = new AbortController();
    elevationProfile(path, ctrl.signal)
      .then(setProfile)
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [path]);

  // Speed along the ride, smoothed over ~5 points so GPS jitter doesn't dominate.
  const speedPoints = useMemo<ChartPoint[]>(() => {
    const v = speeds(ride.points);
    let at = 0;
    const out: ChartPoint[] = [];
    const every = Math.max(1, Math.floor(path.length / 250));
    for (let i = 0; i < path.length; i++) {
      if (i) at += distance(path[i - 1], path[i]);
      if (i % every) continue;
      const w = v.slice(Math.max(0, i - 2), i + 3);
      out.push({ at, value: toSpeed((w.reduce((a, b) => a + b, 0) / w.length) * 3.6), position: path[i] });
    }
    return out;
  }, [ride, path]);

  return (
    <div className="scroll">
      <section>
        <button className="link back" onClick={() => onSelect(null)}>
          ‹ All rides
        </button>
        <h3 className="ride-title">{ride.name}</h3>
        <p className="hint">
          {date(ride.startedAt)} · {formatTime(ride.startedAt)}
        </p>
        <dl className="stats">
          <div>
            <dt>Distance</dt>
            <dd>{formatDistance(s.distance)}</dd>
          </div>
          <div>
            <dt>Riding time</dt>
            <dd>{formatDuration(s.movingTime)}</dd>
          </div>
          <div>
            <dt>Average</dt>
            <dd>
              {Math.round(toSpeed(s.avgSpeed))} {speedUnit()}
            </dd>
          </div>
          <div>
            <dt>Top speed</dt>
            <dd>
              {Math.round(toSpeed(s.maxSpeed))} {speedUnit()}
            </dd>
          </div>
          <div>
            <dt>Bends</dt>
            <dd>{s.bends}</dd>
          </div>
          <div>
            <dt>Climb</dt>
            <dd>{profile ? `${Math.round(profile.ascent)} m` : "…"}</dd>
          </div>
          {s.lean != null && (
            <div title="Estimated from your speed and how tight each bend was">
              <dt>Lean (est.)</dt>
              <dd>~{s.lean}°</dd>
            </div>
          )}
          {s.twistiest && (
            <div title={`Twistiest stretch: from ${formatDistance(s.twistiest.from)} to ${formatDistance(s.twistiest.to)}`}>
              <dt>Twistiest</dt>
              <dd>
                {s.twistiest.score.toFixed(1)} <small>
                  {formatDistance(s.twistiest.from)}–{formatDistance(s.twistiest.to)}
                </small>
              </dd>
            </div>
          )}
        </dl>
      </section>
      <section>
        <h2>Speed</h2>
        <LineChart
          points={speedPoints}
          unit={speedUnit()}
          label={`Speed along the ride, up to ${Math.round(toSpeed(s.maxSpeed))} ${speedUnit()}`}
          caption={`Average ${Math.round(toSpeed(s.avgSpeed))} ${speedUnit()} while moving · top ${Math.round(toSpeed(s.maxSpeed))} ${speedUnit()}`}
          onHover={onHover}
        />
      </section>
      {profile && (
        <section>
          <h2>Elevation</h2>
          <ElevationChart profile={profile} onHover={onHover} />
        </section>
      )}
      <section>
        <div className="button-row">
          <button onClick={() => onPlanAgain(ride)}>
            <Icon name="loop" size={18} /> Plan this again
          </button>
          <button onClick={() => onExport(ride)}>
            <Icon name="download" size={18} /> GPX
          </button>
          {confirmDelete ? (
            <>
              <button className="danger" onClick={() => onDelete(ride)}>
                Delete ride
              </button>
              <button onClick={() => setConfirmDelete(false)}>Keep</button>
            </>
          ) : (
            <button onClick={() => setConfirmDelete(true)}>Delete…</button>
          )}
        </div>
      </section>
    </div>
  );
}
