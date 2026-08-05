import { describe, it, expect, vi, beforeEach } from "vitest";
import { scanMealPhoto, mealScanToFoodProduct, type MealScanSuccess } from "../mealRecognition";
import { supabase } from "../supabase";
import {
  VALID_SUCCESS,
  LOW_CONFIDENCE_SUCCESS,
  NO_FOOD_FAILURE,
  MALFORMED_SUCCESS_SHAPE,
  GARBAGE_PAYLOAD,
} from "./fixtures/mealScan";

const invoke = () => vi.mocked(supabase.functions.invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scanMealPhoto — valid responses", () => {
  it("returns a well-formed success payload unchanged", async () => {
    invoke().mockResolvedValue({ data: VALID_SUCCESS, error: null } as never);

    const result = await scanMealPhoto("base64bytes");
    expect(result).toEqual(VALID_SUCCESS);
  });

  it("calls the function with the base64 bytes and a fixed image/jpeg media type", async () => {
    invoke().mockResolvedValue({ data: VALID_SUCCESS, error: null } as never);

    await scanMealPhoto("abc123");

    expect(invoke()).toHaveBeenCalledWith("scan-meal-photo", {
      body: { imageBase64: "abc123", mediaType: "image/jpeg" },
    });
  });

  it("passes user_dish_label through on a corrected re-estimate", async () => {
    invoke().mockResolvedValue({ data: VALID_SUCCESS, error: null } as never);

    await scanMealPhoto("abc123", "Fruit scone with clotted cream");

    expect(invoke()).toHaveBeenCalledWith("scan-meal-photo", {
      body: {
        imageBase64: "abc123",
        mediaType: "image/jpeg",
        user_dish_label: "Fruit scone with clotted cream",
      },
    });
  });

  it("passes a low-confidence estimate straight through — it does not upgrade, downgrade, or hide it", async () => {
    invoke().mockResolvedValue({
      data: LOW_CONFIDENCE_SUCCESS,
      error: null,
    } as never);

    const result = await scanMealPhoto("base64bytes");

    expect(result).toEqual(LOW_CONFIDENCE_SUCCESS);
    if (result.ok) {
      expect(result.confidence).toBe("low");
      // The extra low-confidence note must survive — it's the one thing
      // that tells the screen to render a warning.
      expect(result.notes).toContain(
        "Low confidence: this dish or portion was hard to judge from the photo.",
      );
    }
  });
});

describe("scanMealPhoto — malformed / unexpected payloads", () => {
  it("rejects a success payload with a contract-drifted per100g (missing macro keys)", async () => {
    invoke().mockResolvedValue({
      data: MALFORMED_SUCCESS_SHAPE,
      error: null,
    } as never);

    const result = await scanMealPhoto("base64bytes");

    // Must fail loudly as network_error, NOT be handed to the screen with
    // `undefined` macros that would render as NaN.
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe("network_error");
  });

  it("rejects a payload with no recognisable shape at all", async () => {
    invoke().mockResolvedValue({ data: GARBAGE_PAYLOAD, error: null } as never);

    const result = await scanMealPhoto("base64bytes");
    expect(result.ok).toBe(false);
  });

  it("rejects a null data payload with no error", async () => {
    invoke().mockResolvedValue({ data: null, error: null } as never);

    const result = await scanMealPhoto("base64bytes");
    expect(result.ok).toBe(false);
  });
});

describe("scanMealPhoto — error envelopes (non-2xx)", () => {
  it("parses the { ok: false, error, message } envelope out of error.context", async () => {
    invoke().mockResolvedValue({
      data: null,
      error: {
        message: "Edge Function returned a non-2xx status code",
        context: { json: async () => NO_FOOD_FAILURE },
      },
    } as never);

    const result = await scanMealPhoto("base64bytes");

    expect(result).toEqual(NO_FOOD_FAILURE);
  });

  it("falls back to a generic failure when the error body is not valid JSON", async () => {
    invoke().mockResolvedValue({
      data: null,
      error: {
        message: "Edge Function returned a non-2xx status code",
        context: {
          json: async () => {
            throw new SyntaxError("Unexpected token in JSON");
          },
        },
      },
    } as never);

    const result = await scanMealPhoto("base64bytes");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe("network_error");
  });

  it("falls back to a generic failure when the error has no context at all", async () => {
    invoke().mockResolvedValue({
      data: null,
      error: { message: "network request failed" },
    } as never);

    const result = await scanMealPhoto("base64bytes");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe("network_error");
  });

  it("falls back to a generic failure when the parsed body is JSON but not our envelope", async () => {
    invoke().mockResolvedValue({
      data: null,
      error: {
        message: "Edge Function returned a non-2xx status code",
        context: { json: async () => ({ some: "unrelated shape" }) },
      },
    } as never);

    const result = await scanMealPhoto("base64bytes");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe("network_error");
  });
});

