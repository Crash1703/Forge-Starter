import { describe, expect, it } from "vitest";
import { destination, type LatLng } from "../geo";
import { Announcer, maneuverKind, Navigator, spliceLeg, spliceRejoin, spokenDistance, type Fix, type NavRoute } from "../navigation";
import { STOP_TYPE, type Step } from "../routes";

const start = { lat: -26.65, lng: 152.95 };
const step = (type: number, at: number, instruction: string, extra: Partial<Step> = {}): Step => ({
  type,
  at,
  instruction,
  maneuver: String(type),
  distance: 0,
  ...extra,
});

/** 2 km east, then a right turn and 1 km south. Points every 100 m. */
function lRoute(): NavRoute {
  const path: LatLng[] = [start];
  for (let i = 0; i < 20; i++) path.push(destination(path[path.length - 1], 90, 100));
  for (let i = 0; i < 10; i++) path.push(destination(path[path.length - 1], 180, 100));
  return {
    path,
    distance: 3000,
    duration: 180,
    steps: [
      step(1, 0, "Drive east on Main Road.", { verbal: "Drive east on Main Road." }),
      step(10, 20, "Turn right onto Hill Road.", { alert: "Turn right onto Hill Road.", verbal: "Turn right onto Hill Road." }),
      step(4, 30, "You have arrived at your destination."),
    ],
  };
}

const fixAt = (p: LatLng, t: number, heading: number | null = null, speed: number | null = 20): Fix => ({
  position: p,
  heading,
  speed,
  accuracy: 8,
  time: t * 1000,
});

describe("Navigator", () => {
  it("tracks progress, the next turn and arrival", () => {
    const route = lRoute();
    const nav = new Navigator(route);
    let s = nav.update(fixAt(destination(route.path[5], 0, 6), 0, 90));
    expect(s.onRoute).toBe(true);
    expect(s.along).toBeGreaterThan(480);
    expect(s.along).toBeLessThan(520);
    expect(s.step).toBe(1);
    expect(s.toNext).toBeGreaterThan(1480);
    s = nav.update(fixAt(route.path[25], 60, 180));
    expect(s.step).toBe(2);
    expect(s.remaining).toBeGreaterThan(480);
    expect(s.remaining).toBeLessThan(520);
    s = nav.update(fixAt(route.path[30], 90, 180));
    expect(s.arrived).toBe(true);
  });

  it("notices leaving the route after a few seconds, and rejoining", () => {
    const route = lRoute();
    const nav = new Navigator(route);
    nav.update(fixAt(route.path[5], 0, 90));
    const away = destination(route.path[8], 0, 300);
    expect(nav.update(fixAt(away, 2, 0)).onRoute).toBe(true); // grace period
    const s = nav.update(fixAt(away, 6, 0));
    expect(s.onRoute).toBe(false);
    expect(s.offBy).toBeGreaterThan(250);
    expect(nav.update(fixAt(route.path[12], 20, 90)).onRoute).toBe(true);
  });

  it("knows which way you're riding a road the route uses twice", () => {
    // Out 2 km east and back the same way.
    const out: LatLng[] = [start];
    for (let i = 0; i < 20; i++) out.push(destination(out[out.length - 1], 90, 100));
    const path = [...out, ...out.slice(0, -1).reverse()];
    const nav = new Navigator({ path, steps: [], distance: 4000, duration: 240 });
    nav.update(fixAt(out[2], 0, 90));
    nav.update(fixAt(out[10], 30, 90));
    nav.update(fixAt(out[19], 60, 90));
    // Heading back west past the same spot: the return half, not the way out.
    const s = nav.update(fixAt(out[15], 80, 270));
    expect(s.along).toBeGreaterThan(2400);
  });

  it("rejoins ahead of where you left, but not past the next stop", () => {
    const route = lRoute();
    route.steps.splice(1, 0, step(STOP_TYPE, 12, "Stop 1"));
    const nav = new Navigator(route);
    nav.update(fixAt(route.path[5], 0, 90));
    expect(nav.rejoinIndex(800)).toBe(12);
    nav.update(fixAt(route.path[13], 30, 90));
    expect(nav.rejoinIndex(800)).toBe(21);
  });
});

