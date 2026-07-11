import { FoodProduct } from "../types";

const BASE = "https://world.openfoodfacts.org";

// Shared field set for both the search and barcode-lookup requests.
// The search endpoint is field-restricted, so image fields MUST be listed
// here or they won't come back. The barcode (v0) endpoint returns the full
// product by default; passing fields is still safe — if honoured it trims
// the payload, if ignored we get the full product as before.
const FIELDS = [
  "product_name",
  "abbreviated_product_name",
  "brands",
  "nutriments",
  "code",
  "_id",
  "id",
  "serving_quantity",
  "serving_quantity_unit",
  "serving_size",
  // ── images (front-of-pack, several resolutions) ──
  "image_front_url",
  "image_front_small_url",
  "image_front_thumb_url",
  "image_url",
  "image_small_url",
  "image_thumb_url",
  // ── ranking signal ──
  // How many distinct users have scanned this. We no longer sort by it
  // server-side (see rankResults below) but it's a useful tiebreaker.
  "unique_scans_n",
].join(",");

// ─── Query normalisation ─────────────────────────────────────
//
// OFF's search index does not stem, so "apples" and "apple" are different
// queries and the plural returns markedly worse results. Naive English
// singularisation covers the food vocabulary well enough — we're dealing
// with "apples", "berries", "tomatoes", not irregular edge cases.

const NO_SINGULARISE = new Set([
  // Words ending in 's' that are already singular.
  "hummus",
  "couscous",
  "asparagus",
  "molasses",
  "swiss",
  "guinness",
  "cheerios",
  "oats", // "oat" alone matches poorly; oats is the common form
  "chips",
  "crisps",
  "greens",
  "beans", // "beans" is how they're actually labelled
  "peas",
  "grapes",
  "oreos",
]);

export function singularise(word: string): string {
  const w = word.toLowerCase();
  if (w.length < 4 || NO_SINGULARISE.has(w)) return w;

  // berries → berry, strawberries → strawberry
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  // tomatoes → tomato, potatoes → potato
  if (w.endsWith("oes")) return w.slice(0, -2);
  // sandwiches → sandwich, boxes → box
  if (w.endsWith("ches") || w.endsWith("shes") || w.endsWith("xes")) {
    return w.slice(0, -2);
  }
  // apples → apple, carrots → carrot. Guard against "ss" (glass, grass).
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) {
    return w.slice(0, -1);
  }
  return w;
}

// Lowercase, strip punctuation, collapse whitespace, singularise each word.
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(singularise)
    .join(" ");
}

// ─── Relevance ranking ───────────────────────────────────────
//
// WHY THIS EXISTS: we used to pass sort_by=unique_scans_n, i.e. sort by
// popularity. But popularity among BARCODED products structurally favours
// packaged goods — nobody scans a loose apple. Search "apples" and you get
// apple-flavoured cereal bars, because a real apple can't win a contest it
// was never eligible for.
//
// So we fetch a wider page and re-rank locally: name matches beat popularity,
// short names beat long ones, and unbranded beats branded. Popularity is
// demoted to a tiebreaker.

