// ============================================================
// src/lib/imageCapture.ts — camera OR library capture, stopping at
// prepared bytes
//
// Shared by every flow that previews a photo before spending a scan on it:
// recipe scan today, the receipt scanner next (findings §4), menu mode
// later. Extracted unchanged in behaviour from recipeImageCapture.ts, which
// is now a thin wrapper over it.
//
// Not used by mealPhotoCapture.ts, which is deliberately camera-only and
// scans immediately — a meal has to be a fresh photo of food in front of
// the camera right now, with no preview step.
//
// Follows CreateFoodScreen's handleTakePhoto/handlePickFromLibrary
// permission+picker pattern.
// ============================================================

import * as ImagePicker from "expo-image-picker";
import { prepareImage, PreparedImage, PrepareKind } from "./imagePrep";

export type ImageCaptureResult =
  | { status: "cancelled" }
  | { status: "permission_denied" }
  | { status: "prep_failed" }
  | { status: "ok"; image: PreparedImage };

// Shared by both pickers. allowsEditing: false because it forces a square
// crop on iOS regardless of aspect — never wanted for a page, label or
// receipt. quality: 1 because prepareImage does the compressing; don't
// double-encode.
const PICKER_OPTIONS = {
  mediaTypes: ["images"],
  allowsEditing: false,
  quality: 1,
  base64: false,
  exif: false,
} satisfies ImagePicker.ImagePickerOptions;

async function fromPickerResult(
  result: ImagePicker.ImagePickerResult,
  kind: PrepareKind,
): Promise<ImageCaptureResult> {
  if (result.canceled || !result.assets?.[0]) return { status: "cancelled" };

  const asset = result.assets[0];
  const prepared = await prepareImage(
    { uri: asset.uri, width: asset.width, height: asset.height },
    kind,
  );
  if (!prepared) return { status: "prep_failed" };

  return { status: "ok", image: prepared };
}

export async function captureImage(kind: PrepareKind): Promise<ImageCaptureResult> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) return { status: "permission_denied" };

  const result = await ImagePicker.launchCameraAsync(PICKER_OPTIONS);
  return fromPickerResult(result, kind);
}

export async function pickImage(kind: PrepareKind): Promise<ImageCaptureResult> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return { status: "permission_denied" };

  const result = await ImagePicker.launchImageLibraryAsync(PICKER_OPTIONS);
  return fromPickerResult(result, kind);
}
