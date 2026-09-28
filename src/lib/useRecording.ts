import { useCallback, useEffect, useRef, useState } from "react";
import { countBends } from "./geo";
import { Recorder, rideName, rideStats, trackPath, type RideRecord, type TrackPoint } from "./recorder";
import { clearDraft, loadDraft, putRide, saveDraft, type Draft } from "./rideStore";
import { subscribeGps, type Stop } from "./device";
import { newId } from "./storage";

export interface RecordingState {
  startedAt: number;
  distance: number; // m
  elapsed: number; // s, wall clock, not counting pauses
  name?: string;
  /** Paused: positions aren't recorded until resumed. */
  paused?: boolean;
}

/** Rides shorter than this aren't worth keeping (a test tap, a trip to the letterbox). */
const MIN_METRES = 200;

export function buildRide(startedAt: number, points: TrackPoint[], name?: string): RideRecord {
  const stats = rideStats(points);
  stats.bends = countBends(trackPath(points));
  return { id: newId(), name: name || rideName(startedAt), startedAt, points, stats };
}

/**
 * Ride recording: start, stop and save, with a draft saved every 15 s so a
 * crash or a killed app keeps the ride. On start-up, any unfinished draft is
 * offered back.
 */
export function useRecording(onSaved: (ride: RideRecord) => void) {
  const [state, setState] = useState<RecordingState | null>(null);
  const [unfinished, setUnfinished] = useState<Draft | null>(null);
  const rec = useRef<Recorder | null>(null);
  const name = useRef<string | undefined>(undefined);
  const stopGps = useRef<Stop | null>(null);
  const timers = useRef<number[]>([]);
  const paused = useRef<number | null>(null); // when the current pause began
  const pausedFor = useRef(0); // ms of earlier pauses
  const savedCb = useRef(onSaved);
  savedCb.current = onSaved;

  useEffect(() => {
    loadDraft()
      .then((d) => d && d.points.length > 1 && setUnfinished(d))
      .catch(() => undefined);
  }, []);

  const writeDraft = () => {
    const r = rec.current;
    if (r) void saveDraft({ startedAt: r.startedAt, points: r.points, name: name.current }).catch(() => undefined);
  };

  const start = useCallback((rideName?: string) => {
    if (rec.current) return;
    const r = new Recorder(Date.now());
    rec.current = r;
    name.current = rideName;
    paused.current = null;
    pausedFor.current = 0;
    const update = () => {
      const now = paused.current ?? Date.now();
      setState({
        startedAt: r.startedAt,
        distance: r.distance,
        elapsed: (now - r.startedAt - pausedFor.current) / 1000,
        name: rideName,
        paused: paused.current != null,
      });
    };
    update();
    stopGps.current = subscribeGps((f) => {
      if (paused.current == null && r.add(f)) update();
    });
    timers.current = [window.setInterval(update, 1000), window.setInterval(writeDraft, 15_000)];
  }, []);

  /** Hold recording (a café stop), or carry on. */
  const pause = useCallback((on: boolean) => {
    if (!rec.current) return;
    if (on && paused.current == null) paused.current = Date.now();
    if (!on && paused.current != null) {
      pausedFor.current += Date.now() - paused.current;
      paused.current = null;
    }
    setState((s) => (s ? { ...s, paused: on } : s));
    writeDraft();
  }, []);

  const stop = useCallback(async (save: boolean): Promise<RideRecord | null> => {
    const r = rec.current;
    rec.current = null;
    stopGps.current?.();
    stopGps.current = null;
    timers.current.forEach(clearInterval);
    timers.current = [];
    setState(null);
    await clearDraft().catch(() => undefined);
    if (!save || !r || r.points.length < 2 || r.distance < MIN_METRES) return null;
    const ride = buildRide(r.startedAt, r.points, name.current);
    await putRide(ride);
    savedCb.current(ride);
    return ride;
  }, []);

  const keepUnfinished = useCallback(async () => {
    const d = unfinished;
    setUnfinished(null);
    await clearDraft().catch(() => undefined);
    if (!d) return;
    const ride = buildRide(d.startedAt, d.points, d.name);
    await putRide(ride);
    savedCb.current(ride);
  }, [unfinished]);

  const discardUnfinished = useCallback(async () => {
    setUnfinished(null);
    await clearDraft().catch(() => undefined);
  }, []);

  // Keep the draft current if the page is being hidden or closed.
  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && writeDraft();
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);

  return { state, start, stop, pause, unfinished, keepUnfinished, discardUnfinished, minMetres: MIN_METRES };
}
