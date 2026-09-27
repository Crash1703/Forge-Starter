const STORAGE_KEY = "forge.apiKey";

/** Build-time key from .env wins; otherwise a key the user pasted into the app. */
export function getApiKey(): string {
  const envKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;
  if (envKey && envKey !== "your-key-here") return envKey;
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setStoredApiKey(key: string) {
  try {
    if (key) localStorage.setItem(STORAGE_KEY, key);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable: key lasts for this page load only */
  }
}

/** Advanced markers need a map ID; Google's demo ID works for development. */
export function getMapId(): string {
  return (import.meta.env.VITE_GOOGLE_MAPS_MAP_ID as string | undefined) || "DEMO_MAP_ID";
}
