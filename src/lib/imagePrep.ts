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
// 3. COST AND SPEED. Anthropic downscales anything over 1568px on the
//    long edge anyway, so pixels above that cost upload time and buy
//    nothing. We resize before sending, not after.
//
// Requires: npx expo install expo-image-manipulator
// Native module -> needs `eas build -p android --profile development`.
// ============================================================

import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import type { PhotoKind } from "./customFoodImages";

// Anthropic's recommended maximum long edge. Above this it downscales
// server-side, so there is no accuracy to be gained by sending more.
const MAX_EDGE = 1568;

// "meal" is NOT a PhotoKind: PhotoKind is the storage upload convention in
// customFoodImages.ts (path = {user}/{food}/{kind}.jpg), and a meal-photo
// scan is never uploaded — see scan-meal-photo's header comment. It only
// needs a JPEG quality here, so it gets its own small union rather than
// widening PhotoKind to mean something it doesn't.
export type PrepareKind = PhotoKind | "meal";

// Front-of-pack is a thumbnail; the label has to survive OCR; a meal photo
// needs enough detail for the model to judge portion size and components.
const QUALITY: Record<PrepareKind, number> = {
  front: 0.7,
  label: 0.85,
  meal: 0.8,
};

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
 * Resize to fit MAX_EDGE (preserving aspect ratio) and re-encode as JPEG.
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
