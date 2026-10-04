// ============================================================
// src/lib/imagePrep.ts — normalise every captured photo before use
//
// WHY THIS EXISTS (three problems, one fix):
//
// 1. FORMAT HONESTY. customFoodImages.ts uploads with a hardcoded
//    contentType of "image/jpeg" and a ".jpg" path. The picker returns
//    whatever the user gave it — a library PNG, or HEIC on iOS. Today
//    that mislabelling is harmless (Storage doesn't sniff, <Image> does).
//    The moment we send those bytes to Anthropic it is a hard 400:
//    media_type must be accurate, and HEIC is not supported at all.
//    Re-encoding as JPEG makes the claim true by construction.
//
// 2. SIZE. Anthropic rejects images over 5MB. An uncropped, full-res
//    Pixel 9 label photo can approach that — and the *better* the photo,
//    the bigger it is, so failures would correlate with exactly the
//    labels most likely to extract cleanly.
//
// 3. COST AND SPEED. Anthropic downscales an image server-side past
//    EITHER of two limits: a long edge (1568px on the standard tier) or a
//    visual-token budget, where an image costs ceil(w/28) * ceil(h/28)
//    tokens (1568 on the standard tier). On a 3:4 photo the token budget
//    binds first: 1176x1568 is 2,352 tokens, so it's shrunk again to about
//    952x1270. Pixels past either limit cost upload time and buy nothing.
//    The meal/label/recipe/front kinds still resize by MAX_EDGE alone —
//    harmless, the model just sees a slightly smaller image than we sent —
//    while "receipt", where legibility is the whole point, is sized to fit
//    both limits exactly with fitToVisionBudget (receipt-scanner findings
//    §3, candidate H).
//
// Requires: npx expo install expo-image-manipulator
// Native module -> needs `eas build -p android --profile development`.
// ============================================================

import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import type { PhotoKind } from "./customFoodImages";

// The standard tier's long-edge limit. Used alone for every kind except
// "receipt" (see the header, point 3).
const MAX_EDGE = 1568;

// ─── Vision budget ──────────────────────────────────────────────────────────
//
// Anthropic vision docs (fetched 2026-09-26): an image costs ceil(w/28) *
// ceil(h/28) visual tokens and is downscaled server-side past either limit.
//   standard  (Haiku 4.5):             1568px long edge, 1568 tokens
//   high      (Claude 4.7 and later,   2576px long edge, 4784 tokens
//              including Sonnet 5)
export type VisionTier = "standard" | "high";

const VISION_LIMITS: Record<VisionTier, { edge: number; tokens: number }> = {
  standard: { edge: 1568, tokens: 1568 },
  high: { edge: 2576, tokens: 4784 },
};

// Receipts are read by RECEIPT_MODEL, claude-sonnet-5 (bake-off, findings
// commit 0), which is on the high-res tier.
const RECEIPT_TIER: VisionTier = "high";

const visionTokens = (w: number, h: number) => Math.ceil(w / 28) * Math.ceil(h / 28);

/**
 * The largest size, at the source's aspect ratio, that the model will NOT
 * downscale again: long edge and visual tokens both within the tier's limits.
 *
 * Never upscales — an image already within both limits comes back as it
 * was. The short edge is rounded DOWN, which is what keeps the token count
 * in budget (952x1270 is 1,564 tokens; 953x1270 would be 1,610), and the
 * long edge is the largest that still fits, found by stepping down from the
 * edge limit (at most ~2,600 cheap steps).
 *
 * MEASURED in the bake-off: 3072x4096 → 1659x2212 (high, 4,740 tokens) and
 * 952x1270 (standard, 1,564 tokens).
 */
export function fitToVisionBudget(
  width: number,
  height: number,
  tier: VisionTier,
): { width: number; height: number } {
  const { edge, tokens } = VISION_LIMITS[tier];
  if (Math.max(width, height) <= edge && visionTokens(width, height) <= tokens) {
    return { width, height };
  }
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  for (let l = Math.min(long, edge); l >= 1; l--) {
    const s = Math.max(1, Math.floor((l * short) / long));
    if (visionTokens(l, s) <= tokens) {
      return width >= height ? { width: l, height: s } : { width: s, height: l };
    }
  }
  return { width: 1, height: 1 }; // unreachable: 1x1 is one token
}

// "meal" and "recipe" are NOT PhotoKinds: PhotoKind is the storage upload
// convention in customFoodImages.ts (path = {user}/{food}/{kind}.jpg), and
// neither a meal-photo scan nor a recipe scan is ever uploaded — see
// scan-meal-photo's and scan-recipe's header comments. They only need a
// JPEG quality here, so they get their own small union rather than widening
// PhotoKind to mean something it doesn't.
//
// "receipt" likewise: a receipt photo is sent for extraction and never
// stored.
export type PrepareKind = PhotoKind | "meal" | "recipe" | "receipt";

