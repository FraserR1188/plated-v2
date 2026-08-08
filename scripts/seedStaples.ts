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
}

export const SEED_STAPLES: SeedStaple[] = [
  // ─────────────────────────────────────────────────────────────
  // HEAD STAPLES — unit_grams seeded (count-words / spoons)
  // ─────────────────────────────────────────────────────────────

  // Flours & baking
  { slug: 'plain-flour', displayName: 'Plain flour', aliases: ['all-purpose flour', 'ap flour', 'white flour', 'flour, wheat, white, plain'],
    unitGrams: { tbsp: 8, tsp: 2.6, cup: 120 }, densityGPerMl: 0.53 },
  { slug: 'self-raising-flour', displayName: 'Self-raising flour', aliases: ['self raising flour', 'self-rising flour', 'sr flour'],
    unitGrams: { tbsp: 8, tsp: 2.6, cup: 120 }, densityGPerMl: 0.53 },
  { slug: 'wholemeal-flour', displayName: 'Wholemeal flour', aliases: ['whole wheat flour', 'wholewheat flour', 'brown flour'],
    unitGrams: { tbsp: 8, tsp: 2.6, cup: 120 }, densityGPerMl: 0.53 },
  { slug: 'cornflour', displayName: 'Cornflour', aliases: ['cornstarch', 'corn starch', 'corn flour'],
    unitGrams: { tbsp: 8, tsp: 2.7 }, densityGPerMl: 0.54 },

  // Sugars & sweeteners
  { slug: 'caster-sugar', displayName: 'Caster sugar', aliases: ['superfine sugar', 'sugar, white', 'white sugar'],
    unitGrams: { tsp: 4.2, tbsp: 12.5, cup: 200 }, densityGPerMl: 0.85 },
  { slug: 'granulated-sugar', displayName: 'Granulated sugar', aliases: ['white sugar', 'sugar', 'table sugar'],
    unitGrams: { tsp: 4.2, tbsp: 12.5, cup: 200 }, densityGPerMl: 0.85 },
  { slug: 'icing-sugar', displayName: 'Icing sugar', aliases: ['powdered sugar', 'confectioners sugar', 'sugar, icing'],
    unitGrams: { tbsp: 8, cup: 125 }, densityGPerMl: 0.56 },
  { slug: 'soft-brown-sugar', displayName: 'Soft brown sugar', aliases: ['brown sugar', 'light brown sugar', 'sugar, brown'],
    unitGrams: { tsp: 4.5, tbsp: 13.5, cup: 200 } },
  { slug: 'honey', displayName: 'Honey', aliases: ['runny honey', 'clear honey'],
    unitGrams: { tsp: 7, tbsp: 21 }, densityGPerMl: 1.42 }, // review: density is the whole point here
  { slug: 'maple-syrup', displayName: 'Maple syrup', aliases: ['pure maple syrup'],
    unitGrams: { tsp: 6.8, tbsp: 20 }, densityGPerMl: 1.37 },
  { slug: 'golden-syrup', displayName: 'Golden syrup', aliases: ['light treacle', 'inverted sugar syrup'],
    unitGrams: { tsp: 7, tbsp: 21 }, densityGPerMl: 1.44 },

  // Fats & oils
  { slug: 'butter', displayName: 'Butter', aliases: ['salted butter', 'unsalted butter'],
    unitGrams: { tsp: 4.7, tbsp: 14.2, knob: 15 } }, // 'knob' is rough — review
  { slug: 'olive-oil', displayName: 'Olive oil', aliases: ['extra virgin olive oil', 'evoo'],
    unitGrams: { tsp: 4.5, tbsp: 13.5 }, densityGPerMl: 0.91 },
  { slug: 'vegetable-oil', displayName: 'Vegetable oil', aliases: ['sunflower oil', 'cooking oil', 'rapeseed oil'],
    unitGrams: { tsp: 4.6, tbsp: 13.8 }, densityGPerMl: 0.92 },

  // Eggs & core dairy
  { slug: 'egg', displayName: 'Egg', aliases: ['eggs', 'chicken egg', 'hens egg', 'egg, chicken, whole, raw'],
    unitGrams: { small: 42, medium: 50, large: 58 } }, // edible portion, no shell — review UK sizing
  { slug: 'whole-milk', displayName: 'Whole milk', aliases: ['full fat milk', 'milk', 'cows milk'],
    unitGrams: { tbsp: 15.4, cup: 247 }, densityGPerMl: 1.03 },

  // Aromatics & everyday veg (highest-variance counts — review)
  { slug: 'garlic', displayName: 'Garlic', aliases: ['garlic clove', 'garlic cloves', 'fresh garlic'],
    unitGrams: { clove: 4, bulb: 50 } },
  { slug: 'onion', displayName: 'Onion', aliases: ['brown onion', 'yellow onion', 'cooking onion'],
    unitGrams: { small: 90, medium: 130, large: 200 } }, // review: wide range
  { slug: 'tomato', displayName: 'Tomato', aliases: ['fresh tomato', 'salad tomato'],
    unitGrams: { small: 90, medium: 120, large: 180, cherry: 17 } },
  { slug: 'carrot', displayName: 'Carrot', aliases: ['fresh carrot'],
    unitGrams: { small: 50, medium: 61, large: 72 } },
  { slug: 'potato', displayName: 'Potato', aliases: ['white potato', 'maris piper', 'baking potato'],
    unitGrams: { small: 130, medium: 170, large: 300 } }, // review: variety-dependent
  { slug: 'bell-pepper', displayName: 'Pepper (bell)', aliases: ['pepper', 'bell pepper', 'capsicum', 'red pepper', 'green pepper'],
    unitGrams: { medium: 120, large: 160 } },

  // Citrus & fruit counts
  { slug: 'lemon', displayName: 'Lemon', aliases: ['fresh lemon'],
    unitGrams: { medium: 58 }, densityGPerMl: 1.03 }, // density for 'juice of' when given in ml
  { slug: 'lime', displayName: 'Lime', aliases: ['fresh lime'],
    unitGrams: { medium: 67 }, densityGPerMl: 1.03 },
  { slug: 'banana', displayName: 'Banana', aliases: ['fresh banana'],
    unitGrams: { small: 90, medium: 118, large: 140 } }, // peeled

  // A few constantly spoon-measured condiments
  { slug: 'soy-sauce', displayName: 'Soy sauce', aliases: ['light soy sauce', 'dark soy sauce', 'shoyu'],
    unitGrams: { tsp: 6, tbsp: 18 }, densityGPerMl: 1.2 },
  { slug: 'tomato-puree', displayName: 'Tomato purée', aliases: ['tomato paste', 'tomato concentrate'],
    unitGrams: { tsp: 5.5, tbsp: 16 } },
  { slug: 'peanut-butter', displayName: 'Peanut butter', aliases: ['smooth peanut butter', 'crunchy peanut butter'],
    unitGrams: { tsp: 5.3, tbsp: 16 } },
  { slug: 'table-salt', displayName: 'Salt', aliases: ['table salt', 'fine salt', 'sea salt'],
    unitGrams: { tsp: 6, tbsp: 18 } }, // note: NO 'pinch' — stays null on purpose
  { slug: 'black-pepper', displayName: 'Black pepper', aliases: ['ground black pepper', 'pepper'],
    unitGrams: { tsp: 2.3, tbsp: 6.9 } },

  // ─────────────────────────────────────────────────────────────
  // TAIL — aliases only (+ density for liquids). unit_grams left empty.
  // ─────────────────────────────────────────────────────────────

  // Baking & dry goods
  { slug: 'strong-white-flour', displayName: 'Strong white bread flour', aliases: ['bread flour', 'strong flour'] },
  { slug: 'baking-powder', displayName: 'Baking powder', aliases: [] },
  { slug: 'bicarbonate-of-soda', displayName: 'Bicarbonate of soda', aliases: ['baking soda', 'bicarb', 'sodium bicarbonate'] },
  { slug: 'dried-yeast', displayName: 'Dried yeast', aliases: ['fast action yeast', 'instant yeast', 'active dried yeast'] },
  { slug: 'rolled-oats', displayName: 'Rolled oats', aliases: ['porridge oats', 'oats', 'oatmeal'] },
  { slug: 'semolina', displayName: 'Semolina', aliases: [] },
  { slug: 'polenta', displayName: 'Polenta', aliases: ['cornmeal'] },
  { slug: 'breadcrumbs', displayName: 'Breadcrumbs', aliases: ['panko', 'dried breadcrumbs'] },
  { slug: 'cocoa-powder', displayName: 'Cocoa powder', aliases: ['unsweetened cocoa'] },
  { slug: 'desiccated-coconut', displayName: 'Desiccated coconut', aliases: ['shredded coconut'] },
  { slug: 'vanilla-extract', displayName: 'Vanilla extract', aliases: ['vanilla essence'], densityGPerMl: 0.88 },
  { slug: 'demerara-sugar', displayName: 'Demerara sugar', aliases: ['raw cane sugar'] },
  { slug: 'muscovado-sugar', displayName: 'Muscovado sugar', aliases: ['dark brown sugar'] },
  { slug: 'treacle', displayName: 'Black treacle', aliases: ['molasses'], densityGPerMl: 1.4 },
  { slug: 'dark-chocolate', displayName: 'Dark chocolate', aliases: ['plain chocolate', 'cooking chocolate'] },
  { slug: 'milk-chocolate', displayName: 'Milk chocolate', aliases: [] },

  // Dairy & alternatives
  { slug: 'semi-skimmed-milk', displayName: 'Semi-skimmed milk', aliases: ['2% milk', 'reduced fat milk'], densityGPerMl: 1.03 },
  { slug: 'skimmed-milk', displayName: 'Skimmed milk', aliases: ['skim milk', 'fat free milk'], densityGPerMl: 1.03 },
  { slug: 'double-cream', displayName: 'Double cream', aliases: ['heavy cream', 'cream, double'], densityGPerMl: 1.0 },
  { slug: 'single-cream', displayName: 'Single cream', aliases: ['light cream', 'cream, single'], densityGPerMl: 1.01 },
  { slug: 'soured-cream', displayName: 'Soured cream', aliases: ['sour cream'], densityGPerMl: 1.0 },
  { slug: 'creme-fraiche', displayName: 'Crème fraîche', aliases: ['creme fraiche'], densityGPerMl: 1.0 },
  { slug: 'natural-yogurt', displayName: 'Natural yogurt', aliases: ['plain yogurt', 'yoghurt'], densityGPerMl: 1.03 },
  { slug: 'greek-yogurt', displayName: 'Greek yogurt', aliases: ['greek style yogurt', 'yogurt, greek style'], densityGPerMl: 1.03 },
  { slug: 'margarine', displayName: 'Margarine', aliases: ['spread', 'vegetable spread'] },
  { slug: 'cheddar', displayName: 'Cheddar cheese', aliases: ['cheddar', 'mature cheddar', 'grated cheese'] },
  { slug: 'mozzarella', displayName: 'Mozzarella', aliases: ['mozzarella cheese'] },
  { slug: 'parmesan', displayName: 'Parmesan', aliases: ['parmigiano', 'grated parmesan', 'hard cheese'] },
  { slug: 'feta', displayName: 'Feta', aliases: ['feta cheese'] },
  { slug: 'cream-cheese', displayName: 'Cream cheese', aliases: ['soft cheese'] },
  { slug: 'halloumi', displayName: 'Halloumi', aliases: [] },

  // Oils & fats (tail)
  { slug: 'sunflower-oil', displayName: 'Sunflower oil', aliases: [], densityGPerMl: 0.92 },
  { slug: 'rapeseed-oil', displayName: 'Rapeseed oil', aliases: ['canola oil'], densityGPerMl: 0.92 },
  { slug: 'coconut-oil', displayName: 'Coconut oil', aliases: [], densityGPerMl: 0.92 },
  { slug: 'sesame-oil', displayName: 'Sesame oil', aliases: ['toasted sesame oil'], densityGPerMl: 0.92 },
  { slug: 'ghee', displayName: 'Ghee', aliases: ['clarified butter'] },

  // Meat, poultry & fish
  { slug: 'chicken-breast', displayName: 'Chicken breast', aliases: ['chicken breast fillet', 'skinless chicken breast'] },
  { slug: 'chicken-thigh', displayName: 'Chicken thigh', aliases: ['boneless chicken thigh'] },
  { slug: 'beef-mince', displayName: 'Beef mince', aliases: ['minced beef', 'ground beef'] },
  { slug: 'pork-mince', displayName: 'Pork mince', aliases: ['minced pork', 'ground pork'] },
  { slug: 'lamb-mince', displayName: 'Lamb mince', aliases: ['minced lamb', 'ground lamb'] },
  { slug: 'turkey-mince', displayName: 'Turkey mince', aliases: ['minced turkey', 'ground turkey'] },
  { slug: 'pork-sausage', displayName: 'Pork sausage', aliases: ['sausages', 'bangers'] },
  { slug: 'streaky-bacon', displayName: 'Streaky bacon', aliases: ['bacon', 'smoked bacon'] },
  { slug: 'back-bacon', displayName: 'Back bacon', aliases: ['bacon rashers', 'bacon medallions'] },
  { slug: 'gammon', displayName: 'Gammon', aliases: ['ham steak'] },
  { slug: 'rump-steak', displayName: 'Rump steak', aliases: ['beef steak', 'sirloin steak'] },
  { slug: 'salmon-fillet', displayName: 'Salmon fillet', aliases: ['salmon'] },
  { slug: 'cod-fillet', displayName: 'Cod fillet', aliases: ['cod', 'white fish'] },
  { slug: 'tinned-tuna', displayName: 'Tinned tuna', aliases: ['canned tuna', 'tuna'] },
  { slug: 'smoked-salmon', displayName: 'Smoked salmon', aliases: [] },
  { slug: 'prawns', displayName: 'Prawns', aliases: ['king prawns', 'shrimp'] },

  // Legumes & pulses
  { slug: 'chickpeas', displayName: 'Chickpeas', aliases: ['tinned chickpeas', 'garbanzo beans'] },
  { slug: 'kidney-beans', displayName: 'Red kidney beans', aliases: ['kidney beans'] },
  { slug: 'cannellini-beans', displayName: 'Cannellini beans', aliases: ['white beans'] },
  { slug: 'butter-beans', displayName: 'Butter beans', aliases: ['lima beans'] },
  { slug: 'black-beans', displayName: 'Black beans', aliases: [] },
  { slug: 'red-lentils', displayName: 'Red lentils', aliases: ['split red lentils'] },
  { slug: 'green-lentils', displayName: 'Green lentils', aliases: ['puy lentils', 'brown lentils'] },
  { slug: 'baked-beans', displayName: 'Baked beans', aliases: ['beans in tomato sauce'] },

  // Vegetables (UK naming)
  { slug: 'red-onion', displayName: 'Red onion', aliases: [] },
  { slug: 'spring-onion', displayName: 'Spring onion', aliases: ['scallion', 'green onion', 'salad onion'] },
  { slug: 'sweet-potato', displayName: 'Sweet potato', aliases: [] },
  { slug: 'cherry-tomatoes', displayName: 'Cherry tomatoes', aliases: ['baby tomatoes'] },
  { slug: 'chopped-tomatoes', displayName: 'Tinned chopped tomatoes', aliases: ['canned tomatoes', 'plum tomatoes'] },
  { slug: 'passata', displayName: 'Passata', aliases: ['sieved tomatoes', 'tomato sauce'], densityGPerMl: 1.05 },
  { slug: 'aubergine', displayName: 'Aubergine', aliases: ['eggplant'] },
  { slug: 'courgette', displayName: 'Courgette', aliases: ['zucchini'] },
  { slug: 'mushroom', displayName: 'Mushrooms', aliases: ['chestnut mushrooms', 'button mushrooms', 'closed cup mushrooms'] },
  { slug: 'broccoli', displayName: 'Broccoli', aliases: ['calabrese'] },
  { slug: 'cauliflower', displayName: 'Cauliflower', aliases: [] },
  { slug: 'spinach', displayName: 'Spinach', aliases: ['baby spinach'] },
  { slug: 'kale', displayName: 'Kale', aliases: ['curly kale', 'cavolo nero'] },
  { slug: 'rocket', displayName: 'Rocket', aliases: ['arugula', 'salad rocket'] },
  { slug: 'lettuce', displayName: 'Lettuce', aliases: ['iceberg lettuce', 'romaine', 'cos lettuce'] },
  { slug: 'cucumber', displayName: 'Cucumber', aliases: [] },
  { slug: 'celery', displayName: 'Celery', aliases: ['celery stick'] },
  { slug: 'leek', displayName: 'Leek', aliases: ['leeks'] },
  { slug: 'swede', displayName: 'Swede', aliases: ['rutabaga'] },
  { slug: 'parsnip', displayName: 'Parsnip', aliases: [] },
  { slug: 'beetroot', displayName: 'Beetroot', aliases: ['beets'] },
  { slug: 'butternut-squash', displayName: 'Butternut squash', aliases: ['squash'] },
  { slug: 'frozen-peas', displayName: 'Peas', aliases: ['frozen peas', 'garden peas'] },
  { slug: 'sweetcorn', displayName: 'Sweetcorn', aliases: ['corn', 'tinned sweetcorn'] },
  { slug: 'green-beans', displayName: 'Green beans', aliases: ['french beans', 'fine beans'] },
  { slug: 'cabbage', displayName: 'Cabbage', aliases: ['savoy cabbage', 'white cabbage'] },
  { slug: 'brussels-sprouts', displayName: 'Brussels sprouts', aliases: ['sprouts'] },
  { slug: 'asparagus', displayName: 'Asparagus', aliases: [] },
  { slug: 'pak-choi', displayName: 'Pak choi', aliases: ['bok choy'] },
  { slug: 'ginger', displayName: 'Ginger', aliases: ['fresh ginger', 'root ginger'] },
  { slug: 'red-chilli', displayName: 'Red chilli', aliases: ['chilli', 'fresh chilli', 'chili pepper'] },

  // Fruit (tail)
  { slug: 'apple', displayName: 'Apple', aliases: ['eating apple', 'bramley apple'] },
  { slug: 'pear', displayName: 'Pear', aliases: [] },
  { slug: 'orange', displayName: 'Orange', aliases: [] },
  { slug: 'strawberries', displayName: 'Strawberries', aliases: [] },
  { slug: 'blueberries', displayName: 'Blueberries', aliases: [] },
  { slug: 'raspberries', displayName: 'Raspberries', aliases: [] },
  { slug: 'grapes', displayName: 'Grapes', aliases: [] },
  { slug: 'avocado', displayName: 'Avocado', aliases: [] },
  { slug: 'mango', displayName: 'Mango', aliases: [] },
  { slug: 'pineapple', displayName: 'Pineapple', aliases: [] },
  { slug: 'raisins', displayName: 'Raisins', aliases: [] },
  { slug: 'sultanas', displayName: 'Sultanas', aliases: [] },
  { slug: 'dates', displayName: 'Dates', aliases: ['medjool dates'] },

  // Herbs & spices
  { slug: 'coriander', displayName: 'Coriander', aliases: ['cilantro', 'fresh coriander', 'coriander leaves'] },
  { slug: 'parsley', displayName: 'Parsley', aliases: ['flat leaf parsley', 'fresh parsley'] },
  { slug: 'basil', displayName: 'Basil', aliases: ['fresh basil'] },
  { slug: 'mint', displayName: 'Mint', aliases: ['fresh mint'] },
  { slug: 'thyme', displayName: 'Thyme', aliases: ['fresh thyme', 'dried thyme'] },
  { slug: 'rosemary', displayName: 'Rosemary', aliases: [] },
  { slug: 'oregano', displayName: 'Oregano', aliases: ['dried oregano'] },
  { slug: 'mixed-herbs', displayName: 'Mixed herbs', aliases: ['italian herbs', 'herbes de provence'] },
  { slug: 'bay-leaves', displayName: 'Bay leaves', aliases: ['bay leaf'] },
  { slug: 'ground-cumin', displayName: 'Ground cumin', aliases: ['cumin'] },
  { slug: 'paprika', displayName: 'Paprika', aliases: [] },
  { slug: 'smoked-paprika', displayName: 'Smoked paprika', aliases: ['pimenton'] },
  { slug: 'ground-turmeric', displayName: 'Ground turmeric', aliases: ['turmeric'] },
  { slug: 'ground-cinnamon', displayName: 'Ground cinnamon', aliases: ['cinnamon'] },
  { slug: 'curry-powder', displayName: 'Curry powder', aliases: [] },
  { slug: 'garam-masala', displayName: 'Garam masala', aliases: [] },
  { slug: 'nutmeg', displayName: 'Nutmeg', aliases: ['ground nutmeg'] },
  { slug: 'cayenne', displayName: 'Cayenne pepper', aliases: ['cayenne'] },
  { slug: 'chilli-flakes', displayName: 'Chilli flakes', aliases: ['crushed chillies', 'red pepper flakes'] },

  // Nuts, seeds & spreads
  { slug: 'almonds', displayName: 'Almonds', aliases: ['whole almonds', 'flaked almonds'] },
  { slug: 'ground-almonds', displayName: 'Ground almonds', aliases: ['almond flour', 'almond meal'] },
  { slug: 'walnuts', displayName: 'Walnuts', aliases: [] },
  { slug: 'cashews', displayName: 'Cashew nuts', aliases: ['cashews'] },
  { slug: 'peanuts', displayName: 'Peanuts', aliases: ['roasted peanuts'] },
  { slug: 'pine-nuts', displayName: 'Pine nuts', aliases: [] },
  { slug: 'sesame-seeds', displayName: 'Sesame seeds', aliases: [] },
  { slug: 'sunflower-seeds', displayName: 'Sunflower seeds', aliases: [] },
  { slug: 'chia-seeds', displayName: 'Chia seeds', aliases: [] },
  { slug: 'tahini', displayName: 'Tahini', aliases: ['sesame paste'] },

  // Pantry & condiments
  { slug: 'worcestershire-sauce', displayName: 'Worcestershire sauce', aliases: [], densityGPerMl: 1.1 },
  { slug: 'balsamic-vinegar', displayName: 'Balsamic vinegar', aliases: ['balsamic'], densityGPerMl: 1.13 },
  { slug: 'white-wine-vinegar', displayName: 'White wine vinegar', aliases: [], densityGPerMl: 1.01 },
  { slug: 'red-wine-vinegar', displayName: 'Red wine vinegar', aliases: [], densityGPerMl: 1.01 },
  { slug: 'cider-vinegar', displayName: 'Cider vinegar', aliases: ['apple cider vinegar'], densityGPerMl: 1.01 },
  { slug: 'dijon-mustard', displayName: 'Dijon mustard', aliases: ['mustard'] },
  { slug: 'english-mustard', displayName: 'English mustard', aliases: [] },
  { slug: 'wholegrain-mustard', displayName: 'Wholegrain mustard', aliases: ['grain mustard'] },
  { slug: 'tomato-ketchup', displayName: 'Tomato ketchup', aliases: ['ketchup'] },
  { slug: 'mayonnaise', displayName: 'Mayonnaise', aliases: ['mayo'] },
  { slug: 'pesto', displayName: 'Pesto', aliases: ['green pesto', 'basil pesto'] },
  { slug: 'sriracha', displayName: 'Sriracha', aliases: ['hot sauce', 'chilli sauce'], densityGPerMl: 1.1 },
  { slug: 'coconut-milk', displayName: 'Coconut milk', aliases: ['tinned coconut milk'], densityGPerMl: 0.98 },
  { slug: 'chicken-stock', displayName: 'Chicken stock', aliases: ['chicken stock cube', 'chicken bouillon'], densityGPerMl: 1.0 },
  { slug: 'vegetable-stock', displayName: 'Vegetable stock', aliases: ['veg stock cube', 'vegetable bouillon'], densityGPerMl: 1.0 },
  { slug: 'beef-stock', displayName: 'Beef stock', aliases: ['beef stock cube'], densityGPerMl: 1.0 },

  // Carbs & grains
  { slug: 'basmati-rice', displayName: 'Basmati rice', aliases: ['white rice', 'long grain rice', 'rice'] },
  { slug: 'brown-rice', displayName: 'Brown rice', aliases: ['wholegrain rice'] },
  { slug: 'pasta', displayName: 'Pasta (dried)', aliases: ['penne', 'fusilli', 'spaghetti', 'dried pasta'] },
  { slug: 'egg-noodles', displayName: 'Egg noodles', aliases: ['noodles'] },
  { slug: 'couscous', displayName: 'Couscous', aliases: [] },
  { slug: 'quinoa', displayName: 'Quinoa', aliases: [] },
  { slug: 'white-bread', displayName: 'White bread', aliases: ['sliced white bread', 'bread'] },
  { slug: 'wholemeal-bread', displayName: 'Wholemeal bread', aliases: ['brown bread', 'wholewheat bread'] },
  { slug: 'tortilla-wrap', displayName: 'Tortilla wrap', aliases: ['wrap', 'flour tortilla'] },
  { slug: 'pitta-bread', displayName: 'Pitta bread', aliases: ['pita bread'] },
  { slug: 'naan', displayName: 'Naan bread', aliases: ['naan'] },
];
