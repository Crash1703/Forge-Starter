import { afterEach, describe, expect, it, vi } from "vitest";
import { VALHALLA_URL } from "../config";
import { checkRouteServer, normaliseServer, requestsAtOnce, routerFetch, setRouteServer } from "../routeServer";

const HOME = "https://routes.example.com";

describe("the rider's own route server", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setRouteServer("");
  });

  it("tidies typed addresses", () => {
    expect(normaliseServer(" routes.example.com/ ")).toBe(HOME);
    expect(normaliseServer("")).toBe("");
    expect(normaliseServer("http://192.168.1.5:8002")).toBe("http://192.168.1.5:8002");
  });

  it("uses the public server when none is set", async () => {
    const f = vi.fn(async (_url: string) => new Response("{}"));
    vi.stubGlobal("fetch", f);
    await routerFetch("/route", {});
    expect(f.mock.calls.map((c) => String(c[0]))).toEqual([`${VALHALLA_URL}/route`]);
    expect(requestsAtOnce()).toBe(2);
  });

  it("asks the rider's server first, and takes its answers (even 'no route')", async () => {
    setRouteServer("routes.example.com");
    const f = vi.fn(async (_url: string) => new Response(JSON.stringify({ error: "No path" }), { status: 400 }));
    vi.stubGlobal("fetch", f);
    const res = await routerFetch("/route", {});
    expect(res.status).toBe(400);
    // First it finds out what kind of server it is (no /info: Valhalla).
    expect(f.mock.calls.map((c) => String(c[0]))).toEqual([`${HOME}/info`, `${HOME}/route`]);
    expect(requestsAtOnce()).toBe(4);
  });

  it("falls back to the public server when the rider's is off", async () => {
    setRouteServer(HOME);
    const f = vi.fn(async (url: string) => {
      if (url.startsWith(HOME)) throw new TypeError("Failed to fetch");
      return new Response("{}");
    });
    vi.stubGlobal("fetch", f);
    const res = await routerFetch("/route", {});
    expect(res.ok).toBe(true);
    expect(f.mock.calls.map((c) => String(c[0]))).toEqual([`${HOME}/info`, `${VALHALLA_URL}/route`]);
  });

  it("falls back when the tunnel answers but the computer behind it doesn't", async () => {
    setRouteServer(HOME);
    const f = vi.fn(async (url: string) => new Response("{}", { status: url.startsWith(HOME) ? 502 : 200 }));
    vi.stubGlobal("fetch", f);
    expect((await routerFetch("/route", {})).status).toBe(200);
  });

  it("doesn't fall back when the rider cancels", async () => {
    setRouteServer(HOME);
    const ctrl = new AbortController();
    const f = vi.fn(async () => {
      ctrl.abort();
      throw new DOMException("aborted", "AbortError");
    });
    vi.stubGlobal("fetch", f);
    await expect(routerFetch("/route", {}, ctrl.signal)).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("checks a server before using it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ version: "3.5.1" }))));
    await expect(checkRouteServer("routes.example.com")).resolves.toBe("Valhalla 3.5.1");
    await expect(checkRouteServer("http://192.168.1.5:8002")).rejects.toThrow(/https/);
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(checkRouteServer(HOME)).rejects.toThrow(/No answer/);
  });
});
