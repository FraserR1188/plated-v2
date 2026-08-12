// ============================================================
// src/lib/scanRecipe.ts — client wrapper for scan-recipe
//
// Same pattern as mealRecognition.ts:
//   • functions.invoke() attaches the session JWT automatically
//   • non-2xx comes back as a FunctionsHttpError with the JSON body
//     hidden inside error.context, NOT in error.message
//   • the function always answers with { ok: true, ... } or
//     { ok: false, error, message } — the caller switches on the code and
//     shows `message` verbatim
//
// This is a DRAFT SOURCE, same family as photo-scan and copy-a-day: it
// produces candidates for src/lib/ingredients.ts's resolveIngredient() to
// resolve and a human to confirm. It never writes anywhere itself.
// ============================================================

import { supabase } from "./supabase";
import { reportError } from "./reportError";

// ⚠️  MIRROR OF supabase/functions/scan-recipe/index.ts.
//     Deno and RN have separate tsconfigs; sharing one file across that
//     boundary costs more than it saves. Change one, change the other.
//
// Named ScannedIngredientLine, NOT ParsedIngredientLine — ingredients.ts
// already exports a ParsedIngredientLine with a narrower shape (the input
// resolveIngredient() expects), and the confirm screen imports from both
// files, so reusing the name would collide.
export type ScannedIngredientLine = {
  raw: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  estimatedGrams: number | null;
  brandPresent: boolean;
};

export type RecipeScanSuccess = {
  ok: true;
  ingredients: ScannedIngredientLine[];
  servings: number | null;
  yieldText: string | null;
};

export type RecipeScanErrorCode =
  | "unauthorized"
  | "bad_request"
  | "rate_limited"
  | "no_ingredients"
  | "model_error"
  | "server_error"
  | "network_error"; // client-side only: never reached the function

export type RecipeScanFailure = {
  ok: false;
  error: RecipeScanErrorCode;
  message: string;
};

export type RecipeScanResponse = RecipeScanSuccess | RecipeScanFailure;

const FUNCTION_NAME = "scan-recipe";

const GENERIC_FAILURE: RecipeScanFailure = {
  ok: false,
  error: "network_error",
  message:
    "Couldn't reach the recipe scanner. Check your connection, or add ingredients by hand.",
};

/** Send pasted recipe text for parsing into ingredient lines. */
export async function scanRecipeText(text: string): Promise<RecipeScanResponse> {
  return invoke({ mode: "text", text });
}

/**
 * Send a recipe photo (screenshot or a photographed page) for parsing.
 *
 * @param base64 JPEG bytes as base64, no data: URI prefix. MUST have been
 *               through prepareImage(source, "recipe") — the function
 *               trusts the declared media type.
 */
export async function scanRecipeImage(
  base64: string,
  mediaType: string,
): Promise<RecipeScanResponse> {
  return invoke({ mode: "image", imageBase64: base64, mediaType });
}

async function invoke(body: Record<string, unknown>): Promise<RecipeScanResponse> {
  try {
    const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, { body });

    if (error) {
      const parsed = await readErrorBody(error);
      if (parsed) return parsed;

      console.warn("scanRecipe:", error.message);
      return GENERIC_FAILURE;
    }

    if (!isRecipeScanSuccessShape(data)) {
      console.warn("scanRecipe: unexpected payload", Object.keys(data ?? {}));
      reportError("scanRecipe:unexpected_payload", new Error("unexpected_payload"));
      return GENERIC_FAILURE;
    }

    return data;
  } catch (e: any) {
    console.warn("scanRecipe:", e?.message ?? e);
    return GENERIC_FAILURE;
  }
}

/** Dig our error envelope out of a FunctionsHttpError. */
async function readErrorBody(error: unknown): Promise<RecipeScanFailure | null> {
  const context = (error as any)?.context;
  if (!context || typeof context.json !== "function") return null;

  try {
    const body = await context.json();
    if (body && body.ok === false && typeof body.error === "string") {
      return {
        ok: false,
        error: body.error as RecipeScanErrorCode,
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
 * Shape-check rather than trusting a cast. A malformed or truncated
 * response must fail loudly here — as GENERIC_FAILURE — instead of handing
 * the confirm screen an ingredients array full of `undefined`.
 */
function isRecipeScanSuccessShape(data: unknown): data is RecipeScanSuccess {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (d.ok !== true) return false;
  if (!Array.isArray(d.ingredients)) return false;
  if (!d.ingredients.every(isScannedIngredientLineShape)) return false;
  if (d.servings !== null && typeof d.servings !== "number") return false;
  if (d.yieldText !== null && typeof d.yieldText !== "string") return false;
  return true;
}

function isScannedIngredientLineShape(v: unknown): v is ScannedIngredientLine {
  if (!v || typeof v !== "object") return false;
  const l = v as Record<string, unknown>;
  if (typeof l.raw !== "string" || typeof l.name !== "string") return false;
  if (l.quantity !== null && typeof l.quantity !== "number") return false;
  if (l.unit !== null && typeof l.unit !== "string") return false;
  if (l.estimatedGrams !== null && typeof l.estimatedGrams !== "number") return false;
  if (typeof l.brandPresent !== "boolean") return false;
  return true;
}
