// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { ROUTE_SERVER_URL } from "../config";
import { loadSettings, PUBLIC_ONLY, routeServerUrl } from "../settings";

const stored = (routeServer: unknown) => localStorage.setItem("forge.settings", JSON.stringify({ routeServer }));

describe("route server setting", () => {
  afterEach(() => localStorage.clear());

  it("uses Ride Forge's own server by default", () => {
    expect(loadSettings().routeServer).toBe("");
    expect(routeServerUrl(loadSettings())).toBe(ROUTE_SERVER_URL);
  });

  it("swaps a dead quick-tunnel address for Ride Forge's server", () => {
    stored("https://aviation-forbes-harder-wednesday.trycloudflare.com");
    expect(routeServerUrl(loadSettings())).toBe(ROUTE_SERVER_URL);
  });

  it("keeps the rider's own server, or the public one alone", () => {
    stored("routes.example.com/");
    expect(routeServerUrl(loadSettings())).toBe("https://routes.example.com");
    stored(PUBLIC_ONLY);
    expect(routeServerUrl(loadSettings())).toBe("");
  });
});
