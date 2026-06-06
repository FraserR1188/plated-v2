import { FoodProduct } from '../types';

const BASE = 'https://world.openfoodfacts.org';

function parseProduct(p: any): FoodProduct | null {
  const n    = p.nutriments ?? {};
  const cal  = n['energy-kcal_100g'] ?? n['energy-kcal'] ?? 0;
  const name = (p.product_name ?? p.abbreviated_product_name ?? '').trim();
  if (!name || cal <= 0) return null;

  // Salt: use direct value or convert from sodium (sodium × 2.5 = salt)
  const salt = n['salt_100g'] ?? (n['sodium_100g'] != null ? n['sodium_100g'] * 2.5 : 0);

  return {
    name,
    brand:           (p.brands ?? '').split(',')[0].trim(),
    cal_per100:      Math.round(cal),
    protein_per100:  parseFloat((n['proteins_100g']      ?? 0).toFixed(1)),
    carbs_per100:    parseFloat((n['carbohydrates_100g'] ?? 0).toFixed(1)),
    fat_per100:      parseFloat((n['fat_100g']           ?? 0).toFixed(1)),
    salt_per100:     parseFloat((salt                    ?? 0).toFixed(2)),
    fibre_per100:    parseFloat((n['fiber_100g'] ?? n['fibre_100g'] ?? 0).toFixed(1)),
    sugar_per100:    parseFloat((n['sugars_100g']        ?? 0).toFixed(1)),
    barcode:         p.code,
    off_id:          p._id ?? p.id,
  };
}

export async function searchFood(query: string): Promise<FoodProduct[]> {
  const params = new URLSearchParams({
    search_terms:  query,
    search_simple: '1',
    action:        'process',
    json:          '1',
    page_size:     '10',
    fields:        'product_name,abbreviated_product_name,brands,nutriments,code,_id',
  });
  const res  = await fetch(`${BASE}/cgi/search.pl?${params}`);
  const data = await res.json();
  return (data.products ?? []).map(parseProduct).filter(Boolean) as FoodProduct[];
}

export async function lookupBarcode(barcode: string): Promise<FoodProduct | null> {
  const res  = await fetch(`${BASE}/api/v0/product/${barcode}.json`);
  const data = await res.json();
  if (data.status !== 1 || !data.product) return null;
  return parseProduct({ ...data.product, code: barcode });
}