function scoreProduct(p: FoodProduct, normQuery: string): number {
  const normName = normalise(p.name);
  const normBrand = normalise(p.brand ?? "");
  let score = 0;

  // 1. Exact match — "apple" for query "apples". The whole point.
  if (normName === normQuery) {
    score += 1000;
  }
  // 2. Name starts with the query — "apple juice" for "apple".
  else if (normName.startsWith(normQuery + " ")) {
    score += 500;
  }
  // 3. Query appears as a whole word — "organic apple rings".
  //    Whole-word, not substring: stops "grape" matching "grapefruit".
  else if (new RegExp(`\\b${escapeRegex(normQuery)}\\b`).test(normName)) {
    score += 250;
  }
  // 4. Every query word appears somewhere — handles "chicken breast"
  //    matching "breast of chicken".
  else {
    const words = normQuery.split(" ");
    const allPresent = words.every((w) =>
      new RegExp(`\\b${escapeRegex(w)}\\b`).test(normName),
    );
    if (allPresent) score += 120;
  }

  // 5. Brevity bonus. "Apple" is a better answer to "apple" than
  //    "Apple & Cinnamon Porridge Sachets" is. Caps at ~40 chars.
  const words = normName.split(" ").length;
  score += Math.max(0, 40 - words * 8);

  // 6. Unbranded bonus — a decent proxy for "this is a food, not a product".
  //    IMPORTANT: only applies when the query isn't itself a brand. Searching
  //    "weetabix" SHOULD surface Weetabix; we're not punishing brands, we're
  //    punishing branded results for generic food queries.
  const queryLooksLikeBrand = !!normBrand && normBrand.includes(normQuery);
  if (!p.brand && !queryLooksLikeBrand) {
    score += 60;
  }

  // 7. Popularity — TIEBREAKER ONLY. Log-scaled and capped so a
  //    mega-popular irrelevant product can't outrank a good match.
  const scans = p.unique_scans_n ?? 0;
  score += Math.min(40, Math.log10(scans + 1) * 12);

  // 8. Small penalty for products with no nutrition data at all — they're
  //    useless to log even if the name matches perfectly.
  if (p.cal_per100 === 0 && p.protein_per100 === 0 && p.carbs_per100 === 0) {
    score -= 80;
  }

  return score;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rankResults(products: FoodProduct[], query: string): FoodProduct[] {
  const normQuery = normalise(query);
  return products
    .map((p) => ({ p, score: scoreProduct(p, normQuery) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.p);
}

// ─── Parsing ─────────────────────────────────────────────────

function pickImages(p: any): {
  image_url?: string;
  image_thumb_url?: string;
} {
  const image_url =
    p.image_front_small_url ??
    p.image_small_url ??
    p.image_front_url ??
    p.image_url ??
    undefined;

  const image_thumb_url =
    p.image_front_thumb_url ??
    p.image_thumb_url ??
    p.image_front_small_url ??
    p.image_small_url ??
    undefined;

  return { image_url, image_thumb_url };
}

function parseProduct(p: any): FoodProduct | null {
  const n = p.nutriments ?? {};

  // Try kcal fields first; energy_100g is kJ and needs converting
  let cal = n["energy-kcal_100g"] ?? n["energy-kcal"] ?? null;
  if (cal == null && n["energy_100g"] != null) {
    cal = n["energy_100g"] / 4.184; // kJ → kcal
  }
  cal = cal ?? 0;

  const name = (p.product_name ?? p.abbreviated_product_name ?? "").trim();

  // Only reject if name is missing — allow 0-cal products (water, veg etc)
  if (!name) return null;

  const salt =
    n["salt_100g"] ?? (n["sodium_100g"] != null ? n["sodium_100g"] * 2.5 : 0);

  // ── Serving portion. serving_quantity is grams (may arrive as a string);
  //    serving_size is the display string e.g. "45 g (1 bowl)".
  //    Only trust the quantity when the unit is grams (or unstated).
  let serving_g: number | undefined;
  const sq = parseFloat(p.serving_quantity);
  const squ = (p.serving_quantity_unit ?? "g").toLowerCase();
  if (Number.isFinite(sq) && sq > 0 && squ === "g") {
    serving_g = Math.round(sq * 10) / 10;
  }

  const serving_label =
    typeof p.serving_size === "string" && p.serving_size.trim()
      ? p.serving_size.trim()
      : undefined;

  // Fallback: extract grams from the label text, e.g. "1 tbsp (15 g)"
  if (serving_g == null && serving_label) {
    const m = serving_label.match(/([\d.]+)\s*g\b/i);
    const parsed = m ? parseFloat(m[1]) : NaN;
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 1000) {
      serving_g = Math.round(parsed * 10) / 10;
    }
  }

  const { image_url, image_thumb_url } = pickImages(p);

  const scans = parseInt(p.unique_scans_n, 10);

  return {
    name,
    brand: (p.brands ?? "").split(",")[0].trim(),
    cal_per100: Math.round(cal),
    protein_per100: parseFloat((n["proteins_100g"] ?? 0).toFixed(1)),
    carbs_per100: parseFloat((n["carbohydrates_100g"] ?? 0).toFixed(1)),
    fat_per100: parseFloat((n["fat_100g"] ?? 0).toFixed(1)),
    sat_fat_per100: parseFloat((n["saturated-fat_100g"] ?? 0).toFixed(1)),
    salt_per100: parseFloat((salt ?? 0).toFixed(2)),
    fibre_per100: parseFloat(
      (n["fiber_100g"] ?? n["fibre_100g"] ?? 0).toFixed(1),
    ),
    sugar_per100: parseFloat((n["sugars_100g"] ?? 0).toFixed(1)),
    barcode: p.code,
    off_id: p._id ?? p.id,
    serving_g,
    serving_label,
    image_url,
    image_thumb_url,
    unique_scans_n: Number.isFinite(scans) ? scans : 0,
  };
}

// ─── Search ──────────────────────────────────────────────────

export async function searchFood(query: string): Promise<FoodProduct[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // Send the SINGULARISED query — OFF doesn't stem, so "apples" and "apple"
  // return meaningfully different result sets, and the singular is better.
  const searchTerms = normalise(trimmed);

  const params = new URLSearchParams({
    search_terms: searchTerms,
    search_simple: "1",
    action: "process",
    json: "1",
    // Fetch a wider net than we display: we re-rank locally, so the best
    // match may well be sitting at position 40 in OFF's own ordering.
    page_size: "50",
    fields: FIELDS,
    // NOTE: no sort_by. We used to pass unique_scans_n (popularity), which
    // buried whole foods under branded products. Ranking now happens locally
    // in rankResults() — see the comment there.
    countries_tags: "en:united-kingdom", // ← UK products first
    lc: "en",
    language: "en",
  });

  const res = await fetch(`${BASE}/cgi/search.pl?${params}`);
  const data = await res.json();

  const products = (data.products ?? [])
    .map(parseProduct)
    .filter(Boolean) as FoodProduct[];

  // Re-rank against the ORIGINAL query (rankResults normalises internally),
  // then trim to a sane list length.
  return rankResults(products, trimmed).slice(0, 20);
}

export async function lookupBarcode(
  barcode: string,
): Promise<FoodProduct | null> {
  const params = new URLSearchParams({ fields: FIELDS });
  const res = await fetch(`${BASE}/api/v0/product/${barcode}.json?${params}`);
  const data = await res.json();
  if (data.status !== 1 || !data.product) return null;
  return parseProduct({ ...data.product, code: barcode });
}