describe("spliceRejoin", () => {
  it("rides the way back, then the rest of the plan with steps re-numbered", () => {
    const route = lRoute();
    const nav = new Navigator(route);
    const target = 10;
    const off = destination(route.path[6], 0, 300);
    const back: NavRoute = {
      path: [off, destination(off, 90, 300), route.path[target]],
      steps: [step(1, 0, "Head east."), step(15, 1, "Turn right."), step(4, 2, "Arrive.")],
      distance: 600,
      duration: 50,
    };
    const joined = spliceRejoin(route, nav, target, back);
    expect(joined.path.length).toBe(3 + (route.path.length - target - 1));
    expect(joined.path[2]).toEqual(route.path[target]);
    expect(joined.steps.map((s) => s.instruction)).toEqual([
      "Head east.",
      "Turn right.",
      "Turn right onto Hill Road.",
      "You have arrived at your destination.",
    ]);
    // Hill Road was at 20 in the plan: 10 points after the rejoin point, which is now index 2.
    expect(joined.steps[2].at).toBe(12);
    expect(joined.distance).toBeGreaterThan(2550);
  });
});

describe("spliceLeg", () => {
  it("keeps the ride to an earlier stop, then a new leg, then the rest after the rejoin point", () => {
    const route = lRoute();
    route.steps.splice(1, 0, step(STOP_TYPE, 8, "Café"));
    const leg: NavRoute = {
      path: [route.path[8], destination(route.path[8], 0, 200), route.path[24]],
      steps: [step(1, 0, "Head north."), step(15, 1, "Turn right."), step(4, 2, "Arrive.")],
      distance: 900,
      duration: 60,
    };
    const joined = spliceLeg(route, 3, 8, leg, route, 24);
    // Points 3–7 of the plan, the leg's three, then 25–30.
    expect(joined.path.length).toBe(5 + 3 + 6);
    expect(joined.path[5]).toEqual(route.path[8]);
    expect(joined.path[7]).toEqual(route.path[24]);
    expect(joined.steps.map((s) => [s.instruction, s.at])).toEqual([
      ["Café", 5],
      ["Head north.", 5],
      ["Turn right.", 6],
      ["You have arrived at your destination.", 13],
    ]);
    expect(joined.distance).toBeGreaterThan(500 + 900 + 550);
    expect(joined.distance).toBeLessThan(500 + 900 + 650);
  });

  it("starts at the rider when the leg starts there", () => {
    const route = lRoute();
    const off = destination(route.path[6], 0, 100);
    const leg: NavRoute = { path: [off, route.path[12]], steps: [step(1, 0, "Head east."), step(4, 1, "Arrive.")], distance: 600, duration: 40 };
    const joined = spliceLeg(route, 6, 6, leg, route, 12);
    expect(joined.path[0]).toEqual(off);
    expect(joined.steps[0].instruction).toBe("Head east.");
    expect(joined.steps[1]).toMatchObject({ instruction: "Turn right onto Hill Road.", at: 1 + 20 - 12 });
  });
});

describe("Announcer", () => {
  it("warns early, calls the turn, and speaks each once", () => {
    const route = lRoute();
    const nav = new Navigator(route);
    const talk = new Announcer();
    const gap = () => 2000;
    const said: string[] = [];
    for (let i = 0; i <= 30; i++) {
      const heading = i <= 20 ? 90 : 180;
      const line = talk.next(nav.update(fixAt(route.path[i], i * 5, heading, 20)), route, gap);
      if (line) said.push(line);
    }
    expect(said).toEqual([
      "Drive east on Main Road.",
      "In 400 metres, turn right onto Hill Road.",
      "Turn right onto Hill Road.",
      "You have arrived.",
    ]);
  });

  it("says when you leave and rejoin the route", () => {
    const route = lRoute();
    const nav = new Navigator(route);
    const talk = new Announcer(true);
    const gap = () => 0;
    talk.next(nav.update(fixAt(route.path[2], 0, 90)), route, gap);
    const away = destination(route.path[4], 0, 300);
    nav.update(fixAt(away, 1, 0));
    expect(talk.next(nav.update(fixAt(away, 8, 0)), route, gap)).toMatch(/Off route/);
    expect(talk.next(nav.update(fixAt(away, 9, 0)), route, gap)).toBeNull();
    expect(talk.next(nav.update(fixAt(route.path[6], 20, 90)), route, gap)).toBe("Back on your route.");
  });
});

describe("wording", () => {
  it("rounds distances the way a person would say them", () => {
    expect(spokenDistance(83)).toBe("100 metres");
    expect(spokenDistance(430)).toBe("400 metres");
    expect(spokenDistance(1000)).toBe("1 kilometre");
    expect(spokenDistance(1740)).toBe("1.5 kilometres");
    expect(spokenDistance(2100)).toBe("2 kilometres");
  });

  it("maps manoeuvre types to arrows", () => {
    expect(maneuverKind(10)).toBe("right");
    expect(maneuverKind(15)).toBe("left");
    expect(maneuverKind(26)).toBe("roundabout");
    expect(maneuverKind(STOP_TYPE)).toBe("stop");
    expect(maneuverKind(4)).toBe("arrive");
  });
});
