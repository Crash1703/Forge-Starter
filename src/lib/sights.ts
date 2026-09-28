import type { LatLng } from "./geo";
import { WIKIDATA_URL } from "./config";
import { overpass, type OverpassElement } from "./overpass";

export type SightKind = "viewpoint" | "attraction" | "museum" | "zoo" | "park" | "peak" | "waterfall" | "historic";

/** Something worth riding to: a lookout, a waterfall, a famous landmark. */
export interface Sight {
  id: string;
  kind: SightKind;
  name: string;
  position: LatLng;
  /** A small photo (Wikimedia Commons), when there is one. */
  photo?: string;
  /** Its Wikipedia page, if it has one. */
  link?: string;
  wikidata?: string;
}

export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export const SIGHT_ICONS: Record<SightKind, string> = {
  viewpoint: "👁",
  attraction: "★",
  museum: "🏛",
  zoo: "🐾",
  park: "🎢",
  peak: "⛰",
  waterfall: "💧",
  historic: "🏰",
};

export const SIGHT_NAMES: Record<SightKind, string> = {
  viewpoint: "Lookout",
  attraction: "Attraction",
  museum: "Museum",
  zoo: "Zoo or wildlife park",
  park: "Theme park",
  peak: "Mountain",
  waterfall: "Waterfall",
  historic: "Historic site",
};

/** Bigger than this (degrees across) and the query would be huge: ask the rider to zoom in. */
export const MAX_SPAN = 1.2;


export function sightsQuery(b: Bounds): string {
  const box = `(${b.south.toFixed(4)},${b.west.toFixed(4)},${b.north.toFixed(4)},${b.east.toFixed(4)})`;
  return `[out:json][timeout:25];(
nwr["tourism"~"^(viewpoint|attraction|museum|zoo|theme_park)$"]["name"]${box};
nwr["natural"="waterfall"]["name"]${box};
nwr["natural"="peak"]["name"]["wikidata"]${box};
nwr["historic"~"^(castle|monument|ruins|fort)$"]["name"]${box};
);out center tags 300;`;
}

function kindOf(tags: Record<string, string>): SightKind {
  switch (tags.tourism) {
    case "viewpoint":
      return "viewpoint";
    case "museum":
      return "museum";
    case "zoo":
      return "zoo";
    case "theme_park":
      return "park";
  }
  if (tags.natural === "peak") return "peak";
  if (tags.natural === "waterfall") return "waterfall";
  if (tags.historic && tags.tourism !== "attraction") return "historic";
  return "attraction";
}

/** A Commons file ("File:Big Pineapple.jpg" or just the name) as a small thumbnail URL. */
export function commonsThumb(file: string, width = 200): string {
  const name = file.replace(/^File:/i, "").trim();
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=${width}`;
}

/** "en:Big Pineapple" -> its Wikipedia URL. */
export function wikipediaLink(tag: string | undefined): string | undefined {
  const m = tag && /^([a-z-]+):(.+)$/.exec(tag);
  return m ? `https://${m[1]}.wikipedia.org/wiki/${encodeURIComponent(m[2].replace(/ /g, "_"))}` : undefined;
}

export function parseSights(elements: OverpassElement[]): Sight[] {
  const seen = new Set<string>();
  const out: Sight[] = [];
  for (const e of elements) {
    const lat = e.lat ?? e.center?.lat;
    const lng = e.lon ?? e.center?.lon;
    const tags = e.tags ?? {};
    if (lat == null || lng == null || !tags.name) continue;
    const id = `${e.type}/${e.id}`;
    // The same place is often mapped twice (a point and an area) with one name.
    const key = `${tags.name}|${lat.toFixed(2)},${lng.toFixed(2)}`;
    if (seen.has(id) || seen.has(key)) continue;
    seen.add(id);
    seen.add(key);
    const commons = tags.wikimedia_commons?.startsWith("File:") ? tags.wikimedia_commons : undefined;
    out.push({
      id,
      kind: kindOf(tags),
      name: tags.name,
      position: { lat, lng },
      ...(commons ? { photo: commonsThumb(commons) } : {}),
      ...(wikipediaLink(tags.wikipedia) ? { link: wikipediaLink(tags.wikipedia) } : {}),
      ...(tags.wikidata ? { wikidata: tags.wikidata } : {}),
    });
  }
  return out;
}

const KIND_RANK: Record<SightKind, number> = {
  viewpoint: 0,
  waterfall: 1,
  attraction: 2,
  peak: 3,
  historic: 4,
  zoo: 5,
  park: 6,
  museum: 7,
};

/**
 * The best few to show: well-known places (with a Wikipedia entry or photo)
 * first, then lookouts and waterfalls ahead of the rest.
 */
export function rankSights(sights: Sight[], limit = 40): Sight[] {
  const fame = (s: Sight) => (s.photo || s.wikidata ? 0 : 1) + (s.link ? 0 : 0.5);
  return sights
    .slice()
    .sort((a, b) => fame(a) - fame(b) || KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** Fill in photos from Wikidata (its main image) for sights that have an entry but no photo yet. */
export async function addPhotos(sights: Sight[], signal?: AbortSignal): Promise<Sight[]> {
  const ids = [...new Set(sights.filter((s) => !s.photo && s.wikidata).map((s) => s.wikidata!))].slice(0, 50);
  if (!ids.length) return sights;
  const url = `${WIKIDATA_URL}?action=wbgetentities&ids=${ids.join("|")}&props=claims|sitelinks&sitefilter=enwiki&format=json&origin=*`;
  const res = await fetch(url, { signal });
  if (!res.ok) return sights;
  const json: {
    entities?: Record<
      string,
      {
        claims?: { P18?: { mainsnak?: { datavalue?: { value?: string } } }[] };
        sitelinks?: { enwiki?: { title?: string } };
      }
    >;
  } = await res.json();
  return sights.map((s) => {
    const ent = s.wikidata ? json.entities?.[s.wikidata] : undefined;
    const file = ent?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    const title = ent?.sitelinks?.enwiki?.title;
    return {
      ...s,
      ...(!s.photo && file ? { photo: commonsThumb(file) } : {}),
      ...(!s.link && title ? { link: wikipediaLink(`en:${title}`) } : {}),
    };
  });
}

/** Sights within `b`: the best 40, with photos where Wikidata has them. */
export async function sightsIn(b: Bounds, signal?: AbortSignal): Promise<Sight[]> {
  const best = rankSights(parseSights(await overpass(sightsQuery(b), signal)));
  try {
    return await addPhotos(best, signal);
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    return best; // Photos are a nice-to-have.
  }
}
