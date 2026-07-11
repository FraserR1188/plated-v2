// ============================================================
// supabase/functions/_shared/types.ts
//
// THE WIRE CONTRACT between the Edge Function and the app.
//
// ⚠️  This file is MIRRORED in src/lib/labelExtraction.ts.
//     Deno and React Native have separate tsconfigs and separate module
//     resolution; sharing one file across the boundary means either a
//     path alias that breaks `deno check`, or a build step. Not worth it
//     for ~40 lines. If you change anything here, change it there too.
//
// Field names are camelCase and match CreateFoodScreen's MacroKey union
// EXACTLY, so the screen can prefill without a mapping layer. (The
// snake_case rule is about Supabase inserts, not HTTP payloads.)
// ============================================================

// ─── Request ─────────────────────────────────────────────────

export type ExtractRequest = {
  /** Raw base64, no data: URI prefix. */
  imageBase64: string;
  /** Always image/jpeg — the client re-encodes before sending. */
  mediaType: "image/jpeg" | "image/png" | "image/webp";
};

// ─── Macros ──────────────────────────────────────────────────

/** Matches CreateFoodScreen's MacroKey. Do not diverge. */
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
 * `confidence` is the MODEL'S OWN self-report. It is a UX hint — we tint
 * low-confidence cells so the user's eye lands on them. It is never a
 * gate, and it is not well calibrated. `value: null` ("I could not read
 * this") is the signal you can actually trust.
 */
export type Confidence = "high" | "medium" | "low";

export type Reading = {
  value: number | null;
  confidence: Confidence;
};

export type MacroSet = Record<MacroKey, Reading>;

// ─── Response ────────────────────────────────────────────────

export type ExtractSuccess = {
  ok: true;

  productName: string | null;

  /** Per-100g values. Present if PRINTED, or DERIVED from a per-serving
   *  column when the serving weight in grams is known. */
  per100g: MacroSet | null;
  /** True when per100g was computed rather than read off the label. */
  per100gDerived: boolean;

  /** The per-serving column, if the label printed one. Shown for
   *  verification only — the macro grid is per-100g. */
  perServing: MacroSet | null;

  servingG: number | null;
  servingLabel: string | null;

  /** Label had ONLY a per-serving column and no gram weight, so we
   *  cannot normalise. The UI asks the user for the weight. */
  needsServingWeight: boolean;

  /** Human-readable trail of what the SERVER computed, e.g.
   *  "Energy converted from kJ". Show these — they are how the user
   *  knows a number wasn't printed on the pack. */
  notes: string[];
};

export type ExtractFailure = {
  ok: false;
  /** Machine-readable. Client switches on this. */
  error:
    | "unauthorized"
    | "bad_request"
    | "rate_limited"
    | "no_label"
    | "model_error"
    | "server_error";
  /** Safe to show the user verbatim. */
  message: string;
};

export type ExtractResponse = ExtractSuccess | ExtractFailure;
