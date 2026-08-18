/**
 * Seed staples for the batch-maker recipe scanner (Phase 2 importer input).
 *
 * WHAT THIS FILE IS
 *   The human-authored identity + conversion layer. Each row carries a canonical
 *   name, aliases, and (for the head staples) quantity->grams conversions.
 *   It does NOT carry macros or CoFID/FDC IDs — the importer resolves those at
 *   run time by searching CoFID (labelling-adjusted 2021, primary) then USDA FDC
 *   (Foundation + SR Legacy, fills NULLs per-field).
 *
 * unit_grams CONTRACT
 *   - Seeded ONLY for the ~30 head staples recipes constantly measure in
 *     counts/spoons (flour, oil, eggs, sugar, butter, common veg, a few condiments).
 *   - Everything else is left undefined => resolver returns grams:null =>
 *     the confirm step forces a human weight. That's safe by design.
 *   - Seeded values are ESTIMATES, not facts. In the resolver, a unit_grams hit
 *     must yield gramsConfidence:'estimated' (NOT 'exact'). Reserve 'exact' for
 *     true mass units (g/kg/oz/lb). See estimateGrams() in src/lib/ingredients.ts.
 *   - Count-word figures are EDIBLE PORTION (no shell/peel/core) unless noted.
 *   - 'pinch'/'dash'/'to taste' are deliberately NOT seeded anywhere, so they
 *     stay null and force input.
 *
 * density_g_per_ml
 *   Populated for liquids even where unit_grams is empty, so the resolver's
 *   VOLUME_ML fallback (tsp/tbsp/cup/ml) can produce an 'estimated' weight.
 *   NB honey/syrups are ~1.4 — the volume default (water) would under-read badly,
 *   which is exactly why they carry explicit density + seeded spoons.
 *
 * REVIEW FOCUS (widest variance — eyeball these first)
 *   onion / potato / tomato / pepper counts (produce size varies enormously),
 *   egg weights (UK medium ~50g vs large ~58g edible), and the honey/syrup densities.
 *
 * IMPORTER NOTE — CoFID uses inverted "Category, descriptor" naming
 *   ("Sugar, white"; "Cream, double"; "Yogurt, Greek style"). Match by tokenised /
 *   alias search, not exact string equality, and log misses for manual mapping.
 *   Filter FDC to dataType Foundation + SR Legacy; skip Branded.
 */

export interface SeedStaple {
  slug: string;
  displayName: string;
  aliases: string[];
  unitGrams?: Record<string, number>; // head staples only; estimates
  densityGPerMl?: number;             // liquids; enables volume fallback
  /**
   * Token(s) to prefer among matching CoFID rows, for staples whose
   * correct recipe-usage state ISN'T "raw" — or where "raw" would be
   * actively wrong, not just unavailable: tinned pulses/tuna ("canned"),
   * dried fruit/herbs ("dried"), roasted peanuts ("roasted"), etc. Leave
   * absent for the great majority of staples, where matchCofid()'s default
   * raw-preference tie-break already does the right thing. See
   * matchCofid()'s ranking comment in cofid.ts for exactly how this changes
   * scoring, and why hinted and unhinted staples are ranked asymmetrically
   * on purpose.
   */
  preparationPreference?: string[];
  /**
   * A CoFID food code a human has already picked for this staple by hand.
   *
   * ⚠ THIS CHANGES CONTROL FLOW, NOT JUST DATA. When present, the seed
   * importer looks this exact code up directly in the loaded CSV and uses
   * that row as-is — matchCofid() is never called for this staple at all,
   * and (since the human already chose the identity, not just filled a
   * gap) FDC merging is skipped too: an override is treated as fully
   * authoritative, `source` is unconditionally 'cofid', and `verified` is
   * true. matchCofid() is a suggestion tool for finding this code in the
   * first place, not the source of truth once it's been set — see
   * scripts/seedIngredients/cofid.ts's identity-anchoring comment for why
   * even a well-anchored matcher still isn't trusted to be the final word.
   *
   * If this code isn't found in the CSV a given run was given (a stale
   * code from a re-exported CoFID edition, a typo), the importer skips the
   * staple entirely rather than silently falling back to matchCofid() —
   * see seedCoreIngredients.ts's run() for exactly how that's reported.
   */
  cofidOverride?: string;
}

