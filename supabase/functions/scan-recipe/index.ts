// ============================================================
// supabase/functions/scan-recipe/index.ts
//
// A recipe in (pasted text OR a photo of a page) -> structured ingredient
// lines out. Same family as scan-meal-photo / extract-nutrition-label: same
// model default, same client setup, same rate limit, same CORS/json/fail
// helpers. What's different is the tool schema, the prompt, and that this
// function accepts TWO input shapes instead of one:
//
//   { mode: "text",  text: string }
//   { mode: "image", imageBase64: string, mediaType: string }
//
// One tool, one schema, one system prompt — only the `messages` content
// block differs between the two modes (image+text vs text-only), the same
// way scan-meal-photo's optional user_dish_label branch only changes the
// text block, not the schema.
//
// THE CENTRAL DESIGN DECISION, same family as the other two scanners:
//   THE MODEL TRANSCRIBES AND ROUGHLY ESTIMATES. THE CLIENT DECIDES.
// This function does NOT look anything up in Open Food Facts or the
// core_ingredients staple table, and does NOT compute final macros or
// grams. `estimatedGrams` here is a rough fallback only — the client's
// resolveIngredient() (src/lib/ingredients.ts) is authoritative and
// overrides it whenever it has a better answer. Nothing this function
// returns is a logged fact; it is a draft for a human to confirm.
//
// This function is STATELESS with respect to the batch being built: it
// never touches batch_compositions or meal_entries. It writes exactly one
// row, to ai_extractions (shared bucket/budget with the other two AI
// scanners — see their header comments for why that's a deliberate reuse,
// not an oversight).
//
// DEPLOY GOTCHAS (bake these in, they've bitten before):
//   - `supabase functions deploy` does NOT type-check. Always run
//     `npm run check:functions` (deno check) before deploying — a type
//     error otherwise deploys silently and fails at runtime instead.
//   - `npx supabase functions logs` does not exist in CLI 2.x. Logs are
//     dashboard-only.
//   - On the client, functions.invoke()'s real error JSON lives on
//     error.context, not error.message — see src/lib/scanRecipe.ts's
//     readErrorBody().
// ============================================================

import { preflight, json, fail } from "../_shared/cors.ts";
import { getCallerId, adminClient } from "../_shared/auth.ts";

// ─── Config — identical to the other two scanners ─────────────

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Same default as the label scanner and meal scanner. Recipe parsing is a
// bounded extraction task with a forced tool schema — exactly what Haiku is
// for. Bump via the MODEL secret if real-world recipes prove harder than
// expected, no redeploy needed.
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const MAX_EXTRACTIONS_PER_HOUR = 20;

// Anthropic's hard ceiling is 5MB of image bytes; base64 inflates by 4/3.
// Same constant as the other two vision scanners.
const MAX_BASE64_CHARS = 6_800_000;

// A pasted recipe has no comparable hard limit, but an unbounded body is
// still a bad idea (cost, latency, someone pasting a whole cookbook). 20,000
// chars is generous for any single recipe's ingredient list + method.
const MAX_TEXT_CHARS = 20_000;

const ANTHROPIC_TIMEOUT_MS = 30_000;

// ─── Tool schema — this IS the output contract ───────────────
//
// Forced tool use, same reason as the other scanners: the API validates
// against this schema before it ever reaches us.
//
// quantity/unit/estimatedGrams use `type: ["number","null"]` / `["string",
// "null"]` — the extract-nutrition-label pattern, not scan-meal-photo's
// all-required-numbers one — because these are legitimately absent on a
// line like "salt to taste" or "a pinch of pepper". Forcing a fabricated
// number there would be worse than admitting there isn't one.

