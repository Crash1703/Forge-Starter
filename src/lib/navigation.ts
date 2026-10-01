import { bearing, distanceUnits, MILE, turnAngle, type LatLng } from "./geo";
import { STOP_TYPE, type Step } from "./routes";

/** The route being ridden: the planned one, or a way back spliced onto it. */
export interface NavRoute {
  path: LatLng[];
  steps: Step[];
  distance: number; // metres
  duration: number; // seconds
}

/** One GPS reading. Speed in m/s, heading in degrees; either may be unknown. */
export interface Fix {
  position: LatLng;
  speed: number | null;
  heading: number | null;
  accuracy: number;
  time: number; // ms
}

export interface NavState {
  /** Your position moved onto the route (or the raw fix when off it). */
  snapped: LatLng;
  /** Metres ridden along the route. */
  along: number;
  remaining: number;
  remainingTime: number; // seconds
  onRoute: boolean;
  /** Metres between you and the route. */
  offBy: number;
  /** Index into route.steps of the next manoeuvre. */
  step: number;
  /** Metres to that manoeuvre. */
  toNext: number;
  arrived: boolean;
  heading: number | null;
  speed: number | null; // m/s
}

// Flat-earth metres around a latitude: accurate enough over a road segment.
function frame(lat: number) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180);
  return { kx, ky: 110540 };
}

/** Closest point to `p` on segment a–b: how far along (0–1) and how far away (m). */
function project(p: LatLng, a: LatLng, b: LatLng) {
  const { kx, ky } = frame(p.lat);
  const ax = (a.lng - p.lng) * kx;
  const ay = (a.lat - p.lat) * ky;
  const bx = (b.lng - p.lng) * kx;
  const by = (b.lat - p.lat) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
  const x = ax + t * dx;
  const y = ay + t * dy;
  return { t, dist: Math.hypot(x, y), point: { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) } };
}

const isArrival = (type: number) => type >= 4 && type <= 6;

/**
 * Follows a rider along a route. Feed it GPS fixes; it says where you are on
 * the route, what's next, and whether you've left it.
 */
export class Navigator {
  readonly cum: number[];
  private index = 0; // segment index (path[index] → path[index + 1])
  private along = 0;
  private offSince: number | null = null;
  private last: Fix | null = null;
  private done = false;
  private stepPtr = 0;

  constructor(readonly route: NavRoute) {
    this.cum = [0];
    for (let i = 1; i < route.path.length; i++) {
      const { kx, ky } = frame(route.path[i].lat);
      const a = route.path[i - 1];
      const b = route.path[i];
      this.cum.push(this.cum[i - 1] + Math.hypot((b.lng - a.lng) * kx, (b.lat - a.lat) * ky));
    }
  }

  get total() {
    return this.cum[this.cum.length - 1] ?? 0;
  }