export const SEED_STAPLES: SeedStaple[] = [
  // ─────────────────────────────────────────────────────────────
  // HEAD STAPLES — unit_grams seeded (count-words / spoons)
  // ─────────────────────────────────────────────────────────────

  // Flours & baking
  { slug: 'plain-flour', displayName: 'Plain flour', aliases: ['all-purpose flour', 'ap flour', 'white flour', 'flour, wheat, white, plain'],
    unitGrams: { tbsp: 8, tsp: 2.6, cup: 120 }, densityGPerMl: 0.53, cofidOverride: '11-886', /* Flour, wheat, white, plain, soft */ },
  { slug: 'self-raising-flour', displayName: 'Self-raising flour', aliases: ['self raising flour', 'self-rising flour', 'sr flour'],
    unitGrams: { tbsp: 8, tsp: 2.6, cup: 120 }, densityGPerMl: 0.53, cofidOverride: '11-888', /* Flour, wheat, white, self raising */ },
  { slug: 'wholemeal-flour', displayName: 'Wholemeal flour', aliases: ['whole wheat flour', 'wholewheat flour', 'brown flour'],
    unitGrams: { tbsp: 8, tsp: 2.6, cup: 120 }, densityGPerMl: 0.53, cofidOverride: '11-889', /* Flour, wheat, wholemeal */ },
  { slug: 'cornflour', displayName: 'Cornflour', aliases: ['cornstarch', 'corn starch', 'corn flour'],
    unitGrams: { tbsp: 8, tsp: 2.7 }, densityGPerMl: 0.54, cofidOverride: '11-1045', /* Flour, corn */ },

  // Sugars & sweeteners
  { slug: 'caster-sugar', displayName: 'Caster sugar', aliases: ['superfine sugar', 'sugar, white', 'white sugar'],
    unitGrams: { tsp: 4.2, tbsp: 12.5, cup: 200 }, densityGPerMl: 0.85, cofidOverride: '17-063', /* Sugar, white */ },
  { slug: 'granulated-sugar', displayName: 'Granulated sugar', aliases: ['white sugar', 'sugar', 'table sugar'],
    unitGrams: { tsp: 4.2, tbsp: 12.5, cup: 200 }, densityGPerMl: 0.85, cofidOverride: '17-063', /* Sugar, white */ },
  { slug: 'icing-sugar', displayName: 'Icing sugar', aliases: ['powdered sugar', 'confectioners sugar', 'sugar, icing'],
    unitGrams: { tbsp: 8, cup: 125 }, densityGPerMl: 0.56, cofidOverride: '17-062', /* Sugar, icing */ },
  { slug: 'soft-brown-sugar', displayName: 'Soft brown sugar', aliases: ['brown sugar', 'light brown sugar', 'sugar, brown'],
    unitGrams: { tsp: 4.5, tbsp: 13.5, cup: 200 }, cofidOverride: '17-060', /* Sugar, brown */ },
  { slug: 'honey', displayName: 'Honey', aliases: ['runny honey', 'clear honey'],
    unitGrams: { tsp: 7, tbsp: 21 }, densityGPerMl: 1.42, cofidOverride: '17-050', /* Honey */ }, // review: density is the whole point here
  { slug: 'maple-syrup', displayName: 'Maple syrup', aliases: ['pure maple syrup'],
    unitGrams: { tsp: 6.8, tbsp: 20 }, densityGPerMl: 1.37 },
  { slug: 'golden-syrup', displayName: 'Golden syrup', aliases: ['light treacle', 'inverted sugar syrup'],
    unitGrams: { tsp: 7, tbsp: 21 }, densityGPerMl: 1.44, cofidOverride: '17-065', /* Syrup, golden */ },

  // Fats & oils
  { slug: 'butter', displayName: 'Butter', aliases: ['salted butter', 'unsalted butter'],
    unitGrams: { tsp: 4.7, tbsp: 14.2, knob: 15 }, cofidOverride: '17-685', /* Butter, salted */ }, // 'knob' is rough — review
  { slug: 'olive-oil', displayName: 'Olive oil', aliases: ['extra virgin olive oil', 'evoo'],
    unitGrams: { tsp: 4.5, tbsp: 13.5 }, densityGPerMl: 0.91, cofidOverride: '17-038', /* Oil, olive */ },
  { slug: 'vegetable-oil', displayName: 'Vegetable oil', aliases: ['sunflower oil', 'cooking oil', 'rapeseed oil'],
    unitGrams: { tsp: 4.6, tbsp: 13.8 }, densityGPerMl: 0.92, cofidOverride: '17-041', /* Oil, rapeseed */ },

  // Eggs & core dairy
  { slug: 'egg', displayName: 'Egg', aliases: ['eggs', 'chicken egg', 'hens egg', 'egg, chicken, whole, raw'],
    unitGrams: { small: 42, medium: 50, large: 58 }, cofidOverride: '12-937', /* Eggs, chicken, whole, raw */ }, // edible portion, no shell — review UK sizing
  { slug: 'whole-milk', displayName: 'Whole milk', aliases: ['full fat milk', 'milk', 'cows milk'],
    unitGrams: { tbsp: 15.4, cup: 247 }, densityGPerMl: 1.03, cofidOverride: '12-320', /* Milk, whole, UHT */ },

  // Aromatics & everyday veg (highest-variance counts — review)
  { slug: 'garlic', displayName: 'Garlic', aliases: ['garlic clove', 'garlic cloves', 'fresh garlic'],
    unitGrams: { clove: 4, bulb: 50 }, cofidOverride: '13-244', /* Garlic, raw */ },
  { slug: 'onion', displayName: 'Onion', aliases: ['brown onion', 'yellow onion', 'cooking onion'],
    unitGrams: { small: 90, medium: 130, large: 200 }, cofidOverride: '13-499', /* Onions, raw */ }, // review: wide range
  { slug: 'tomato', displayName: 'Tomato', aliases: ['fresh tomato', 'salad tomato'],
    unitGrams: { small: 90, medium: 120, large: 180, cherry: 17 }, cofidOverride: '13-517', /* Tomatoes, standard, raw */ },
  { slug: 'carrot', displayName: 'Carrot', aliases: ['fresh carrot'],
    unitGrams: { small: 50, medium: 61, large: 72 }, cofidOverride: '13-496', /* Carrots, old, raw */ },
  { slug: 'potato', displayName: 'Potato', aliases: ['white potato', 'maris piper', 'baking potato'],
    unitGrams: { small: 130, medium: 170, large: 300 }, cofidOverride: '15-850', /* Potatoes, duchesse */ }, // review: variety-dependent
  { slug: 'bell-pepper', displayName: 'Pepper (bell)', aliases: ['pepper', 'bell pepper', 'capsicum', 'red pepper', 'green pepper'],
    unitGrams: { medium: 120, large: 160 }, cofidOverride: '13-524', /* Pepper, capsicum, red, raw */ },

  // Citrus & fruit counts
  { slug: 'lemon', displayName: 'Lemon', aliases: ['fresh lemon'],
    unitGrams: { medium: 58 }, densityGPerMl: 1.03, cofidOverride: '14-128', /* Lemons, whole, without pips */ }, // density for 'juice of' when given in ml
  { slug: 'lime', displayName: 'Lime', aliases: ['fresh lime'],
    unitGrams: { medium: 67 }, densityGPerMl: 1.03, cofidOverride: '14-132', /* Limes, flesh only, weighed with peel and pips */ },
  { slug: 'banana', displayName: 'Banana', aliases: ['fresh banana'],
    unitGrams: { small: 90, medium: 118, large: 140 }, cofidOverride: '14-318', /* Bananas, flesh only */ }, // peeled

  // A few constantly spoon-measured condiments
  { slug: 'soy-sauce', displayName: 'Soy sauce', aliases: ['light soy sauce', 'dark soy sauce', 'shoyu'],
    unitGrams: { tsp: 6, tbsp: 18 }, densityGPerMl: 1.2, cofidOverride: '17-721', /* Soy sauce, light and dark varieties */ },
  { slug: 'tomato-puree', displayName: 'Tomato purée', aliases: ['tomato paste', 'tomato concentrate'],
    unitGrams: { tsp: 5.5, tbsp: 16 }, cofidOverride: '13-531', /* Tomato puree */ },
  { slug: 'peanut-butter', displayName: 'Peanut butter', aliases: ['smooth peanut butter', 'crunchy peanut butter'],
    unitGrams: { tsp: 5.3, tbsp: 16 }, cofidOverride: '14-892', /* Peanut butter, smooth */ },
  { slug: 'table-salt', displayName: 'Salt', aliases: ['table salt', 'fine salt', 'sea salt'],
    unitGrams: { tsp: 6, tbsp: 18 }, cofidOverride: '17-367', /* Salt */ }, // note: NO 'pinch' — stays null on purpose
  { slug: 'black-pepper', displayName: 'Black pepper', aliases: ['ground black pepper', 'pepper'],
    unitGrams: { tsp: 2.3, tbsp: 6.9 }, cofidOverride: '13-880', /* Pepper, black */ },

  // ─────────────────────────────────────────────────────────────
  // TAIL — aliases only (+ density for liquids). unit_grams left empty.
  // ─────────────────────────────────────────────────────────────

  // Baking & dry goods
  { slug: 'strong-white-flour', displayName: 'Strong white bread flour', aliases: ['bread flour', 'strong flour'], cofidOverride: '11-887', /* Flour, wheat, bread/strong, white */ },
  { slug: 'baking-powder', displayName: 'Baking powder', aliases: [], cofidOverride: '17-355', /* Baking powder */ },
  { slug: 'bicarbonate-of-soda', displayName: 'Bicarbonate of soda', aliases: ['baking soda', 'bicarb', 'sodium bicarbonate'], cofidOverride: '17-356', /* Bicarbonate of soda */ },
  { slug: 'dried-yeast', displayName: 'Dried yeast', aliases: ['fast action yeast', 'instant yeast', 'active dried yeast'], cofidOverride: '17-379', /* Yeast, dried */ },
  { slug: 'rolled-oats', displayName: 'Rolled oats', aliases: ['porridge oats', 'oats', 'oatmeal'], cofidOverride: '11-788', /* Porridge oats, unfortified */ },
  { slug: 'semolina', displayName: 'Semolina', aliases: [], cofidOverride: '11-903', /* Semolina, raw */ },
  { slug: 'polenta', displayName: 'Polenta', aliases: ['cornmeal'], cofidOverride: '11-905', /* Polenta, hydrated, raw */ },
  { slug: 'breadcrumbs', displayName: 'Breadcrumbs', aliases: ['panko', 'dried breadcrumbs'] },
  { slug: 'cocoa-powder', displayName: 'Cocoa powder', aliases: ['unsweetened cocoa'], cofidOverride: '12-545', /* Cocoa powder */ },
  { slug: 'desiccated-coconut', displayName: 'Desiccated coconut', aliases: ['shredded coconut'], cofidOverride: '14-873', /* Coconut, desiccated */ },
  { slug: 'vanilla-extract', displayName: 'Vanilla extract', aliases: ['vanilla essence'], densityGPerMl: 0.88 },
  { slug: 'demerara-sugar', displayName: 'Demerara sugar', aliases: ['raw cane sugar'], cofidOverride: '17-061', /* Sugar, Demerara */ },
  { slug: 'muscovado-sugar', displayName: 'Muscovado sugar', aliases: ['dark brown sugar'] },
  { slug: 'treacle', displayName: 'Black treacle', aliases: ['molasses'], densityGPerMl: 1.4, cofidOverride: '17-826', /* Treacle, black */ },
  { slug: 'dark-chocolate', displayName: 'Dark chocolate', aliases: ['plain chocolate', 'cooking chocolate'], cofidOverride: '17-650', /* Chocolate, dark, with crème or mint fondant centres */ },
  { slug: 'milk-chocolate', displayName: 'Milk chocolate', aliases: [], cofidOverride: '17-648', /* Chocolate, milk */ },

  // Dairy & alternatives
  { slug: 'semi-skimmed-milk', displayName: 'Semi-skimmed milk', aliases: ['2% milk', 'reduced fat milk'], densityGPerMl: 1.03, cofidOverride: '12-314', /* Milk, semi-skimmed, UHT */ },
  { slug: 'skimmed-milk', displayName: 'Skimmed milk', aliases: ['skim milk', 'fat free milk'], densityGPerMl: 1.03, cofidOverride: '12-554', /* Milk, skimmed, UHT */ },
  { slug: 'double-cream', displayName: 'Double cream', aliases: ['heavy cream', 'cream, double'], densityGPerMl: 1.0, cofidOverride: '12-334', /* Cream, fresh, double, including Jersey cream */ },
  { slug: 'single-cream', displayName: 'Single cream', aliases: ['light cream', 'cream, single'], densityGPerMl: 1.01, cofidOverride: '12-332', /* Cream, fresh, single */ },
  { slug: 'soured-cream', displayName: 'Soured cream', aliases: ['sour cream'], densityGPerMl: 1.0, cofidOverride: '17-677', /* Dips, sour-cream based, reduced fat */ },
  { slug: 'creme-fraiche', displayName: 'Crème fraîche', aliases: ['creme fraiche'], densityGPerMl: 1.0, cofidOverride: '12-335', /* Creme fraiche, full fat */ },
  { slug: 'natural-yogurt', displayName: 'Natural yogurt', aliases: ['plain yogurt', 'yoghurt'], densityGPerMl: 1.03, cofidOverride: '12-555', /* Yogurt, Greek style, plain */ },
  { slug: 'greek-yogurt', displayName: 'Greek yogurt', aliases: ['greek style yogurt', 'yogurt, greek style'], densityGPerMl: 1.03, cofidOverride: '12-555', /* Yogurt, Greek style, plain */ },
  { slug: 'margarine', displayName: 'Margarine', aliases: ['spread', 'vegetable spread'] },
  { slug: 'cheddar', displayName: 'Cheddar cheese', aliases: ['cheddar', 'mature cheddar', 'grated cheese'], cofidOverride: '12-346', /* Cheese, Cheddar, English */ },
  { slug: 'mozzarella', displayName: 'Mozzarella', aliases: ['mozzarella cheese'], cofidOverride: '12-360', /* Cheese, Mozzarella, fresh */ },
  { slug: 'parmesan', displayName: 'Parmesan', aliases: ['parmigiano', 'grated parmesan', 'hard cheese'], cofidOverride: '12-526', /* Cheese, Parmesan, fresh */ },
  { slug: 'feta', displayName: 'Feta', aliases: ['feta cheese'], cofidOverride: '12-525', /* Cheese, Feta */ },
  { slug: 'cream-cheese', displayName: 'Cream cheese', aliases: ['soft cheese'], cofidOverride: '12-551', /* Cheese, spreadable, full fat, soft, white */ },
  { slug: 'halloumi', displayName: 'Halloumi', aliases: [], cofidOverride: '12-496', /* Cheese, Halloumi */ },

  // Oils & fats (tail)
  { slug: 'sunflower-oil', displayName: 'Sunflower oil', aliases: [], densityGPerMl: 0.92, cofidOverride: '17-045', /* Oil, sunflower */ },
  { slug: 'rapeseed-oil', displayName: 'Rapeseed oil', aliases: ['canola oil'], densityGPerMl: 0.92, cofidOverride: '17-041', /* Oil, rapeseed */ },
  { slug: 'coconut-oil', displayName: 'Coconut oil', aliases: [], densityGPerMl: 0.92, cofidOverride: '17-031', /* Oil, coconut */ },
  { slug: 'sesame-oil', displayName: 'Sesame oil', aliases: ['toasted sesame oil'], densityGPerMl: 0.92, cofidOverride: '17-043', /* Oil, sesame */ },
  { slug: 'ghee', displayName: 'Ghee', aliases: ['clarified butter'], cofidOverride: '17-640', /* Ghee, butter */ },

  // Meat, poultry & fish
  { slug: 'chicken-breast', displayName: 'Chicken breast', aliases: ['chicken breast fillet', 'skinless chicken breast'], cofidOverride: '18-307', /* Chicken, breast, casseroled, meat only */ },
  { slug: 'chicken-thigh', displayName: 'Chicken thigh', aliases: ['boneless chicken thigh'], cofidOverride: '18-317', /* Chicken, thighs, casseroled, meat and skin */ },
  { slug: 'beef-mince', displayName: 'Beef mince', aliases: ['minced beef', 'ground beef'], cofidOverride: '18-469', /* Beef, mince, raw */ },
  { slug: 'pork-mince', displayName: 'Pork mince', aliases: ['minced pork', 'ground pork'], cofidOverride: '18-606', /* Pork, mince, raw */ },
  { slug: 'lamb-mince', displayName: 'Lamb mince', aliases: ['minced lamb', 'ground lamb'], cofidOverride: '18-481', /* Lamb, mince, raw */ },
  { slug: 'turkey-mince', displayName: 'Turkey mince', aliases: ['minced turkey', 'ground turkey'], cofidOverride: '18-354', /* Turkey, mince, stewed */ },
  { slug: 'pork-sausage', displayName: 'Pork sausage', aliases: ['sausages', 'bangers'], cofidOverride: '19-510', /* Sausages, pork, raw */ },
  { slug: 'streaky-bacon', displayName: 'Streaky bacon', aliases: ['bacon', 'smoked bacon'], cofidOverride: '19-016', /* Bacon rashers, streaky, raw */ },
  { slug: 'back-bacon', displayName: 'Back bacon', aliases: ['bacon rashers', 'bacon medallions'], cofidOverride: '19-500', /* Bacon rashers, back, grilled */ },
  // Split from a single 'gammon' entry — a raw gammon joint and cooked/cured
  // ham are different foods with different macros (moisture loss + curing),
  // and 'ham steak' was a misplaced alias on the raw entry. gammon stays
  // unhinted (raw is correct, same as every other raw meat); ham needs the
  // 'cooked' hint since it's never sold or used raw.
  { slug: 'gammon', displayName: 'Gammon', aliases: ['gammon joint'], cofidOverride: '19-020', /* Ham, gammon joint, raw */ },
  { slug: 'ham', displayName: 'Ham', aliases: ['ham steak', 'cooked ham', 'sliced ham'], preparationPreference: ['cooked'], cofidOverride: '19-496', /* Ham */ },
  { slug: 'rump-steak', displayName: 'Rump steak', aliases: ['beef steak', 'sirloin steak'], cofidOverride: '18-043', /* Beef, rump steak, raw, lean */ },
  { slug: 'salmon-fillet', displayName: 'Salmon fillet', aliases: ['salmon'], cofidOverride: '16-485', /* Salmon, wild, baked */ },
  { slug: 'cod-fillet', displayName: 'Cod fillet', aliases: ['cod', 'white fish'], cofidOverride: '16-158', /* White fish, dried, salted */ },
  // The bare 'tuna' alias risks matching a raw tuna steak CoFID row instead
  // of the canned-in-brine/oil product this staple actually means — a very
  // different food nutritionally. 'canned' pins it down.
  { slug: 'tinned-tuna', displayName: 'Tinned tuna', aliases: ['canned tuna', 'tuna'], preparationPreference: ['canned'], cofidOverride: '16-416', /* Tuna, canned in brine, drained */ },
  { slug: 'smoked-salmon', displayName: 'Smoked salmon', aliases: [], cofidOverride: '16-412', /* Salmon, smoked (cold-smoked) */ },
  // UK retail/recipe convention leans toward the pre-cooked pink prawns from
  // the chiller cabinet, not raw grey ones — unlike other meat/fish, raw
  // isn't obviously the safer default here.
  { slug: 'prawns', displayName: 'Prawns', aliases: ['king prawns', 'shrimp'], preparationPreference: ['boiled'], cofidOverride: '16-387', /* Prawns, king, raw */ },

  // Legumes & pulses
  // A recipe stating "400g chickpeas" means the tinned/cooked weight, not
  // dry raw weight (400g dry would be an absurd ~1kg cooked) — 'canned' is
  // the correct disambiguator, not the default 'raw'. Contrast with
  // red-lentils/green-lentils below, which genuinely ARE dry-weight staples.
  { slug: 'chickpeas', displayName: 'Chickpeas', aliases: ['tinned chickpeas', 'garbanzo beans'], preparationPreference: ['canned'] },
  { slug: 'kidney-beans', displayName: 'Red kidney beans', aliases: ['kidney beans'], preparationPreference: ['canned'], cofidOverride: '13-660', /* Beans, red kidney, canned in water, re-heated, drained */ },
  { slug: 'cannellini-beans', displayName: 'Cannellini beans', aliases: ['white beans'], preparationPreference: ['canned'], cofidOverride: '13-666', /* Beans, cannellini, canned, re-heated, drained */ },
  { slug: 'butter-beans', displayName: 'Butter beans', aliases: ['lima beans'], preparationPreference: ['canned'], cofidOverride: '13-559', /* Beans, butter, canned, re-heated, drained */ },
  { slug: 'black-beans', displayName: 'Black beans', aliases: [], preparationPreference: ['canned'] },
  { slug: 'red-lentils', displayName: 'Red lentils', aliases: ['split red lentils'], cofidOverride: '13-657', /* Lentils, red, split, dried, raw */ },
  { slug: 'green-lentils', displayName: 'Green lentils', aliases: ['puy lentils', 'brown lentils'], cofidOverride: '13-089', /* Lentils, green and brown, whole, dried, raw */ },
  { slug: 'baked-beans', displayName: 'Baked beans', aliases: ['beans in tomato sauce'], cofidOverride: '13-532', /* Baked beans, canned in tomato sauce */ },

  // Vegetables (UK naming)
  { slug: 'red-onion', displayName: 'Red onion', aliases: [] },
  { slug: 'spring-onion', displayName: 'Spring onion', aliases: ['scallion', 'green onion', 'salad onion'], cofidOverride: '13-352', /* Spring onions, bulbs and tops, raw */ },
  { slug: 'sweet-potato', displayName: 'Sweet potato', aliases: [], cofidOverride: '13-463', /* Sweet potato, raw, flesh only */ },
  { slug: 'cherry-tomatoes', displayName: 'Cherry tomatoes', aliases: ['baby tomatoes'], cofidOverride: '13-519', /* Tomatoes, cherry, raw */ },
  { slug: 'chopped-tomatoes', displayName: 'Tinned chopped tomatoes', aliases: ['canned tomatoes', 'plum tomatoes'], preparationPreference: ['canned'], cofidOverride: '13-530', /* Tomatoes, canned, whole contents */ },
  { slug: 'passata', displayName: 'Passata', aliases: ['sieved tomatoes', 'tomato sauce'], densityGPerMl: 1.05, cofidOverride: '17-834', /* Sauce, tomato based, homemade */ },
  { slug: 'aubergine', displayName: 'Aubergine', aliases: ['eggplant'], cofidOverride: '13-161', /* Aubergine, raw */ },
  { slug: 'courgette', displayName: 'Courgette', aliases: ['zucchini'], cofidOverride: '13-627', /* Courgette, raw */ },
  { slug: 'mushroom', displayName: 'Mushrooms', aliases: ['chestnut mushrooms', 'button mushrooms', 'closed cup mushrooms'], cofidOverride: '17-416', /* Mushroom, dried */ },
  { slug: 'broccoli', displayName: 'Broccoli', aliases: ['calabrese'], cofidOverride: '13-502', /* Broccoli, green, raw */ },
  { slug: 'cauliflower', displayName: 'Cauliflower', aliases: [], cofidOverride: '13-512', /* Cauliflower, raw */ },
  { slug: 'spinach', displayName: 'Spinach', aliases: ['baby spinach'], cofidOverride: '13-521', /* Spinach, baby, raw */ },
  { slug: 'kale', displayName: 'Kale', aliases: ['curly kale', 'cavolo nero'], cofidOverride: '13-234', /* Curly kale, raw */ },
  { slug: 'rocket', displayName: 'Rocket', aliases: ['arugula', 'salad rocket'], cofidOverride: '13-522', /* Rocket, raw */ },
  { slug: 'lettuce', displayName: 'Lettuce', aliases: ['iceberg lettuce', 'romaine', 'cos lettuce'], cofidOverride: '13-520', /* Lettuce, average, raw */ },
  { slug: 'cucumber', displayName: 'Cucumber', aliases: [], cofidOverride: '13-523', /* Cucumber, raw, flesh and skin */ },
  { slug: 'celery', displayName: 'Celery', aliases: ['celery stick'], cofidOverride: '13-636', /* Celery, raw */ },
  { slug: 'leek', displayName: 'Leek', aliases: ['leeks'], cofidOverride: '13-624', /* Leeks, raw */ },
  { slug: 'swede', displayName: 'Swede', aliases: ['rutabaga'], cofidOverride: '13-359', /* Swede, flesh only, raw */ },
  { slug: 'parsnip', displayName: 'Parsnip', aliases: [], cofidOverride: '13-312', /* Parsnip, raw */ },
  { slug: 'beetroot', displayName: 'Beetroot', aliases: ['beets'], cofidOverride: '13-164', /* Beetroot, raw */ },
  { slug: 'butternut-squash', displayName: 'Butternut squash', aliases: ['squash'], cofidOverride: '13-355', /* Squash, butternut, raw */ },
  { slug: 'frozen-peas', displayName: 'Peas', aliases: ['frozen peas', 'garden peas'], cofidOverride: '13-527', /* Peas, frozen, raw */ },
  { slug: 'sweetcorn', displayName: 'Sweetcorn', aliases: ['corn', 'tinned sweetcorn'], preparationPreference: ['canned'], cofidOverride: '13-609', /* Sweetcorn, dried */ },
  { slug: 'green-beans', displayName: 'Green beans', aliases: ['french beans', 'fine beans'], cofidOverride: '13-514', /* Beans, green, raw */ },
  { slug: 'cabbage', displayName: 'Cabbage', aliases: ['savoy cabbage', 'white cabbage'], cofidOverride: '13-509', /* Cabbage, white, raw */ },
  { slug: 'brussels-sprouts', displayName: 'Brussels sprouts', aliases: ['sprouts'], cofidOverride: '13-177', /* Brussels sprouts, raw */ },
  { slug: 'asparagus', displayName: 'Asparagus', aliases: [], cofidOverride: '13-157', /* Asparagus, raw */ },
  { slug: 'pak-choi', displayName: 'Pak choi', aliases: ['bok choy'], cofidOverride: '13-516', /* Pak choi, steamed */ },
  { slug: 'ginger', displayName: 'Ginger', aliases: ['fresh ginger', 'root ginger'], cofidOverride: '13-890', /* Ginger, fresh */ },
  { slug: 'red-chilli', displayName: 'Red chilli', aliases: ['chilli', 'fresh chilli', 'chili pepper'], cofidOverride: '15-640', /* Chilli, vegetable, homemade */ },

  // Fruit (tail)
  { slug: 'apple', displayName: 'Apple', aliases: ['eating apple', 'bramley apple'], cofidOverride: '14-362', /* Apples, cooking, raw, flesh only, peeled */ },
  { slug: 'pear', displayName: 'Pear', aliases: [], cofidOverride: '14-365', /* Pears, average, raw, flesh only */ },
  { slug: 'orange', displayName: 'Orange', aliases: [], cofidOverride: '14-327', /* Oranges, flesh only */ },
  { slug: 'strawberries', displayName: 'Strawberries', aliases: [], cofidOverride: '14-324', /* Strawberries, raw */ },
  { slug: 'blueberries', displayName: 'Blueberries', aliases: [], cofidOverride: '14-325', /* Blueberries */ },
  { slug: 'raspberries', displayName: 'Raspberries', aliases: [], cofidOverride: '14-375', /* Raspberries, raw */ },
  { slug: 'grapes', displayName: 'Grapes', aliases: [], cofidOverride: '14-350', /* Grapes, average */ },
  { slug: 'avocado', displayName: 'Avocado', aliases: [], cofidOverride: '14-039', /* Avocado, Fuerte, flesh only */ },
  { slug: 'mango', displayName: 'Mango', aliases: [], cofidOverride: '14-378', /* Mangoes, ripe, flesh only, raw */ },
  { slug: 'pineapple', displayName: 'Pineapple', aliases: [], cofidOverride: '14-376', /* Pineapple, flesh only, raw */ },
  // Dried fruit isn't raw fruit that happens to need a tie-break — it's
  // literally a different, dehydrated food. 'dried' is the correct
  // disambiguator, not a preference among otherwise-equal options.
  { slug: 'raisins', displayName: 'Raisins', aliases: [], preparationPreference: ['dried'], cofidOverride: '14-393', /* Raisins, dried */ },
  { slug: 'sultanas', displayName: 'Sultanas', aliases: [], preparationPreference: ['dried'], cofidOverride: '14-263', /* Sultanas */ },
  { slug: 'dates', displayName: 'Dates', aliases: ['medjool dates'], preparationPreference: ['dried'], cofidOverride: '14-394', /* Dates, dried, flesh and skin */ },

  // Herbs & spices
  { slug: 'coriander', displayName: 'Coriander', aliases: ['cilantro', 'fresh coriander', 'coriander leaves'], cofidOverride: '13-818', /* Coriander leaves, dried */ },
  { slug: 'parsley', displayName: 'Parsley', aliases: ['flat leaf parsley', 'fresh parsley'], cofidOverride: '13-844', /* Parsley, fresh */ },
  { slug: 'basil', displayName: 'Basil', aliases: ['fresh basil'], cofidOverride: '13-804', /* Basil, fresh */ },
  { slug: 'mint', displayName: 'Mint', aliases: ['fresh mint'], cofidOverride: '13-836', /* Mint, fresh */ },
  // thyme carries BOTH 'fresh thyme' and 'dried thyme' as aliases — a real
  // residual ambiguity, not a clean call. Hinted 'dried' as the more likely
  // generic-pantry-staple meaning; a recipe wanting fresh sprigs specifically
  // usually says so. oregano/mixed-herbs/bay-leaves/rosemary are the jar
  // spice in ordinary UK cooking far more often than the fresh herb.
  { slug: 'thyme', displayName: 'Thyme', aliases: ['fresh thyme', 'dried thyme'], preparationPreference: ['dried'], cofidOverride: '13-883', /* Thyme, dried, ground */ },
  { slug: 'rosemary', displayName: 'Rosemary', aliases: [], preparationPreference: ['dried'], cofidOverride: '13-882', /* Rosemary, dried */ },
  { slug: 'oregano', displayName: 'Oregano', aliases: ['dried oregano'], preparationPreference: ['dried'], cofidOverride: '13-878', /* Oregano, dried, ground */ },
  { slug: 'mixed-herbs', displayName: 'Mixed herbs', aliases: ['italian herbs', 'herbes de provence'], preparationPreference: ['dried'], cofidOverride: '13-884', /* Mixed herbs, dried */ },
  { slug: 'bay-leaves', displayName: 'Bay leaves', aliases: ['bay leaf'], preparationPreference: ['dried'], cofidOverride: '13-806', /* Bay leaf, dried */ },
  { slug: 'ground-cumin', displayName: 'Ground cumin', aliases: ['cumin'] },
  { slug: 'paprika', displayName: 'Paprika', aliases: [], cofidOverride: '13-879', /* Paprika */ },
  { slug: 'smoked-paprika', displayName: 'Smoked paprika', aliases: ['pimenton'] },
  { slug: 'ground-turmeric', displayName: 'Ground turmeric', aliases: ['turmeric'], cofidOverride: '13-861', /* Turmeric, ground */ },
  { slug: 'ground-cinnamon', displayName: 'Ground cinnamon', aliases: ['cinnamon'], cofidOverride: '13-874', /* Cinnamon, ground */ },
  { slug: 'curry-powder', displayName: 'Curry powder', aliases: [], cofidOverride: '13-876', /* Curry powder */ },
  { slug: 'garam-masala', displayName: 'Garam masala', aliases: [], cofidOverride: '13-829', /* Garam masala */ },
  { slug: 'nutmeg', displayName: 'Nutmeg', aliases: ['ground nutmeg'], cofidOverride: '13-877', /* Nutmeg, ground */ },
  { slug: 'cayenne', displayName: 'Cayenne pepper', aliases: ['cayenne'], cofidOverride: '13-847', /* Pepper, cayenne, ground */ },
  { slug: 'chilli-flakes', displayName: 'Chilli flakes', aliases: ['crushed chillies', 'red pepper flakes'] },

  // Nuts, seeds & spreads
  { slug: 'almonds', displayName: 'Almonds', aliases: ['whole almonds', 'flaked almonds'], cofidOverride: '14-896', /* Almonds, whole kernels */ },
  { slug: 'ground-almonds', displayName: 'Ground almonds', aliases: ['almond flour', 'almond meal'], cofidOverride: '14-870', /* Almonds, flaked and ground */ },
  { slug: 'walnuts', displayName: 'Walnuts', aliases: [], cofidOverride: '14-879', /* Walnuts, kernel only */ },
  { slug: 'cashews', displayName: 'Cashew nuts', aliases: ['cashews'], cofidOverride: '14-811', /* Cashew nuts, kernel only, plain */ },
  { slug: 'peanuts', displayName: 'Peanuts', aliases: ['roasted peanuts'], preparationPreference: ['roasted'], cofidOverride: '14-877', /* Peanuts, kernel only, plain, unsalted */ },
  { slug: 'pine-nuts', displayName: 'Pine nuts', aliases: [], cofidOverride: '14-839', /* Pine nuts, kernel only */ },
  { slug: 'sesame-seeds', displayName: 'Sesame seeds', aliases: [], cofidOverride: '14-844', /* Sesame seeds */ },
  { slug: 'sunflower-seeds', displayName: 'Sunflower seeds', aliases: [], cofidOverride: '14-845', /* Sunflower seeds */ },
  { slug: 'chia-seeds', displayName: 'Chia seeds', aliases: [] },
  { slug: 'tahini', displayName: 'Tahini', aliases: ['sesame paste'], cofidOverride: '14-847', /* Tahini paste */ },

  // Pantry & condiments
  { slug: 'worcestershire-sauce', displayName: 'Worcestershire sauce', aliases: [], densityGPerMl: 1.1, cofidOverride: '17-723', /* Worcestershire sauce */ },
  { slug: 'balsamic-vinegar', displayName: 'Balsamic vinegar', aliases: ['balsamic'], densityGPerMl: 1.13 },
  { slug: 'white-wine-vinegar', displayName: 'White wine vinegar', aliases: [], densityGPerMl: 1.01 },
  { slug: 'red-wine-vinegar', displayName: 'Red wine vinegar', aliases: [], densityGPerMl: 1.01 },
  { slug: 'cider-vinegar', displayName: 'Cider vinegar', aliases: ['apple cider vinegar'], densityGPerMl: 1.01 },
  { slug: 'dijon-mustard', displayName: 'Dijon mustard', aliases: ['mustard'], cofidOverride: '17-364', /* Mustard, smooth */ },
  { slug: 'english-mustard', displayName: 'English mustard', aliases: [] },
  { slug: 'wholegrain-mustard', displayName: 'Wholegrain mustard', aliases: ['grain mustard'], cofidOverride: '17-365', /* Mustard, wholegrain */ },
  { slug: 'tomato-ketchup', displayName: 'Tomato ketchup', aliases: ['ketchup'], cofidOverride: '17-709', /* Tomato ketchup */ },
  { slug: 'mayonnaise', displayName: 'Mayonnaise', aliases: ['mayo'], cofidOverride: '17-809', /* Mayonnaise, homemade */ },
  { slug: 'pesto', displayName: 'Pesto', aliases: ['green pesto', 'basil pesto'], cofidOverride: '15-838', /* Pesto sauce, homemade */ },
  { slug: 'sriracha', displayName: 'Sriracha', aliases: ['hot sauce', 'chilli sauce'], densityGPerMl: 1.1, cofidOverride: '17-719', /* Chilli sauce */ },
  { slug: 'coconut-milk', displayName: 'Coconut milk', aliases: ['tinned coconut milk'], densityGPerMl: 0.98, cofidOverride: '14-820', /* Coconut milk */ },
  { slug: 'chicken-stock', displayName: 'Chicken stock', aliases: ['chicken stock cube', 'chicken bouillon'], densityGPerMl: 1.0, cofidOverride: '17-726', /* Stock cubes, chicken */ },
  { slug: 'vegetable-stock', displayName: 'Vegetable stock', aliases: ['veg stock cube', 'vegetable bouillon'], densityGPerMl: 1.0, cofidOverride: '17-727', /* Stock cubes, vegetable */ },
  { slug: 'beef-stock', displayName: 'Beef stock', aliases: ['beef stock cube'], densityGPerMl: 1.0, cofidOverride: '17-515', /* Stock cubes, beef */ },

  // Carbs & grains
  { slug: 'basmati-rice', displayName: 'Basmati rice', aliases: ['white rice', 'long grain rice', 'rice'], cofidOverride: '11-857', /* Rice, white, basmati, raw */ },
  { slug: 'brown-rice', displayName: 'Brown rice', aliases: ['wholegrain rice'], cofidOverride: '11-868', /* Rice, brown, wholegrain, raw */ },
  { slug: 'pasta', displayName: 'Pasta (dried)', aliases: ['penne', 'fusilli', 'spaghetti', 'dried pasta'], cofidOverride: '11-716', /* Pasta, white, dried, raw */ },
  { slug: 'egg-noodles', displayName: 'Egg noodles', aliases: ['noodles'], cofidOverride: '11-719', /* Noodles, egg, dried, raw */ },
  { slug: 'couscous', displayName: 'Couscous', aliases: [], cofidOverride: '11-901', /* Couscous, plain, raw */ },
  { slug: 'quinoa', displayName: 'Quinoa', aliases: [], cofidOverride: '14-843', /* Quinoa, raw */ },
  { slug: 'white-bread', displayName: 'White bread', aliases: ['sliced white bread', 'bread'], cofidOverride: '11-980', /* Bread, white, sliced */ },
  { slug: 'wholemeal-bread', displayName: 'Wholemeal bread', aliases: ['brown bread', 'wholewheat bread'], cofidOverride: '11-981', /* Bread, wholemeal, average */ },
  { slug: 'tortilla-wrap', displayName: 'Tortilla wrap', aliases: ['wrap', 'flour tortilla'] },
  { slug: 'pitta-bread', displayName: 'Pitta bread', aliases: ['pita bread'], cofidOverride: '11-974', /* Bread, pitta, white */ },
  { slug: 'naan', displayName: 'Naan bread', aliases: ['naan'], cofidOverride: '11-973', /* Bread, naan, retail */ },
];
