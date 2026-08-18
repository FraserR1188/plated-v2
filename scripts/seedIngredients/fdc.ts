// ============================================================
// scripts/seedIngredients/fdc.ts — USDA FoodData Central lookup for the
// seed importer.
//
// CC0 public domain, free with a data.gov key (~1,000 req/hr — nowhere near
// what a ~150-200 staple run needs, but SEARCH_DELAY_MS below is a small
// courtesy pause, not a rate-limit workaround).
//
// FILTERED TO Foundation Foods + SR Legacy ONLY. Branded is packaged
// product data, not staples — including it here would be the exact same
// mistake the OFF search re-rank exists to correct in the other direction
// (see src/lib/openfoodfacts.ts's header comment: popularity among BARCODED
// products structurally favours packaged goods).
//
// NUTRIENT NUMBER MAP — verify this against a live response before a real
// run. FDC represents energy multiple ways (kcal and kJ both show up as
// separate nutrient rows) and has migrated sugar IDs across releases; 1008/
// 1003/1004/1005/1258/1079/2000|1063/1093 is current as of the Phase 2
// brief but is exactly the kind of thing that silently drifts.
//
// ATTRIBUTION — this importer has never written a production row (see
// src/content/attributions.ts, DATA_SOURCES: only cofid-2021 and
// open-food-facts are listed). If this path is ever used to seed
// core_ingredients rows that ship in a build, a USDA FoodData Central entry
// MUST be added to DATA_SOURCES first — that file is the single source of
// truth for attribution, not this comment. Suggested citation: U.S.
// Department of Agriculture, Agricultural Research Service. FoodData
// Central. fdc.nal.usda.gov.
// ============================================================

import type { SeedStaple } from "../seedStaples";
import { Macro100, toSaltG } from "./convert";

const BASE = "https://api.nal.usda.gov/fdc/v1";
const ALLOWED_DATA_TYPES = new Set(["Foundation", "SR Legacy"]);
const SEARCH_DELAY_MS = 260;

const NUTRIENT_IDS = {
  kcal: [1008],
  protein: [1003],
  fat: [1004],
  carbs: [1005],
  satFat: [1258],
  fibre: [1079],
  sugars: [2000, 1063], // migrated across releases — accept either
  sodiumMg: [1093],
} as const;

export interface FdcMatch {
  macros: Partial<Macro100>;
  sourceRef: string; // fdcId
  matchedName: string;
}

export interface FdcNutrientRow {
  value?: number;
  amount?: number;
  nutrientId?: number;
  nutrient?: { id?: number };
}

export interface FdcFood {
  fdcId: number;
  description: string;
  dataType: string;
  foodNutrients?: FdcNutrientRow[];
}

function extractNutrient(food: FdcFood, ids: readonly number[]): number | null {
  for (const row of food.foodNutrients ?? []) {
    const id = row.nutrientId ?? row.nutrient?.id;
    if (id != null && (ids as readonly number[]).includes(id)) {
      const v = row.value ?? row.amount;
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    }
  }
  return null;
}

export function foodToMacros(food: FdcFood): Partial<Macro100> {
  const sodiumMg = extractNutrient(food, NUTRIENT_IDS.sodiumMg);
  return {
    kcal_100g: extractNutrient(food, NUTRIENT_IDS.kcal),
    protein_100g: extractNutrient(food, NUTRIENT_IDS.protein),
    carbs_100g: extractNutrient(food, NUTRIENT_IDS.carbs),
    fat_100g: extractNutrient(food, NUTRIENT_IDS.fat),
    satfat_100g: extractNutrient(food, NUTRIENT_IDS.satFat),
    sugar_100g: extractNutrient(food, NUTRIENT_IDS.sugars),
    fibre_100g: extractNutrient(food, NUTRIENT_IDS.fibre),
    salt_100g: toSaltG(sodiumMg),
  };
}

async function searchOnce(query: string, apiKey: string): Promise<FdcFood[]> {
  const params = new URLSearchParams({
    api_key: apiKey,
    query,
    dataType: "Foundation,SR Legacy",
    pageSize: "10",
  });
  const res = await fetch(`${BASE}/foods/search?${params}`);
  if (!res.ok) {
    throw new Error(`FDC search failed (${res.status}) for "${query}": ${await res.text()}`);
  }
  const data = (await res.json()) as { foods?: FdcFood[] };
  return (data.foods ?? []).filter((f) => ALLOWED_DATA_TYPES.has(f.dataType));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Try the display name first, then each alias in turn, stopping at the
 * first query that returns a Foundation/SR-Legacy hit. FDC's own search
 * relevance ranks the response, so we take its top result rather than
 * re-scoring — but the caller logs matchedName so a bad pick is visible in
 * the run output, not silently baked into a NULL-filling merge.
 */
export async function lookupFdc(
  staple: SeedStaple,
  apiKey: string,
): Promise<FdcMatch | null> {
  const queries = [staple.displayName, ...staple.aliases];

  for (const query of queries) {
    const results = await searchOnce(query, apiKey);
    await sleep(SEARCH_DELAY_MS);
    if (results.length === 0) continue;

    const top = results[0];
    return {
      macros: foodToMacros(top),
      sourceRef: String(top.fdcId),
      matchedName: top.description,
    };
  }
  return null;
}
