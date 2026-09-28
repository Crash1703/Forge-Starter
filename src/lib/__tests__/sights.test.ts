import { afterEach, describe, expect, it, vi } from "vitest";
import { addPhotos, commonsThumb, parseSights, rankSights, sightsQuery, wikipediaLink } from "../sights";

const el = (id: number, tags: Record<string, string>, lat = -26.6, lon = 152.9) => ({ type: "node", id, lat, lon, tags });

describe("sights", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks Overpass for lookouts, waterfalls, attractions and landmarks in the box", () => {
    const q = sightsQuery({ south: -27, west: 152.5, north: -26.5, east: 153 });
    expect(q).toContain('"tourism"~"^(viewpoint|attraction|museum|zoo|theme_park)$"');
    expect(q).toContain("(-27.0000,152.5000,-26.5000,153.0000)");
    expect(q).toContain('"natural"="waterfall"');
  });

  it("reads kinds, photos and links, skipping unnamed and duplicate places", () => {
    const sights = parseSights([
      el(1, { tourism: "viewpoint", name: "Mary Cairncross lookout" }),
      el(2, { tourism: "attraction", name: "Big Pineapple", wikipedia: "en:Big Pineapple", wikimedia_commons: "File:Big Pineapple.jpg" }),
      el(3, { tourism: "viewpoint" }),
      // The same attraction mapped again as an area.
      { type: "way", id: 9, center: { lat: -26.6001, lon: 152.9001 }, tags: { tourism: "attraction", name: "Big Pineapple" } },
      el(4, { natural: "waterfall", name: "Kondalilla Falls" }, -26.63, 152.87),
      el(5, { historic: "castle", name: "Castle" }, -26.7, 152.8),
    ]);
    expect(sights.map((s) => [s.name, s.kind])).toEqual([
      ["Mary Cairncross lookout", "viewpoint"],
      ["Big Pineapple", "attraction"],
      ["Kondalilla Falls", "waterfall"],
      ["Castle", "historic"],
    ]);
    expect(sights[1].photo).toBe(commonsThumb("File:Big Pineapple.jpg"));
    expect(sights[1].link).toBe("https://en.wikipedia.org/wiki/Big_Pineapple");
  });

  it("builds Commons thumbnails and Wikipedia links", () => {
    expect(commonsThumb("File:A b.jpg", 120)).toBe("https://commons.wikimedia.org/wiki/Special:FilePath/A%20b.jpg?width=120");
    expect(wikipediaLink("de:Schloss Neuschwanstein")).toBe("https://de.wikipedia.org/wiki/Schloss_Neuschwanstein");
    expect(wikipediaLink(undefined)).toBeUndefined();
  });

  it("puts well-known places first, then lookouts and waterfalls", () => {
    const s = (name: string, kind: "viewpoint" | "museum" | "waterfall", extra = {}) => ({ id: name, name, kind, position: { lat: 0, lng: 0 }, ...extra });
    const ranked = rankSights([s("Museum", "museum"), s("Falls", "waterfall"), s("Famous museum", "museum", { wikidata: "Q1" }), s("Lookout", "viewpoint")], 3);
    expect(ranked.map((x) => x.name)).toEqual(["Famous museum", "Lookout", "Falls"]);
  });

  it("adds photos and Wikipedia links from Wikidata", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          entities: {
            Q42: {
              claims: { P18: [{ mainsnak: { datavalue: { value: "Australia Zoo.jpg" } } }] },
              sitelinks: { enwiki: { title: "Australia Zoo" } },
            },
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const [zoo, other] = await addPhotos([
      { id: "a", name: "Australia Zoo", kind: "zoo", position: { lat: 0, lng: 0 }, wikidata: "Q42" },
      { id: "b", name: "Lookout", kind: "viewpoint", position: { lat: 0, lng: 0 } },
    ]);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("ids=Q42");
    expect(zoo.photo).toBe(commonsThumb("Australia Zoo.jpg"));
    expect(zoo.link).toBe("https://en.wikipedia.org/wiki/Australia_Zoo");
    expect(other.photo).toBeUndefined();
  });
});
