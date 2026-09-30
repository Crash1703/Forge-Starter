import { Capacitor } from "@capacitor/core";
import { APP_VERSION, RELEASES_API } from "./config";

export interface Update {
  version: string;
  url: string;
}

/** Whether version `a` ("1.123") is newer than `b`. */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

const KEY = "forge.latestRelease";
const DAY = 24 * 3_600_000;

/**
 * A newer Android release than this app, if there is one. Only in the app
 * (the website is always the latest), and GitHub is asked at most once a day.
 */
export async function newerRelease(): Promise<Update | null> {
  if (!Capacitor.isNativePlatform() || APP_VERSION === "dev") return null;
  let latest: (Update & { at: number }) | null = null;
  try {
    latest = JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    /* ask again */
  }
  if (!latest || Date.now() - latest.at > DAY) {
    const res = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return null;
    const json = (await res.json()) as { tag_name?: string; html_url?: string };
    const version = (json.tag_name ?? "").replace(/^android-/, "");
    if (!/^\d+(\.\d+)*$/.test(version) || !json.html_url) return null;
    latest = { version, url: json.html_url, at: Date.now() };
    try {
      localStorage.setItem(KEY, JSON.stringify(latest));
    } catch {
      /* asked again next time */
    }
  }
  return isNewer(latest.version, APP_VERSION) ? { version: latest.version, url: latest.url } : null;
}
