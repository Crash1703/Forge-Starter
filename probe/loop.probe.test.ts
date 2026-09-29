// Temporary: runs the round-trip pipeline against the real route server and
// prints how clean each loop is. Not part of the app or its tests.
import { test } from "vitest";
import { distance, findSpurs, loopLayout, resample, type LatLng } from "../src/lib/geo";
import { findLoops, type FoundLoop } from "../src/lib/loopFinder";
import { defaultOptions, planRoute, quickPlan, type RouteOptions, type RoutePoint, type RouteResult } from "../src/lib/routes";
import { routePoints, type Stop } from "../src/lib/storage";

function planPoints(stops: Stop[], returnToStart: boolean): RoutePoint[] {
  const plan = routePoints(stops, returnToStart);
  return plan.map(({ position, stop: s, shape }, i) => {
    const between = i > 0 && i < plan.length - 1;
    if (between && shape >= 0) return { pos: position, via: true, radius: 2000, movable: true };
    return { pos: position, noUturn: between && (returnToStart || s.auto), radius: between ? (s.auto ? 1000 : 75) : undefined, movable: between && s.auto };
  });
}
let id = 0;
function loopStops(origin: Stop, ring: LatLng[]): Stop[] {
  const layout = loopLayout(ring, [1, 3]);
  return [{ ...origin, shape: layout.startShape }, ...layout.stops.map((p) => ({ id: `s${id++}`, position: p.position, label: "", auto: true, shape: p.shape }))];
}

/** Metres of road ridden twice anywhere (either direction), and self-crossings far from home. */
function twice(path: LatLng[], home: LatLng) {
  const pts = resample(path, 50);
  const kx = 111320 * Math.cos((pts[0].lat * Math.PI) / 180), ky = 110540;
  let n = 0;
  for (let i = 0; i < pts.length; i++) {
    if (distance(pts[i], home) < 1500) continue;
    for (let j = 0; j < pts.length; j++) {
      if (Math.abs(i - j) < 30) continue;
      const dx = (pts[i].lng - pts[j].lng) * kx, dy = (pts[i].lat - pts[j].lat) * ky;
      if (dx * dx + dy * dy < 40 * 40) { n++; break; }
    }
  }
  return (n * 50) / 2;
}
const fmt = (p: LatLng) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
function report(tag: string, r: RouteResult, home: LatLng, extra: Record<string, unknown> = {}) {
  const spurs = findSpurs(r.path, 100, 60).map((s) => `${Math.round(s.length)}m@${fmt(s.tip)}`);
  console.log(`${tag}: ${(r.distance / 1000).toFixed(0)} km, ${Math.round(r.duration / 60)} min | twice ${(twice(r.path, home) / 1000).toFixed(1)} km | spurs ${spurs.length} ${spurs.join(" ")} | ${JSON.stringify(extra)}`);
}

async function scenario(name: string, home: LatLng, km: number, heading: number | null, opts: RouteOptions) {
  const origin: Stop = { id: "home", label: "home", position: home };
  const t0 = Date.now();
  let requests = 0;
  const { choices, loops } = await findLoops({
    origin: home, targetMetres: km * 1000, heading, count: 6, atOnce: 2, random: () => 0.5,
    plan: (ring) => (requests++, quickPlan(planPoints(loopStops(origin, ring), true), opts)),
  });
  console.log(`${name}: ${requests} quick requests, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  for (const l of loops) report(`${name} quick h${l.heading.toFixed(0)} x${l.scale}`, l.route, home, { balance: Math.round(l.balance), curves: Math.round(l.curves), acc: Math.round(l.accuracy), overlap: +l.overlap.toFixed(2), deadEnds: +l.deadEnds.toFixed(2), cross: l.crossings });
  for (const c of choices) {
    const ring = (c.loop as FoundLoop).ring;
    const [r] = await planRoute(planPoints(loopStops(origin, ring), true), opts);
    report(`${name} FULL ${c.label} h${c.loop.heading.toFixed(0)} x${c.loop.scale}`, r, home, { moves: r.moves?.length ?? 0 });
    if (c.label === "Best balance") console.log(`PATH ${name} ${JSON.stringify({ ring: ring.map(fmt), path: resample(r.path, 300).map(fmt) })}`);
  }
}

const twisty: RouteOptions = { ...defaultOptions, style: "twisty", returnToStart: true };
const scenic: RouteOptions = { ...defaultOptions, style: "scenic", returnToStart: true };
const caloundra = { lat: -26.8036, lng: 153.1216 };

test("round trips", async () => {
  await scenario("CAL-SW-176-twisty", caloundra, 176, 225, twisty);
  await scenario("CAL-SW-150-scenic", caloundra, 150, 225, scenic);
  await scenario("CAL-W-120-twisty", caloundra, 120, 270, twisty);
  await scenario("NAMBOUR-any-150-twisty", { lat: -26.6264, lng: 152.9594 }, 150, null, twisty);
}, 900_000);
