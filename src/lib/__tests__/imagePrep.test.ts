// ============================================================
// Receipt scanner, commit 2 — RED. fitToVisionBudget doesn't exist in
// src/lib/imagePrep.ts yet (findings §3, §4). Every test here must fail
// with "export not found: imagePrep → fitToVisionBudget" until commit 4a;
// see helpers/redImports.ts.
//
// The rule (Anthropic vision docs, fetched 2026-09-26): an image costs
// ⌈w/28⌉ × ⌈h/28⌉ visual tokens and is downscaled server-side past EITHER
// limit —
//   standard tier (Haiku 4.5):            1568 px long edge, 1568 tokens
//   high-res tier (Sonnet 5 and later):   2576 px long edge, 4784 tokens
// On a 3:4 photo the token cap binds first, which is why a single MAX_EDGE
// is wrong for receipts. The bake-off (commit 0) measured the sizes below
// with an exact search over rounded dimensions.
//
// imagePrep.ts imports expo-image-manipulator, a native module that can't
// load under Node and isn't mocked in vitest.setup.ts; it's stubbed here so
// the module loads and the only failure is the missing export.
// ============================================================

import { describe, it, expect, vi } from "vitest";
import { requireExports } from "./helpers/redImports";

vi.mock("expo-image-manipulator", () => ({
  ImageManipulator: { manipulate: vi.fn() },
  SaveFormat: { JPEG: "jpeg" },
}));

type Tier = "standard" | "high";
type Fit = (w: number, h: number, tier: Tier) => { width: number; height: number };

const IMAGE_PREP = "../imagePrep";
const fit = async () =>
  (
    await requireExports<{ fitToVisionBudget: Fit }>(
      () => import(/* @vite-ignore */ IMAGE_PREP),
      "imagePrep",
      ["fitToVisionBudget"],
    )
  ).fitToVisionBudget;

const LIMITS: Record<Tier, { edge: number; tokens: number }> = {
  standard: { edge: 1568, tokens: 1568 },
  high: { edge: 2576, tokens: 4784 },
};
const tokens = (w: number, h: number) => Math.ceil(w / 28) * Math.ceil(h / 28);

describe("fitToVisionBudget — the sizes the bake-off measured", () => {
  it("a 12.5 MP 3:4 photo (3072×4096) → 1659×2212 on the high-res tier", async () => {
    expect((await fit())(3072, 4096, "high")).toEqual({ width: 1659, height: 2212 });
  });

  it("the same photo → 952×1270 on the standard tier (not 945×1260)", async () => {
    expect((await fit())(3072, 4096, "standard")).toEqual({ width: 952, height: 1270 });
  });

  it("landscape is the transpose", async () => {
    expect((await fit())(4096, 3072, "high")).toEqual({ width: 2212, height: 1659 });
  });

  it("a 1080×2400 screenshot is within both high-res limits, so it's unchanged", async () => {
    expect((await fit())(1080, 2400, "high")).toEqual({ width: 1080, height: 2400 });
  });

  it("a larger tall screenshot (1440×3200) is held by the long edge, at 2576", async () => {
    expect((await fit())(1440, 3200, "high")).toEqual({ width: 1159, height: 2576 });
  });

  it("a small image (800×600) is never upscaled", async () => {
    expect((await fit())(800, 600, "standard")).toEqual({ width: 800, height: 600 });
    expect((await fit())(800, 600, "high")).toEqual({ width: 800, height: 600 });
  });
});

describe("fitToVisionBudget — properties over a grid of sizes", () => {
  const sizes: [number, number][] = [];
  for (let w = 200; w <= 6000; w += 347) {
    for (let h = 200; h <= 8000; h += 413) sizes.push([w, h]);
  }

  it.each<Tier>(["standard", "high"])(
    "%s: never exceeds the long-edge or token limit, and never upscales",
    async (tier) => {
      const f = await fit();
      const bad: string[] = [];
      for (const [w, h] of sizes) {
        const out = f(w, h, tier);
        if (Math.max(out.width, out.height) > LIMITS[tier].edge) bad.push(`${w}x${h}: edge`);
        if (tokens(out.width, out.height) > LIMITS[tier].tokens) bad.push(`${w}x${h}: tokens`);
        if (out.width > w || out.height > h) bad.push(`${w}x${h}: upscaled`);
        if (!Number.isInteger(out.width) || !Number.isInteger(out.height)) bad.push(`${w}x${h}: fractional`);
      }
      expect(bad).toEqual([]);
    },
  );

  it.each<Tier>(["standard", "high"])(
    "%s: an image already within both limits comes back exactly as it was",
    async (tier) => {
      const f = await fit();
      for (const [w, h] of sizes) {
        if (Math.max(w, h) <= LIMITS[tier].edge && tokens(w, h) <= LIMITS[tier].tokens) {
          expect(f(w, h, tier)).toEqual({ width: w, height: h });
        }
      }
    },
  );
});
