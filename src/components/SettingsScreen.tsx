import { createPortal } from "react-dom";
import Icon from "./Icon";
import type { Settings } from "../lib/settings";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClearSearches: () => void;
  onClose: () => void;
}

/** App settings: units, clock, how stops are placed, navigation, history. */
export default function SettingsScreen({ settings: s, onChange, onClearSearches, onClose }: Props) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...s, [k]: v });
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

        <button className="danger-link" onClick={onClearSearches}>
          Delete search history
        </button>
      </div>
    </div>,
    document.body,
  );
}