  /** Path index of the first point at least `metres` along the route. */
  indexAt(metres: number): number {
    let lo = 0;
    let hi = this.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] < metres) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private best(fix: Fix, from: number, to: number, heading: number | null, moving: boolean) {
    const { path } = this.route;
    let pick = { i: -1, dist: Infinity, score: Infinity, t: 0, point: fix.position };
    for (let i = Math.max(0, from); i < Math.min(path.length - 1, to); i++) {
      const pr = project(fix.position, path[i], path[i + 1]);
      if (pr.dist > 250) continue;
      // On a road ridden both ways (out and back, or a loop's home road),
      // the direction of travel decides which pass you're on.
      let score = pr.dist;
      if (heading != null && moving && Math.abs(turnAngle(bearing(path[i], path[i + 1]), heading)) > 100) score += 80;
      if (score < pick.score) pick = { i, dist: pr.dist, score, t: pr.t, point: pr.point };
    }
    return pick;
  }

  update(fix: Fix): NavState {
    const d = this.last ? delta(this.last.position, fix.position) : null;
    const moved = d ? Math.hypot(d.x, d.y) : 0;
    const heading =
      fix.heading ?? (this.last && moved > 5 ? bearing(this.last.position, fix.position) : null);
    const speed =
      fix.speed ?? (this.last && fix.time > this.last.time ? moved / ((fix.time - this.last.time) / 1000) : null);
    const moving = (speed ?? 0) > 2;
    this.last = fix;

    const tolerance = Math.min(80, Math.max(35, 25 + fix.accuracy));
    // Look a little behind and well ahead of where we last were.
    const back = this.indexAt(this.along - 150);
    const ahead = this.indexAt(this.along + Math.max(800, (speed ?? 0) * 60)) + 1;
    let m = this.best(fix, back, ahead, heading, moving);
    // As far along the route as you could have ridden since the last fix
    // (twisty roads are longer than the straight line, hence twice).
    const couldRide = moved * 2 + 100;
    if (m.dist > tolerance) {
      // Rejoined further on (a short cut, back from a detour, or after a GPS
      // gap)? Look ahead along the whole route, but not into the run-in to
      // the finish unless you could be most of the way round by now: on a
      // loop the finish is where you start, and starting a little off the
      // road (a driveway) matched the finish, and "arrived".
      const far = this.best(fix, this.index, this.lastStretchFrom(couldRide), heading, moving);
      if (far.dist <= tolerance) m = far;
    }

    let onRoute: boolean;
    if (m.i >= 0 && m.dist <= tolerance) {
      const along = this.cum[m.i] + m.t * (this.cum[m.i + 1] - this.cum[m.i]);
      // Ridden: going on along the route, as far as you could have since the last fix.
      if (along > this.along) this.ridden += Math.min(along - this.along, couldRide);
      this.index = m.i;
      this.along = along;
      this.offSince = null;
      this.everOn = true;
      onRoute = true;
    } else {
      this.offSince ??= fix.time;
      // A few seconds of grace for GPS wobble in towns and under trees.
      onRoute = fix.time - this.offSince < 4000;
    }

    const total = this.total;
    const remaining = Math.max(0, total - this.along);
    // Arrived: at the finish, having ridden at least half of the way there.
    if (onRoute && m.dist <= tolerance && remaining < 35 && this.ridden >= Math.min(total / 2, total - 500)) this.done = true;

    const { steps } = this.route;
    while (this.stepPtr < steps.length - 1 && this.cum[steps[this.stepPtr].at] <= this.along + 3) this.stepPtr++;
    // Re-matching backwards (a U-turn onto the route) can move the next step back too.
    while (this.stepPtr > 0 && this.cum[steps[this.stepPtr - 1].at] > this.along + 3) this.stepPtr--;
    const next = steps[this.stepPtr];

    return {
      snapped: onRoute && m.dist <= tolerance ? m.point : fix.position,
      along: this.along,
      remaining,
      remainingTime: total > 0 ? (this.route.duration * remaining) / total : 0,
      onRoute,
      offBy: m.i >= 0 ? m.dist : Infinity,
      step: this.stepPtr,
      toNext: next ? Math.max(0, this.cum[next.at] - this.along) : remaining,
      arrived: this.done,
      heading,
      speed,
    };
  }

  /**
   * Path index nearest to `p` on the route, leaving out the run-in to the
   * finish until most of the ride is done (on a loop it's where you start).
   */
  closestIndex(p: LatLng): number {
    let best = 0;
    let bestD = Infinity;
    const { kx, ky } = frame(p.lat);
    const end = this.lastStretchFrom();
    for (let i = 0; i < end; i++) {
      const q = this.route.path[i];
      const d = Math.hypot((q.lng - p.lng) * kx, (q.lat - p.lat) * ky);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Metres of the route ridden in order (not jumped over). */
  private ridden = 0;

  /**
   * Where the run-in to the finish begins (a path index): the last fifth of
   * the route (at least 1.5 km), only matched once half the ride is done
   * (counting `extra` metres more). After that, the whole route.
   */
  private lastStretchFrom(extra = 0): number {
    const total = this.total;
    if (this.ridden + extra >= total / 2) return this.route.path.length;
    return Math.max(1, this.indexAt(total - Math.max(1500, total * 0.2)));
  }

  /** True once any fix has matched the route. */
  get started() {
    return this.along > 0 || this.everOn;
  }
  private everOn = false;

  /**
   * Where to rejoin the route after leaving it: about `ahead` metres past
   * the last point ridden, but never past the next stop, so stops aren't skipped.
   */
  rejoinIndex(ahead = 800): number {
    let target = this.indexAt(this.along + ahead);
    const stop = this.route.steps.find(
      (s) => (s.type === STOP_TYPE || isArrival(s.type)) && this.cum[s.at] > this.along + 20,
    );
    if (stop && stop.at < target) target = stop.at;
    return Math.min(target, this.route.path.length - 1);
  }
}

function delta(a: LatLng, b: LatLng) {
  const { kx, ky } = frame(a.lat);
  return { x: (b.lng - a.lng) * kx, y: (b.lat - a.lat) * ky };
}

/**
 * A new route to ride: the way back (`back`, from where you are to path
 * index `target` of the planned route), followed by the rest of the plan.
 */
export function spliceRejoin(route: NavRoute, nav: Navigator, target: number, back: NavRoute): NavRoute {
  const base = back.path.length - 1;
  const restMetres = nav.total - nav.cum[target];
  return {
    path: [...back.path, ...route.path.slice(target + 1)],
    steps: [
      ...back.steps.filter((s) => !isArrival(s.type)),
      ...route.steps.filter((s) => s.at > target).map((s) => ({ ...s, at: s.at - target + base })),
    ],
    distance: back.distance + restMetres,
    duration: back.duration + (nav.total > 0 ? (route.duration * restMetres) / nav.total : 0),
  };
}

/**
 * A new route to ride: `head` from path index `start` up to `cut`, then
 * `leg` (which starts at head.path[cut], or where the rider is when `start`
 * and `cut` are the same), then `tail` after path index `from` (where the leg
 * ends). Used to take a stop back out of the route.
 */
export function spliceLeg(head: NavRoute, start: number, cut: number, leg: NavRoute, tail: NavRoute, from: number): NavRoute {
  const hc = new Navigator(head).cum;
  const tn = new Navigator(tail);
  const legAt = cut - start;
  const tailAt = legAt + leg.path.length - 1;
  const headMetres = hc[cut] - hc[start];
  const tailMetres = tn.total - tn.cum[from];
  const headTotal = hc[hc.length - 1] ?? 0;
  return {
    path: [...head.path.slice(start, cut), ...leg.path, ...tail.path.slice(from + 1)],
    steps: [
      ...head.steps.filter((s) => s.at >= start && (s.at < cut || (s.at === cut && cut > start && s.type === STOP_TYPE)) && !isArrival(s.type)).map((s) => ({ ...s, at: s.at - start })),
      ...leg.steps.filter((s) => !isArrival(s.type)).map((s) => ({ ...s, at: s.at + legAt })),
      ...tail.steps.filter((s) => s.at > from).map((s) => ({ ...s, at: s.at - from + tailAt })),
    ],
    distance: headMetres + leg.distance + tailMetres,
    duration:
      (headTotal > 0 ? (head.duration * headMetres) / headTotal : 0) + leg.duration + (tn.total > 0 ? (tail.duration * tailMetres) / tn.total : 0),
  };
}

/**
 * "400 metres", "1.5 kilometres" (or "500 feet", "1.5 miles"): rounded the
 * way a co-rider would say it.
 */
export function spokenDistance(m: number): string {
  if (distanceUnits() === "mi") {
    if (m >= 0.2 * MILE) {
      const mi = Math.round((m / MILE) * 2) / 2 || 0.5;
      return `${mi % 1 ? mi.toFixed(1) : mi} mile${mi === 1 ? "" : "s"}`;
    }
    const ft = m * 3.28084;
    return `${ft >= 300 ? Math.round(ft / 100) * 100 : Math.max(100, Math.round(ft / 50) * 50)} feet`;
  }
  if (m >= 950) {
    const km = Math.round(m / 500) / 2;
    return `${km % 1 ? km.toFixed(1) : km} kilometre${km === 1 ? "" : "s"}`;
  }
  const r = m >= 300 ? Math.round(m / 100) * 100 : Math.max(50, Math.round(m / 50) * 50);
  return `${r} metres`;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Decides what to say and when: an early warning for each turn (if there's
 * room for one), a call as you reach it, and a word when you leave or rejoin
 * the route or arrive. Each is said once.
 */
export class Announcer {
  private said = new Set<string>();
  private wasOff = false;

  constructor(
    private readonly loop = false,
    /** After finding a way back, don't repeat the ride's opening instruction. */
    skipStart = false,
  ) {
    if (skipStart) this.said.add("start");
  }

  next(state: NavState, route: NavRoute, stepGap: (i: number) => number): string | null {
    if (!state.onRoute) {
      if (this.wasOff) return null;
      this.wasOff = true;
      return "Off route. Finding the way back to your route.";
    }
    if (this.wasOff) {
      this.wasOff = false;
      return "Back on your route.";
    }
    // The route's opening instruction sits at its very start, before the
    // first fix moves past it: say it once as the ride begins.
    const first = route.steps[0];
    if (!this.said.has("start") && first && first.type >= 1 && first.type <= 3 && state.along < 150) {
      this.said.add("start");
      return first.verbal ?? first.instruction;
    }
    if (state.arrived) {
      if (this.said.has("arrived")) return null;
      this.said.add("arrived");
      return this.loop ? "You're back at the start. Nice ride." : "You have arrived.";
    }
    const step = route.steps[state.step];
    if (!step || isArrival(step.type)) return null;
    const v = state.speed ?? 15;
    const near = Math.max(40, v * 7); // about 7 seconds out
    const early = Math.max(350, v * 25); // about 25 seconds out
    const now = `${state.step}:now`;
    const warn = `${state.step}:early`;
    if (state.toNext <= near) {
      if (this.said.has(now)) return null;
      this.said.add(now);
      this.said.add(warn);
      return step.verbal ?? step.instruction;
    }
    // Only warn early when the previous turn is well behind, so prompts don't pile up.
    if (state.toNext <= early && state.toNext > near * 1.5 && !this.said.has(warn) && stepGap(state.step) > near * 2) {
      this.said.add(warn);
      return `In ${spokenDistance(state.toNext)}, ${lowerFirst(step.alert ?? step.instruction)}`;
    }
    return null;
  }
}

export type ManeuverKind =
  | "depart"
  | "arrive"
  | "stop"
  | "straight"
  | "slight-right"
  | "right"
  | "sharp-right"
  | "uturn"
  | "sharp-left"
  | "left"
  | "slight-left"
  | "roundabout"
  | "merge"
  | "ferry";

/** Which arrow to draw for a Valhalla manoeuvre type. */
export function maneuverKind(type: number): ManeuverKind {
  if (type === STOP_TYPE) return "stop";
  if (type >= 1 && type <= 3) return "depart";
  if (isArrival(type)) return "arrive";
  switch (type) {
    case 9:
    case 18:
    case 20:
    case 23:
      return "slight-right";
    case 10:
      return "right";
    case 11:
      return "sharp-right";
    case 12:
    case 13:
      return "uturn";
    case 14:
      return "sharp-left";
    case 15:
      return "left";
    case 16:
    case 19:
    case 21:
    case 24:
      return "slight-left";
    case 25:
    case 37:
    case 38:
      return "merge";
    case 26:
    case 27:
      return "roundabout";
    case 28:
    case 29:
      return "ferry";
    default:
      return "straight";
  }
}
