// ============================================================
// src/lib/ingredients.ts — recipe scanner ingredient resolver
//
// Turns one parsed recipe line ("2 large eggs", "1 tbsp olive oil") into
// ranked candidates for a human to confirm. This is a DRAFT SOURCE, same
// family as copy-a-day / bundles / photo scan: it produces candidates, a
// human confirms, the result becomes an EntryDraft via applyEntries(). It
// NEVER sets date or planned, and it never writes anywhere itself.
//
// OUTPUT SHAPE — deliberately FoodProduct, not a bespoke wrapper type.
// BatchIngredientPickerScreen already has the full "search -> pick ->
// confirm quantity in grams" flow built around FoodProduct: startPicking()
// prefills the quantity field from product.serving_g, and confirming calls
// useStore's addBatchIngredient(product, quantityG) — see that screen and
// useStore.ts's BatchDraft comment (addBatchIngredient(s) replaced an
// onPick callback threaded through navigation params, which React
// Navigation warned about; the FoodProduct shape itself is unaffected by
// that change). A resolved candidate's `product.serving_g` is set to the
// estimated grams for exactly that reason: a future recipe-scan screen can
// call startPicking(candidate.product) UNCHANGED and the quantity field
// prefills itself, the same way a search hit or barcode scan does today.
// ResolvedCandidate is a thin sidecar carrying what FoodProduct has no
// field for — confidence and provenance — not a replacement for it.
//
// ⚠ KNOWN SCHEMA MISMATCH — see stapleToProduct()'s comment. core_ingredients
// (migration 20260808140000) makes ALL EIGHT macros nullable, but FoodProduct
// /EntryDraft/meal_entries have only ever treated satFat/salt/fibre/sugar as
// nullable — cal/protein/carbs/fat are NOT NULL everywhere else in this app.
// A staple missing any of the required four cannot become a valid FoodProduct
// without either lying (coalescing to 0, the exact bug this project keeps
// fixing) or widening a type that's load-bearing in a lot of other places.
// This resolver takes the narrow way out: such a staple is skipped, not
// offered, and the ingredient falls through to the OFF tiers instead.
// ============================================================

import { searchFood, singularise } from "./openfoodfacts";
import { supabase } from "./supabase";
import type { FoodProduct } from "../types";
import { reportError } from "./reportError";

// ─── Types ───────────────────────────────────────────────────

export type ResolvedSource = "staple" | "off-generic" | "off-branded";
export type GramsConfidence = "exact" | "estimated" | "unknown";

/** One parsed line from the (separate, not-yet-built) recipe scanner LLM. */
export interface ParsedIngredientLine {
  name: string;
  quantity?: number;
  unit?: string;
  /** True when the parsed name names a specific product/brand, not a
   *  generic ingredient — e.g. "Heinz baked beans" vs "baked beans". */
  brandPresent: boolean;
}

export interface ResolvedCandidate {
  product: FoodProduct;
  estimatedGrams: number | null;
  gramsConfidence: GramsConfidence;
  source: ResolvedSource;
  /** Exactly one candidate in a resolveIngredient() result has this true. */
  preselected: boolean;
}

/** Mirrors the core_ingredients columns this file reads. */
export interface StapleRow {
  slug: string;
  display_name: string;
  aliases: string[];
  kcal_100g: number | null;
  protein_100g: number | null;
  carbs_100g: number | null;
  fat_100g: number | null;
  satfat_100g: number | null;
  sugar_100g: number | null;
  fibre_100g: number | null;
  salt_100g: number | null;
  unit_grams: Record<string, number>;
  density_g_per_ml: number | null;
}

// ─── Grams estimation ───────────────────────────────────────
//
// CONFIDENCE RULE: only a true mass unit (g/kg/oz/lb) is 'exact'. A
// unit_grams hit (an egg counted as "large", a spoon of oil) and a
// density-derived volume are BOTH 'estimated' — unit_grams values are
// human-seeded averages, not a measurement of the ingredient in front of
// this user, and deserve the same "check this" treatment as a volume
// conversion. Only a real scale reading (grams themselves) earns 'exact'.

const MASS_G: Record<string, number> = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };
const VOLUME_ML: Record<string, number> = { tsp: 5, tbsp: 15, cup: 240, ml: 1 };
// NOTE: cup/tbsp are region-dependent (US cup 240 vs UK ~250, AU tbsp 20).
// Volume always resolves 'estimated', not 'exact' — see the rule above.

