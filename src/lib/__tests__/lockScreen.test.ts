import { describe, expect, it, vi } from "vitest";

// As in the Android app: native plugins present.
vi.mock("../native", () => ({ isApp: true }));
const schedule = vi.fn(async () => ({ notifications: [] }));
const cancel = vi.fn(async () => undefined);
const deleteChannel = vi.fn(async () => undefined);
vi.mock("@capacitor/local-notifications", () => ({ LocalNotifications: { schedule, cancel, deleteChannel } }));
const setLock = vi.fn(async () => undefined);
vi.mock("@capacitor/core", () => ({ registerPlugin: () => ({ set: setLock }) }));

const { clearOldTurnNotification, showOverLockScreen } = await import("../device");

describe("navigation on the lock screen", () => {
  it("shows the ride over the lock screen while riding, and stops after", async () => {
    await showOverLockScreen(true);
    await showOverLockScreen(false);
    expect(setLock.mock.calls).toEqual([[{ on: true }], [{ on: false }]]);
  });

  it("removes 1.52's next-turn notification and its channel, and posts nothing new", async () => {
    await clearOldTurnNotification();
    expect(cancel).toHaveBeenCalledWith({ notifications: [{ id: 7314 }] });
    expect(deleteChannel).toHaveBeenCalledWith({ id: "ride-next-turn" });
    expect(schedule).not.toHaveBeenCalled();
  });
});
