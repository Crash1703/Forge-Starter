import type { RideRecord, TrackPoint } from "./recorder";

/**
 * Recorded rides live in IndexedDB: a long ride is hundreds of KB, more than
 * localStorage should hold. The ride being recorded is saved as a draft
 * every few seconds, so a crash or a killed app doesn't lose it.
 */

const DB = "forge";
const RIDES = "rides";
const DRAFT = "draft";

export interface Draft {
  startedAt: number;
  points: TrackPoint[];
  /** Name to give the ride when saved (the planned route's name, when riding one). */
  name?: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(RIDES, { keyPath: "id" });
      req.result.createObjectStore(DRAFT);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** All rides, newest first. */
export async function listRides(): Promise<RideRecord[]> {
  const all = await run<RideRecord[]>(RIDES, "readonly", (s) => s.getAll());
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export const putRide = (ride: RideRecord) => run(RIDES, "readwrite", (s) => s.put(ride)).then(() => undefined);
export const deleteRide = (id: string) => run(RIDES, "readwrite", (s) => s.delete(id)).then(() => undefined);

export const saveDraft = (draft: Draft) => run(DRAFT, "readwrite", (s) => s.put(draft, "current")).then(() => undefined);
export const loadDraft = () => run<Draft | undefined>(DRAFT, "readonly", (s) => s.get("current"));
export const clearDraft = () => run(DRAFT, "readwrite", (s) => s.delete("current")).then(() => undefined);
