import { setDisplayPrefs } from "./geo";
import { setKeepRecentSearches } from "./places";
import { FUEL_CHOICES, type FuelChoice } from "./fuelPrices";

/** The rider's preferences, kept on the device. */
export interface Settings {
  /** App colours: follow the phone, or always light or dark. */
  theme: "system" | "light" | "dark";
  /** Distances in kilometres or miles (speeds follow: km/h or mph). */
  units: "km" | "mi";
  /** Clock: the phone's own style, or always 24 h or 12 h. */
  clock: "auto" | "24" | "12";
  /** Put a new stop where it adds the least riding, instead of at the end. */
  smartVias: boolean;
  /** In Ride mode, let the screen dim and sleep, and check GPS less often. */
  energySaving: boolean;
  /** Keep recent place searches for quick picking. */
  keepSearches: boolean;
  /** Mark home on the map. */
  showHome: boolean;
  /** Fuel to show prices for. */
  fuelType: FuelChoice;
  /** The rider's own Queensland fuel price token (kept on this device only). */
  fuelToken: string;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  units: "km",
  clock: "auto",
  smartVias: true,
  energySaving: false,
  keepSearches: true,
  showHome: true,
  fuelType: "p95",
  fuelToken: "",
};

const KEY = "forge.settings";

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const s = { ...DEFAULT_SETTINGS };
    if (["system", "light", "dark"].includes(raw.theme)) s.theme = raw.theme;
    if (["km", "mi"].includes(raw.units)) s.units = raw.units;
    if (["auto", "24", "12"].includes(raw.clock)) s.clock = raw.clock;
    if (FUEL_CHOICES.some((c) => c.id === raw.fuelType)) s.fuelType = raw.fuelType;
    if (typeof raw.fuelToken === "string") s.fuelToken = raw.fuelToken.trim();
    for (const k of ["smartVias", "energySaving", "keepSearches", "showHome"] as const) if (typeof raw[k] === "boolean") s[k] = raw[k];
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function storeSettings(s: Settings): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

/** Colours follow `theme`: the stylesheet reads data-theme on the page. */
export function applyTheme(theme: Settings["theme"]) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

/** Put settings into effect: colours, units and clock, search history. */
export function applySettings(s: Settings) {
  applyTheme(s.theme);
  setDisplayPrefs({ units: s.units, clock: s.clock });
  setKeepRecentSearches(s.keepSearches);
}