const INGREDIENT_LINE_SCHEMA = {
  type: "object",
  properties: {
    raw: {
      type: "string",
      description:
        "The ingredient line exactly as it appeared in the source, verbatim, including quantity and unit. This is shown to the user next to your parsed fields so they can catch a transcription mistake — do not clean it up or paraphrase it.",
    },
    name: {
      type: "string",
      description:
        "The ingredient name only, with quantity/unit/brand pulled out into their own fields. E.g. '2 large eggs' -> 'eggs'; 'Heinz baked beans, 1 tin' -> 'baked beans'.",
    },
    quantity: {
      type: ["number", "null"],
      description:
        "The numeric quantity, e.g. 2 for '2 large eggs'. null if the line has no quantity ('salt to taste').",
    },
    unit: {
      type: ["string", "null"],
      description:
        "The unit as written, lowercased ('g', 'kg', 'ml', 'tbsp', 'tsp', 'cup', 'large', 'medium', 'clove', 'slice', 'tin', etc). null if the line has no unit or is a bare count noun with nothing after the number.",
    },
    estimatedGrams: {
      type: ["number", "null"],
      description:
        "Your OWN rough best-guess total weight in grams for this line, purely as a fallback — the app has its own authoritative gram-conversion table and will normally override this. null if you have no reasonable basis to guess (e.g. 'salt to taste').",
    },
    brandPresent: {
      type: "boolean",
      description:
        "true ONLY if the line names an actual brand or specific commercial product (e.g. 'Heinz baked beans', 'Philadelphia cream cheese'). false for a generic ingredient, even a specific variety ('self-raising flour', 'Heinz' is a brand, 'self-raising' is not).",
    },
  },
  required: ["raw", "name", "quantity", "unit", "estimatedGrams", "brandPresent"],
  additionalProperties: false,
};