export function estimateGrams(
  qty: number | undefined,
  unit: string | undefined,
  staple?: Pick<StapleRow, "unit_grams" | "density_g_per_ml"> | null,
): { grams: number | null; confidence: GramsConfidence } {
  if (qty == null || !Number.isFinite(qty)) return { grams: null, confidence: "unknown" };

  const u = (unit ?? "").toLowerCase().trim();

  if (u in MASS_G) return { grams: qty * MASS_G[u], confidence: "exact" };

  if (staple?.unit_grams?.[u] != null) {
    return { grams: qty * staple.unit_grams[u], confidence: "estimated" };
  }

  if (u in VOLUME_ML && staple?.density_g_per_ml != null) {
    return { grams: qty * VOLUME_ML[u] * staple.density_g_per_ml, confidence: "estimated" };
  }

  // 'pinch', 'dash', 'to taste', an unrecognised count-word with no staple
  // hit — all deliberately fall through here. Forcing a human weight beats
  // guessing.
  return { grams: null, confidence: "unknown" };
}

// ─── Name normalisation ─────────────────────────────────────
//
// Conservative on purpose. Only strips words that change nothing about
// WHICH FOOD this is — prep state and portion-size adjectives. Words that
// change the food's identity (and therefore its macros) are deliberately
// NOT stripped: "plain" vs "self-raising" flour, "white" vs "wholemeal",
// "skimmed" vs "whole" milk, "raw" vs "cooked" are all different foods with
// different per-100g rates, not noise around one food's name.

const STRIP_WORDS = new Set([
  "a", "an", "the", "of",
  "fresh", "chopped", "diced", "sliced", "minced", "grated", "peeled",
  "crushed", "crumbled",
  "large", "medium", "small", "extra", "ripe",
]);

export function normalizeIngredientName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    // Defensive: the parser SHOULD already separate quantity from name, but
    // a stray leading "2" surviving into the name string must not stop this
    // from matching "onion" — silently useless is worse than silently lenient.
    .filter((w) => !/^\d+$/.test(w))
    .filter((w) => !STRIP_WORDS.has(w))
    .map(singularise)
    .join(" ")
    .trim();
}

// ─── Staple -> FoodProduct ───────────────────────────────────

/**
 * null when kcal/protein/carbs/fat aren't ALL known — see the file header's
 * schema-mismatch note. Never coalesces a missing required macro to 0.
 */
function stapleToProduct(staple: StapleRow): FoodProduct | null {
  const { kcal_100g, protein_100g, carbs_100g, fat_100g } = staple;
  if (kcal_100g == null || protein_100g == null || carbs_100g == null || fat_100g == null) {
    return null;
  }
  return {
    name: staple.display_name,
    brand: "",
    cal_per100: kcal_100g,
    protein_per100: protein_100g,
    carbs_per100: carbs_100g,
    fat_per100: fat_100g,
    sat_fat_per100: staple.satfat_100g ?? undefined,
    salt_per100: staple.salt_100g ?? undefined,
    fibre_per100: staple.fibre_100g ?? undefined,
    sugar_per100: staple.sugar_100g ?? undefined,
  };
}

// ─── Resolver ────────────────────────────────────────────────

export interface ResolveDeps {
  lookupStaple: (normalizedName: string) => Promise<StapleRow | null>;
  offSearch: typeof searchFood;
}

const OFF_SECONDARY_COUNT = 3;

function candidateFromOff(product: FoodProduct, preselected: boolean): ResolvedCandidate {
  return {
    product,
    estimatedGrams: product.serving_g ?? null,
    gramsConfidence: product.serving_g != null ? "estimated" : "unknown",
    source: "off-generic",
    preselected,
  };
}

export async function resolveIngredient(
  parsed: ParsedIngredientLine,
  deps: ResolveDeps,
): Promise<ResolvedCandidate[]> {
  // ── Tier 1: a named brand/product. Trust OFF's own top-ranked result —
  // there is no staple concept of "brand", so core_ingredients isn't
  // consulted at all in this tier.
  if (parsed.brandPresent) {
    const results = await deps.offSearch(parsed.name);
    if (results.length === 0) return [];
    const [top, ...rest] = results;
    const { grams, confidence } = estimateGrams(parsed.quantity, parsed.unit, null);
    return [
      {
        product: withServingG(top, grams),
        estimatedGrams: grams,
        gramsConfidence: confidence,
        source: "off-branded",
        preselected: true,
      },
      ...rest.slice(0, OFF_SECONDARY_COUNT).map((p) => candidateFromOff(p, false)),
    ];
  }

  // ── No brand: try the staple table first.
  const normalized = normalizeIngredientName(parsed.name);
  const staple = normalized ? await deps.lookupStaple(normalized) : null;
  const stapleProduct = staple ? stapleToProduct(staple) : null;

  if (stapleProduct) {
    // ── Tier 2: staple hit. Primary = staple, preselected. OFF generics
    // ride along as secondaries so the user can override the pick.
    const { grams, confidence } = estimateGrams(parsed.quantity, parsed.unit, staple);
    const primary: ResolvedCandidate = {
      product: withServingG(stapleProduct, grams),
      estimatedGrams: grams,
      gramsConfidence: confidence,
      source: "staple",
      preselected: true,
    };

    let secondaries: ResolvedCandidate[] = [];
    try {
      const offResults = await deps.offSearch(parsed.name);
      secondaries = offResults.slice(0, OFF_SECONDARY_COUNT).map((p) => candidateFromOff(p, false));
    } catch {
      // A failed OFF search must not cost the user the staple hit they
      // already have — secondaries are a nice-to-have, not load-bearing.
      console.warn("resolveIngredient: OFF secondary search failed");
    }

    return [primary, ...secondaries];
  }

  // ── Tier 3: no brand, no staple. OFF generic fallback, top result
  // preselected.
  const results = await deps.offSearch(parsed.name);
  if (results.length === 0) return [];
  const [top, ...rest] = results;
  const { grams, confidence } = estimateGrams(parsed.quantity, parsed.unit, null);
  return [
    {
      product: withServingG(top, grams),
      estimatedGrams: grams,
      gramsConfidence: confidence,
      source: "off-generic",
      preselected: true,
    },
    ...rest.slice(0, OFF_SECONDARY_COUNT).map((p) => candidateFromOff(p, false)),
  ];
}

