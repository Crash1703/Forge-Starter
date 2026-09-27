import type { BackgroundGeolocationPlugin } from "@capacitor-community/background-geolocation";
import { bearing, destination, distance, resample, type LatLng } from "./geo";
import type { Fix } from "./navigation";
import { isApp } from "./native";

export type Stop = () => void;

/**
 * Follow the rider's GPS. In the Android app this runs as a foreground
 * service with a "navigating" notification, so it keeps going with the
 * screen locked; in a browser it only runs while the page is open and awake.
 */
export async function watchPosition(onFix: (f: Fix) => void, onError: (message: string) => void): Promise<Stop> {
  if (isApp) {
    const { registerPlugin } = await import("@capacitor/core");
    const bg = registerPlugin<BackgroundGeolocationPlugin>("BackgroundGeolocation");
    const id = await bg.addWatcher(
      {
        backgroundTitle: "Ride Forge is navigating",
        backgroundMessage: "Guiding you along your route.",
        requestPermissions: true,
        stale: false,
        distanceFilter: 0,
      },
      (loc, err) => {
        if (err) {
          onError(
            err.code === "NOT_AUTHORIZED"
              ? "Ride Forge needs location access to navigate. Allow it in Settings."
              : err.message || "GPS error",
          );
          return;
        }
        if (!loc) return;
        onFix({
          position: { lat: loc.latitude, lng: loc.longitude },
          speed: loc.speed,
          heading: loc.bearing,
          accuracy: loc.accuracy,
          time: loc.time ?? Date.now(),
        });
      },
    );
    return () => void bg.removeWatcher({ id });
  }
  if (!navigator.geolocation) {
    onError("This browser can't share your location.");
    return () => undefined;
  }
  const id = navigator.geolocation.watchPosition(
    (p) =>
      onFix({
        position: { lat: p.coords.latitude, lng: p.coords.longitude },
        speed: p.coords.speed,
        heading: p.coords.heading != null && !Number.isNaN(p.coords.heading) ? p.coords.heading : null,
        accuracy: p.coords.accuracy,
        time: p.timestamp,
      }),
    (e) => onError(e.code === e.PERMISSION_DENIED ? "Allow location access to navigate." : "Waiting for GPS…"),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

/**
 * Ride the route without moving: fixes along the path at `kmh`, `speedUp`
 * times faster than real time. Powers "Preview ride" and the tests.
 */
export function simulateRide(path: LatLng[], onFix: (f: Fix) => void, kmh = 70, speedUp = 4): Stop {
  const ms = kmh / 3.6;
  const pts = resample(path, ms); // one point per simulated second
  let i = 0;
  let t = Date.now();
  const tick = () => {
    if (i >= pts.length) return;
    const here = pts[i];
    const next = pts[Math.min(i + 1, pts.length - 1)];
    const heading = distance(here, next) > 0.5 ? bearing(here, next) : null;
    // A little GPS scatter keeps it honest.
    const jitter = destination(here, Math.random() * 360, Math.random() * 4);
    onFix({ position: jitter, speed: i < pts.length - 1 ? ms : 0, heading, accuracy: 6, time: t });
    t += 1000;
    i++;
  };
  tick();
  const timer = window.setInterval(tick, 1000 / speedUp);
  return () => clearInterval(timer);
}

/** Say something out loud: Android's voice in the app, the browser's voice on the web. */
export async function speak(text: string): Promise<void> {
  const lang = navigator.language || "en-AU";
  if (isApp) {
    const { TextToSpeech } = await import("@capacitor-community/text-to-speech");
    await TextToSpeech.speak({ text, lang, rate: 1.0, category: "playback" });
    return;
  }
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel(); // the newest prompt matters most
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  window.speechSynthesis.speak(u);
}

/** Keep the screen on while riding. Returns a function that lets it sleep again. */
export async function keepScreenOn(): Promise<Stop> {
  if (isApp) {
    const { KeepAwake } = await import("@capacitor-community/keep-awake");
    await KeepAwake.keepAwake();
    return () => void KeepAwake.allowSleep();
  }
  // Browsers drop the lock when the page is hidden, so take it again on return.
  let lock: WakeLockSentinel | null = null;
  const take = async () => {
    try {
      lock = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      /* not allowed here (battery saver, old browser) */
    }
  };
  const onVisible = () => document.visibilityState === "visible" && void take();
  await take();
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    void lock?.release();
  };
}
