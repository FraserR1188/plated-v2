// ============================================================
// src/lib/labelExtraction.ts — client wrapper for the Edge Function
//
// The pattern in this file is the whole point of Session C. The WHOOP
// token-exchange call will be the same twenty lines with a different
// function name and a different payload:
//
//   • functions.invoke() attaches the session JWT automatically
//     (persistSession: true + AsyncStorage — see src/lib/supabase.ts)
//   • non-2xx comes back as a FunctionsHttpError with the JSON body
//     hidden inside error.context, NOT in error.message
//   • the function always answers with { ok: true, ... } or
//     { ok: false, error, message } — so the caller switches on a code
//     and shows `message` verbatim
// ============================================================

import { supabase } from "./supabase";

// ⚠️  MIRROR OF supabase/functions/_shared/types.ts.
//     Deno and RN have separate tsconfigs; sharing one file across that
//     boundary costs more than it saves. Change one, change the other.

/** Must stay identical to CreateFoodScreen's MacroKey. */
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

/**
 * The model's own self-report. A UX hint for tinting cells — NOT a gate,
 * and not well calibrated. `value: null` is the signal you can trust.
 */
export type Confidence = "high" | "medium" | "low";

export type Reading = {
  value: number | null;
  confidence: Confidence;
};

export type MacroSet = Record<MacroKey, Reading>;

export type ExtractSuccess = {
  ok: true;
  productName: string | null;
  per100g: MacroSet | null;
  per100gDerived: boolean;
  perServing: MacroSet | null;
  servingG: number | null;
  servingLabel: string | null;
  needsServingWeight: boolean;
  notes: string[];
};

export type ExtractErrorCode =
  | "unauthorized"
  | "bad_request"
  | "rate_limited"
  | "no_label"
  | "model_error"
  | "server_error"
  | "network_error"; // client-side only: never reached the function

export type ExtractFailure = {
  ok: false;
  error: ExtractErrorCode;
  message: string;
};

export type ExtractResponse = ExtractSuccess | ExtractFailure;

const FUNCTION_NAME = "extract-nutrition-label";

const GENERIC_FAILURE: ExtractFailure = {
  ok: false,
  error: "network_error",
  message:
    "Couldn't reach the label scanner. Check your connection, or enter the values by hand.",
};

/**
 * Send a JPEG label photo for extraction.
 *
 * @param base64 JPEG bytes as base64, no data: URI prefix.
 *               MUST have been through prepareImage() — the function
 *               trusts the declared media type.
 */
export async function extractNutritionLabel(
  base64: string,
): Promise<ExtractResponse> {
  try {
    const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, {
      body: { imageBase64: base64, mediaType: "image/jpeg" },
    });

    if (error) {
      // GOTCHA: on a non-2xx, supabase-js gives you a FunctionsHttpError
      // whose .message is a useless "Edge Function returned a non-2xx
      // status code". The real body — our { ok, error, message } envelope
      // — is on error.context, which is a Response we have to read.
      const parsed = await readErrorBody(error);
      if (parsed) return parsed;

      console.warn("extractNutritionLabel:", error.message);
      return GENERIC_FAILURE;
    }

    // Shape-check rather than trusting the cast. If the contract ever
    // drifts, fail loudly here instead of rendering `undefined` macros.
    if (!data || typeof data !== "object" || (data as any).ok !== true) {
      console.warn("extractNutritionLabel: unexpected payload", data);
      return GENERIC_FAILURE;
    }

    return data as ExtractSuccess;
  } catch (e: any) {
    console.warn("extractNutritionLabel:", e?.message ?? e);
    return GENERIC_FAILURE;
  }
}

/** Dig our error envelope out of a FunctionsHttpError. */
async function readErrorBody(error: unknown): Promise<ExtractFailure | null> {
  const context = (error as any)?.context;
  if (!context || typeof context.json !== "function") return null;

  try {
    const body = await context.json();
    if (body && body.ok === false && typeof body.error === "string") {
      return {
        ok: false,
        error: body.error as ExtractErrorCode,
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

// ─── Client-side derivation ──────────────────────────────────

/**
 * Scale a per-serving MacroSet to per-100g.
 *
 * Only used for the `needsServingWeight` case: the label printed a
 * per-serving column but no gram weight, so the server couldn't
 * normalise, and we ask the user for the weight instead.
 *
 * Rounding matches the server exactly — if you change one, change both.
 */
const ROUND: Record<MacroKey, number> = {
  cal: 0,
  protein: 1,
  carbs: 1,
  fat: 1,
  satFat: 1,
  salt: 2,
  fibre: 1,
  sugar: 1,
};

export function scaleTo100g(set: MacroSet, servingG: number): MacroSet | null {
  if (!Number.isFinite(servingG) || servingG <= 0) return null;

  const factor = 100 / servingG;
  const out = {} as MacroSet;

  for (const key of MACRO_KEYS) {
    const r = set[key];
    if (r?.value == null) {
      out[key] = { value: null, confidence: "low" };
      continue;
    }
    const f = Math.pow(10, ROUND[key]);
    out[key] = {
      value: Math.round(r.value * factor * f) / f,
      confidence: r.confidence,
    };
  }
  return out;
}

/** MacroSet -> the string map CreateFoodScreen's inputs are bound to. */
export function macroSetToFields(set: MacroSet): Record<MacroKey, string> {
  const out = {} as Record<MacroKey, string>;
  for (const key of MACRO_KEYS) {
    const v = set[key]?.value;
    out[key] = v == null ? "" : String(v);
  }
  return out;
}
