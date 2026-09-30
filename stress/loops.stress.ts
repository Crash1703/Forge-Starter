// Loops styled as a whole: add stops, reverse, drag pins, change the style.
import { test } from "vitest";
import { check, run } from "./harness";

test("loops", async () => {
  check("loops", await run("loops", ["add stop", "reverse", "drag pin", "scenic", "add stop", "fastest", "reverse", "twisty"]));
});
