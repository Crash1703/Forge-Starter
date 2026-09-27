import { Capacitor } from "@capacitor/core";

/** True inside the Ride Forge Android app, false on the website. */
export const isApp = Capacitor.isNativePlatform();

/** The public website: links shared from the app must point here, not at the app's internal address. */
const PUBLIC_URL: string = import.meta.env.VITE_PUBLIC_URL || "https://crash1703.github.io/Forge-Starter/";

/** A link to the current plan that opens anywhere. */
export const shareableUrl = () => (isApp ? PUBLIC_URL + location.hash : location.href);

/** Open the system share sheet for a link. Returns false where there is none (desktop browsers). */
export async function shareLink(title: string, url: string): Promise<boolean> {
  if (isApp) {
    const { Share } = await import("@capacitor/share");
    await Share.share({ title, url });
    return true;
  }
  if (!navigator.share) return false;
  await navigator.share({ title, url });
  return true;
}

/**
 * Hand a file to the user: a download on the website; in the app, which
 * can't download, save it and open the share sheet (Save to Files, OsmAnd…).
 */
export async function saveFile(filename: string, content: string, type: string): Promise<void> {
  if (isApp) {
    const { Filesystem, Directory, Encoding } = await import("@capacitor/filesystem");
    const { Share } = await import("@capacitor/share");
    const { uri } = await Filesystem.writeFile({ path: filename, data: content, directory: Directory.Cache, encoding: Encoding.UTF8 });
    await Share.share({ title: filename, files: [uri] });
    return;
  }
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
