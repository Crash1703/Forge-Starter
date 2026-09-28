/**
 * Free, keyless OpenStreetMap services. Each can be pointed at your own server
 * through .env when you outgrow the public instances' fair-use limits.
 */
import type { StyleSpecification } from "maplibre-gl";

const env = import.meta.env;

export const MAP_STYLE: string = env.VITE_MAP_STYLE || "https://tiles.openfreemap.org/styles/liberty";
export const MAP_STYLE_DARK: string = env.VITE_MAP_STYLE_DARK || "https://tiles.openfreemap.org/styles/dark";
export const VALHALLA_URL: string = env.VITE_VALHALLA_URL || "https://valhalla1.openstreetmap.de";
export const PHOTON_URL: string = env.VITE_PHOTON_URL || "https://photon.komoot.io";
export const ELEVATION_URL: string = env.VITE_ELEVATION_URL || "https://api.open-meteo.com/v1/elevation";
export const FORECAST_URL: string = env.VITE_FORECAST_URL || "https://api.open-meteo.com/v1/forecast";
export const OVERPASS_URL: string = env.VITE_OVERPASS_URL || "https://overpass-api.de/api/interpreter";
/**
 * Another public Overpass server, asked at the same time as the main one:
 * when the main one is overloaded (it often is), this one usually answers.
 */
export const OVERPASS_MIRRORS: string[] = env.VITE_OVERPASS_URL ? [] : ["https://maps.mail.ru/osm/tools/overpass/api/interpreter"];
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
