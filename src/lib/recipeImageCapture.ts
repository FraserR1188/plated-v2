// ============================================================
// src/lib/recipeImageCapture.ts — camera OR library capture for recipe scan
//
// Neither ScannerScreen (barcode-only) nor mealPhotoCapture.ts (camera-only,
// scans immediately) fits a recipe: a screenshot already in the library is
// exactly as valid a source as a photographed cookbook page, and
// RecipeScanScreen previews the photo before submitting it.
//
// The capture itself now lives in imageCapture.ts, shared with the receipt
// scanner; this module keeps RecipeScanScreen's API and fixes the kind.
// ============================================================

import { captureImage, pickImage, ImageCaptureResult } from "./imageCapture";

export type RecipeImageCaptureResult = ImageCaptureResult;

export function captureRecipePhoto(): Promise<RecipeImageCaptureResult> {
  return captureImage("recipe");
}

export function pickRecipeImage(): Promise<RecipeImageCaptureResult> {
  return pickImage("recipe");
}
