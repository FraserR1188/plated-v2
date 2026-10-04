// ============================================================
// src/lib/__tests__/imageCapture.test.ts
//
// Receipt scanner commit 4a moved recipe capture onto the shared
// imageCapture.ts. These pin that RecipeScanScreen's two entry points
// behave exactly as before — same permission, same picker, same options,
// prepareImage with "recipe" — and that the shared helpers pass their kind
// through, which is what the receipt flow relies on.
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as ImagePicker from "expo-image-picker";
import { prepareImage } from "../imagePrep";
import { captureRecipePhoto, pickRecipeImage } from "../recipeImageCapture";
import { captureImage, pickImage } from "../imageCapture";

vi.mock("expo-image-picker", () => ({
  requestCameraPermissionsAsync: vi.fn(),
  requestMediaLibraryPermissionsAsync: vi.fn(),
  launchCameraAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn(),
}));

vi.mock("../imagePrep", () => ({
  prepareImage: vi.fn(),
}));

const ASSET = { uri: "file:///photo.jpg", width: 3072, height: 4096 };
const PREPARED = { uri: "file:///prepared.jpg", base64: "QUJD" };
// The options both pickers used before the move, verbatim.
const OPTIONS = {
  mediaTypes: ["images"],
  allowsEditing: false,
  quality: 1,
  base64: false,
  exif: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ImagePicker.requestCameraPermissionsAsync).mockResolvedValue({ granted: true } as never);
  vi.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockResolvedValue({ granted: true } as never);
  vi.mocked(ImagePicker.launchCameraAsync).mockResolvedValue({ canceled: false, assets: [ASSET] } as never);
  vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({ canceled: false, assets: [ASSET] } as never);
  vi.mocked(prepareImage).mockResolvedValue(PREPARED);
});

describe("recipe capture, through imageCapture", () => {
  it("camera: camera permission, the camera with the same options, prepared as a recipe", async () => {
    expect(await captureRecipePhoto()).toEqual({ status: "ok", image: PREPARED });
    expect(ImagePicker.launchCameraAsync).toHaveBeenCalledWith(OPTIONS);
    expect(ImagePicker.launchImageLibraryAsync).not.toHaveBeenCalled();
    expect(prepareImage).toHaveBeenCalledWith(ASSET, "recipe");
  });

  it("library: library permission, the library with the same options, prepared as a recipe", async () => {
    expect(await pickRecipeImage()).toEqual({ status: "ok", image: PREPARED });
    expect(ImagePicker.requestMediaLibraryPermissionsAsync).toHaveBeenCalled();
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(OPTIONS);
    expect(ImagePicker.launchCameraAsync).not.toHaveBeenCalled();
    expect(prepareImage).toHaveBeenCalledWith(ASSET, "recipe");
  });

  it("permission denied stops before the picker", async () => {
    vi.mocked(ImagePicker.requestCameraPermissionsAsync).mockResolvedValue({ granted: false } as never);
    expect(await captureRecipePhoto()).toEqual({ status: "permission_denied" });
    expect(ImagePicker.launchCameraAsync).not.toHaveBeenCalled();
  });

  it("cancelled stops before prepareImage", async () => {
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({ canceled: true, assets: null } as never);
    expect(await pickRecipeImage()).toEqual({ status: "cancelled" });
    expect(prepareImage).not.toHaveBeenCalled();
  });

  it("prepareImage failing is prep_failed", async () => {
    vi.mocked(prepareImage).mockResolvedValue(null);
    expect(await captureRecipePhoto()).toEqual({ status: "prep_failed" });
  });
});

describe("the shared helpers pass their kind through", () => {
  it.each(["receipt", "recipe"] as const)("%s", async (kind) => {
    await captureImage(kind);
    expect(prepareImage).toHaveBeenLastCalledWith(ASSET, kind);
    await pickImage(kind);
    expect(prepareImage).toHaveBeenLastCalledWith(ASSET, kind);
  });
});
