import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// A made-up tile for S27E153 (26°S–27°S, 153°E–154°E): height = 10 × row + column,
// row 0 at the north edge, so heights rise to the south and to the east.
const SIZE = 1200;
let heightAt: (lat: number, lon: number) => number;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "dem-"));
  const t = new Int16Array(SIZE * SIZE);
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) t[r * SIZE + c] = (10 * r + c) % 30000;
  writeFileSync(join(dir, "S27E153.i16"), Buffer.from(t.buffer));
  process.env.DEM_DIR = dir;
  // @ts-expect-error: plain JavaScript on the server, no types
  ({ heightAt } = await import("../../../server/elevation/elevation.mjs"));
});

describe("elevation from the terrain tiles", () => {
  const cell = 1 / SIZE;
  it("reads the tile north row first, west column first", () => {
    // The middle of the grid cell in row 0, column 0: the tile's north-west corner.
    expect(heightAt(-26 - cell / 2, 153 + cell / 2)).toBe(0);
    // Row 3, column 7.
    expect(heightAt(-26 - 3.5 * cell, 153 + 7.5 * cell)).toBe(37);
  });

  it("blends between grid points", () => {
    // Halfway between columns 7 and 8 of row 3: 37.5.
    expect(heightAt(-26 - 3.5 * cell, 153 + 8 * cell)).toBe(37.5);
    // Halfway between rows 3 and 4 of column 7: 42.
    expect(heightAt(-26 - 4 * cell, 153 + 7.5 * cell)).toBe(42);
  });

  it("is 0 where there's no tile (the sea)", () => {
    expect(heightAt(-30.5, 170.5)).toBe(0);
  });
});
