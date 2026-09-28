import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { clearDraft, deleteRide, listRides, loadDraft, putRide, saveDraft } from "../rideStore";
import type { RideRecord } from "../recorder";

const ride = (id: string, startedAt: number): RideRecord => ({
  id,
  name: `Ride ${id}`,
  startedAt,
  points: [[-26.7, 152.9, 0, 50]],
  stats: { distance: 1, totalTime: 1, movingTime: 1, avgSpeed: 1, maxSpeed: 1, curviness: 0, bends: 0, twistiest: null, lean: null },
});

describe("rideStore", () => {
  it("saves, lists newest first, and deletes rides", async () => {
    await putRide(ride("a", 1000));
    await putRide(ride("b", 2000));
    expect((await listRides()).map((r) => r.id)).toEqual(["b", "a"]);
    await deleteRide("b");
    expect((await listRides()).map((r) => r.id)).toEqual(["a"]);
  });

  it("keeps a draft of the ride in progress", async () => {
    expect(await loadDraft()).toBeUndefined();
    await saveDraft({ startedAt: 5, points: [[-26.7, 152.9, 0, 40]], name: "Maleny loop" });
    expect(await loadDraft()).toEqual({ startedAt: 5, points: [[-26.7, 152.9, 0, 40]], name: "Maleny loop" });
    await clearDraft();
    expect(await loadDraft()).toBeUndefined();
  });
});
