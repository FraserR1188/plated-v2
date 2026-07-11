// ============================================================
// supabase/functions/extract-nutrition-label/index.ts
//
// Photo of a nutrition label in → macros out.
//
// THE CENTRAL DESIGN DECISION:
//   The MODEL TRANSCRIBES. THE SERVER CALCULATES.
//
// LLMs are excellent at reading a number off a photographed table and
// mediocre at arithmetic they were not asked to show. So the model is
// told to report ONLY what is literally printed — including kJ and
// sodium if that is what the pack says — and this file does every
// conversion in TypeScript, where it is deterministic and testable:
//
//   kcal  = kJ / 4.184          (when only kJ is printed)
//   salt  = sodium × 2.5        (when the pack lists sodium)
//   /100g = perServing × 100/g  (when the serving weight is known)
//
// This function is STATELESS with respect to the food being created:
// it never touches custom_foods and never touches Storage. It takes
// bytes and returns numbers. That is what lets extraction happen
// BEFORE the custom_foods row exists.
//
// It writes exactly one row, to ai_extractions, for rate limiting and
// quality telemetry.
// ============================================================

import { preflight, json, fail } from "../_shared/cors.ts";
import { getCallerId, adminClient } from "../_shared/auth.ts";
import {
  MACRO_KEYS,
  type Confidence,
  type ExtractSuccess,
  type MacroKey,
  type MacroSet,
  type Reading,
} from "../_shared/types.ts";

// ─── Config ──────────────────────────────────────────────────

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Haiku 4.5 is the right default: this is a bounded extraction task with
// a forced tool schema, which is exactly what Haiku is for. ~$0.004 a
// scan. Set the MODEL secret to claude-sonnet-5 if real-world labels
// prove harder than expected — no redeploy needed.
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

// You are paying for every one of these. 20/hour is generous for a human
// photographing packets and cheap insurance against a runaway retry loop.
const MAX_EXTRACTIONS_PER_HOUR = 20;

// Anthropic's hard ceiling is 5MB of image bytes. base64 inflates by 4/3,
// so 5MB of bytes ≈ 6.99M base64 chars. We reject a little under that and
// give a clean error rather than passing a doomed request upstream.
const MAX_BASE64_CHARS = 6_800_000;

// A stuck vision call must not hang the capture screen forever.
const ANTHROPIC_TIMEOUT_MS = 30_000;

// ─── Tool schema — this IS the output contract ───────────────
// Forced tool use is how you get structured output reliably. Asking for
// "JSON only" in the prompt works most of the time; a forced tool call
// works every time, because the API validates against this schema before
// it ever reaches us.

const READING_SCHEMA = {
  type: "object",
  properties: {
    value: {
      type: ["number", "null"],
      description:
        "The number exactly as printed. null if absent, illegible, or not shown for this column. NEVER estimate, infer from other values, or guess.",
    },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
      description:
        "high = crisply legible. medium = readable but blurred/angled/partially obscured. low = a genuine guess at the digits.",
    },
  },
  required: ["value", "confidence"],
  additionalProperties: false,
};