const RECIPE_SCAN_TOOL = {
  name: "record_recipe_scan",
  description:
    "Record the parsed ingredient lines, servings, and yield from a recipe.",
  input_schema: {
    type: "object",
    properties: {
      readable: {
        type: "boolean",
        description:
          "false if the input contains no discernible recipe or ingredient list, or (for an image) is too degraded to read at all. If false, still return an empty ingredients array and null servings/yieldText.",
      },
      ingredients: {
        type: "array",
        description:
          "One entry per ingredient line, in the order they appeared. Skip section headers ('For the sauce:'), method/instruction steps, and blank lines — only actual ingredient lines.",
        items: INGREDIENT_LINE_SCHEMA,
      },
      servings: {
        type: ["number", "null"],
        description:
          "The number of servings/portions this recipe makes, parsed from a phrase like 'serves 4' or 'makes 6 portions'. null if not stated anywhere.",
      },
      yieldText: {
        type: ["string", "null"],
        description:
          "The yield phrase as written, e.g. 'makes 12 muffins' or 'serves 4-6'. null if the recipe states no yield/serving info at all.",
      },
    },
    required: ["readable", "ingredients", "servings", "yieldText"],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = `You parse a recipe (from pasted text or a photo of a page) into a structured ingredient list. You are transcribing and lightly estimating, not cooking or judging the recipe.

Rules, in order of importance:

1. ONE ENTRY PER INGREDIENT LINE, VERBATIM IN "raw". Copy the ingredient line exactly as it appears before you touch it — this is the user's only way to catch a transcription mistake later, so it must be a faithful copy, not a cleaned-up paraphrase. Skip section headers ("For the sauce:"), method/instruction steps, and blank lines.

2. SPLIT QUANTITY, UNIT, AND NAME CLEANLY. "2 large eggs" -> quantity 2, unit "large", name "eggs". "3 tbsp olive oil" -> quantity 3, unit "tbsp", name "olive oil". "Salt, to taste" -> quantity null, unit null, name "salt". Never fold the quantity or unit back into the name.

3. brandPresent IS TRUE ONLY FOR AN ACTUAL BRAND OR COMMERCIAL PRODUCT NAME, never for a variety, cut, or preparation ("self-raising flour", "chicken thighs", "wholemeal bread" are all false — "Heinz baked beans", "Philadelphia" are true).

4. estimatedGrams IS YOUR OWN ROUGH FALLBACK GUESS ONLY. The app has its own authoritative unit-to-grams conversion and will normally override this — do not agonize over precision, a reasonable ballpark is enough. Use null when you have no reasonable basis to guess at all (e.g. "salt to taste", "a pinch of pepper").

5. PARSE SERVINGS AND YIELD IF STATED. Look for a phrase like "serves 4", "makes 12 muffins", "yields 2 loaves" anywhere in the input. servings is the number alone; yieldText is the phrase as written. Both null if nothing like this is stated.

6. DO NOT DO ANYONE ELSE'S JOB. Do not look up or estimate final per-100g macros, do not try to match ingredients to specific products or brands, and do not attempt any nutrition calculation — none of that is your job here, it happens downstream from what you return.

7. If the input contains no discernible recipe or ingredient list, or (for a photo) is too degraded to read at all, set readable to false and return an empty ingredients array.`;

// ─── Response contract — MIRRORED in src/lib/scanRecipe.ts ──────
//
// Same boundary reason as the other two scanners: Deno and React Native
// have separate module resolution, and sharing one file across it costs
// more than the ~20 lines below are worth. Change one, change the other.

type RawIngredientLine = {
  raw: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  estimatedGrams: number | null;
  brandPresent: boolean;
};

type RawResult = {
  readable: boolean;
  ingredients: RawIngredientLine[];
  servings: number | null;
  yieldText: string | null;
};

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

export type RecipeScanFailure = {
  ok: false;
  error:
    | "unauthorized"
    | "bad_request"
    | "rate_limited"
    | "no_ingredients"
    | "model_error"
    | "server_error";
  message: string;
};

export type RecipeScanResponse = RecipeScanSuccess | RecipeScanFailure;

// ─── Normalisation ───────────────────────────────────────────

function isValidLine(v: unknown): v is RawIngredientLine {
  if (!v || typeof v !== "object") return false;
  const l = v as Record<string, unknown>;
  if (typeof l.raw !== "string" || typeof l.name !== "string") return false;
  if (!l.name.trim()) return false;
  if (l.quantity !== null && typeof l.quantity !== "number") return false;
  if (l.unit !== null && typeof l.unit !== "string") return false;
  if (l.estimatedGrams !== null && typeof l.estimatedGrams !== "number") return false;
  if (typeof l.brandPresent !== "boolean") return false;
  return true;
}

/**
 * Raw tool input -> the wire response, or null if the response is unusable
 * (caller turns that into a model_error, distinct from a clean "no
 * ingredients found" no_ingredients).
 */
function normalise(raw: RawResult): RecipeScanSuccess | null {
  if (!Array.isArray(raw.ingredients)) return null;

  const ingredients: ScannedIngredientLine[] = [];
  for (const line of raw.ingredients) {
    if (!isValidLine(line)) continue; // drop a malformed single line rather than fail the whole scan
    ingredients.push({
      raw: line.raw,
      name: line.name.trim(),
      quantity:
        line.quantity != null && Number.isFinite(line.quantity) && line.quantity > 0
          ? line.quantity
          : null,
      unit: line.unit?.trim().toLowerCase() || null,
      estimatedGrams:
        line.estimatedGrams != null && Number.isFinite(line.estimatedGrams) && line.estimatedGrams > 0
          ? line.estimatedGrams
          : null,
      brandPresent: line.brandPresent,
    });
  }

  const servings =
    raw.servings != null && Number.isFinite(raw.servings) && raw.servings > 0
      ? raw.servings
      : null;
  const yieldText =
    typeof raw.yieldText === "string" && raw.yieldText.trim() ? raw.yieldText.trim() : null;

  return { ok: true, ingredients, servings, yieldText };
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
    return fail("server_error", "Recipe scanning is unavailable.", 500);
  }
  const model = Deno.env.get("MODEL") ?? DEFAULT_MODEL;

  let mode: string;
  let text: string | undefined;
  let imageBase64: string | undefined;
  let mediaType: string | undefined;
  try {
    const body = await req.json();
    mode = String(body?.mode ?? "");
    if (mode === "text") {
      text = String(body?.text ?? "");
    } else if (mode === "image") {
      imageBase64 = String(body?.imageBase64 ?? "");
      mediaType = String(body?.mediaType ?? "image/jpeg");
    }
  } catch {
    return fail("bad_request", "Couldn't read that request.", 400);
  }

  let userContent: Array<Record<string, unknown>>;

  if (mode === "text") {
    const trimmed = (text ?? "").trim();
    if (!trimmed) {
      return fail("bad_request", "No recipe text was sent.", 400);
    }
    if (trimmed.length > MAX_TEXT_CHARS) {
      return fail("bad_request", "That recipe is too long. Try pasting just the ingredients.", 413);
    }
    userContent = [
      { type: "text", text: `Parse this recipe:\n\n${trimmed}` },
    ];
  } else if (mode === "image") {
    if (!imageBase64) {
      return fail("bad_request", "No image was sent.", 400);
    }
    if (imageBase64.length > MAX_BASE64_CHARS) {
      return fail("bad_request", "That photo is too large. Try taking it again.", 413);
    }
    if (!["image/jpeg", "image/png", "image/webp"].includes(mediaType ?? "")) {
      return fail("bad_request", "That image format isn't supported.", 400);
    }
    userContent = [
      {
        type: "image",
        source: { type: "base64", media_type: mediaType, data: imageBase64 },
      },
      { type: "text", text: "Parse the recipe shown in this photo." },
    ];
  } else {
    return fail("bad_request", "Unknown scan mode.", 400);
  }

  const admin = adminClient();

  // Shared bucket with the other two AI scanners — see the file header.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error: countErr } = await admin
    .from("ai_extractions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .neq("outcome", "rate_limited")
    .gte("created_at", hourAgo);

  if (countErr) {
    // Fail OPEN, same reasoning as the other scanners: a telemetry hiccup
    // shouldn't block someone scanning a recipe.
    console.error("rate limit check failed:", countErr.message);
  } else if ((count ?? 0) >= MAX_EXTRACTIONS_PER_HOUR) {
    await logExtraction(admin, { userId, outcome: "rate_limited", model });
    return fail(
      "rate_limited",
      "You've used a lot of AI scans in the last hour. Try again shortly, or add ingredients by hand.",
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
        max_tokens: 4096,
        // No `temperature` — see the other scanners for why: Sonnet 5 /
        // Opus 4.x reject non-default sampling params outright, and forced
        // tool use already gives all the determinism this needs.
        system: SYSTEM_PROMPT,
        tools: [RECIPE_SCAN_TOOL],
        tool_choice: { type: "tool", name: RECIPE_SCAN_TOOL.name },
        messages: [{ role: "user", content: userContent }],
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
          ? "The recipe scanner is busy. Try again in a moment."
          : "Couldn't read that recipe. Try again, or add ingredients by hand.",
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
        ? "That took too long. Try again, or add ingredients by hand."
        : "Couldn't read that recipe. Try again, or add ingredients by hand.",
      502,
    );
  }

  const durationMs = Date.now() - started;
  const inputTokens = anthropicJson.usage?.input_tokens;
  const outputTokens = anthropicJson.usage?.output_tokens;

  const toolUse = anthropicJson.content?.find(
    (b) => b.type === "tool_use" && b.name === RECIPE_SCAN_TOOL.name,
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
    return fail("model_error", "Couldn't read that recipe. Try again.", 502);
  }

  const raw = toolUse.input as RawResult;

  if (!raw.readable || !Array.isArray(raw.ingredients) || raw.ingredients.length === 0) {
    await logExtraction(admin, {
      userId,
      outcome: "no_label",
      model,
      inputTokens,
      outputTokens,
      durationMs,
    });
    return fail(
      "no_ingredients",
      "I couldn't find any ingredients in that recipe. Try again, or add them by hand.",
      422,
    );
  }

  const result = normalise(raw);

  if (!result || result.ingredients.length === 0) {
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
      "Couldn't produce a usable ingredient list. Try again, or add them by hand.",
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
