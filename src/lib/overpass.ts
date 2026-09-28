import { OVERPASS_MIRRORS, OVERPASS_URL } from "./config";

export interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/**
 * Give up on a server after this long. When the main server is healthy it
 * answers in 1-4 s; when it's overloaded it fails after ~10 s; the second
 * server takes 10-20 s but usually gets there.
 */
const WAIT_MS = 25_000;
/** Answers are kept this long, so looking again (planner, then ride) is instant. */
const KEEP_MS = 30 * 60_000;
const cache = new Map<string, { at: number; elements: OverpassElement[] }>();

class ServerBusy extends Error {}

async function ask(url: string, query: string, signal: AbortSignal): Promise<OverpassElement[]> {
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw res.status === 429 || res.status === 504 ? new ServerBusy(`${res.status}`) : new Error(`${res.status}`);
  const json: { elements?: OverpassElement[]; remark?: string } = await res.json();
  // Ran out of time on the server: comes back "OK" with a remark and nothing in it.
  if (!json.elements?.length && /runtime error|timed out|out of memory/i.test(json.remark ?? "")) throw new ServerBusy(json.remark);
  return json.elements ?? [];
}

/** Ask every server at once; the first good answer wins and the rest are called off. */
async function race(query: string, servers: string[], signal?: AbortSignal): Promise<OverpassElement[]> {
  const ctrls = servers.map(() => new AbortController());
  const stopAll = () => ctrls.forEach((c) => c.abort());
  signal?.addEventListener("abort", stopAll);
  const timers = ctrls.map((c) => setTimeout(() => c.abort(), WAIT_MS));
  try {
    return await Promise.any(servers.map((url, i) => ask(url, query, ctrls[i].signal)));
  } finally {
    stopAll();
    timers.forEach(clearTimeout);
    signal?.removeEventListener("abort", stopAll);
  }
}

/**
 * Run an Overpass query. The public servers are shared and often
 * overloaded, so they're asked together (first answer wins), and if all
 * fail it tries once more. Answers are remembered for half an hour.
 */
export async function overpass(query: string, signal?: AbortSignal, servers = [OVERPASS_URL, ...OVERPASS_MIRRORS]): Promise<OverpassElement[]> {
  const hit = cache.get(query);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.elements;
  let busy = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (attempt) await new Promise((r) => setTimeout(r, 1500));
    try {
      const elements = await race(query, servers, signal);
      cache.set(query, { at: Date.now(), elements });
      return elements;
    } catch (e) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const errors = e instanceof AggregateError ? e.errors : [e];
      // A busy server, or one that ran out of our time: worth another go.
      busy ||= errors.some((x) => x instanceof ServerBusy || (x as Error)?.name === "AbortError");
    }
  }
  throw new Error(
    busy ? "The map data servers are busy. Try again in a minute." : "Couldn't reach the map data server. Check your signal and try again.",
  );
}

/** Forget remembered answers (for tests). */
export function clearOverpassCache() {
  cache.clear();
}
