// ============================================================
// src/lib/mealPhotoCapture.ts — shared camera→estimate orchestration
//
// Pulled out of AddIngredientScreen so BatchIngredientPickerScreen can reuse
// the exact same capture→prepare→scan pipeline for the batch flow, without
// reusing AddIngredientScreen's LOGGING behaviour (it navigates straight to
// Product, which writes to meal_entries — a batch ingredient must not).
// Each caller gets the same discriminated result back and decides for
// itself what to do with it (navigate to Product vs. hand to a picker's
// quantity step) and how to phrase its own alerts.
//
// Camera only (no library), same reasoning as before: recognising what's on
// the plate depends on a fresh photo of food in front of the camera. The
// photo is never uploaded to Storage or written to any row — scanMealPhoto
// sends the bytes for recognition and gets numbers back. It IS retained
// client-side on the resulting draft (FoodProduct.aiEstimate.
// sourceImageBase64, set by mealScanToFoodProduct below), purely so
// ProductScreen can resend the same bytes for a corrected re-estimate
// without reopening the camera. That's still "never stored" in the sense
// that matters here (no Storage bucket, no DB row) — it just doesn't die
// with this function's return anymore.
// ============================================================

import * as ImagePicker from "expo-image-picker";
import { prepareImage } from "./imagePrep";
import { scanMealPhoto, mealScanToFoodProduct } from "./mealRecognition";
import { FoodProduct } from "../types";

export type MealPhotoCaptureResult =
  | { status: "cancelled" }
  | { status: "permission_denied" }
  | { status: "prep_failed" }
  | { status: "scan_failed"; message: string }
  | { status: "ok"; product: FoodProduct };

export async function captureAndScanMealPhoto(): Promise<MealPhotoCaptureResult> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) return { status: "permission_denied" };

  const picked = await ImagePicker.launchCameraAsync({
    quality: 1,
    base64: false,
  });
  if (picked.canceled || !picked.assets?.[0]) return { status: "cancelled" };

  const asset = picked.assets[0];
  const prepared = await prepareImage(
    { uri: asset.uri, width: asset.width, height: asset.height },
    "meal",
  );
  if (!prepared) return { status: "prep_failed" };

  const scan = await scanMealPhoto(prepared.base64);
  if (!scan.ok) return { status: "scan_failed", message: scan.message };

  return { status: "ok", product: mealScanToFoodProduct(scan, prepared.base64) };
}
