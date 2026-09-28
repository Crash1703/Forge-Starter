/**
 * Free, keyless OpenStreetMap services. Each can be pointed at your own server
 * through .env when you outgrow the public instances' fair-use limits.
 */
const env = import.meta.env;

export const MAP_STYLE: string = env.VITE_MAP_STYLE || "https://tiles.openfreemap.org/styles/liberty";
export const MAP_STYLE_DARK: string = env.VITE_MAP_STYLE_DARK || "https://tiles.openfreemap.org/styles/dark";
export const VALHALLA_URL: string = env.VITE_VALHALLA_URL || "https://valhalla1.openstreetmap.de";
export const PHOTON_URL: string = env.VITE_PHOTON_URL || "https://photon.komoot.io";
export const ELEVATION_URL: string = env.VITE_ELEVATION_URL || "https://api.open-meteo.com/v1/elevation";
export const FORECAST_URL: string = env.VITE_FORECAST_URL || "https://api.open-meteo.com/v1/forecast";
export const OVERPASS_URL: string = env.VITE_OVERPASS_URL || "https://overpass-api.de/api/interpreter";
