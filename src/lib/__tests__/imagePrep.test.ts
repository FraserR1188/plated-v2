// ============================================================
// fitToVisionBudget and the "receipt" PrepareKind (receipt scanner
// commits 2 and 4a; findings §3, §4).
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
// load under Node and isn't mocked in vitest.setup.ts; it's stubbed here,
// with a fake rendered image whose saveAsync each test scripts.
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const manip = vi.hoisted(() => {
  const resize = vi.fn();
  const saveAsync = vi.fn();
  const renderAsync = vi.fn(async () => ({ saveAsync }));
  const manipulate = vi.fn(() => ({ resize, renderAsync }));
  return { resize, saveAsync, renderAsync, manipulate };
});

vi.mock("expo-image-manipulator", () => ({
  ImageManipulator: { manipulate: manip.manipulate },
  SaveFormat: { JPEG: "jpeg" },
}));

import { fitToVisionBudget, prepareImage, MAX_PART_BASE64_CHARS } from "../imagePrep";

type Tier = "standard" | "high";

const LIMITS: Record<Tier, { edge: number; tokens: number }> = {
  standard: { edge: 1568, tokens: 1568 },
  high: { edge: 2576, tokens: 4784 },
};
const tokens = (w: number, h: number) => Math.ceil(w / 28) * Math.ceil(h / 28);

describe("fitToVisionBudget — the sizes the bake-off measured", () => {
  it("a 12.5 MP 3:4 photo (3072×4096) → 1659×2212 on the high-res tier", () => {
    expect(fitToVisionBudget(3072, 4096, "high")).toEqual({ width: 1659, height: 2212 });
  });

  it("the same photo → 952×1270 on the standard tier (not 945×1260)", () => {
    expect(fitToVisionBudget(3072, 4096, "standard")).toEqual({ width: 952, height: 1270 });
  });

  it("landscape is the transpose", () => {
    expect(fitToVisionBudget(4096, 3072, "high")).toEqual({ width: 2212, height: 1659 });
  });

  it("a 1080×2400 screenshot is within both high-res limits, so it's unchanged", () => {
    expect(fitToVisionBudget(1080, 2400, "high")).toEqual({ width: 1080, height: 2400 });
  });

  it("a larger tall screenshot (1440×3200) is held by the long edge, at 2576", () => {
    expect(fitToVisionBudget(1440, 3200, "high")).toEqual({ width: 1159, height: 2576 });
  });

  it("a small image (800×600) is never upscaled", () => {
    expect(fitToVisionBudget(800, 600, "standard")).toEqual({ width: 800, height: 600 });
    expect(fitToVisionBudget(800, 600, "high")).toEqual({ width: 800, height: 600 });
  });
});

