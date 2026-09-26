// PL-058 — source guard: HistoryScreen takes its averages from
// lib/historyAverages.ts and never coalesces an unknown small-four value to
// 0. Kept apart from the logic tests so it runs (and can be seen red)
// even while that module doesn't exist.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

describe("HistoryScreen delegates its averages (PL-058)", () => {
  const code = fs
    .readFileSync(path.resolve(process.cwd(), "src/screens/HistoryScreen.tsx"), "utf8")
    .replace(/\r\n/g, "\n");

  it("uses dailyAverages", () => {
    expect(code).toContain("dailyAverages(");
  });

  it("never coalesces an unknown small-four value to 0", () => {
    // The fabrication itself: `eaten.fibre ?? 0` and friends.
    expect(code).not.toMatch(/\.(satFat|salt|fibre|sugar)\s*\?\?\s*0\b/);
  });

  it("does no averaging arithmetic of its own", () => {
    // A second, local average is how the two surfaces diverged.
    expect(code).not.toMatch(/reduce\(\s*\(s,\s*d\)\s*=>\s*s\s*\+\s*d\./);
  });
});
