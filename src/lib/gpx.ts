import type { LatLng } from "./geo";

export interface GpxData {
  name: string;
  waypoints: LatLng[];
  track: LatLng[];
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const pt = (tag: string, p: LatLng, inner = "") =>
  `<${tag} lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}">${inner}</${tag}>`;

/**
 * Build a GPX 1.1 file with both a route (the planned stops, for devices that
 * re-route) and a track (the exact road geometry, for devices that follow it).
 */
export function toGpx({ name, waypoints, track }: GpxData): string {
  const n = esc(name);
  const rtepts = waypoints
    .map((p, i) => pt("rtept", p, `<name>${i === 0 ? "Start" : i === waypoints.length - 1 ? "Finish" : `Via ${i}`}</name>`))
    .join("\n      ");
  const trkpts = track.map((p) => pt("trkpt", p)).join("\n        ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Forge Route Planner" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${n}</name></metadata>
  <rte>
    <name>${n}</name>
      ${rtepts}
  </rte>
  <trk>
    <name>${n}</name>
    <trkseg>
        ${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}

const readPts = (doc: Document, tag: string): LatLng[] =>
  Array.from(doc.getElementsByTagName(tag))
    .map((el) => ({ lat: parseFloat(el.getAttribute("lat") ?? ""), lng: parseFloat(el.getAttribute("lon") ?? "") }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));

/**
 * Parse a GPX file. Route points (or waypoints) become stops; if the file only
 * has a track, stops are sampled from it so it can be re-routed.
 */
export function parseGpx(xml: string, parser: DOMParser = new DOMParser()): GpxData {
  const doc = parser.parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("Not a valid GPX file");
  const name = doc.getElementsByTagName("name")[0]?.textContent?.trim() || "Imported route";
  const track = readPts(doc, "trkpt");
  let waypoints = readPts(doc, "rtept");
  if (waypoints.length < 2) waypoints = readPts(doc, "wpt");
  if (waypoints.length < 2) waypoints = sampleStops(track, 10);
  if (waypoints.length < 2) throw new Error("GPX file has no usable route, waypoints or track");
  return { name, waypoints, track };
}

/** Evenly pick up to `max` points from a track, always keeping both ends. */
export function sampleStops(track: LatLng[], max: number): LatLng[] {
  if (track.length <= max) return track.slice();
  const out: LatLng[] = [];
  for (let i = 0; i < max; i++) out.push(track[Math.round((i * (track.length - 1)) / (max - 1))]);
  return out;
}
