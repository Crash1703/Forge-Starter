import { Capacitor } from "@capacitor/core";
import { APP_VERSION, FEEDBACK_URL } from "./config";

/** What every report says about where it came from: the app's version and the phone, never where the rider is. */
function about() {
  return {
    version: APP_VERSION,
    platform: Capacitor.isNativePlatform() ? Capacitor.getPlatform() : "web",
    device: navigator.userAgent,
    screen: `${window.screen.width}×${window.screen.height}`,
  };
}

const post = (body: object) =>
  fetch(FEEDBACK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, ...about() }), keepalive: true });

/** A rider's message from Settings, to Ride Forge's server. */
export async function sendFeedback(message: string): Promise<void> {
  if (!FEEDBACK_URL) throw new Error("Feedback isn't set up in this version.");
  const res = await post({ kind: "feedback", message }).catch(() => null);
  if (res?.status === 429) throw new Error("That's a lot of feedback at once: try again in an hour.");
  if (!res?.ok) throw new Error("Couldn't send it just now (no signal?). Try again later.");
}

/** Errors that are just the phone being offline or a request being cancelled: not worth reporting. */
const NOISE = /AbortError|aborted|Failed to fetch|Load failed|NetworkError|network error|The Internet connection appears to be offline/i;
const REPORT_MAX = 5;
let reported = 0;
const seen = new Set<string>();

/** Tell Ride Forge's server about an error the app hit (a few per session, each once; not in development). */
export function reportError(message: string, detail?: string) {
  if (!FEEDBACK_URL || import.meta.env.DEV || reported >= REPORT_MAX || seen.has(message) || NOISE.test(message)) return;
  seen.add(message);
  reported++;
  void post({ kind: "error", message: message.slice(0, 500), detail: detail?.slice(0, 4000) }).catch(() => undefined);
}

/** Report errors nothing else caught. */
export function reportErrors() {
  window.addEventListener("error", (e) => reportError(e.message || "Error", (e.error as Error | undefined)?.stack));
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason as { message?: string; stack?: string; name?: string } | undefined;
    if (r?.name === "AbortError") return;
    reportError(r?.message ?? String(r), r?.stack);
  });
}
