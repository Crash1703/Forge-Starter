// The small part of Overpass QL the Ride Forge app asks (see src/lib/pois.ts,
// rideStops.ts, sights.ts), answered from places held in memory:
//   [out:json][timeout:25];(nwr["amenity"="fuel"](around:300,lat,lon,lat,lon,…);
//     node["mountain_pass"="yes"](s,w,n,e); …);out center tags 300;
// Statements: nwr/node/way/relation, tag filters ["k"="v"], ["k"~"regex"],
// ["k"], and either around a line (the points joined up) or inside a box.

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

/** Parse the app's query: its statements and the most it wants back. */
export function parseQuery(q) {
  const group = /\(([\s\S]*)\);\s*out\b([^;]*);/.exec(q);
  if (!group) throw new Error("Query not understood");
  const limit = Number(/(\d+)\s*$/.exec(group[2].trim())?.[1] ?? Infinity);
  const statements = group[1]
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(nwr|node|way|relation|rel)((?:\[[^\]]*\])+)\(([^)]*)\)$/.exec(s);
      if (!m) throw new Error(`Statement not understood: ${s.slice(0, 80)}`);
      const filters = [...m[2].matchAll(/\["([^"]+)"(?:(=|~)"([^"]*)")?\]/g)].map(([, key, op, value]) => ({
        key,
        test: !op ? (v) => v != null : op === "=" ? (v) => v === value : ((re) => (v) => v != null && re.test(v))(new RegExp(value)),
      }));
      const type = m[1] === "nwr" ? null : m[1] === "rel" ? "relation" : m[1];
      const area = m[3].trim();
      if (area.startsWith("around:")) {
        const [radius, ...nums] = area.slice(7).split(",").map(Number);
        const line = [];
        for (let i = 0; i + 1 < nums.length; i += 2) line.push([nums[i], nums[i + 1]]);
        if (!line.length || !Number.isFinite(radius)) throw new Error("Bad around");
        return { type, filters, around: { radius, line } };
      }
      const box = area.split(",").map(Number);
      if (box.length !== 4 || !box.every(Number.isFinite)) throw new Error("Bad box");
      return { type, filters, box };
    });
  return { statements, limit };
}

/** Metres from point p to the segment a–b (all [lat, lon]), flat earth around p. */
function toSegment(p, a, b) {
  const kx = R * rad(1) * Math.cos(rad(p[0]));
  const ky = R * rad(1);
  const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky;
  const bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/**
 * Places held in a grid of 0.1° cells, for quick lookups by box and around
 * a line. `places`: { type, id, lat, lon, tags }.
 */
export class Places {
  constructor(places) {
    this.places = places;
    this.cells = new Map();
    places.forEach((p, i) => {
      const k = this.key(p.lat, p.lon);
      if (!this.cells.has(k)) this.cells.set(k, []);
      this.cells.get(k).push(i);
    });
  }
  key(lat, lon) {
    return `${Math.floor(lat * 10)},${Math.floor(lon * 10)}`;
  }
  /** Indexes of places in the cells covering a box. */
  *inBox(s, w, n, e) {
    for (let a = Math.floor(s * 10); a <= Math.floor(n * 10); a++)
      for (let b = Math.floor(w * 10); b <= Math.floor(e * 10); b++) yield* this.cells.get(`${a},${b}`) ?? [];
  }
  /** Run a parsed query: Overpass-shaped elements, each once, at most `limit`. */
  run({ statements, limit }) {
    const found = new Map();
    for (const st of statements) {
      const ok = (p) => (!st.type || p.type === st.type) && st.filters.every((f) => f.test(p.tags[f.key]));
      if (st.box) {
        const [s, w, n, e] = st.box;
        for (const i of this.inBox(s, w, n, e)) {
          const p = this.places[i];
          if (p.lat >= s && p.lat <= n && p.lon >= w && p.lon <= e && ok(p)) found.set(i, p);
        }
      } else {
        const { radius, line } = st.around;
        const segs = line.length === 1 ? [[line[0], line[0]]] : line.slice(1).map((b, k) => [line[k], b]);
        const dLat = radius / (R * rad(1));
        for (const [a, b] of segs) {
          const dLon = dLat / Math.max(0.1, Math.cos(rad((a[0] + b[0]) / 2)));
          const s = Math.min(a[0], b[0]) - dLat, n = Math.max(a[0], b[0]) + dLat;
          const w = Math.min(a[1], b[1]) - dLon, e = Math.max(a[1], b[1]) + dLon;
          for (const i of this.inBox(s, w, n, e)) {
            if (found.has(i)) continue;
            const p = this.places[i];
            if (ok(p) && toSegment([p.lat, p.lon], a, b) <= radius) found.set(i, p);
          }
        }
      }
    }
    return [...found.values()].slice(0, limit).map((p) =>
      p.type === "node" ? { type: p.type, id: p.id, lat: p.lat, lon: p.lon, tags: p.tags } : { type: p.type, id: p.id, center: { lat: p.lat, lon: p.lon }, tags: p.tags },
    );
  }
}
