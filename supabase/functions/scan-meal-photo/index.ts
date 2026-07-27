// ============================================================
// supabase/functions/scan-meal-photo/index.ts
//
// Photo of a plated meal in -> best-guess identification + macro estimate
// out. Same pattern as extract-nutrition-label (same model default, same
// client setup, same rate limit, same CORS/json/fail helpers) — the thing
// that changes is the tool schema and the prompt, because this is a
// different task:
//
//   extract-nutrition-label: THE MODEL TRANSCRIBES A PRINTED NUMBER.
//   scan-meal-photo:         THE MODEL ESTIMATES AN UNKNOWN ONE.
//
// There is no ground truth to read off a photo of a plate, so this
// function does NOT pretend otherwise: everything comes back as a single
// portion-level estimate plus one overall confidence band, never a
// per-field "reading" the way the label scanner returns one. The one thing
// that IS still true from that function: THE MODEL ESTIMATES, THE SERVER
// CALCULATES. The model is asked for totals over its own stated portion
// (the natural unit for a human estimating a plate — "this bowl is about
// 600 kcal", not "this food is 120kcal/100g"), and this file derives
// per-100g deterministically by dividing. That's the number ProductScreen
// actually consumes, via the same per-100g convention as every other
// FoodProduct in this app (OFF products, custom foods, label scans).
//
// This function is STATELESS with respect to the meal being logged: it
// never touches meal_entries. It takes bytes and returns an editable
// draft; nothing is written until the user confirms on ProductScreen.
//
// It writes exactly one row, to ai_extractions, for rate limiting and
// quality telemetry — the SAME table extract-nutrition-label uses. That
// means the two features currently share one hourly AI-vision budget per
// user, not two separate ones. That's a deliberate reuse of the existing
// table rather than a migration; if the two ever need independent limits,
// ai_extractions needs a `kind` column and this is the place to add it.
// ============================================================

import { preflight, json, fail } from "../_shared/cors.ts";
import { getCallerId, adminClient } from "../_shared/auth.ts";
import { MACRO_KEYS, type Confidence, type MacroKey } from "../_shared/types.ts";

// ─── Config — identical to extract-nutrition-label ────────────

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Same default as the label scanner. Meal recognition leans harder on
// visual judgement than label OCR does, but Haiku 4.5 is still the right
// starting point — bump via the MODEL secret if real-world plates prove
// harder than expected, no redeploy needed.
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const MAX_EXTRACTIONS_PER_HOUR = 20;
const MAX_BASE64_CHARS = 6_800_000;
const ANTHROPIC_TIMEOUT_MS = 30_000;

// ─── Tool schema — this IS the output contract ───────────────
//
// Forced tool use, same reason as the label scanner: the API validates
// against this schema before it ever reaches us, so "the model replied in
// prose" is not a failure mode we have to handle.

const MACRO_PROPERTIES: Record<MacroKey, Record<string, unknown>> = Object.fromEntries(
  MACRO_KEYS.map((key) => [
    key,
    {
      type: "number",
      description: `Estimated ${key} for the WHOLE portion described in portionGrams — NOT per 100g. Must be a realistic, non-negative number.`,
    },
  ]),
) as Record<MacroKey, Record<string, unknown>>;