describe("fitToVisionBudget — properties over a grid of sizes", () => {
  const sizes: [number, number][] = [];
  for (let w = 200; w <= 6000; w += 347) {
    for (let h = 200; h <= 8000; h += 413) sizes.push([w, h]);
  }

  it.each<Tier>(["standard", "high"])(
    "%s: never exceeds the long-edge or token limit, and never upscales",
    (tier) => {
      const bad: string[] = [];
      for (const [w, h] of sizes) {
        const out = fitToVisionBudget(w, h, tier);
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
    (tier) => {
      for (const [w, h] of sizes) {
        if (Math.max(w, h) <= LIMITS[tier].edge && tokens(w, h) <= LIMITS[tier].tokens) {
          expect(fitToVisionBudget(w, h, tier)).toEqual({ width: w, height: h });
        }
      }
    },
  );
});

// ─── prepareImage("receipt") — commit 4a ────────────────────────────────────

const src = (width: number, height: number) => ({ uri: "file:///in.jpg", width, height });
const b64 = (n: number) => "A".repeat(n);

describe('prepareImage("receipt")', () => {
  beforeEach(() => {
    manip.resize.mockClear();
    manip.saveAsync.mockReset();
  });

  it("resizes a 3:4 photo to the high-res vision budget, 1659×2212, at quality 0.85", async () => {
    manip.saveAsync.mockResolvedValueOnce({ uri: "file:///out.jpg", base64: b64(900_000) });
    const out = await prepareImage(src(3072, 4096), "receipt");
    expect(manip.resize).toHaveBeenCalledWith({ width: 1659, height: 2212 });
    expect(manip.saveAsync).toHaveBeenCalledTimes(1);
    expect(manip.saveAsync).toHaveBeenCalledWith(expect.objectContaining({ compress: 0.85 }));
    expect(out).toEqual({ uri: "file:///out.jpg", base64: b64(900_000) });
  });

  it("doesn't resize an image already within the budget", async () => {
    manip.saveAsync.mockResolvedValueOnce({ uri: "file:///out.jpg", base64: b64(500_000) });
    await prepareImage(src(1080, 2400), "receipt");
    expect(manip.resize).not.toHaveBeenCalled();
  });

  it("over MAX_PART_BASE64_CHARS, re-encodes once at quality 0.7", async () => {
    manip.saveAsync
      .mockResolvedValueOnce({ uri: "file:///big.jpg", base64: b64(MAX_PART_BASE64_CHARS + 1) })
      .mockResolvedValueOnce({ uri: "file:///small.jpg", base64: b64(2_000_000) });
    const out = await prepareImage(src(3072, 4096), "receipt");
    expect(manip.saveAsync).toHaveBeenCalledTimes(2);
    expect(manip.saveAsync).toHaveBeenLastCalledWith(expect.objectContaining({ compress: 0.7 }));
    expect(out).toEqual({ uri: "file:///small.jpg", base64: b64(2_000_000) });
  });

  it("still over after the re-encode → null (prep_failed), with no third attempt", async () => {
    manip.saveAsync
      .mockResolvedValueOnce({ uri: "file:///big.jpg", base64: b64(MAX_PART_BASE64_CHARS + 1) })
      .mockResolvedValueOnce({ uri: "file:///big2.jpg", base64: b64(MAX_PART_BASE64_CHARS + 1) });
    expect(await prepareImage(src(3072, 4096), "receipt")).toBeNull();
    expect(manip.saveAsync).toHaveBeenCalledTimes(2);
  });

  it("the cap is the provisional 3.5M chars, confirmed on real photos (bake-off)", () => {
    expect(MAX_PART_BASE64_CHARS).toBe(3_500_000);
  });
});

describe("prepareImage — every other kind is unchanged", () => {
  beforeEach(() => {
    manip.resize.mockClear();
    manip.saveAsync.mockReset();
  });

  it.each([
    ["meal", 0.8],
    ["recipe", 0.85],
    ["label", 0.85],
    ["front", 0.7],
  ] as const)("%s: long edge to 1568 at quality %d, one save", async (kind, quality) => {
    manip.saveAsync.mockResolvedValueOnce({ uri: "file:///out.jpg", base64: b64(400_000) });
    await prepareImage(src(3072, 4096), kind);
    expect(manip.resize).toHaveBeenCalledWith({ height: 1568 });
    expect(manip.saveAsync).toHaveBeenCalledTimes(1);
    expect(manip.saveAsync).toHaveBeenCalledWith(expect.objectContaining({ compress: quality }));
  });

  it("a landscape meal photo resizes by width", async () => {
    manip.saveAsync.mockResolvedValueOnce({ uri: "file:///out.jpg", base64: b64(400_000) });
    await prepareImage(src(4096, 3072), "meal");
    expect(manip.resize).toHaveBeenCalledWith({ width: 1568 });
  });

  it("a meal photo over 3.5M but under the old 6.8M guard is still accepted, not re-encoded", async () => {
    manip.saveAsync.mockResolvedValueOnce({ uri: "file:///out.jpg", base64: b64(4_000_000) });
    expect(await prepareImage(src(3072, 4096), "meal")).not.toBeNull();
    expect(manip.saveAsync).toHaveBeenCalledTimes(1);
  });
});
