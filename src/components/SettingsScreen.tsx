import { useState } from "react";
import { createPortal } from "react-dom";
import { clearFuelPrices, FUEL_CHOICES, loadFuelPrices, type FuelChoice } from "../lib/fuelPrices";
import Icon from "./Icon";
import { clearMapCache } from "../lib/mapCache";
import { checkRouteServer, normaliseServer } from "../lib/routeServer";
import { ROUTE_SERVER_URL } from "../lib/config";
import { PUBLIC_ONLY, type Settings } from "../lib/settings";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClearSearches: () => void;
  onClose: () => void;
  /** This build's version, shown under About. */
  build: string;
}

/** App settings: units, clock, how stops are placed, navigation, history. */
export default function SettingsScreen({ settings: s, onChange, onClearSearches, onClose, build }: Props) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...s, [k]: v });
  const [check, setCheck] = useState<{ busy?: boolean; text: string; ok?: boolean } | null>(null);
  const own = s.routeServer !== PUBLIC_ONLY ? s.routeServer : "";
  const [server, setServer] = useState(own);
  const [serverCheck, setServerCheck] = useState<{ busy?: boolean; text: string; ok?: boolean } | null>(null);
  const [mapCleared, setMapCleared] = useState(false);

  /** "" for Ride Forge's own server, PUBLIC_ONLY, or the typed address (checked first). */
  async function useServer(choice?: string) {
    if (choice != null) {
      setServer("");
      set("routeServer", choice);
      setServerCheck(null);
      return;
    }
    const url = normaliseServer(server);
    setServer(url);
    if (!url || url === ROUTE_SERVER_URL) return void useServer("");
    setServerCheck({ busy: true, text: "Checking…" });
    try {
      const what = await checkRouteServer(url);
      set("routeServer", url);
      setServerCheck({ ok: true, text: `Working: ${what}. Routes are planned there now (the public server steps in if it's off).` });
    } catch (e) {
      setServerCheck({ text: (e as Error).message });
    }
  }

  async function checkToken() {
    setCheck({ busy: true, text: "Checking…" });
    clearFuelPrices();
    try {
      const data = await loadFuelPrices(s.fuelToken);
      let priced = 0;
      const id = data.fuelIds.get(s.fuelType);
      data.prices.forEach((m) => id != null && m.has(id) && priced++);
      setCheck({ ok: true, text: `Working: ${data.sites.length.toLocaleString()} stations, ${priced.toLocaleString()} with ${FUEL_CHOICES.find((c) => c.id === s.fuelType)?.name} prices.` });
    } catch (e) {
      setCheck({ text: (e as Error).message });
    }
  }
  const toggle = (k: "smartVias" | "energySaving" | "keepSearches", title: string, hint: string) => (
    <label className="set-row">
      <span>
        <strong>{title}</strong>
        <small>{hint}</small>
      </span>
      <input type="checkbox" role="switch" className="switch" checked={s[k]} onChange={(e) => set(k, e.target.checked)} />
    </label>
  );
  return createPortal(
    <div className="screen" role="dialog" aria-modal="true" aria-labelledby="set-title">
      <header className="screen-head">
        <button className="icon" aria-label="Back to the map" onClick={onClose}>
          <Icon name="back" size={24} />
        </button>
        <h2 id="set-title">Settings</h2>
      </header>
      <div className="screen-body">
        <h3 className="set-group">Units of measurement</h3>
        <div className="rt-rows">
          <label className="rt-row">
            <span>Distance</span>
            <select id="set-units" value={s.units} onChange={(e) => set("units", e.target.value as Settings["units"])}>
              <option value="km">Kilometres</option>
              <option value="mi">Miles</option>
            </select>
          </label>
          <label className="rt-row">
            <span>Time</span>
            <select id="set-clock" value={s.clock} onChange={(e) => set("clock", e.target.value as Settings["clock"])}>
              <option value="auto">Phone's setting</option>
              <option value="24">24 h</option>
              <option value="12">12 h</option>
            </select>
          </label>
        </div>

        <h3 className="set-group">Appearance</h3>
        <div className="rt-rows">
          <label className="rt-row">
            <span>Theme</span>
            <select id="set-theme" value={s.theme} onChange={(e) => set("theme", e.target.value as Settings["theme"])}>
              <option value="system">Same as phone</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </div>

        <h3 className="set-group">Planning and riding</h3>
        <div className="rt-rows">
          {toggle("smartVias", "Set via points intelligently", "New stops go where they add the least riding, not just on the end")}
          {toggle(
            "energySaving",
            "Energy-saving mode",
            "Let the screen turn off while navigating; the voice still guides you (in the app; the website needs the screen on)",
          )}
          {toggle("keepSearches", "Remember searches", "Show recent places when you tap a search box")}
        </div>

        <h3 className="set-group">Fuel prices (Queensland)</h3>
        <div className="rt-rows">
          <label className="rt-row">
            <span>Your fuel</span>
            <select id="set-fuel" value={s.fuelType} onChange={(e) => set("fuelType", e.target.value as FuelChoice)}>
              {FUEL_CHOICES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="set-row token-row">
            <span>
              <strong>Price token</strong>
              <small>
                Free from{" "}
                <a href="https://www.fuelpricesqld.com.au/" target="_blank" rel="noreferrer">
                  fuelpricesqld.com.au
                </a>{" "}
                (sign up as a data consumer). Kept on this phone only.
              </small>
              <input
                id="set-fuel-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste your subscriber token"
                value={s.fuelToken}
                onChange={(e) => {
                  setCheck(null);
                  set("fuelToken", e.target.value.trim());
                }}
              />
            </span>
          </label>
          {s.fuelToken && (
            <div className="set-row">
              <button onClick={() => void checkToken()} disabled={check?.busy}>
                Check token
              </button>
              {check && <small className={check.ok ? "ok-text" : check.busy ? "" : "error-text"}>{check.text}</small>}
            </div>
          )}
        </div>

        <h3 className="set-group">Route server</h3>
        <div className="rt-rows">
          <label className="set-row token-row">
            <span>
              <strong>Route server</strong>
              <small>
                {s.routeServer === PUBLIC_ONLY
                  ? "Using only the free public server. "
                  : s.routeServer
                    ? `Using ${s.routeServer}; the free public server steps in if it doesn't answer. `
                    : `Using Ride Forge's route server (${ROUTE_SERVER_URL.replace(/^https:\/\//, "")}); the free public server steps in if it doesn't answer. `}
                To use a GraphHopper or Valhalla server of your own, enter its address:{" "}
                <a href="https://github.com/Crash1703/Forge-Starter/blob/main/docs/own-route-server.md" target="_blank" rel="noreferrer">
                  how to set one up
                </a>
                .
              </small>
              <input
                id="set-route-server"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://routes.example.com"
                value={server}
                onChange={(e) => {
                  setServerCheck(null);
                  setServer(e.target.value);
                }}
              />
            </span>
          </label>
          <div className="set-row server-actions">
            {normaliseServer(server) && normaliseServer(server) !== own && (
              <button onClick={() => void useServer()} disabled={serverCheck?.busy}>
                Check and use
              </button>
            )}
            {s.routeServer !== "" && (
              <button onClick={() => void useServer("")} disabled={serverCheck?.busy}>
                Use Ride Forge's server
              </button>
            )}
            {s.routeServer !== PUBLIC_ONLY && (
              <button onClick={() => void useServer(PUBLIC_ONLY)} disabled={serverCheck?.busy}>
                Public server only
              </button>
            )}
            {serverCheck && <small className={serverCheck.ok ? "ok-text" : serverCheck.busy ? "" : "error-text"}>{serverCheck.text}</small>}
          </div>
        </div>

        <button className="danger-link" onClick={onClearSearches}>
          Delete search history
        </button>
        <button
          className="danger-link"
          disabled={mapCleared}
          onClick={() => {
            void clearMapCache();
            setMapCleared(true);
          }}
        >
          {mapCleared ? "Saved map data deleted" : "Delete saved map data"}
        </button>

        <h3 className="set-group">About</h3>
        <p className="credits">
          Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>{" "}
          contributors · tiles <a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> · routing{" "}
          <a href="https://valhalla.github.io/valhalla/" target="_blank" rel="noreferrer">Valhalla</a> (FOSSGIS) · search{" "}
          <a href="https://photon.komoot.io" target="_blank" rel="noreferrer">Photon</a> · elevation and weather{" "}
          <a href="https://open-meteo.com" target="_blank" rel="noreferrer">Open-Meteo</a> · version {build}
        </p>
      </div>
    </div>,
    document.body,
  );
}