// Front-of-pack is a thumbnail; the label and a recipe page both have to
// survive OCR (same quality tier); a meal photo needs enough detail for the
// model to judge portion size and components.
const QUALITY: Record<PrepareKind, number> = {
  front: 0.7,
  label: 0.85,
  meal: 0.8,
  recipe: 0.85,
  // The bake-off measured real receipt photos at 0.85 (heaviest part 933k
  // chars at 1659x2212, 27% of MAX_PART_BASE64_CHARS).
  receipt: 0.85,
};

// A receipt part's cap (findings §3, confirmed on 15 real photos in the
// bake-off). Over it, the part is re-encoded ONCE at RECEIPT_RETRY_QUALITY;
// still over is prep_failed. Three parts at the cap still fit the request
// total (MAX_TOTAL_BASE64_CHARS, 9M, checked when the scan is sent).
export const MAX_PART_BASE64_CHARS = 3_500_000;
const RECEIPT_RETRY_QUALITY = 0.7;

// Belt and braces. After a 1568px resize we can't realistically hit this,
// but a silent 400 from Anthropic is a miserable thing to debug.
const MAX_BASE64_CHARS = 6_800_000; // ≈ 5MB of bytes

export type PreparedImage = {
  uri: string; // local file URI — for the preview
  base64: string; // JPEG bytes — for upload AND for extraction
};

export type SourceImage = {
  uri: string;
  width: number;
  height: number;
};

/**
 * Resize (preserving aspect ratio) and re-encode as JPEG. Every kind but
 * "receipt" fits MAX_EDGE on the long edge; "receipt" fits the high-res
 * vision budget (fitToVisionBudget) and has its own size cap and one retry.
 *
 * Returns null on failure; callers should fall back to an error message
 * rather than proceeding with unprepared bytes.
 */
export async function prepareImage(
  source: SourceImage,
  kind: PrepareKind,
): Promise<PreparedImage | null> {
  try {
    const context = ImageManipulator.manipulate(source.uri);

    if (kind === "receipt") {
      return await prepareReceipt(context, source);
    }

    // Resize by the LONG edge. Passing only one dimension preserves the
    // aspect ratio — important, because label photos are uncropped and
    // portrait, and squashing them to a square would destroy the table.
    const longest = Math.max(source.width, source.height);
    if (longest > MAX_EDGE) {
      if (source.width >= source.height) {
        context.resize({ width: MAX_EDGE });
      } else {
        context.resize({ height: MAX_EDGE });
      }
    }
    // If it's already small enough we skip the resize but still render and
    // save — that's what re-encodes it to JPEG, which is the whole point.

    const image = await context.renderAsync();
    const result = await image.saveAsync({
      format: SaveFormat.JPEG,
      compress: QUALITY[kind],
      base64: true,
    });

    if (!result.base64 || !result.uri) {
      console.warn("prepareImage: no output from manipulator");
      return null;
    }

    if (result.base64.length > MAX_BASE64_CHARS) {
      console.warn("prepareImage: still too large after resize");
      return null;
    }

    return { uri: result.uri, base64: result.base64 };
  } catch (e: any) {
    console.warn("prepareImage:", e?.message ?? e);
    return null;
  }
}

/**
 * The "receipt" path: size to the high-res vision budget, encode at 0.85,
 * and if the part is over MAX_PART_BASE64_CHARS, re-encode once at 0.7 from
 * the same rendered image. Errors propagate to prepareImage's catch.
 */
async function prepareReceipt(
  context: ReturnType<typeof ImageManipulator.manipulate>,
  source: SourceImage,
): Promise<PreparedImage | null> {
  const target = fitToVisionBudget(source.width, source.height, RECEIPT_TIER);
  if (target.width !== source.width || target.height !== source.height) {
    context.resize({ width: target.width, height: target.height });
  }

  const image = await context.renderAsync();
  let result = await image.saveAsync({
    format: SaveFormat.JPEG,
    compress: QUALITY.receipt,
    base64: true,
  });
  if (result.base64 && result.base64.length > MAX_PART_BASE64_CHARS) {
    result = await image.saveAsync({
      format: SaveFormat.JPEG,
      compress: RECEIPT_RETRY_QUALITY,
      base64: true,
    });
  }

  if (!result.base64 || !result.uri) {
    console.warn("prepareImage: no output from manipulator");
    return null;
  }
  if (result.base64.length > MAX_PART_BASE64_CHARS) {
    console.warn("prepareImage: receipt part still too large after re-encode");
    return null;
  }
  return { uri: result.uri, base64: result.base64 };
}
