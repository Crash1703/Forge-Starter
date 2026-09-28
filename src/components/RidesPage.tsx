import Icon from "./Icon";
import { formatDistance, formatDuration } from "../lib/geo";
import type { RideRecord } from "../lib/recorder";
import type { SavedRoute } from "../lib/storage";

interface Props {
  saved: SavedRoute[];
  rides: RideRecord[];
  onPlanned: () => void;
  onCompleted: () => void;
  onOpenSaved: (r: SavedRoute) => void;
  onOpenRide: (r: RideRecord) => void;
  onRoundTrip: () => void;
  onPlan: () => void;
}

const when = (t: number) => new Date(t).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });

/**
 * The Rides page: planned routes and completed rides at a glance, the
 * latest of each, and a quick way to plan the next one.
 */
export default function RidesPage(p: Props) {
  const km = p.rides.reduce((a, r) => a + r.stats.distance, 0);
  const recentRides = [...p.rides].sort((a, b) => b.startedAt - a.startedAt).slice(0, 3);
  const recentSaved = [...p.saved].sort((a, b) => b.savedAt - a.savedAt).slice(0, 3);
  return (
    <div className="page" role="region" aria-label="Rides">
      <div className="page-body">
        <h1 className="page-title">Rides</h1>
        <h2 className="page-group">My rides</h2>
        <div className="ride-cards">
          <button className="ride-card" onClick={p.onPlanned}>
            <Icon name="calendar" size={30} />
            <strong>Planned</strong>
            <span>{p.saved.length}</span>
          </button>
          <button className="ride-card" onClick={p.onCompleted}>
            <Icon name="checkCircle" size={30} />
            <strong>Completed</strong>
            <span>
              {p.rides.length} · {formatDistance(km)}
            </span>
          </button>
        </div>
        <div className="ride-cards">
          <button className="ride-card wide" onClick={p.onRoundTrip}>
            <Icon name="loop" size={26} />
            <strong>Plan a round trip</strong>
            <span>A loop from home or where you are</span>
          </button>
          <button className="ride-card wide" onClick={p.onPlan}>
            <Icon name="flag" size={26} />
            <strong>Plan a route</strong>
            <span>From A to B, via the good roads</span>
          </button>
        </div>

        {recentRides.length > 0 && (
          <>
            <h2 className="page-group">Latest rides</h2>
            <div className="page-rows">
              {recentRides.map((r) => (
                <button key={r.id} className="page-row" onClick={() => p.onOpenRide(r)}>
                  <Icon name="bike" size={22} />
                  <span>
                    <strong>{r.name}</strong>
                    <small>
                      {when(r.startedAt)} · {formatDistance(r.stats.distance)} · {formatDuration(r.stats.movingTime)}
                    </small>
                  </span>
                  <Icon name="chevronRight" size={20} />
                </button>
              ))}
            </div>
          </>
        )}
        {recentSaved.length > 0 && (
          <>
            <h2 className="page-group">Planned routes</h2>
            <div className="page-rows">
              {recentSaved.map((r) => (
                <button key={r.id} className="page-row" onClick={() => p.onOpenSaved(r)}>
                  <Icon name="map" size={22} />
                  <span>
                    <strong>{r.name}</strong>
                    <small>
                      {formatDistance(r.distance)} · {formatDuration(r.duration)}
                    </small>
                  </span>
                  <Icon name="chevronRight" size={20} />
                </button>
              ))}
            </div>
          </>
        )}
        {!p.rides.length && !p.saved.length && (
          <p className="hint">Routes you save and rides you record show up here.</p>
        )}
      </div>
    </div>
  );
}
