import { describe, expect, it } from "vitest";
import { toSuggestion } from "../places";

describe("toSuggestion", () => {
  it("uses the place name with its town and country", () => {
    const s = toSuggestion({
      geometry: { coordinates: [10.4529, 46.5285] },
      properties: { osm_type: "N", osm_id: 1, name: "Stilfser Joch", state: "Trentino-Alto Adige", country: "Italy" },
    });
    expect(s).toMatchObject({ main: "Stilfser Joch", secondary: "Trentino-Alto Adige, Italy", position: { lat: 46.5285, lng: 10.4529 } });
  });

  it("falls back to the street address for unnamed places", () => {
    const s = toSuggestion({
      geometry: { coordinates: [11.4, 47.26] },
      properties: { street: "Maria-Theresien-Straße", housenumber: "18", city: "Innsbruck", country: "Austria" },
    });
    expect(s.main).toBe("Maria-Theresien-Straße 18");
    expect(s.secondary).toBe("Innsbruck, Austria");
  });
});
