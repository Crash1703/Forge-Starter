import type { LatLng } from "./geo";

export interface Suggestion {
  placeId: string;
  main: string;
  secondary: string;
}

let sessionToken = crypto.randomUUID();

/** Places API (New) autocomplete, biased towards `near` when given. */
export async function autocomplete(
  key: string,
  input: string,
  near?: LatLng,
  signal?: AbortSignal,
): Promise<Suggestion[]> {
  const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
    body: JSON.stringify({
      input,
      sessionToken,
      ...(near
        ? { locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 50000 } } }
        : {}),
    }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? "Place search failed");
  const json: { suggestions?: { placePrediction?: Prediction }[] } = await res.json();
  return (json.suggestions ?? []).flatMap(({ placePrediction: p }) =>
    p
      ? [{
          placeId: p.placeId,
          main: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
          secondary: p.structuredFormat?.secondaryText?.text ?? "",
        }]
      : [],
  );
}

interface Prediction {
  placeId: string;
  text?: { text: string };
  structuredFormat?: { mainText?: { text: string }; secondaryText?: { text: string } };
}

export async function placeLocation(key: string, placeId: string): Promise<{ name: string; position: LatLng }> {
  const res = await fetch(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?sessionToken=${sessionToken}`,
    { headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "displayName,location" } },
  );
  // A details call ends the autocomplete billing session.
  sessionToken = crypto.randomUUID();
  if (!res.ok) throw new Error("Could not look up that place");
  const p = await res.json();
  return {
    name: p.displayName?.text ?? "Place",
    position: { lat: p.location.latitude, lng: p.location.longitude },
  };
}

/** Best-effort short name for a clicked point, using the Maps JS geocoder. */
export async function reverseGeocode(p: LatLng): Promise<string> {
  const fallback = `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;
  try {
    // The geocoder can hang (e.g. key rejected), so don't wait on it forever.
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000));
    const { results } = await Promise.race([new google.maps.Geocoder().geocode({ location: p }), timeout]);
    const r = results[0];
    if (!r) return fallback;
    const part = (t: string) => r.address_components.find((c) => c.types.includes(t))?.long_name;
    const road = part("route");
    const town = part("locality") ?? part("postal_town") ?? part("administrative_area_level_2");
    return [road, town].filter(Boolean).join(", ") || r.formatted_address;
  } catch {
    return fallback;
  }
}
