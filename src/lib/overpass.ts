import { OVERPASS_MIRRORS, OVERPASS_URL } from "./config";

export interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Give each server this long before trying the next. */
const WAIT_MS = 12_000;

/**
 * Run an Overpass query. The public servers are shared and often busy, so
 * each gets a short time limit, and a busy, slow or unreachable one (or one
 * that ran out of time on its side) hands over to the next.
 */
export async function overpass(query: string, signal?: AbortSignal, servers = [OVERPASS_URL, ...OVERPASS_MIRRORS]): Promise<OverpassElement[]> {
  let busy = false;
  for (const url of servers) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const ctrl = new AbortController();
    const stop = () => ctrl.abort();
    signal?.addEventListener("abort", stop);
    const timer = setTimeout(stop, WAIT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) {
        busy ||= res.status === 429 || res.status === 504;
        continue;
      }
      const json: { elements?: OverpassElement[]; remark?: string } = await res.json();
      // A query that ran out of time on the server comes back "OK" with a remark and nothing in it.
      if (!json.elements?.length && /runtime error|timed out|out of memory/i.test(json.remark ?? "")) {
        busy = true;
        continue;
      }
      return json.elements ?? [];
    } catch (e) {
      if (signal?.aborted) throw e;
      // Timed out or unreachable: try the next server.
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  }
  throw new Error(
    busy ? "The map data servers are busy. Try again in a minute." : "Couldn't reach the map data server. Check your signal and try again.",
  );
}
