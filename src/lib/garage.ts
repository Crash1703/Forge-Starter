import type { FuelChoice } from "./fuelPrices";
import type { Vehicle as VehicleKind } from "./routes";

/** A bike (or car) in the rider's garage. */
export interface GarageVehicle {
  id: string;
  name: string;
  kind: VehicleKind;
  /** How far a full tank goes, in km (for fuel stops along the way). */
  tankKm: number;
  fuel: FuelChoice;
}

export interface Garage {
  vehicles: GarageVehicle[];
  /** The one being ridden: its kind, range and fuel are used for planning. */
  active: string | null;
}

export interface Profile {
  name: string;
}

const GARAGE_KEY = "forge.garage";
const PROFILE_KEY = "forge.profile";
/** Tank range as the fuel-stop list reads it. */
const RANGE_KEY = "forge.tankRange";

function read<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") as T | null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadGarage(): Garage {
  const g = read<Garage>(GARAGE_KEY);
  const vehicles = Array.isArray(g?.vehicles)
    ? g!.vehicles.filter((v) => v && typeof v.id === "string" && typeof v.name === "string" && (v.kind === "motorcycle" || v.kind === "car"))
    : [];
  const active = vehicles.some((v) => v.id === g?.active) ? g!.active : null;
  return { vehicles, active };
}

export function storeGarage(g: Garage): boolean {
  return write(GARAGE_KEY, g);
}

/** The vehicle's range becomes the fuel-stop list's tank range. */
export function applyTankRange(v: GarageVehicle) {
  try {
    localStorage.setItem(RANGE_KEY, String(Math.round(v.tankKm)));
  } catch {
    /* this visit only */
  }
}

export function loadProfile(): Profile {
  const p = read<Profile>(PROFILE_KEY);
  return { name: typeof p?.name === "string" ? p.name : "" };
}

export function storeProfile(p: Profile): boolean {
  return write(PROFILE_KEY, p);
}
