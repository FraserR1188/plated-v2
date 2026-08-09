// ============================================================
// src/lib/recipeImageCapture.ts — camera OR library capture for recipe scan
//
// Neither existing capture path fits here. ScannerScreen is barcode-only.
// mealPhotoCapture.ts is deliberately camera-only — a meal has to be a
// fresh photo of food in front of the camera right now. A recipe is the
// opposite case: a screenshot (already in the library) is exactly as valid
// a source as a photographed cookbook page, so this module offers BOTH,
// following CreateFoodScreen's handleTakePhoto/handlePickFromLibrary
// permission+picker pattern.
//
// Deliberately stops at "here are prepared bytes", unlike
// captureAndScanMealPhoto which also calls the scan API — RecipeScanScreen
// shows a preview of the photo before submitting it (the meal-photo flow
// has no such preview step), so the capture and the scan are two separate
// user-visible moments here.
// ============================================================

import * as ImagePicker from "expo-image-picker";
import { prepareImage, PreparedImage } from "./imagePrep";

export type RecipeImageCaptureResult =
  | { status: "cancelled" }
  | { status: "permission_denied" }
  | { status: "prep_failed" }
  | { status: "ok"; image: PreparedImage };

async function fromPickerResult(
  result: ImagePicker.ImagePickerResult,
): Promise<RecipeImageCaptureResult> {
  if (result.canceled || !result.assets?.[0]) return { status: "cancelled" };

  const asset = result.assets[0];
  const prepared = await prepareImage(
    { uri: asset.uri, width: asset.width, height: asset.height },
    "recipe",
  );
  if (!prepared) return { status: "prep_failed" };

  return { status: "ok", image: prepared };
}

export async function captureRecipePhoto(): Promise<RecipeImageCaptureResult> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) return { status: "permission_denied" };

  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ["images"],
    allowsEditing: false, // forces a square crop on iOS regardless of aspect — never wanted for a page photo
    quality: 1, // prepareImage does the compressing; don't double-encode
    base64: false,
    exif: false,
  });
  return fromPickerResult(result);
}

export async function pickRecipeImage(): Promise<RecipeImageCaptureResult> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return { status: "permission_denied" };

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsEditing: false,
    quality: 1,
    base64: false,
    exif: false,
  });
  return fromPickerResult(result);
}