describe("mealScanToFoodProduct", () => {
  it("maps per100g and the portion assumption onto the fields ProductScreen already renders", () => {
    const product = mealScanToFoodProduct(VALID_SUCCESS, "sourceBytes");

    expect(product.name).toBe(VALID_SUCCESS.dish.name);
    expect(product.cal_per100).toBe(VALID_SUCCESS.per100g.cal);
    expect(product.protein_per100).toBe(VALID_SUCCESS.per100g.protein);
    expect(product.carbs_per100).toBe(VALID_SUCCESS.per100g.carbs);
    expect(product.fat_per100).toBe(VALID_SUCCESS.per100g.fat);
    expect(product.sat_fat_per100).toBe(VALID_SUCCESS.per100g.satFat);
    expect(product.salt_per100).toBe(VALID_SUCCESS.per100g.salt);
    expect(product.fibre_per100).toBe(VALID_SUCCESS.per100g.fibre);
    expect(product.sugar_per100).toBe(VALID_SUCCESS.per100g.sugar);

    // The portion assumption rides the existing serving_g/serving_label
    // fields — no new UI needed for ProductScreen to state it.
    expect(product.serving_g).toBe(VALID_SUCCESS.portion.grams);
    expect(product.serving_label).toBe(VALID_SUCCESS.portion.description);
  });

  it("carries confidence, alternatives and notes into aiEstimate so ProductScreen can flag provenance", () => {
    const product = mealScanToFoodProduct(LOW_CONFIDENCE_SUCCESS, "sourceBytes");

    expect(product.aiEstimate).toEqual({
      alternatives: LOW_CONFIDENCE_SUCCESS.dish.alternatives,
      confidence: "low",
      notes: LOW_CONFIDENCE_SUCCESS.notes,
      sourceImageBase64: "sourceBytes",
      userCorrected: false,
    });
  });

  it("never sets an image — the capture photo is used for recognition only, never stored", () => {
    const product = mealScanToFoodProduct(VALID_SUCCESS, "sourceBytes");
    expect(product.image_url).toBeUndefined();
    expect(product.image_path).toBeUndefined();
  });

  describe("on a corrected re-estimate (corrected = true)", () => {
    it("sets userCorrected and retains the source image bytes the re-estimate needs", () => {
      const product = mealScanToFoodProduct(VALID_SUCCESS, "sourceBytes", true);

      expect(product.aiEstimate?.userCorrected).toBe(true);
      expect(product.aiEstimate?.sourceImageBase64).toBe("sourceBytes");
    });

    it("forces alternatives empty even if the result still carries some — the user has final say", () => {
      const stillHasAlternatives: MealScanSuccess = {
        ...VALID_SUCCESS,
        dish: { name: "Fruit scone with clotted cream", alternatives: ["Pâté on toast"] },
      };

      const product = mealScanToFoodProduct(stillHasAlternatives, "sourceBytes", true);

      expect(product.aiEstimate?.alternatives).toEqual([]);
    });

    it("carries identityDivergence through when the server flagged the model's own guess as diverging", () => {
      const diverging: MealScanSuccess = { ...VALID_SUCCESS, identityDivergence: true };

      const product = mealScanToFoodProduct(diverging, "sourceBytes", true);

      expect(product.aiEstimate?.identityDivergence).toBe(true);
    });
  });

  it("defaults to userCorrected: false and keeps the model's own alternatives on a first pass", () => {
    const product = mealScanToFoodProduct(VALID_SUCCESS, "sourceBytes");

    expect(product.aiEstimate?.userCorrected).toBe(false);
    expect(product.aiEstimate?.alternatives).toEqual(VALID_SUCCESS.dish.alternatives);
  });
});

describe("scanMealPhoto — transport failure", () => {
  it("catches a thrown/rejected invoke() call and returns a generic failure", async () => {
    invoke().mockRejectedValue(new Error("fetch failed"));

    const result = await scanMealPhoto("base64bytes");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe("network_error");
  });
});
