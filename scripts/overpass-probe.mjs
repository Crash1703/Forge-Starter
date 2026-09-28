// Temporary: time Overpass query styles against the public servers from CI.
const ORIGIN = "https://localhost"; // what the Android app sends
const servers = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
function decode(str, precision = 6) {
  let index = 0, lat = 0, lng = 0; const coords = []; const factor = 10 ** precision;
  while (index < str.length) {
    for (const which of [0, 1]) {
      let b, shift = 0, result = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d; else lng += d;
    }
    coords.push({ lat: lat / factor, lng: lng / factor });
  }
  return coords;
}
const dist = (a, b) => { const R = 6371000, r = Math.PI / 180; const x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r; return Math.hypot(x, y) * R; };
function resample(path, step) { const out = [path[0]]; let acc = 0; for (let i = 1; i < path.length; i++) { acc += dist(path[i - 1], path[i]); if (acc >= step) { out.push(path[i]); acc = 0; } } if (out.at(-1) !== path.at(-1)) out.push(path.at(-1)); return out; }

const res = await fetch("https://valhalla1.openstreetmap.de/route", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
  locations: [{ lat: -26.80, lon: 153.11 }, { lat: -26.76, lon: 152.85 }, { lat: -26.63, lon: 152.87 }, { lat: -26.80, lon: 153.11 }], costing: "motorcycle" }) });
const trip = (await res.json()).trip;
const path = trip.legs.flatMap((l) => decode(l.shape));
let total = 0; for (let i = 1; i < path.length; i++) total += dist(path[i - 1], path[i]);
console.log(`route: ${(total / 1000).toFixed(0)} km, ${path.length} points`);
const line200 = resample(path, Math.max(400, total / 200));
const line60 = resample(path, Math.max(400, total / 60));
const co = (l) => l.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(",");
const lats = path.map((p) => p.lat), lngs = path.map((p) => p.lng);
const bbox = [Math.min(...lats) - 0.01, Math.min(...lngs) - 0.01, Math.max(...lats) + 0.01, Math.max(...lngs) + 0.01].map((v) => v.toFixed(4)).join(",");

const queries = {
  "planner (3 filters, around 200pts)": `[out:json][timeout:25];(nwr["amenity"="fuel"](around:300,${co(line200)});nwr["amenity"="cafe"](around:200,${co(line200)});nwr["shop"="bakery"](around:200,${co(line200)}););out center tags;`,
  "fuel only, around 200pts": `[out:json][timeout:25];nwr["amenity"="fuel"](around:300,${co(line200)});out center tags;`,
  "fuel only, around 60pts r600": `[out:json][timeout:25];nwr["amenity"="fuel"](around:600,${co(line60)});out center tags;`,
  "fuel only, node+way bbox": `[out:json][timeout:25];(node["amenity"="fuel"](${bbox});way["amenity"="fuel"](${bbox}););out center tags;`,
  "food (cafe|restaurant|fast_food|pub) bbox": `[out:json][timeout:25];(node["amenity"~"^(cafe|restaurant|fast_food|pub)$"](${bbox});way["amenity"~"^(cafe|restaurant|fast_food|pub)$"](${bbox}););out center tags;`,
  "toilets bbox": `[out:json][timeout:25];(node["amenity"="toilets"](${bbox}););out center tags;`,
};
for (const [name, q] of Object.entries(queries)) {
  console.log(`\n== ${name} (${q.length} chars)`);
  for (const url of servers) {
    const t0 = Date.now();
    try {
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 40000);
      const r = await fetch(url, { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN }, body: `data=${encodeURIComponent(q)}` });
      const text = await r.text(); clearTimeout(timer);
      let n = "-", remark = "";
      try { const j = JSON.parse(text); n = j.elements?.length; remark = j.remark || ""; } catch { remark = text.slice(0, 80).replace(/\s+/g, " "); }
      console.log(`${new URL(url).host.padEnd(22)} ${r.status} ${String(Date.now() - t0).padStart(6)} ms  elements=${n}  cors=${r.headers.get("access-control-allow-origin")}  ${remark}`);
    } catch (e) {
      console.log(`${new URL(url).host.padEnd(22)} ERR ${String(Date.now() - t0).padStart(6)} ms  ${e.name}: ${e.message}`);
    }
  }
}