// ─── Default staple lookup (production dependency) ──────────
//
// The real ResolveDeps.lookupStaple for app code — a caller wires this in
// rather than resolveIngredient() importing supabase itself, so the resolver
// stays testable with a fake in memory (see the test file). normalizedName
// has already been through normalizeIngredientName(), so it's lowercase
// words/hyphens/spaces only — safe to interpolate into a PostgREST `.or()`
// filter without a comma or parenthesis ever showing up in it.
//
// Tries, in order: exact slug, exact alias, exact display-name match. No
// fuzzy/trigram fallback yet — core_ingredients_name_trgm (the migration's
// index) is there for a future "did you mean" pass, not wired up here.
export async function lookupStapleFromDb(normalizedName: string): Promise<StapleRow | null> {
  if (!normalizedName) return null;
  const slug = normalizedName.replace(/\s+/g, "-");

  const { data, error } = await supabase
    .from("core_ingredients")
    .select(
      "slug, display_name, aliases, kcal_100g, protein_100g, carbs_100g, fat_100g, " +
        "satfat_100g, sugar_100g, fibre_100g, salt_100g, unit_grams, density_g_per_ml",
    )
    .or(`slug.eq.${slug},aliases.cs.{${normalizedName}},display_name.ilike.${normalizedName}`)
    .limit(1)
    .maybeSingle();

  if (error) {
    reportError("lookupStapleFromDb", error);
    return null;
  }
  return (data as StapleRow | null) ?? null;
}

/** Sets product.serving_g to the resolver's own grams estimate when known,
 *  so a caller can hand the product straight to startPicking() and get the
 *  right quantity prefilled — see the file header. Leaves the OFF product's
 *  own serving_g alone when the parsed line gave us nothing to estimate from. */
function withServingG(product: FoodProduct, grams: number | null): FoodProduct {
  return grams != null ? { ...product, serving_g: grams } : product;
}

// ─── Recipe-scan confirm row grams precedence ────────────────
//
// The recipe-scan confirm screen has TWO independent grams opinions for a
// line: the resolved candidate's (from THIS file's own estimateGrams/staple
// logic) and the scanner LLM's own rough estimatedGrams fallback (see
// scan-recipe's header — that field exists purely for when the resolver has
// nothing). This function is the one place that reconciles them, so the
// precedence rule has exactly one implementation and one set of tests.
//
// THE EDGE CASE THIS EXISTS TO GET RIGHT: a resolved candidate can be a
// real, correctly-matched product that STILL carries gramsConfidence
// 'unknown' (e.g. "salt to taste" resolves to a salt product, but there is
// no quantity to convert). Branching on whether `preselected` itself is
// truthy — as an early draft of this did — would let the LLM's fallback
// number silently render on screen while the badge still says 'unknown',
// which is a lie: 'unknown' means "no number is showing, tap to set one,"
// not "there's a number but don't trust it." So this branches on
// `preselected.estimatedGrams`, not on `preselected`.
export function resolveRowGrams(
  preselected: ResolvedCandidate | null,
  llmFallbackGrams: number | null,
): { grams: number | null; confidence: GramsConfidence } {
  if (preselected?.estimatedGrams != null) {
    return { grams: preselected.estimatedGrams, confidence: preselected.gramsConfidence };
  }
  if (llmFallbackGrams != null) {
    // The resolver had nothing; the LLM's rough figure is genuinely better
    // than blank, but the moment a number is actually shown it must read as
    // 'estimated', never inherit 'unknown' styling.
    return { grams: llmFallbackGrams, confidence: "estimated" };
  }
  return { grams: null, confidence: "unknown" }; // no number from either source — forces the tap
}
