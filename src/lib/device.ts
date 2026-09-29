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

type GpsListener = { onFix: (f: Fix) => void; onError: (message: string) => void };
const gpsListeners = new Set<GpsListener>();
let gpsStop: Stop | null = null;
let gpsStarting = false;

/**
 * Share one GPS watcher between everything that needs it (Ride mode and ride
 * recording), so the app runs one location service and one notification.
 * Returns an unsubscribe function; the watcher stops when nobody listens.
 */
export function subscribeGps(onFix: (f: Fix) => void, onError: (message: string) => void = () => undefined): Stop {
  const listener = { onFix, onError };
  gpsListeners.add(listener);
  if (!gpsStop && !gpsStarting) {
    gpsStarting = true;
    void watchPosition(
      (f) => gpsListeners.forEach((l) => l.onFix(f)),
      (m) => gpsListeners.forEach((l) => l.onError(m)),
    ).then((stop) => {
      gpsStarting = false;
      if (gpsListeners.size) gpsStop = stop;
      else stop(); // everyone left while it was starting
    });
  }
  return () => {
    gpsListeners.delete(listener);
    if (!gpsListeners.size && gpsStop) {
      gpsStop();
      gpsStop = null;
    }
  };
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

/**
 * In the app, show the ride screen over the lock screen while riding (as
 * Google Maps does): waking the phone shows the ride straight away, no
 * unlocking. Off again when the ride ends. Nothing to do on the website.
 */
export async function showOverLockScreen(on: boolean): Promise<void> {
  if (!isApp) return;
  try {
    const { registerPlugin } = await import("@capacitor/core");
    const lock = registerPlugin<{ set(o: { on: boolean }): Promise<void> }>("LockScreen");
    await lock.set({ on });
  } catch {
    /* an older app build without the plugin: the ride still works */
  }
}

/** The lock-screen "next turn" notification. */
const TURN_ID = 7314;
const TURN_CHANNEL = "ride-next-turn";
let turnChannel: Promise<void> | null = null;
let turnShown = { title: "", body: "", at: 0 };

/**
 * Show the next turn in a silent notification that sits on the lock screen
 * (and in the notification shade) during a ride, updated as it changes: a
 * new instruction straight away, the distance at most every 5 seconds.
 */
export async function showNextTurn(title: string, body: string): Promise<void> {
  if (!isApp) return;
  const now = Date.now();
  if (title === turnShown.title && (body === turnShown.body || now - turnShown.at < 5000)) return;
  turnShown = { title, body, at: now };
  try {
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    // Low importance: no sound or buzz (the voice does the talking); public: readable while locked.
    turnChannel ??= LocalNotifications.createChannel({
      id: TURN_CHANNEL,
      name: "Next turn",
      description: "The next turn while riding, on the lock screen",
      importance: 2,
      visibility: 1,
      vibration: false,
      lights: false,
    }).catch(() => undefined);
    await turnChannel;
    await LocalNotifications.schedule({
      notifications: [{ id: TURN_ID, title, body, channelId: TURN_CHANNEL, ongoing: true, autoCancel: false }],
    });
  } catch {
    /* notifications not allowed: the ride screen still shows it */
  }
}

/** Take the next-turn notification away (ride over). */
export async function clearNextTurn(): Promise<void> {
  turnShown = { title: "", body: "", at: 0 };
  if (!isApp) return;
  try {
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    await LocalNotifications.cancel({ notifications: [{ id: TURN_ID }] });
  } catch {
    /* nothing showing */
  }
}

/**
 * Android 13+ hides the "navigating" notification (the one that keeps GPS
 * running with the screen locked) until the app may post notifications.
 * Ask once, when the first ride starts; riding works either way.
 */
export async function askToShowRideNotification(): Promise<void> {
  if (!isApp) return;
  try {
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    const { display } = await LocalNotifications.checkPermissions();
    if (display === "prompt" || display === "prompt-with-rationale") await LocalNotifications.requestPermissions();
  } catch {
    /* older Android: nothing to ask */
  }
}
