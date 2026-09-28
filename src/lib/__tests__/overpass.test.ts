import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearOverpassCache, overpass } from "../overpass";

const servers = ["https://a.example/api", "https://b.example/api"];
const ok = (elements: unknown[]) => new Response(JSON.stringify({ elements }));
const never = (_u: string, init: RequestInit) =>
  new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));

describe("overpass", () => {
  beforeEach(() => clearOverpassCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("asks both servers at once and takes the first answer", async () => {
    const f = vi.fn((url: string, init: RequestInit) => (url.includes("a.") ? never(url, init) : Promise.resolve(ok([{ type: "node", id: 2 }]))));
    vi.stubGlobal("fetch", f);
    expect(await overpass("q", undefined, servers)).toEqual([{ type: "node", id: 2 }]);
    expect(f).toHaveBeenCalledTimes(2);
    // The slow one is called off.
    expect((f.mock.calls[0][1] as RequestInit).signal!.aborted).toBe(true);
  });

  it("uses the other server when one is busy or ran out of time on its side", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("a.") ? new Response(JSON.stringify({ elements: [], remark: "runtime error: Query timed out" })) : ok([{ type: "node", id: 3 }]),
      ),
    );
    expect(await overpass("q", undefined, servers)).toEqual([{ type: "node", id: 3 }]);
  });

  it("tries once more when every server fails the first time", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (++calls <= 2 ? new Response("", { status: 504 }) : ok([{ type: "node", id: 4 }]))));
    expect(await overpass("q", undefined, servers)).toEqual([{ type: "node", id: 4 }]);
  });

  it("gives up on a server that doesn't answer in time", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => (url.includes("a.") ? never(url, init) : Promise.resolve(new Response("", { status: 504 })))));
    const p = overpass("q", undefined, servers);
    const done = expect(p).rejects.toThrow(/busy/);
    await vi.advanceTimersByTimeAsync(60_000);
    await done;
  });

  it("remembers answers", async () => {
    const f = vi.fn(async () => ok([{ type: "node", id: 5 }]));
    vi.stubGlobal("fetch", f);
    await overpass("same", undefined, servers);
    const before = f.mock.calls.length;
    expect(await overpass("same", undefined, servers)).toEqual([{ type: "node", id: 5 }]);
    expect(f.mock.calls.length).toBe(before);
  });

  it("says what went wrong when every server fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(overpass("q", undefined, servers)).rejects.toThrow(/Couldn't reach/);
  });

  it("stops when the caller gives up", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(overpass("q", ctrl.signal, servers)).rejects.toThrow(/Abort/);
  });
});
