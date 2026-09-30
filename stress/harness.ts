// Stress tests on real roads: plan loops the way the app does, make the
// edits a rider makes, and count what goes wrong (U-turns, riding up dead
// ends and back, failed routes). Needs the route server on localhost:8989
// (or STRESS_SERVER). Run with `npm run stress`; see stress/README.md.
import { readFileSync, writeFileSync } from "node:fs";
import { expect } from "vitest";
import { bestInsertIndex, destination, distance, findSpurs, loopLayout, roundTripWaypoints } from "../src/lib/geo";
import { onRoads } from "../src/lib/loopFinder";
import { defaultOptions, planRoute, planSections, snapToRoad, throughRoadsNear, type RouteOptions, type RoutePoint, type RouteResult } from "../src/lib/routes";
import { setRouteServer } from "../src/lib/routeServer";
import { reverseStops, routePoints, type Stop } from "../src/lib/storage";

export const SERVER = process.env.STRESS_SERVER ?? "http://localhost:8989";
/** Home for every loop: Caloundra, where the rider lives. */
const HOME = { lat: -26.8036, lng: 153.1216 };
/** Six loops: compass heading and length (km). */
const LOOPS = [
  [250, 120],
  [270, 100],
  [300, 110],
  [230, 110],
  [320, 130],
  [260, 90],
] as const;
/** Out and back further than this counts as a long spur (metres, one way). */
const LONG_SPUR = 1000;

/** The route points the app asks for (as App.tsx's planPoints does, on a loop). */
function planPoints(stops: Stop[]): RoutePoint[] {
  const plan = routePoints(stops, true);
  return plan.map(({ position, stop: s, shape }, i) => {
    const between = i > 0 && i < plan.length - 1;
    if (between && shape >= 0) return { pos: position, via: true, radius: 2000, movable: true };
    return { pos: position, noUturn: between, radius: between ? (s.auto ? 1000 : 75) : undefined, movable: between && s.auto, tapped: between && !s.auto && !!s.tapped };
  });
}

/** Plan as the app does: per-leg styles planned leg by leg, and dead-end fixes applied (up to 3 rounds). */
async function appPlan(stops: Stop[], opts: RouteOptions): Promise<{ stops: Stop[]; r: RouteResult }> {
  for (let fixes = 0; ; fixes++) {
    const plan = routePoints(stops, true);
    const styles = [...stops, stops[0]].slice(0, -1).map((s) => s.legStyle);
    const [r] = await (styles.some(Boolean) ? planSections(planPoints(stops), styles, opts) : planRoute(planPoints(stops), opts));
    const moves = r.moves ?? [];
    if (moves.length && fixes < 3) {
      const to = new Map(moves.filter((m) => plan[m.stop].shape < 0).map((m) => [plan[m.stop].stop.id, m.to]));
      const drop = new Set(moves.filter((m) => plan[m.stop].shape >= 0).map((m) => `${plan[m.stop].stop.id}/${plan[m.stop].shape}`));
      stops = stops.map((s) => ({ ...s, ...(to.has(s.id) ? { position: to.get(s.id)! } : {}), ...(s.shape ? { shape: s.shape.filter((_, k) => !drop.has(`${s.id}/${k}`)) } : {}) }));
      continue;
    }
    const at = r.stopsAt;
    if (at && at.length >= stops.length) stops = stops.map((s, i) => (s.auto && !s.free && distance(s.position, at[i]) > 25 ? { ...s, position: at[i] } : s));
    return { stops, r };
  }
}

/** Each U-turn the router makes, by what it's nearest: home, a hidden shaping point, an app pin, the rider's pin, or nothing. */
function uturns(r: RouteResult, stops: Stop[]): string[] {
  const pts = routePoints(stops, true);
  return r.steps
    .filter((st) => st.type === 12 || st.type === 13)
    .map((st) => {
      const at = r.path[st.at];
      const near = pts
        .map((p, i) => ({ kind: i === 0 || i === pts.length - 1 ? "home" : p.shape >= 0 ? "hidden" : p.stop.auto ? "appPin" : "ownPin", d: distance(p.position, at) }))
        .sort((a, b) => a.d - b.d)[0];
      return near.d < 400 ? near.kind : "none";
    });
}

export interface Tally {
  plans: number;
  failed: number;
  uturns: number;
  uturnsBy: Record<string, number>;
  spurs: number;
  spurMetres: number;
  longSpurs: number;
  km: number;
}

/**
 * Six loops from home, each put through the edits in `ops`: "add stop",
 * "reverse", "drag pin", a whole-route style ("scenic"…), or a style for
 * every leg ("legs fastest", "legs mixed"…).
 */
