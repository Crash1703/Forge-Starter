// Loops with a style for each leg, planned leg by leg and joined.
import { test } from "vitest";
import { check, run } from "./harness";

test("legs", async () => {
  check("legs", await run("legs", ["legs fastest", "legs scenic", "legs twisty", "legs mixed", "add stop", "legs fastest"]));
});
