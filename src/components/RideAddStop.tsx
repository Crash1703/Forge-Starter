import { useEffect, useState } from "react";
import Icon, { POI_ICONS } from "./Icon";
import PlaceSearch from "./PlaceSearch";
import { distance, formatDistance, type LatLng } from "../lib/geo";
import { knownPlaces, placesAhead, RIDE_PLACE_KINDS, type RidePlace, type RidePlaceKind } from "../lib/rideStops";
import type { Poi, PoiKind } from "../lib/pois";
import { formatPrice, priceAge, type FuelPrice } from "../lib/fuelPrices";

export type AddMode = "via" | "finish";

/** Both lists, without the same place twice, nearest ahead first. */
function mergePlaces(a: RidePlace[], b: RidePlace[]): RidePlace[] {
  const out = [...a];
  for (const p of b) if (!out.some((q) => distance(q.position, p.position) < 80)) out.push(p);
  return out.sort((x, y) => (x.ahead == null ? 1 : 0) - (y.ahead == null ? 1 : 0) || (x.ahead ?? x.away) - (y.ahead ?? y.away));
}



interface Props {
  /** Where the rider is. */
  from: LatLng;
  /** The road still ahead. */
  ahead: LatLng[];
  /** Route to the stop; resolves when the new route is in place. */
  onAdd: (place: { name: string; position: LatLng; kind: PoiKind | null }, mode: AddMode) => Promise<void>;
  /** Stops added this ride that are still ahead. */
  stops?: { id: string; name: string; kind: PoiKind | null; finish: boolean }[];
  /** Take an added stop back out; resolves when the new route is in place. */
  onRemove?: (id: string) => Promise<void>;
  onClose: () => void;
  /** Today's fuel price at a station, where known. */
  priceAt?: (p: LatLng) => FuelPrice | null;
  /** Fuel and cafés found in the planner before riding. */
  known?: Poi[];
}

/**
 * Ride mode's "add a stop": search for anywhere, or pick fuel, food, a
 * lookout or toilets along the road ahead, then stop there on the way or
 * finish there. Stops already added are listed first, to take back out.
 */
export default function RideAddStop({ from, ahead, onAdd, onClose, known = [], priceAt, stops = [], onRemove }: Props) {
  const [kind, setKind] = useState<RidePlaceKind | null>(null);
  const [places, setPlaces] = useState<RidePlace[] | null>(null);
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<{ name: string; position: LatLng; kind: PoiKind | null; where: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!kind) return;
    const ctrl = new AbortController();
    // What the planner already found shows straight away; a fresh look fills in the rest.
    const already = knownPlaces(known, kind, ahead, from);
    setPlaces(already.length ? already : null);
    setFailed(false);
    setNote("Looking along the road ahead…");
    placesAhead(kind, ahead, from, ctrl.signal)
      .then((found) => {
        const merged = mergePlaces(already, found);
        setPlaces(merged);
        setNote(merged.length ? "" : "Nothing found near the road ahead.");
      })
      .catch((e: Error) => {
        if (e.name === "AbortError") return;
        if (already.length) {
          setNote("Showing what was found when you planned. Couldn't look for more just now.");
        } else setNote(e.message);
        setFailed(true);
      });
    return () => ctrl.abort();
    // Look once per choice (or retry); the rider keeps moving but the list stays put.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, attempt]);

  // The cheapest fuel on the list, when there's more than one price to compare.
  const fuelCents = kind === "fuel" ? (places ?? []).flatMap((p) => priceAt?.(p.position)?.cents ?? []) : [];
  const cheapestAhead = fuelCents.length > 1 ? Math.min(...fuelCents) : NaN;

  const where = (p: RidePlace) => (p.ahead != null ? `${formatDistance(p.ahead)} ahead` : `${formatDistance(p.away)} away`);

  async function add(mode: AddMode) {
    if (!picked) return;
    setBusy(true);
    setNote("");
    try {
      await onAdd(picked, mode);
    } catch {
      setNote("Couldn't find a route there. Try again, or pick somewhere else.");
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!onRemove) return;
    setRemoving(id);
    setNote("");
    try {
      await onRemove(id);
    } catch {
      setNote("Couldn't find a route without that stop. Try again.");
    }
    setRemoving(null);
  }

  return (
    <div className="ride-add" role="dialog" aria-label="Add a stop">
      <div className="ride-add-head">
        <strong>{picked ? picked.name : "Add a stop"}</strong>
        <button className="ride-add-close" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={20} />
        </button>
      </div>
      {picked ? (
        <>
          <p className="ride-add-where">{picked.where}</p>
          <div className="ride-add-actions">
            <button className="primary" disabled={busy} onClick={() => void add("via")}>
              {busy ? "Finding the way…" : "Stop on the way"}
            </button>
            <button disabled={busy} onClick={() => void add("finish")}>
              Finish here
            </button>
            <button disabled={busy} onClick={() => setPicked(null)}>
              Back
            </button>
          </div>
          {note && <p className="ride-add-note">{note}</p>}
        </>
      ) : (
        <>
          <PlaceSearch
            near={from}
            placeholder="Search for a place"
            onPick={(name, position) => setPicked({ name, position, kind: null, where: `${formatDistance(distance(from, position))} away` })}
          />
          {stops.length > 0 && (
            <ol className="ride-add-list ride-add-stops" aria-label="Your stops">
              {stops.map((s) => (
                <li key={s.id}>
                  <Icon name={s.kind ? POI_ICONS[s.kind] : s.finish ? "flag" : "pin"} size={18} />
                  <strong>{s.name}</strong>
                  {s.finish && <small>Finish</small>}
                  <button className="ride-add-remove" disabled={removing != null} aria-label={`Remove ${s.name}`} onClick={() => void remove(s.id)}>
                    <Icon name="trash" size={18} /> {removing === s.id ? "Removing…" : "Remove"}
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div className="ride-add-kinds" role="radiogroup" aria-label="Find along the road ahead">
            {RIDE_PLACE_KINDS.map((k) => (
              <button
                key={k.kind}
                role="radio"
                aria-checked={kind === k.kind}
                onClick={() => (kind === k.kind ? setAttempt((a) => a + 1) : setKind(k.kind))}
              >
                <Icon name={POI_ICONS[k.kind]} size={18} /> {k.name}
              </button>
            ))}
          </div>
          {note && <p className="ride-add-note">{note}</p>}
          {failed && (
            <button className="ride-add-retry" onClick={() => setAttempt((a) => a + 1)}>
              <Icon name="loop" size={18} /> Try again
            </button>
          )}
          {places && places.length > 0 && (
            <ol className="ride-add-list">
              {places.map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => {
                      const price = kind === "fuel" ? priceAt?.(p.position) : null;
                      setPicked({ name: p.name, position: p.position, kind, where: `${where(p)}${price ? ` · ${formatPrice(price)}, ${priceAge(price)}` : ""}` });
                    }}
                  >
                    <strong>{p.name}</strong>
                    {kind === "fuel" && priceAt?.(p.position) && (
                      <span className={`price${priceAt(p.position)!.cents === cheapestAhead ? " cheapest" : ""}`}>{formatPrice(priceAt(p.position)!)}</span>
                    )}
                    <small>{where(p)}</small>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
