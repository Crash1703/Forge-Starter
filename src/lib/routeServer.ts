import { VALHALLA_URL } from "./config";

/**
 * Which route server to ask: the free public one, or the rider's own (say, a
 * computer at home running Valhalla, reached through a tunnel). The rider's
 * own server is asked first; if it's switched off or unreachable, the public
 * one answers instead, so a sleeping home PC never leaves the rider stuck.
 */
let own = "";

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
}

/** Requests the server can take at once: the public one refuses bursts, the rider's own doesn't mind. */
export const requestsAtOnce = () => (own ? 4 : 2);

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
  const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  if (own) {
    try {
      const res = await fetch(`${own}${path}`, { ...init, signal: withTimeout(signal, OWN_TIMEOUT_MS) });
      // Down behind a working tunnel (502/503/504): try the public server.
      if (res.status < 500) return res;
    } catch (e) {
      if (signal?.aborted) throw e;
      // Off, asleep or unreachable: fall through to the public server.
    }
  }
  return fetch(`${VALHALLA_URL}${path}`, { ...init, signal });
}

/** Check a route server answers: its Valhalla version, or why not. */
export async function checkRouteServer(url: string, signal?: AbortSignal): Promise<string> {
  const base = normaliseServer(url);
  if (!/^https:\/\//.test(base)) throw new Error("The address must start with https:// (the app can't use plain http).");
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