export async function run(name: string, ops: string[]): Promise<Tally> {
  setRouteServer(SERVER);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const t: Tally = { plans: 0, failed: 0, uturns: 0, uturnsBy: {}, spurs: 0, spurMetres: 0, longSpurs: 0, km: 0 };
  for (const [heading, km] of LOOPS) {
    let opts: RouteOptions = { ...defaultOptions, style: "twisty", returnToStart: true };
    const [ring] = await onRoads([roundTripWaypoints(HOME, km * 1000, heading, 5)], HOME, (p) => throughRoadsNear(p, opts));
    const l = loopLayout(ring, [1, 3]);
    let stops: Stop[] = [{ id: "h", label: "", position: HOME, shape: l.startShape }, ...l.stops.map((p, i) => ({ id: `s${i}`, position: p.position, label: "", auto: true, shape: p.shape }))];
    let out: { stops: Stop[]; r: RouteResult } | null = null;
    for (const op of ["new loop", ...ops]) {
      if (out) stops = out.stops;
      if (op === "add stop" && out) {
        const onPath = out.r.path[Math.floor(rnd() * out.r.path.length)];
        const p = await snapToRoad(destination(onPath, rnd() * 360, 300 + rnd() * 1500), opts);
        const at = bestInsertIndex(stops.map((s) => s.position), p, true);
        stops = [...stops.slice(0, at), { id: `u${t.plans}`, label: "", position: p, tapped: true }, ...stops.slice(at)];
      } else if (op === "reverse") stops = reverseStops(stops, true);
      else if (op === "drag pin") {
        const i = 1 + Math.floor(rnd() * (stops.length - 1));
        const p = await snapToRoad(destination(stops[i].position, rnd() * 360, 800 + rnd() * 1500), opts);
        stops = stops.map((s, k) => (k === i ? { ...s, position: p, auto: false, tapped: true } : s));
      } else if (op.startsWith("legs ")) {
        const style = op.slice(5);
        const pick = ["fastest", "twisty", "scenic"] as const;
        stops = stops.map((s, k) => ({ ...s, legStyle: style === "mixed" ? pick[k % 3] : (style as RouteOptions["style"]) }));
      } else if (op !== "new loop") opts = { ...opts, style: op as RouteOptions["style"] };
      t.plans++;
      try {
        out = await appPlan(stops, opts);
      } catch (e) {
        t.failed++;
        console.log(`${name} h${heading} ${op.padEnd(14)} FAILED ${(e as Error).message}`);
        continue;
      }
      const spurs = findSpurs(out.r.path, 100, 40);
      const u = uturns(out.r, out.stops);
      t.km += out.r.distance / 1000;
      t.spurs += spurs.length;
      t.spurMetres += spurs.reduce((a, x) => a + x.length, 0);
      t.longSpurs += spurs.filter((x) => x.length > LONG_SPUR).length;
      t.uturns += u.length;
      for (const k of u) t.uturnsBy[k] = (t.uturnsBy[k] ?? 0) + 1;
      console.log(`${name} h${heading} ${op.padEnd(14)} ${(out.r.distance / 1000).toFixed(0)}km ${u.length ? `U-turns: ${u.join(",")}` : "no U-turns"}${spurs.length ? ` spurs: ${spurs.map((x) => Math.round(x.length)).join(",")} m` : ""}`);
    }
  }
  t.spurMetres = Math.round(t.spurMetres);
  t.km = Math.round(t.km);
  return t;
}

/**
 * Compare with the baseline (stress/baseline.json) and fail if anything got
 * noticeably worse. Results go to STRESS_OUT when set. STRESS_UPDATE=1
 * writes this run as the new baseline instead.
 */
export function check(name: string, t: Tally) {
  const file = new URL("./baseline.json", import.meta.url);
  const all = JSON.parse(readFileSync(file, "utf8")) as Record<string, Tally>;
  const out = process.env.STRESS_OUT;
  if (out) {
    let prev: Record<string, Tally> = {};
    try {
      prev = JSON.parse(readFileSync(out, "utf8"));
    } catch {
      /* first suite of this run */
    }
    writeFileSync(out, JSON.stringify({ ...prev, [name]: t }, null, 2));
  }
  const base = all[name];
  console.log(`${name}: ${t.plans} plans, ${t.failed} failed, ${t.uturns} U-turns ${JSON.stringify(t.uturnsBy)}, ${t.spurs} spurs (${t.spurMetres} m, ${t.longSpurs} over 1 km), ${t.km} km`);
  if (process.env.STRESS_UPDATE === "1" || !base) {
    writeFileSync(file, JSON.stringify({ ...all, [name]: t }, null, 2) + "\n");
    console.log(`${name}: baseline ${base ? "updated" : "written"}`);
    return;
  }
  console.log(`${name} baseline: ${base.failed} failed, ${base.uturns} U-turns, ${base.spurMetres} m of spurs, ${base.longSpurs} over 1 km`);
  // Some slack: the map data changes month to month.
  expect.soft(t.failed, "failed routes").toBeLessThanOrEqual(base.failed);
  expect.soft(t.uturns, "U-turns").toBeLessThanOrEqual(base.uturns + 3);
  expect.soft(t.spurMetres, "metres ridden up dead ends and back").toBeLessThanOrEqual(Math.round(base.spurMetres * 1.3 + 1500));
  expect.soft(t.longSpurs, "spurs over 1 km").toBeLessThanOrEqual(base.longSpurs + 1);
}
