import { useState } from "react";
import Icon from "./Icon";
import PlaceSearch from "./PlaceSearch";
import { FUEL_CHOICES, type FuelChoice } from "../lib/fuelPrices";
import type { Garage, GarageVehicle, Profile } from "../lib/garage";
import type { LatLng } from "../lib/geo";
import type { Home } from "../lib/storage";

interface Props {
  profile: Profile;
  onProfile: (p: Profile) => void;
  garage: Garage;
  onGarage: (g: Garage) => void;
  home: Home | null;
  onHome: (h: Home | null) => void;
  /** "Where I am now" for home. */
  onHomeHere: () => void;
  near?: LatLng;
  fuelDefault: FuelChoice;
  onSettings: () => void;
  onBackUp: () => void;
  onRestore: () => void;
  onImportGpx: () => void;
}

const newId = () => Math.random().toString(36).slice(2, 10);

/**
 * The Profile page: the rider's name, settings, home, garage (the bike's
 * type, tank range and fuel are used for planning), and backups.
 */
export default function ProfilePage(p: Props) {
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(p.profile.name);
  const [homeOpen, setHomeOpen] = useState(false);
  const [adding, setAdding] = useState<GarageVehicle | null>(null);

  const saveName = () => {
    p.onProfile({ ...p.profile, name: name.trim() });
    setEditingName(false);
  };
  const setVehicles = (vehicles: GarageVehicle[], active = p.garage.active) =>
    p.onGarage({ vehicles, active: vehicles.some((v) => v.id === active) ? active : (vehicles[0]?.id ?? null) });

  return (
    <div className="page" role="region" aria-label="Profile">
      <div className="page-body">
        <div className="profile-head">
          <span className="avatar" aria-hidden>
            <Icon name="helmet" size={56} />
          </span>
          {editingName ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                saveName();
              }}
            >
              <input aria-label="Your name" value={name} autoFocus maxLength={40} placeholder="Your name" onChange={(e) => setName(e.target.value)} onBlur={saveName} />
            </form>
          ) : (
            <button className="profile-name" onClick={() => setEditingName(true)}>
              <strong>{p.profile.name || "Add your name"}</strong>
              <Icon name="edit" size={16} />
            </button>
          )}
        </div>

        <div className="page-rows">
          <button className="page-row" aria-label="Settings" onClick={p.onSettings}>
            <Icon name="settings" size={22} />
            <span>
              <strong>Settings</strong>
              <small>Units, look, riding, fuel prices, route server</small>
            </span>
            <Icon name="chevronRight" size={20} />
          </button>
          <button className="page-row" aria-expanded={homeOpen} onClick={() => setHomeOpen((o) => !o)}>
            <Icon name="home" size={22} />
            <span>
              <strong>Home</strong>
              <small>{p.home ? p.home.label : "Not set: loops from home and ride home in one tap"}</small>
            </span>
            <Icon name={homeOpen ? "chevronDown" : "chevronRight"} size={20} />
          </button>
          {homeOpen && (
            <div className="page-row-body">
              <div className="button-row">
                <button onClick={p.onHomeHere}>
                  <Icon name="locate" size={18} /> Where I am now
                </button>
                {p.home && (
                  <button className="danger-text" onClick={() => p.onHome(null)}>
                    <Icon name="trash" size={18} /> Remove
                  </button>
                )}
              </div>
              <PlaceSearch near={p.home?.position ?? p.near} placeholder="Search for your home address" onPick={(label, pos) => p.onHome({ label, position: pos })} />
            </div>
          )}
        </div>

        <h2 className="page-group">My garage</h2>
        <div className="page-rows">
          {p.garage.vehicles.map((v) => (
            <div key={v.id} className={`page-row vehicle${p.garage.active === v.id ? " active" : ""}`}>
              <button className="vehicle-pick" aria-pressed={p.garage.active === v.id} onClick={() => p.onGarage({ ...p.garage, active: v.id })}>
                <Icon name={p.garage.active === v.id ? "check" : "bike"} size={22} />
                <span>
                  <strong>{v.name}</strong>
                  <small>
                    {v.kind === "motorcycle" ? "Motorcycle" : "Car"} · {v.tankKm} km a tank · {FUEL_CHOICES.find((c) => c.id === v.fuel)?.name}
                    {p.garage.active === v.id ? " · riding this" : ""}
                  </small>
                </span>
              </button>
              <button className="icon-btn" aria-label={`Edit ${v.name}`} onClick={() => setAdding(v)}>
                <Icon name="edit" size={18} />
              </button>
            </div>
          ))}
          {adding ? (
            <form
              className="page-row-body vehicle-form"
              onSubmit={(e) => {
                e.preventDefault();
                const v = { ...adding, name: adding.name.trim() || "My bike", tankKm: Math.max(30, Math.min(1500, adding.tankKm || 250)) };
                const exists = p.garage.vehicles.some((x) => x.id === v.id);
                setVehicles(exists ? p.garage.vehicles.map((x) => (x.id === v.id ? v : x)) : [...p.garage.vehicles, v], exists ? p.garage.active : v.id);
                setAdding(null);
              }}
            >
              <label>
                Name
                <input id="vehicle-name" value={adding.name} placeholder="e.g. Tracer 9 GT" maxLength={40} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
              </label>
              <label>
                Type
                <select value={adding.kind} onChange={(e) => setAdding({ ...adding, kind: e.target.value as GarageVehicle["kind"] })}>
                  <option value="motorcycle">Motorcycle</option>
                  <option value="car">Car</option>
                </select>
              </label>
              <label>
                Range on a full tank (km)
                <input id="vehicle-range" type="number" min={30} max={1500} step={10} value={adding.tankKm} onChange={(e) => setAdding({ ...adding, tankKm: +e.target.value })} />
              </label>
              <label>
                Fuel
                <select value={adding.fuel} onChange={(e) => setAdding({ ...adding, fuel: e.target.value as FuelChoice })}>
                  {FUEL_CHOICES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="button-row">
                <button type="submit" className="primary">
                  Save
                </button>
                <button type="button" onClick={() => setAdding(null)}>
                  Cancel
                </button>
                {p.garage.vehicles.some((x) => x.id === adding.id) && (
                  <button
                    type="button"
                    className="danger-text"
                    onClick={() => {
                      setVehicles(p.garage.vehicles.filter((x) => x.id !== adding.id));
                      setAdding(null);
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </form>
          ) : (
            <button className="page-row add-vehicle" onClick={() => setAdding({ id: newId(), name: "", kind: "motorcycle", tankKm: 250, fuel: p.fuelDefault })}>
              <Icon name="plus" size={22} />
              <span>
                <strong>Add vehicle</strong>
                <small>Its range and fuel set the fuel stops and prices</small>
              </span>
            </button>
          )}
        </div>

        <h2 className="page-group">Your data</h2>
        <div className="page-rows">
          <button className="page-row" onClick={p.onBackUp}>
            <Icon name="download" size={22} />
            <span>
              <strong>Back up routes &amp; rides</strong>
              <small>A file to move them to a new phone, or between the app and the website</small>
            </span>
          </button>
          <button className="page-row" onClick={p.onRestore}>
            <Icon name="up" size={22} />
            <span>
              <strong>Restore a backup</strong>
            </span>
          </button>
          <button className="page-row" onClick={p.onImportGpx}>
            <Icon name="map" size={22} />
            <span>
              <strong>Import a GPX route</strong>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
