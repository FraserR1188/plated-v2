// ============================================================
// src/lib/__tests__/mealPhotoCapture.test.ts
//
// captureAndScanMealPhoto is the ONE capture→prepare→scan pipeline shared by
// AddIngredientScreen (logging flow) and BatchIngredientPickerScreen (batch
// flow) — each screen owns its own result-handling, but both must see the
// same branches for the same underlying outcome. This locks the discriminated
// result shape in place so neither caller can silently start branching on a
// status that doesn't exist.
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as ImagePicker from "expo-image-picker";
import { prepareImage } from "../imagePrep";
import { scanMealPhoto, mealScanToFoodProduct } from "../mealRecognition";
import { captureAndScanMealPhoto } from "../mealPhotoCapture";
import { VALID_SUCCESS, NO_FOOD_FAILURE } from "./fixtures/mealScan";

vi.mock("expo-image-picker", () => ({
  requestCameraPermissionsAsync: vi.fn(),
  launchCameraAsync: vi.fn(),
}));

vi.mock("../imagePrep", () => ({
  prepareImage: vi.fn(),
}));

vi.mock("../mealRecognition", () => ({
  scanMealPhoto: vi.fn(),
  mealScanToFoodProduct: vi.fn(),
}));

const ASSET = { uri: "file:///photo.jpg", width: 1200, height: 900 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("captureAndScanMealPhoto", () => {
  it("stops at permission_denied without touching the camera or the network", async () => {
    vi.mocked(ImagePicker.requestCameraPermissionsAsync).mockResolvedValue({
      granted: false,
    } as never);

    const result = await captureAndScanMealPhoto();

    expect(result).toEqual({ status: "permission_denied" });
    expect(ImagePicker.launchCameraAsync).not.toHaveBeenCalled();
    expect(scanMealPhoto).not.toHaveBeenCalled();
  });

  it("stops at cancelled when the user backs out of the camera", async () => {
    vi.mocked(ImagePicker.requestCameraPermissionsAsync).mockResolvedValue({
      granted: true,
    } as never);
    vi.mocked(ImagePicker.launchCameraAsync).mockResolvedValue({
      canceled: true,
      assets: null,
    } as never);

    const result = await captureAndScanMealPhoto();

    expect(result).toEqual({ status: "cancelled" });
    expect(prepareImage).not.toHaveBeenCalled();
  });

  it("stops at prep_failed when prepareImage can't produce bytes, without calling the network", async () => {
    vi.mocked(ImagePicker.requestCameraPermissionsAsync).mockResolvedValue({
      granted: true,
    } as never);
    vi.mocked(ImagePicker.launchCameraAsync).mockResolvedValue({
      canceled: false,
      assets: [ASSET],
    } as never);
    vi.mocked(prepareImage).mockResolvedValue(null);

    const result = await captureAndScanMealPhoto();

    expect(result).toEqual({ status: "prep_failed" });
    expect(scanMealPhoto).not.toHaveBeenCalled();
  });

  it("passes the prepared base64 through and surfaces scan_failed with the server's message on failure", async () => {
    vi.mocked(ImagePicker.requestCameraPermissionsAsync).mockResolvedValue({
      granted: true,
    } as never);
    vi.mocked(ImagePicker.launchCameraAsync).mockResolvedValue({
      canceled: false,
      assets: [ASSET],
    } as never);
    vi.mocked(prepareImage).mockResolvedValue({
      uri: ASSET.uri,
      base64: "preparedBytes",
    });
    vi.mocked(scanMealPhoto).mockResolvedValue(NO_FOOD_FAILURE);

    const result = await captureAndScanMealPhoto();

    expect(scanMealPhoto).toHaveBeenCalledWith("preparedBytes");
    expect(result).toEqual({
      status: "scan_failed",
      message: NO_FOOD_FAILURE.message,
    });
  });

  it("returns ok with the mapped FoodProduct on a successful scan", async () => {
    vi.mocked(ImagePicker.requestCameraPermissionsAsync).mockResolvedValue({
      granted: true,
    } as never);
    vi.mocked(ImagePicker.launchCameraAsync).mockResolvedValue({
      canceled: false,
      assets: [ASSET],
    } as never);
    vi.mocked(prepareImage).mockResolvedValue({
      uri: ASSET.uri,
      base64: "preparedBytes",
    });
    vi.mocked(scanMealPhoto).mockResolvedValue(VALID_SUCCESS);
    const fakeProduct = { name: "Fake dish" } as never;
    vi.mocked(mealScanToFoodProduct).mockReturnValue(fakeProduct);

    const result = await captureAndScanMealPhoto();

    // The prepared bytes are threaded through so a later correction can
    // resend the SAME photo without reopening the camera.
    expect(mealScanToFoodProduct).toHaveBeenCalledWith(VALID_SUCCESS, "preparedBytes");
    expect(result).toEqual({ status: "ok", product: fakeProduct });
  });
});
