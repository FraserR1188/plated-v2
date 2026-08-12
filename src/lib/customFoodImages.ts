// ============================================================
// src/lib/customFoodImages.ts — custom food photo storage
//
// Bucket `custom-food-images` is PRIVATE. That means:
//   • we persist the storage OBJECT PATH on custom_foods.image_url
//   • we mint a short-lived SIGNED URL at display time
//
// Path convention: {user_id}/{custom_food_id}/{kind}.jpg
//   kind = "front" today. Session C adds "label" (the nutrition-label
//   photo for AI extraction) with zero changes here — it's just
//   another kind, same bucket, same RLS.
// ============================================================

import { supabase } from "./supabase";
import { useStore } from "../store/useStore";
import { reportError } from "./reportError";

const BUCKET = "custom-food-images";

// The photo types a custom food can carry. Session C adds "label".
export type PhotoKind = "front" | "label";

// Signed URLs are short-lived by design; we regenerate per display.
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

// ─── Path helpers ────────────────────────────────────────────

// RLS enforces that the FIRST path segment is the user's id, so this
// convention isn't cosmetic — it's what makes the policies work.
export function buildImagePath(
  userId: string,
  customFoodId: string,
  kind: PhotoKind,
): string {
  return `${userId}/${customFoodId}/${kind}.jpg`;
}

// ─── base64 → Uint8Array ─────────────────────────────────────
// React Native's fetch(uri).blob() is unreliable for local file URIs,
// so we take base64 straight from the image picker and decode it
// ourselves. Manual decode = zero extra dependencies.

const B64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64ToUint8Array(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, "");
  const len = clean.length;
  const bytes = new Uint8Array((len * 3) >> 2);

  let byteIndex = 0;
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < len; i++) {
    const value = B64_CHARS.indexOf(clean[i]);
    if (value === -1) continue;

    buffer = (buffer << 6) | value;
    bits += 6;

    if (bits >= 8) {
      bits -= 8;
      bytes[byteIndex++] = (buffer >> bits) & 0xff;
    }
  }

  return bytes.subarray(0, byteIndex);
}

// ─── Upload ──────────────────────────────────────────────────

export type UploadResult = {
  path: string | null;
  error: string | null;
};

/**
 * Upload a photo for an existing custom food.
 *
 * Called AFTER the custom_foods row exists, so we have a real id to
 * build the path from. `upsert: true` means re-photographing a food
 * overwrites cleanly rather than orphaning the old object.
 *
 * Returns the object PATH — caller persists it on custom_foods.
 */
export async function uploadCustomFoodImage(
  customFoodId: string,
  base64: string,
  kind: PhotoKind = "front",
): Promise<UploadResult> {
  const userId = useStore.getState().userId;
  if (!userId) return { path: null, error: "Not signed in." };
  if (!base64) return { path: null, error: "No image data." };

  const path = buildImagePath(userId, customFoodId, kind);

  try {
    const bytes = base64ToUint8Array(base64);

    const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, {
      // TRUE BY CONSTRUCTION, not by luck: every caller runs the bytes through
      // prepareImage() (src/lib/imagePrep.ts), which re-encodes to JPEG. Before
      // Session C this was an assumption, and a wrong one — the picker hands
      // back PNG from the library and HEIC on iOS.
      contentType: "image/jpeg",
      upsert: true,
    });

    if (error) {
      reportError("uploadCustomFoodImage", error);
      return { path: null, error: "Couldn't upload the photo." };
    }

    return { path, error: null };
  } catch (e: any) {
    reportError("uploadCustomFoodImage", e);
    return { path: null, error: "Couldn't upload the photo." };
  }
}

// ─── Display ─────────────────────────────────────────────────

/**
 * Turn a stored object path into a temporary URL an <Image> can render.
 * Returns null on failure — callers fall back to the placeholder tile.
 */
export async function getSignedImageUrl(
  path: string | null | undefined,
): Promise<string | null> {
  if (!path) return null;

  try {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

    if (error || !data?.signedUrl) {
      reportError("getSignedImageUrl", error);
      return null;
    }
    return data.signedUrl;
  } catch (e: any) {
    reportError("getSignedImageUrl", e);
    return null;
  }
}

// ─── Delete ──────────────────────────────────────────────────

/** Remove a stored photo (e.g. when a custom food is deleted). */
export async function deleteCustomFoodImage(
  path: string | null | undefined,
): Promise<void> {
  if (!path) return;
  try {
    await supabase.storage.from(BUCKET).remove([path]);
  } catch (e: any) {
    reportError("deleteCustomFoodImage", e);
  }
}