const MEAL_SCAN_TOOL = {
  name: "record_meal_estimate",
  description:
    "Record a best-guess identification and nutrition estimate for a photographed plate of food.",
  input_schema: {
    type: "object",
    properties: {
      recognisable: {
        type: "boolean",
        description:
          "false if the image contains no identifiable food, or is too degraded to assess at all. If false, still fill every other field with your best placeholder — they will be discarded.",
      },
      dishName: {
        type: "string",
        description:
          "Your single best-guess name for the dish, specific enough to be useful (e.g. 'chicken katsu curry with rice'), not vague ('Asian food'). Do not guess a brand or restaurant from the plate alone.",
      },
      alternativeNames: {
        type: "array",
        items: { type: "string" },
        description:
          "0 to 2 OTHER plausible names for what this could be, most-plausible first. Return an empty array if you are genuinely confident there is only one reasonable read — do not pad this out.",
      },
      portionGrams: {
        type: "number",
        description:
          "Your single best-guess TOTAL weight of the plated food, in grams. You cannot weigh it — pick the concrete number a dietitian would write down for a plate that looks like this. This is the single most important number you produce: the user sees it and can correct it before anything is saved.",
      },
      portionDescription: {
        type: "string",
        description:
          "Plain-language description of the SAME portion assumption as portionGrams, e.g. '1 regular dinner plate, roughly 380g' or '2 slices, about 120g'. Never vague ('a serving') — always tie it to a concrete size or count.",
      },
      macros: {
        type: "object",
        description:
          "Estimated macro totals for the WHOLE portion described above (portionGrams) — not per 100g. Cover every visible component together (sauce, oil, dressing, rice) — a curry's oil content is invisible on camera but real; account for it rather than only estimating what you can literally see.",
        properties: MACRO_PROPERTIES,
        required: [...MACRO_KEYS],
        additionalProperties: false,
      },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
        description:
          "ONE band covering BOTH the identification and the macro estimate together. high = a common, clearly-plated, unambiguous dish. medium = plausible but could be one of a few similar dishes, or the portion is genuinely hard to judge. low = a real guess — poor lighting, an odd angle, a composite plate with many small components, or packaging/garnish obscuring most of the food.",
      },
    },
    required: [
      "recognisable",
      "dishName",
      "alternativeNames",
      "portionGrams",
      "portionDescription",
      "macros",
      "confidence",
    ],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = `You identify a plated meal from a photograph and estimate its nutrition. You are an experienced dietitian making a considered visual estimate, not a food-recognition API returning a label, and not a nutrition-label scanner with a printed number to read.

Rules, in order of importance:

1. YOU ARE ESTIMATING, NOT MEASURING. There is no barcode and no printed label here — every number you give is an informed guess from what a plate like this typically contains. Report your real uncertainty through the confidence field; do not manufacture false precision.

2. NAME THE DISH, THEN SAY WHAT ELSE IT MIGHT BE. Give your single best-guess name (specific enough to be useful: "chicken katsu curry with rice", not "Asian food"). Then list up to two other plausible reads of the same photo, most-plausible first. If you are genuinely confident there is only one reasonable interpretation, return an empty list rather than padding it out.

3. STATE YOUR PORTION ASSUMPTION EXPLICITLY, IN GRAMS. You cannot weigh the plate, so pick one concrete gram figure a dietitian would use for a plate that looks like this, and say so in plain language. This is the single most important number you produce — everything else is estimated FOR that assumed weight, and the user sees and can correct it before anything is saved. Never leave it vague ("a serving", "some rice") — always a number.

4. ESTIMATE MACROS FOR THE STATED PORTION, NOT PER 100G. Give totals for the plate as assumed in (3), covering every visible component together — a curry's oil content is invisible on camera but real; account for it. Downstream code derives per-100g from your grams figure; do not do that conversion yourself.

5. STAY CONSERVATIVE. Favour typical, home-style portion and recipe assumptions over worst-case restaurant-sized ones, unless the photo clearly shows an unusually large plate. When two dishes are genuinely hard to tell apart, don't split the difference between their nutrition profiles — pick the more likely one as your estimate and name the other as an alternative. If the plate is a mixed or composite dish you cannot confidently decompose, that uncertainty belongs in a "low" confidence, not in an inflated or deflated number.

6. CONFIDENCE COVERS THE WHOLE ESTIMATE. One band for both the identification and the macro numbers together — see the field description for what each level means.

7. If a printed nutrition label happens to be visible in the photo, ignore it — you are estimating the plated meal in front of the camera, not transcribing a label (a separate tool does that).

8. If the image shows no identifiable food, or is too degraded to assess at all, set recognisable to false.`;

// ─── Types coming back from the model ────────────────────────

type RawResult = {
  recognisable: boolean;
  dishName: string;
  alternativeNames: string[];
  portionGrams: number;
  portionDescription: string;
  macros: Record<MacroKey, number>;
  confidence: Confidence;
};

// ─── Response contract — MIRRORED in src/lib/mealRecognition.ts ──
//
// Same boundary reason as _shared/types.ts: Deno and React Native have
// separate module resolution, and sharing one file across it costs more
// than the ~30 lines below are worth. Change one, change the other.

type MacroTotals = Record<MacroKey, number>;

export type MealScanSuccess = {
  ok: true;
  dish: { name: string; alternatives: string[] };
  /** The model's stated assumption. ALWAYS shown to the user, unedited,
   *  before they see a single macro — see (3) in the prompt. */
  portion: { grams: number; description: string };
  /** Per-100g, derived HERE from macros ÷ portionGrams × 100. This is what
   *  the client turns into a FoodProduct — same convention as every other
   *  product source in the app. */
  per100g: MacroTotals;
  /** One band for the whole estimate. Not well calibrated, same caveat as
   *  the label scanner's per-field confidence — a UX hint, not a gate. */
  confidence: Confidence;
  notes: string[];
};

export type MealScanFailure = {
  ok: false;
  error:
    | "unauthorized"
    | "bad_request"
    | "rate_limited"
    | "no_food"
    | "model_error"
    | "server_error";
  message: string;
};

export type MealScanResponse = MealScanSuccess | MealScanFailure;

// ─── Normalisation ───────────────────────────────────────────

/** Per-macro rounding. Matches extract-nutrition-label's precision exactly
 *  — the two features must not disagree on how many decimal places a gram
 *  figure gets. */
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

function round(key: MacroKey, v: number): number {
  const dp = ROUND[key];
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}

/** A macro total the model handed back must be a real, non-negative
 *  number. Unlike the label scanner there is no `null` here — every macro
 *  is required by the schema — so a bad value means the response itself is
 *  broken, not that a value is honestly unknown. */
function isValidMacro(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * Raw tool input -> the wire response, or null if the response is unusable
 * (caller turns that into a model_error, distinct from a clean "no food in
 * this photo" no_food).
 */
function normalise(raw: RawResult): MealScanSuccess | null {
  const name = raw.dishName?.trim();
  if (!name) return null;

  if (!isValidMacro(raw.portionGrams) || raw.portionGrams <= 0) return null;
  const grams = raw.portionGrams;

  for (const key of MACRO_KEYS) {
    if (!isValidMacro(raw.macros?.[key])) return null;
  }

  const macros = {} as MacroTotals;
  const per100g = {} as MacroTotals;
  const factor = 100 / grams;
  for (const key of MACRO_KEYS) {
    macros[key] = round(key, raw.macros[key]);
    per100g[key] = round(key, raw.macros[key] * factor);
  }

  const alternatives = Array.isArray(raw.alternativeNames)
    ? raw.alternativeNames
        .map((a) => (typeof a === "string" ? a.trim() : ""))
        .filter((a) => a.length > 0 && a.toLowerCase() !== name.toLowerCase())
        .slice(0, 2)
    : [];

  const confidence: Confidence = (["high", "medium", "low"] as const).includes(
    raw.confidence,
  )
    ? raw.confidence
    : "low"; // fail safe: an unrecognised value is treated as the least trustworthy

  const notes = [
    "AI estimate from a photo — not a measured value. Check the macros before logging.",
  ];
  if (confidence === "low") {
    notes.push(
      "Low confidence: this dish or portion was hard to judge from the photo.",
    );
  }

  return {
    ok: true,
    dish: { name, alternatives },
    portion: {
      grams,
      description: raw.portionDescription?.trim() || `${Math.round(grams)}g`,
    },
    per100g,
    confidence,
    notes,
  };
}

// ─── Telemetry ───────────────────────────────────────────────

type Outcome = "success" | "no_label" | "model_error" | "rate_limited";

// deno-lint-ignore no-explicit-any
async function logExtraction(
  admin: any,
  row: {
    userId: string;
    outcome: Outcome;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    durationMs?: number;
  },
) {
  // Explicit snake_case mapping — never spread a camelCase object into a
  // Supabase insert.
  const { error } = await admin.from("ai_extractions").insert({
    user_id: row.userId,
    outcome: row.outcome,
    model: row.model ?? null,
    input_tokens: row.inputTokens ?? null,
    output_tokens: row.outputTokens ?? null,
    duration_ms: row.durationMs ?? null,
  });
  if (error) console.error("logExtraction:", error.message);
}

// ─── Handler ─────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== "POST") {
    return fail("bad_request", "Method not allowed.", 405);
  }

  const userId = await getCallerId(req);
  if (!userId) {
    return fail("unauthorized", "Please sign in and try again.", 401);
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set");
    return fail("server_error", "Meal scanning is unavailable.", 500);
  }
  const model = Deno.env.get("MODEL") ?? DEFAULT_MODEL;

  let imageBase64: string;
  let mediaType: string;
  try {
    const body = await req.json();
    imageBase64 = String(body?.imageBase64 ?? "");
    mediaType = String(body?.mediaType ?? "image/jpeg");
  } catch {
    return fail("bad_request", "Couldn't read that request.", 400);
  }

  if (!imageBase64) {
    return fail("bad_request", "No image was sent.", 400);
  }
  if (imageBase64.length > MAX_BASE64_CHARS) {
    return fail(
      "bad_request",
      "That photo is too large. Try taking it again.",
      413,
    );
  }
  if (!["image/jpeg", "image/png", "image/webp"].includes(mediaType)) {
    return fail("bad_request", "That image format isn't supported.", 400);
  }

  const admin = adminClient();

  // Shared bucket with extract-nutrition-label — see the file header.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error: countErr } = await admin
    .from("ai_extractions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .neq("outcome", "rate_limited")
    .gte("created_at", hourAgo);

  if (countErr) {
    // Fail OPEN, same reasoning as the label scanner: a telemetry hiccup
    // shouldn't block someone logging their lunch.
    console.error("rate limit check failed:", countErr.message);
  } else if ((count ?? 0) >= MAX_EXTRACTIONS_PER_HOUR) {
    await logExtraction(admin, { userId, outcome: "rate_limited", model });
    return fail(
      "rate_limited",
      "You've used a lot of AI scans in the last hour. Try again shortly, or add this meal by hand.",
      429,
    );
  }

  const started = Date.now();
  let anthropicJson: {
    content?: Array<{ type: string; name?: string; input?: unknown }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);

    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        // No `temperature` — see extract-nutrition-label for why: Sonnet 5
        // / Opus 4.x reject non-default sampling params outright, and
        // forced tool use gives all the determinism this needs.
        system: SYSTEM_PROMPT,
        tools: [MEAL_SCAN_TOOL],
        tool_choice: { type: "tool", name: MEAL_SCAN_TOOL.name },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType,
                  data: imageBase64,
                },
              },
              {
                type: "text",
                text: "Identify this meal and estimate its nutrition.",
              },
            ],
          },
        ],
      }),
    });

    clearTimeout(timer);

    if (!res.ok) {
      const detail = await res.text();
      console.error(`anthropic ${res.status}:`, detail.slice(0, 500));
      await logExtraction(admin, {
        userId,
        outcome: "model_error",
        model,
        durationMs: Date.now() - started,
      });
      return fail(
        "model_error",
        res.status === 429
          ? "The meal scanner is busy. Try again in a moment."
          : "Couldn't read that photo. Try again, or add it by hand.",
        502,
      );
    }

    anthropicJson = await res.json();
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "AbortError";
    console.error("anthropic call failed:", aborted ? "timeout" : e);
    await logExtraction(admin, {
      userId,
      outcome: "model_error",
      model,
      durationMs: Date.now() - started,
    });
    return fail(
      "model_error",
      aborted
        ? "That took too long. Try again, or add it by hand."
        : "Couldn't read that photo. Try again, or add it by hand.",
      502,
    );
  }

  const durationMs = Date.now() - started;
  const inputTokens = anthropicJson.usage?.input_tokens;
  const outputTokens = anthropicJson.usage?.output_tokens;

  const toolUse = anthropicJson.content?.find(
    (b) => b.type === "tool_use" && b.name === MEAL_SCAN_TOOL.name,
  );

  if (!toolUse?.input) {
    console.error("no tool_use block in response");
    await logExtraction(admin, {
      userId,
      outcome: "model_error",
      model,
      inputTokens,
      outputTokens,
      durationMs,
    });
    return fail("model_error", "Couldn't read that photo. Try again.", 502);
  }

  const raw = toolUse.input as RawResult;

  if (!raw.recognisable) {
    await logExtraction(admin, {
      userId,
      outcome: "no_label",
      model,
      inputTokens,
      outputTokens,
      durationMs,
    });
    return fail(
      "no_food",
      "I couldn't identify any food in that photo. Try again with the plate filling the frame, or add it by hand.",
      422,
    );
  }

  const result = normalise(raw);

  if (!result) {
    await logExtraction(admin, {
      userId,
      outcome: "model_error",
      model,
      inputTokens,
      outputTokens,
      durationMs,
    });
    return fail(
      "model_error",
      "Couldn't produce a usable estimate from that photo. Try again, or add it by hand.",
      502,
    );
  }

  await logExtraction(admin, {
    userId,
    outcome: "success",
    model,
    inputTokens,
    outputTokens,
    durationMs,
  });

  return json(result, 200);
});
