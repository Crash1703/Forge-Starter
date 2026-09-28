import { afterEach, describe, expect, it, vi } from "vitest";
import { overpass } from "../overpass";

const servers = ["https://a.example/api", "https://b.example/api"];
const ok = (elements: unknown[]) => new Response(JSON.stringify({ elements }));

describe("overpass", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("uses the first server when it answers", async () => {
    const f = vi.fn(async () => ok([{ type: "node", id: 1 }]));
    vi.stubGlobal("fetch", f);
    expect(await overpass("q", undefined, servers)).toHaveLength(1);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("moves on when a server is busy, or ran out of time on its side", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 504 }))
      .mockResolvedValueOnce(ok([{ type: "node", id: 2 }]));
    vi.stubGlobal("fetch", f);
    expect(await overpass("q", undefined, servers)).toEqual([{ type: "node", id: 2 }]);

    const g = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ elements: [], remark: "runtime error: Query timed out" })))
      .mockResolvedValueOnce(ok([{ type: "node", id: 3 }]));
    vi.stubGlobal("fetch", g);
    expect(await overpass("q", undefined, servers)).toEqual([{ type: "node", id: 3 }]);
  });

  it("moves on when a server doesn't answer in time", async () => {
    vi.useFakeTimers();
    const f = vi
      .fn()
      .mockImplementationOnce((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))))
      .mockResolvedValueOnce(ok([{ type: "node", id: 4 }]));
    vi.stubGlobal("fetch", f);
    const p = overpass("q", undefined, servers);
    await vi.advanceTimersByTimeAsync(12_500);
    expect(await p).toEqual([{ type: "node", id: 4 }]);
  });

  it("says what went wrong when every server fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
    await expect(overpass("q", undefined, servers)).rejects.toThrow(/busy/);
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(overpass("q", undefined, servers)).rejects.toThrow(/Couldn't reach/);
  });

  it("stops when the caller gives up", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(overpass("q", ctrl.signal, servers)).rejects.toThrow(/Abort/);
  });
});
