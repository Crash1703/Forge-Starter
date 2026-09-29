import { VALHALLA_URL } from "./config";
import { edgesFromKnown, edgesFromMatch, ghRouteRequest, ghSnapRequest, roadsOf, toGpx, tripFromPath, type GhMatch, type GhPath, type Road, type ValhallaRouteBody } from "./graphhopper";
import { decodePolyline } from "./polyline";

/**
 * Which route server to ask: the free public one, or the rider's own (say, a
 * computer at home running Valhalla, reached through a tunnel). The rider's
 * own server is asked first; if it's switched off or unreachable, the public
 * one answers instead, so a sleeping home PC never leaves the rider stuck.
 * The rider's server may be Valhalla or GraphHopper; the app asks both in
 * Valhalla's terms (see graphhopper.ts).
 */
let own = "";
/** What the rider's server is, found out on first use. */
let ownKind: Promise<"valhalla" | "graphhopper"> | null = null;

/** How long to wait for the rider's own server before asking the public one. */
const OWN_TIMEOUT_MS = 6000;

/** Tidy a typed address: trim, drop a trailing slash, add https:// if missing. */
export function normaliseServer(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (u && !/^[a-z]+:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

export function setRouteServer(url: string) {
  own = normaliseServer(url);
  ownKind = null;
  graphHopper = false;
}

/** Whether the rider's GraphHopper server is answering (known once it has been asked). */
let graphHopper = false;

/** Requests the server can take at once: the public one refuses bursts, the rider's own doesn't mind. */
export const requestsAtOnce = () => (own ? (graphHopper ? 6 : 4) : 2);

/**
 * Whether the router itself chooses roads by the ride style (the rider's
 * GraphHopper server does; Valhalla doesn't, so the app tries detours).
 */
export const routerKnowsStyle = () => !!own && graphHopper;

/** GraphHopper answers /info with its profiles; Valhalla doesn't have one. */
async function kindOf(base: string, signal?: AbortSignal): Promise<"valhalla" | "graphhopper"> {
  // No answer at all throws: asked again next time rather than guessed.
  const res = await fetch(`${base}/info`, { signal: withTimeout(signal, OWN_TIMEOUT_MS) });
  const json = res.ok ? ((await res.json().catch(() => null)) as { profiles?: unknown } | null) : null;
  return json && Array.isArray(json.profiles) ? "graphhopper" : "valhalla";
}

/** The roads under recently planned paths, by point (see roadsOf); cleared when it grows large. */
const knownRoads = new Map<string, Road>();
const KNOWN_MAX = 400_000;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A Valhalla request answered by GraphHopper, as a Valhalla-shaped response. */
async function askGraphHopper(base: string, path: string, body: unknown, signal: AbortSignal): Promise<Response> {
  const decode = (s: string) => decodePolyline(s, 6);
  const post = (url: string, payload: unknown) =>
    fetch(`${base}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal });
  const profileOf = (costing: string) => (costing === "auto" ? "car" : "motorcycle");
  /** `p` on the nearest road of at least `minClass` the profile can ride, or null if none is near. */
  const snap = async (p: { lat: number; lon: number }, profile: string, minClass?: string) => {
    const res = await post("/route", ghSnapRequest(p, profile, minClass));
    const answer = res.ok ? ((await res.json()) as { paths?: { snapped_waypoints?: { coordinates?: [number, number][] } }[] }) : null;
    const c = answer?.paths?.[0]?.snapped_waypoints?.coordinates?.[0];
    return c ? { lat: c[1], lon: c[0] } : null;
  };
  if (path === "/route") {
    const b0 = body as ValhallaRouteBody;
    // Points the app placed itself snap only to proper roads (Valhalla's
    // search_filter): a loop's shaping points onto through roads, not a
    // side street or a forestry track the route would ride up and back.
    // With no proper road near (deep in a forest, say), any rideable road
    // will do; a shaping point with no road near at all is skipped rather
    // than failing the whole route, as Valhalla's radius would allow.
    const snapped = await Promise.all(
      b0.locations.map(async (l) => {
        if (!l.search_filter?.min_road_class) return l;
        const profile = profileOf(b0.costing);
        const at = (await snap(l, profile, l.search_filter.min_road_class)) ?? (await snap(l, profile));
        return at ? { ...l, ...at } : l.type === "through" ? null : l;
      }),
    );
    const b: ValhallaRouteBody = { ...b0, locations: snapped.filter((l): l is NonNullable<typeof l> => !!l) };
    const res = await post("/route", ghRouteRequest(b));
    const answer = (await res.json().catch(() => ({}))) as { paths?: GhPath[]; message?: string };
    if (!res.ok || !answer.paths?.length) return json({ error: answer.message ?? "No route found" }, res.status >= 500 ? res.status : 400);
    if (knownRoads.size > KNOWN_MAX) knownRoads.clear();
    for (const p of answer.paths) for (const [k, road] of roadsOf(p, decode)) knownRoads.set(k, road);
    const [first, ...others] = answer.paths.map((p) => tripFromPath(p, b, decode));
    return json({ trip: first, alternates: others.map((trip) => ({ trip })) });
  }
  if (path === "/locate") {
    const b = body as { locations: { lat: number; lon: number; search_filter?: { min_road_class?: string } }[]; costing: string };
    const found = await Promise.all(
      b.locations.map(async (l) => {
        const at = await snap(l, profileOf(b.costing), l.search_filter?.min_road_class);
        return { edges: at ? [{ correlated_lat: at.lat, correlated_lon: at.lon }] : [] };
      }),
    );
    return json(found);
  }
  if (path === "/trace_attributes") {
    const b = body as { shape: { lat: number; lon: number }[]; costing: string };
    // A path this server planned: its roads are already known.
    const known = edgesFromKnown(b.shape, (k) => knownRoads.get(k));
    if (known) return json({ edges: known });
    // Anything else is matched to the map, which takes a few seconds.
    const profile = profileOf(b.costing);
    const details = ["road_class", "surface", "urban_density", "max_speed"].map((d) => `details=${d}`).join("&");
    const res = await fetch(`${base}/match?profile=${profile}&gps_accuracy=15&points_encoded=true&points_encoded_multiplier=1000000&instructions=false&${details}`, {
      method: "POST",
      headers: { "Content-Type": "application/gpx+xml" },
      body: toGpx(b.shape),
      signal,
    });
    if (!res.ok) return json({ error: "Map matching failed" }, res.status);
    return json({ edges: edgesFromMatch((await res.json()) as GhMatch, b.shape, decode) });
  }
  return json({ error: `Not supported: ${path}` }, 501);
}

/** The body as Valhalla takes it: without the app's own hints. */
function forValhalla(body: unknown): unknown {
  if (!body || typeof body !== "object" || !("_rf" in body)) return body;
  const { _rf: _hints, ...rest } = body as Record<string, unknown>;
  return rest;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms);
  // Older phones' web views lack AbortSignal.any: then only the rider can cancel.
  if (!signal) return t;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, t]) : signal;
}

/**
 * POST to the route server: the rider's own first (if set), the public one
 * if that fails to answer. Errors the server gives (no route, bad request)
 * are real answers and aren't retried.
 */
export async function routerFetch(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(forValhalla(body)) };
  if (own) {
    try {
      const base = own;
      ownKind ??= kindOf(base, signal).then(
        (kind) => ((graphHopper = kind === "graphhopper"), kind),
        (e) => {
          ownKind = null;
          throw e;
        },
      );
      const res =
        (await ownKind) === "graphhopper"
          ? await askGraphHopper(base, path, body, withTimeout(signal, OWN_TIMEOUT_MS * 3))
          : await fetch(`${base}${path}`, { ...init, signal: withTimeout(signal, OWN_TIMEOUT_MS) });
      // Down behind a working tunnel (502/503/504): try the public server.
      if (res.status < 500) return res;
    } catch (e) {
      if (signal?.aborted) throw e;
      // Off, asleep or unreachable: fall through to the public server.
    }
  }
  return fetch(`${VALHALLA_URL}${path}`, { ...init, signal });
}

/** Check a route server answers: which server and version, or why not. */
export async function checkRouteServer(url: string, signal?: AbortSignal): Promise<string> {
  const base = normaliseServer(url);
  if (!/^https:\/\//.test(base)) throw new Error("The address must start with https:// (the app can't use plain http).");
  // GraphHopper tells its version and map date at /info.
  try {
    const info = await fetch(`${base}/info`, { signal: withTimeout(signal, 10_000) });
    const gh = info.ok ? ((await info.json()) as { profiles?: { name: string }[]; version?: string; data_date?: string }) : null;
    if (gh && Array.isArray(gh.profiles)) {
      if (!gh.profiles.some((p) => p.name === "motorcycle")) throw new Error("That GraphHopper server has no motorcycle profile (see README-server.md).");
      return `GraphHopper ${gh.version ?? ""}${gh.data_date ? `, map from ${gh.data_date.slice(0, 10)}` : ""}`.trim();
    }
  } catch (e) {
    if ((e as Error).message.startsWith("That GraphHopper")) throw e;
    // Not GraphHopper, or no answer: try Valhalla's status below.
  }
  let res: Response;
  try {
    res = await fetch(`${base}/status`, { signal: withTimeout(signal, 10_000) });
  } catch {
    throw new Error("No answer from that address. Is the server on, and the tunnel running?");
  }
  if (!res.ok) throw new Error(`The server answered, but not as a route server (HTTP ${res.status}).`);
  const json = (await res.json().catch(() => ({}))) as { version?: string };
  return json.version ? `Valhalla ${json.version}` : "a route server";
}
