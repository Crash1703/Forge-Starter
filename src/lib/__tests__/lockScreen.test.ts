import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// As in the Android app: native plugins present.
vi.mock("../native", () => ({ isApp: true }));
const schedule = vi.fn(async () => ({ notifications: [] }));
const cancel = vi.fn(async () => undefined);
const createChannel = vi.fn(async () => undefined);
vi.mock("@capacitor/local-notifications", () => ({ LocalNotifications: { schedule, cancel, createChannel } }));
const setLock = vi.fn(async () => undefined);
vi.mock("@capacitor/core", () => ({ registerPlugin: () => ({ set: setLock }) }));

const { clearNextTurn, showNextTurn, showOverLockScreen } = await import("../device");

describe("navigation on the lock screen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T08:00:00Z"));
  });
  afterEach(async () => {
    await clearNextTurn();
    vi.useRealTimers();
    schedule.mockClear();
    cancel.mockClear();
  });

  it("shows the ride over the lock screen while riding, and stops after", async () => {
    await showOverLockScreen(true);
    await showOverLockScreen(false);
    expect(setLock.mock.calls).toEqual([[{ on: true }], [{ on: false }]]);
  });

  it("posts the next turn as a silent notification anyone can read on the lock screen", async () => {
    await showNextTurn("300 m · Maleny Stanley River Road", "42 km to go · arrive 10:15");
    expect(createChannel).toHaveBeenCalledWith(expect.objectContaining({ importance: 2, visibility: 1, vibration: false }));
    const [{ notifications }] = schedule.mock.calls[0] as unknown as [{ notifications: Record<string, unknown>[] }];
    expect(notifications[0]).toMatchObject({ title: "300 m · Maleny Stanley River Road", ongoing: true, autoCancel: false });
  });

  it("updates a new turn at once, but the distance at most every 5 seconds", async () => {
    await showNextTurn("300 m · Maleny Stanley River Road", "42 km to go");
    await showNextTurn("300 m · Maleny Stanley River Road", "41.9 km to go"); // same turn, 0 s later: skipped
    expect(schedule).toHaveBeenCalledTimes(1);
    await showNextTurn("250 m · Maleny Stanley River Road", "41.9 km to go"); // closer: the title changed
    expect(schedule).toHaveBeenCalledTimes(2);
    await showNextTurn("250 m · Maleny Stanley River Road", "41.8 km to go");
    expect(schedule).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(6000);
    await showNextTurn("250 m · Maleny Stanley River Road", "41.7 km to go");
    expect(schedule).toHaveBeenCalledTimes(3);
  });

  it("takes the notification away when the ride ends", async () => {
    await showNextTurn("Arrived", "Ride Forge");
    await clearNextTurn();
    expect(cancel).toHaveBeenCalledWith({ notifications: [{ id: expect.any(Number) }] });
  });
});
