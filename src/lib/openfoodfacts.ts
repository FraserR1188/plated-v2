import { FoodProduct } from "../types";

const BASE = "https://world.openfoodfacts.org";

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

  // ── Serving portion ("of which" OFF calls serving_quantity /
  //    serving_size). serving_quantity is grams (may arrive as a
  //    string); serving_size is the display string e.g. "45 g (1 bowl)".
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
  };
}

export async function searchFood(query: string): Promise<FoodProduct[]> {
  const params = new URLSearchParams({
    search_terms: query,
    search_simple: "1",
    action: "process",
    json: "1",
    page_size: "20",
    fields:
      "product_name,abbreviated_product_name,brands,nutriments,code,_id," +
      "serving_quantity,serving_quantity_unit,serving_size",
    sort_by: "unique_scans_n",
    countries_tags: "en:united-kingdom", // ← UK products first
    lc: "en", // ← English language names
    language: "en", // ← English language names
  });

  const res = await fetch(`${BASE}/cgi/search.pl?${params}`);
  const data = await res.json();

  return (data.products ?? [])
    .map(parseProduct)
    .filter(Boolean) as FoodProduct[];
}

export async function lookupBarcode(
  barcode: string,
): Promise<FoodProduct | null> {
  const res = await fetch(`${BASE}/api/v0/product/${barcode}.json`);
  const data = await res.json();
  if (data.status !== 1 || !data.product) return null;
  return parseProduct({ ...data.product, code: barcode });
}
