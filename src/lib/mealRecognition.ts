// ============================================================
// src/lib/mealRecognition.ts — client wrapper for scan-meal-photo
//
// Same pattern as labelExtraction.ts:
//   • functions.invoke() attaches the session JWT automatically
//   • non-2xx comes back as a FunctionsHttpError with the JSON body
//     hidden inside error.context, NOT in error.message
//   • the function always answers with { ok: true, ... } or
//     { ok: false, error, message } — the caller switches on the code and
//     shows `message` verbatim
// ============================================================

import { supabase } from "./supabase";
import { FoodProduct } from "../types";

// ⚠️  MIRROR OF supabase/functions/scan-meal-photo/index.ts.
//     Deno and RN have separate tsconfigs; sharing one file across that
//     boundary costs more than it saves. Change one, change the other.

/** Must stay identical to labelExtraction's MacroKey / CreateFoodScreen's. */
export type MacroKey =
  | "cal"
  | "protein"
  | "carbs"
  | "fat"
  | "satFat"
  | "salt"
  | "fibre"
  | "sugar";

export const MACRO_KEYS: MacroKey[] = [
  "cal",
  "protein",
  "carbs",
  "fat",
  "satFat",
  "salt",
  "fibre",
  "sugar",
];

export type Confidence = "high" | "medium" | "low";

export type MacroTotals = Record<MacroKey, number>;

export type MealScanSuccess = {
  ok: true;
  dish: { name: string; alternatives: string[] };
  portion: { grams: number; description: string };
  per100g: MacroTotals;
  confidence: Confidence;
  notes: string[];
};

export type MealScanErrorCode =
  | "unauthorized"
  | "bad_request"
  | "rate_limited"
  | "no_food"
  | "model_error"
  | "server_error"
  | "network_error"; // client-side only: never reached the function

export type MealScanFailure = {
  ok: false;
  error: MealScanErrorCode;
  message: string;
};

export type MealScanResponse = MealScanSuccess | MealScanFailure;

const FUNCTION_NAME = "scan-meal-photo";

const GENERIC_FAILURE: MealScanFailure = {
  ok: false,
  error: "network_error",
  message:
    "Couldn't reach the meal scanner. Check your connection, or add this meal by hand.",
};

/**
 * Send a JPEG meal photo for identification and macro estimation.
 *
 * @param base64 JPEG bytes as base64, no data: URI prefix.
 *               MUST have been through prepareImage() — the function
 *               trusts the declared media type.
 */
export async function scanMealPhoto(base64: string): Promise<MealScanResponse> {
  try {
    const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, {
      body: { imageBase64: base64, mediaType: "image/jpeg" },
    });

    if (error) {
      const parsed = await readErrorBody(error);
      if (parsed) return parsed;

      console.warn("scanMealPhoto:", error.message);
      return GENERIC_FAILURE;
    }

    if (!isMealScanSuccessShape(data)) {
      console.warn("scanMealPhoto: unexpected payload", data);
      return GENERIC_FAILURE;
    }

    return data;
  } catch (e: any) {
    console.warn("scanMealPhoto:", e?.message ?? e);
    return GENERIC_FAILURE;
  }
}

/** Dig our error envelope out of a FunctionsHttpError. */
async function readErrorBody(error: unknown): Promise<MealScanFailure | null> {
  const context = (error as any)?.context;
  if (!context || typeof context.json !== "function") return null;

  try {
    const body = await context.json();
    if (body && body.ok === false && typeof body.error === "string") {
      return {
        ok: false,
        error: body.error as MealScanErrorCode,
        message:
          typeof body.message === "string" && body.message
            ? body.message
            : GENERIC_FAILURE.message,
      };
    }
  } catch {
    // Body wasn't JSON, or was already consumed. Fall through.
  }
  return null;
}

/**
 * Turn a successful scan into an editable ProductScreen draft.
 *
 * No image: the captured photo is used for recognition only and is never
 * uploaded or stored (same statelessness as extract-nutrition-label), so
 * image_url / image_path are deliberately left unset — ProductThumb falls
 * back to its placeholder tile, same as any product with no picture.
 *
 * serving_g / serving_label carry the model's stated portion assumption
 * through to the existing "Suggested serving" line on ProductScreen — that
 * is what satisfies "must state its portion assumption" without any new
 * UI for the number itself. aiEstimate carries the rest (confidence,
 * alternatives, disclaimer notes) for the banner that IS new.
 */
export function mealScanToFoodProduct(result: MealScanSuccess): FoodProduct {
  return {
    name: result.dish.name,
    brand: "",
    cal_per100: result.per100g.cal,
    protein_per100: result.per100g.protein,
    carbs_per100: result.per100g.carbs,
    fat_per100: result.per100g.fat,
    sat_fat_per100: result.per100g.satFat,
    salt_per100: result.per100g.salt,
    fibre_per100: result.per100g.fibre,
    sugar_per100: result.per100g.sugar,
    serving_g: result.portion.grams,
    serving_label: result.portion.description,
    aiEstimate: {
      alternatives: result.dish.alternatives,
      confidence: result.confidence,
      notes: result.notes,
    },
  };
}

/**
 * Shape-check rather than trusting a cast. A malformed or truncated
 * response (a proxy timeout mid-body, a contract drift) must fail loudly
 * here — as GENERIC_FAILURE — instead of handing the screen a MealScanSuccess
 * with `undefined` macros that render as NaN.
 */
function isMealScanSuccessShape(data: unknown): data is MealScanSuccess {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (d.ok !== true) return false;

  const dish = d.dish as Record<string, unknown> | undefined;
  if (!dish || typeof dish.name !== "string" || !Array.isArray(dish.alternatives)) {
    return false;
  }

  const portion = d.portion as Record<string, unknown> | undefined;
  if (
    !portion ||
    typeof portion.grams !== "number" ||
    typeof portion.description !== "string"
  ) {
    return false;
  }

  const per100g = d.per100g as Record<string, unknown> | undefined;
  if (!per100g || !MACRO_KEYS.every((k) => typeof per100g[k] === "number")) {
    return false;
  }

  if (!["high", "medium", "low"].includes(d.confidence as string)) return false;
  if (!Array.isArray(d.notes)) return false;

  return true;
}