const EXTRACTION_TOOL = {
  name: "record_nutrition_label",
  description:
    "Record the values printed in a nutrition information table, exactly as printed.",
  input_schema: {
    type: "object",
    properties: {
      readable: {
        type: "boolean",
        description:
          "false if the image contains no nutrition information table, or it is too degraded to read at all.",
      },
      productName: {
        type: ["string", "null"],
        description:
          "Product name, ONLY if clearly visible in this image. null otherwise. Do not infer it from the nutrient values.",
      },
      columns: {
        type: "array",
        description:
          "One entry per column of figures. UK labels typically print per-100g and per-serving side by side: record BOTH, as separate entries. If only one column exists, return one entry.",
        items: {
          type: "object",
          properties: {
            basis: {
              type: "string",
              enum: ["per_100g", "per_serving"],
              description:
                "What this column is measured per. Column headers say things like 'Per 100g' or 'Per 30g serving'.",
            },
            servingG: {
              type: ["number", "null"],
              description:
                "For a per_serving column: the serving weight IN GRAMS, if the header states it (e.g. 'Per 30g' -> 30). null if the header gives no gram weight. null for per_100g columns.",
            },
            servingLabel: {
              type: ["string", "null"],
              description:
                "Human description of the serving if given, e.g. '1 bowl', '2 biscuits'. null otherwise.",
            },
            energyKcal: READING_SCHEMA,
            energyKj: READING_SCHEMA,
            proteinG: READING_SCHEMA,
            carbsG: READING_SCHEMA,
            sugarG: READING_SCHEMA,
            fatG: READING_SCHEMA,
            satFatG: READING_SCHEMA,
            fibreG: READING_SCHEMA,
            saltG: READING_SCHEMA,
            sodiumG: READING_SCHEMA,
          },
          required: [
            "basis",
            "servingG",
            "servingLabel",
            "energyKcal",
            "energyKj",
            "proteinG",
            "carbsG",
            "sugarG",
            "fatG",
            "satFatG",
            "fibreG",
            "saltG",
            "sodiumG",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["readable", "productName", "columns"],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = `You transcribe nutrition information tables from photographs of food packaging. You are an OCR system with domain knowledge, not a nutritionist.

Rules, in order of importance:

1. TRANSCRIBE, DO NOT CALCULATE. Report only what is literally printed on the label. Never convert kJ to kcal. Never convert sodium to salt. Never scale between per-serving and per-100g. Downstream code does all arithmetic; your conversions would only introduce error.

2. NULL IS A CORRECT ANSWER. If a nutrient is not on the label, report null. Do not derive it, do not estimate it from the other values, and do not fall back on typical values for this kind of food. Fibre is optional on UK labels and is frequently genuinely absent. A null costs the user one tap. A confident wrong number can go unnoticed for months.

3. RECORD EVERY COLUMN. UK labels usually print "per 100g" and "per serving" side by side. Return both as separate entries. Take care not to read a value from the wrong column — check which column each figure sits under.

4. WATCH THE UNITS. Salt and sodium are often printed in grams but sometimes in mg — convert mg to g (divide by 1000) so every gram field is in grams, and ONLY for that. That is the one unit conversion you perform. Energy is usually printed as "1,046kJ / 250kcal": record both.

5. "of which saturates" is saturated fat. "of which sugars" is sugar. Both are sub-lines indented under their parent — do not confuse a sub-line with its parent.

If the image is not a nutrition table, or is too degraded to read, set readable to false and return an empty columns array.`;

// ─── Types coming back from the model ────────────────────────

type RawReading = { value: number | null; confidence: Confidence };

type RawColumn = {
  basis: "per_100g" | "per_serving";
  servingG: number | null;
  servingLabel: string | null;
  energyKcal: RawReading;
  energyKj: RawReading;
  proteinG: RawReading;
  carbsG: RawReading;
  sugarG: RawReading;
  fatG: RawReading;
  satFatG: RawReading;
  fibreG: RawReading;
  saltG: RawReading;
  sodiumG: RawReading;
};

type RawResult = {
  readable: boolean;
  productName: string | null;
  columns: RawColumn[];
};

// ─── Normalisation ───────────────────────────────────────────
// Everything the model was forbidden from doing, done here instead.

const KCAL_PER_KJ = 1 / 4.184;
const SALT_PER_SODIUM = 2.5; // salt (NaCl) = sodium × 2.5, the standard factor

/** Per-macro rounding. Matches the precision the rest of the app stores. */
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

/** Reject NaN, Infinity, and negatives — a negative macro is a misread. */
function clean(v: number | null | undefined): number | null {
  if (v == null) return null;
  if (!Number.isFinite(v) || v < 0) return null;
  return v;
}

const NULL_READING: Reading = { value: null, confidence: "low" };

/**
 * One raw column -> one MacroSet, applying the two unit conversions the
 * model was told not to make. `notes` accumulates a user-visible trail so
 * nobody is surprised by a number that isn't on their packet.
 */
function toMacroSet(col: RawColumn, notes: string[]): MacroSet {
  // Energy: prefer printed kcal; fall back to converting kJ.
  let cal: Reading = NULL_READING;
  const kcal = clean(col.energyKcal?.value);
  const kj = clean(col.energyKj?.value);

  if (kcal != null) {
    cal = { value: round("cal", kcal), confidence: col.energyKcal.confidence };
  } else if (kj != null) {
    cal = {
      value: round("cal", kj * KCAL_PER_KJ),
      // A converted value is no more trustworthy than the reading it came
      // from — never promote confidence during a calculation.
      confidence: col.energyKj.confidence,
    };
    notes.push("Calories calculated from the kJ figure.");
  }

  // Salt: prefer printed salt; fall back to sodium × 2.5.
  let salt: Reading = NULL_READING;
  const saltG = clean(col.saltG?.value);
  const sodiumG = clean(col.sodiumG?.value);

  if (saltG != null) {
    salt = { value: round("salt", saltG), confidence: col.saltG.confidence };
  } else if (sodiumG != null) {
    salt = {
      value: round("salt", sodiumG * SALT_PER_SODIUM),
      confidence: col.sodiumG.confidence,
    };
    notes.push("Salt calculated from the sodium figure.");
  }

  const simple = (key: MacroKey, r: RawReading | undefined): Reading => {
    const v = clean(r?.value);
    if (v == null) return NULL_READING;
    return { value: round(key, v), confidence: r!.confidence };
  };

  return {
    cal,
    salt,
    protein: simple("protein", col.proteinG),
    carbs: simple("carbs", col.carbsG),
    fat: simple("fat", col.fatG),
    satFat: simple("satFat", col.satFatG),
    fibre: simple("fibre", col.fibreG),
    sugar: simple("sugar", col.sugarG),
  };
}

/** Scale a per-serving MacroSet up to per-100g. */
function scaleTo100g(set: MacroSet, servingG: number): MacroSet {
  const factor = 100 / servingG;
  const out = {} as MacroSet;
  for (const key of MACRO_KEYS) {
    const r = set[key];
    out[key] =
      r.value == null
        ? NULL_READING
        : { value: round(key, r.value * factor), confidence: r.confidence };
  }
  return out;
}

/** True if we got nothing usable at all — every single value is null. */
function isEmpty(set: MacroSet): boolean {
  return MACRO_KEYS.every((k) => set[k].value == null);
}

function normalise(raw: RawResult): ExtractSuccess | null {
  const notes: string[] = [];

  const per100Col = raw.columns.find((c) => c.basis === "per_100g");
  const servingCol = raw.columns.find((c) => c.basis === "per_serving");

  let per100g: MacroSet | null = per100Col
    ? toMacroSet(per100Col, notes)
    : null;
  const perServing: MacroSet | null = servingCol
    ? toMacroSet(servingCol, notes)
    : null;

  // A column of all-nulls is not a column.
  if (per100g && isEmpty(per100g)) per100g = null;

  const servingG = clean(servingCol?.servingG ?? null);
  const servingLabel = servingCol?.servingLabel?.trim() || null;

  let per100gDerived = false;
  let needsServingWeight = false;

  if (!per100g && perServing && !isEmpty(perServing)) {
    if (servingG != null && servingG > 0) {
      // Per-serving only, but we know what a serving weighs -> derive.
      per100g = scaleTo100g(perServing, servingG);
      per100gDerived = true;
      notes.push(
        `Per-100g values calculated from the per-serving column (${servingG}g).`,
      );
    } else {
      // Per-serving only, no gram weight. Genuinely cannot normalise —
      // the client asks the user for the weight and derives on device.
      needsServingWeight = true;
    }
  }

  // Nothing usable in any column.
  if (!per100g && !needsServingWeight) return null;

  const name = raw.productName?.trim();

  return {
    ok: true,
    productName: name && name.length > 0 ? name : null,
    per100g,
    per100gDerived,
    perServing,
    servingG,
    servingLabel,
    needsServingWeight,
    // Same conversion can be noted for both columns — dedupe.
    notes: [...new Set(notes)],
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
  // Explicit snake_case mapping. Never spread a camelCase object into a
  // Supabase insert — it silently no-ops the columns that don't match.
  const { error } = await admin.from("ai_extractions").insert({
    user_id: row.userId,
    outcome: row.outcome,
    model: row.model ?? null,
    input_tokens: row.inputTokens ?? null,
    output_tokens: row.outputTokens ?? null,
    duration_ms: row.durationMs ?? null,
  });
  // Telemetry must never break the feature.
  if (error) console.error("logExtraction:", error.message);
}

// ─── Handler ─────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== "POST") {
    return fail("bad_request", "Method not allowed.", 405);
  }

  // 1) Who is calling? verify_jwt already rejected anonymous callers,
  //    but we need the id for the rate limit and the log.
  const userId = await getCallerId(req);
  if (!userId) {
    return fail("unauthorized", "Please sign in and try again.", 401);
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set");
    return fail("server_error", "Label scanning is unavailable.", 500);
  }
  const model = Deno.env.get("MODEL") ?? DEFAULT_MODEL;

  // 2) Body.
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
  // Anthropic accepts JPEG, PNG, GIF and WebP only. The client re-encodes
  // to JPEG, so anything else here means the client is broken (or someone
  // is calling us directly). Reject rather than let Anthropic 400.
  if (!["image/jpeg", "image/png", "image/webp"].includes(mediaType)) {
    return fail("bad_request", "That image format isn't supported.", 400);
  }

  const admin = adminClient();

  // 3) Rate limit. Service-role read: the user cannot see or spoof this.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error: countErr } = await admin
    .from("ai_extractions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", hourAgo);

  if (countErr) {
    // Fail OPEN, deliberately. A telemetry-table hiccup shouldn't stop
    // someone logging their lunch; the ceiling exists to catch runaway
    // loops, not to be a security boundary.
    console.error("rate limit check failed:", countErr.message);
  } else if ((count ?? 0) >= MAX_EXTRACTIONS_PER_HOUR) {
    await logExtraction(admin, { userId, outcome: "rate_limited", model });
    return fail(
      "rate_limited",
      "You've scanned a lot of labels in the last hour. Try again shortly, or enter the values by hand.",
      429,
    );
  }

  // 4) Call the model.
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
        max_tokens: 2048,
        // NOTE: no `temperature`. Sonnet 5 and the Opus 4.x line REJECT
        // non-default sampling parameters with a 400 — a temperature: 0
        // that works fine on Haiku would break the moment you switch the
        // MODEL secret. Forced tool use gives all the determinism we need.
        system: SYSTEM_PROMPT,
        tools: [EXTRACTION_TOOL],
        // Force the tool. Without this the model may reply in prose and
        // the parse below falls over.
        tool_choice: { type: "tool", name: EXTRACTION_TOOL.name },
        messages: [
          {
            role: "user",
            content: [
              // Image BEFORE text: Anthropic's own guidance, and it
              // measurably helps on single-image extraction.
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
                text: "Transcribe the nutrition information table in this photograph. Report only what is printed.",
              },
            ],
          },
        ],
      }),
    });

    clearTimeout(timer);

    if (!res.ok) {
      const detail = await res.text();
      // Server-side only. NEVER return upstream text to the client — an
      // auth error would leak the shape of the key setup.
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
          ? "The label scanner is busy. Try again in a moment."
          : "Couldn't read that label. Try again, or enter the values by hand.",
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
        ? "That took too long. Try again, or enter the values by hand."
        : "Couldn't read that label. Try again, or enter the values by hand.",
      502,
    );
  }

  const durationMs = Date.now() - started;
  const inputTokens = anthropicJson.usage?.input_tokens;
  const outputTokens = anthropicJson.usage?.output_tokens;

  // 5) Pull the tool call out. Find it BY TYPE, never by position — the
  //    content array can carry text blocks alongside the tool_use block.
  const toolUse = anthropicJson.content?.find(
    (b) => b.type === "tool_use" && b.name === EXTRACTION_TOOL.name,
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
    return fail("model_error", "Couldn't read that label. Try again.", 502);
  }

  const raw = toolUse.input as RawResult;

  if (
    !raw.readable ||
    !Array.isArray(raw.columns) ||
    raw.columns.length === 0
  ) {
    await logExtraction(admin, {
      userId,
      outcome: "no_label",
      model,
      inputTokens,
      outputTokens,
      durationMs,
    });
    return fail(
      "no_label",
      "I couldn't find a nutrition table in that photo. Try again with the label filling the frame.",
      422,
    );
  }

  // 6) Convert. Everything the model was forbidden from doing.
  const result = normalise(raw);

  if (!result) {
    await logExtraction(admin, {
      userId,
      outcome: "no_label",
      model,
      inputTokens,
      outputTokens,
      durationMs,
    });
    return fail(
      "no_label",
      "I found a table but couldn't read any values from it. Try again with more light.",
      422,
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
