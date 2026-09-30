// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { FEEDBACK_URL } from "../config";
import { sendFeedback } from "../feedback";
import { isNewer } from "../updates";

describe("feedback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the rider's message with the app's version and phone, not where they are", async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", f);
    await sendFeedback("The arrows point the wrong way on my loop");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(FEEDBACK_URL);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ kind: "feedback", message: "The arrows point the wrong way on my loop", version: "dev" });
    expect(Object.keys(body).sort()).toEqual(["device", "kind", "message", "platform", "screen", "version"]);
  });

  it("says when there's been too much at once, or it couldn't be sent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 429 })));
    await expect(sendFeedback("hi")).rejects.toThrow(/try again in an hour/);
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(sendFeedback("hi")).rejects.toThrow(/Couldn't send/);
  });
});

describe("app updates", () => {
  it("compares release numbers as numbers", () => {
    expect(isNewer("1.125", "1.119")).toBe(true);
    expect(isNewer("1.119", "1.119")).toBe(false);
    expect(isNewer("1.99", "1.119")).toBe(false);
    expect(isNewer("2.1", "1.200")).toBe(true);
  });
});
