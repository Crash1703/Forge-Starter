/**
 * Free, keyless OpenStreetMap services. Each can be pointed at your own server
 * through .env when you outgrow the public instances' fair-use limits.
 */
import type { StyleSpecification } from "maplibre-gl";

const env = import.meta.env;

export const MAP_STYLE: string = env.VITE_MAP_STYLE || "https://tiles.openfreemap.org/styles/liberty";
export const MAP_STYLE_DARK: string = env.VITE_MAP_STYLE_DARK || "https://tiles.openfreemap.org/styles/dark";
export const VALHALLA_URL: string = env.VITE_VALHALLA_URL || "https://valhalla1.openstreetmap.de";
/**
 * Ride Forge's own route server (GraphHopper, Australia), used by default;
 * the public Valhalla server above steps in when it doesn't answer.
 */
export const ROUTE_SERVER_URL: string = env.VITE_ROUTE_SERVER_URL ?? "https://routes.mbcgaming.net";
/**
 * Queensland fuel prices through Ride Forge's server, which holds the token
 * (see server/fuel): no rider needs one. Empty: only a rider's own token.
 */
/** Feedback and error reports, to Ride Forge's server (see server/feedback). Empty: none. */
export const FEEDBACK_URL: string = env.VITE_FEEDBACK_URL ?? (ROUTE_SERVER_URL ? `${ROUTE_SERVER_URL}/feedback/report` : "");
/** This app's version, as its Android release is numbered (e.g. "1.123"); "dev" when built by hand. */
export const APP_VERSION: string = env.VITE_APP_VERSION || "dev";
/** The privacy policy and terms of use (published with the website, from public/). */
export const PRIVACY_URL = "https://crash1703.github.io/Forge-Starter/privacy.html";
export const TERMS_URL = "https://crash1703.github.io/Forge-Starter/terms.html";
/** Where the latest Android release is announced. */
export const RELEASES_API = "https://api.github.com/repos/Crash1703/Forge-Starter/releases/latest";
export const FUEL_PRICES_URL: string = env.VITE_FUEL_PRICES_URL ?? (ROUTE_SERVER_URL ? `${ROUTE_SERVER_URL}/fuel` : "");
/** Place search and names: Ride Forge's own Photon, with Australia's places (see server/photon). */
export const PHOTON_URL: string = env.VITE_PHOTON_URL || (env.VITE_ROUTE_SERVER_URL ?? "https://routes.mbcgaming.net");
/** Elevation: the Copernicus 90 m terrain model on Ride Forge's server (see server/elevation), answered as Open-Meteo would. */
export const ELEVATION_URL: string = env.VITE_ELEVATION_URL || (env.VITE_ROUTE_SERVER_URL ?? "https://routes.mbcgaming.net") + "/elevation";
/** Weather: MET Norway, through Ride Forge's server (see server/weather), answered as Open-Meteo would. */
export const FORECAST_URL: string =
  env.VITE_FORECAST_URL || (env.VITE_ROUTE_SERVER_URL ?? "https://routes.mbcgaming.net") + "/weather/forecast";
/**
 * Places (fuel, cafés, sights…): Ride Forge's server answers the app's
 * Overpass queries from the map it routes on (see server/places).
 */
export const OVERPASS_URL: string = env.VITE_OVERPASS_URL || (env.VITE_ROUTE_SERVER_URL ?? "https://routes.mbcgaming.net") + "/places/interpreter";
/** Other servers asked at the same time (none: the public Overpass servers aren't for a paid app's traffic). */
export const OVERPASS_MIRRORS: string[] = [];
export const WIKIDATA_URL: string = env.VITE_WIKIDATA_URL || "https://www.wikidata.org/w/api.php";

/** Terrain map: OpenTopoMap raster tiles (contours and hill shading). */
export const MAP_STYLE_TOPO: StyleSpecification = {
  version: 8,
  sources: {
    topo: {
      type: "raster",
      tiles: ["a", "b", "c"].map((s) => (env.VITE_TOPO_TILES || "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png").replace("{s}", s)),
      tileSize: 256,
      maxzoom: 17,
      attribution:
        'Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM · style © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    },
  },
  layers: [{ id: "topo", type: "raster", source: "topo" }],
};
