// ============================================================
// src/lib/labelCapture.ts — shared camera->extraction orchestration
//
// captureAndScanMealPhoto()'s sibling (src/lib/mealPhotoCapture.ts): a
// non-navigating camera capture that never touches custom_foods and never
// uploads to Storage. Pulled out so RecipeConfirmScreen's per-row "Scan
// label" button can reuse the exact same capture->prepare->extract pipeline
// CreateFoodScreen uses inline, without reusing CreateFoodScreen's SAVE
// behaviour (it writes a custom_foods row; a recipe-scan row must not).
//
// UNLIKE captureAndScanMealPhoto, this cannot resolve all the way to a
// FoodProduct in one call. scan-meal-photo's schema requires every macro,
// so mealScanToFoodProduct() never fails. extract-nutrition-label's per
// -field readings can legitimately be null (the label just didn't print
// fibre, or gave a per-serving column with no stated weight) — resolving
// those cases needs a human decision (LabelConfirmSheet's weight prompt,
// and the missing-macro gate), not something this function can make. So it
// stops at the raw ExtractSuccess/ExtractFailure and hands that to the
// caller, same as CreateFoodScreen.runExtraction does today.
//
// No-crop picker options mirror CreateFoodScreen.pickerOptionsFor("label"):
// the model wants the whole table, and any crop UI risks eating the bottom
// rows (salt, fibre) the way a forced square crop would.
// ============================================================

import * as ImagePicker from "expo-image-picker";
import { prepareImage } from "./imagePrep";
import { extractNutritionLabel, type ExtractResponse } from "./labelExtraction";

export type LabelCaptureResult =
  | { status: "cancelled" }
  | { status: "permission_denied" }
  | { status: "prep_failed" }
  | { status: "scan_failed"; message: string }
  | { status: "ok"; result: Extract<ExtractResponse, { ok: true }> };

export async function captureAndScanLabel(): Promise<LabelCaptureResult> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) return { status: "permission_denied" };

  const picked = await ImagePicker.launchCameraAsync({
    mediaTypes: ["images"],
    allowsEditing: false,
    quality: 1, // prepareImage does the real compressing; don't double-encode
    base64: false,
    exif: false,
  });
  if (picked.canceled || !picked.assets?.[0]) return { status: "cancelled" };

  const asset = picked.assets[0];
  const prepared = await prepareImage(
    { uri: asset.uri, width: asset.width, height: asset.height },
    "label",
  );
  if (!prepared) return { status: "prep_failed" };

  const scan = await extractNutritionLabel(prepared.base64);
  if (!scan.ok) return { status: "scan_failed", message: scan.message };

  return { status: "ok", result: scan };
}
