# Tester findings — PL-015 to PL-018 (external round: Ian, Kayce)

Read-only investigation, written 2026-09-25 against master @ `63be47c`. No source, config, migration or Edge Function was changed. Nothing was deployed and nothing was written to the database. All SQL below is SELECT-only, for you to run in the Supabase dashboard.

**Labels used throughout**

- **READ**: seen in the code or config at the cited line.
- **MEASURED**: I ran it and this is the output. The only things run were read-only: two OFF search requests, sent from a throwaway Vitest file in my scratchpad (not in the repo) that called the repo's own `parseProduct`/`rankResults`, and grep/`git log`.
- **INFERRED**: follows from what was read, but not observed directly.
- **PREDICTED**: needs a device, a dashboard or a run to confirm.

## Before anything else: the IDs collide

> **Resolved 2026-09-25.** Filed in the repo record as **PL-035 to PL-038** (`testing/2026-09-21-ian.md`, `testing/2026-09-21-kayce.md`). Route B is **PL-039**, and the out-of-scope items are PL-040 to PL-047; the mapping is in `testing/2026-09-25-internal.md`. The collision happened because this round was first filed against a mirror of `testing/` that stops at PL-014. The headings below keep the brief's IDs in brackets so they can be traced.

The brief calls these issues PL-015 to PL-018. In the repo's testing record, which is the only source of truth, those four IDs **already belong to different issues**:

| ID | What the repo record says it is | Where |
|---|---|---|
| PL-015 | Cleared AI macro cell stores 0 | [testing/2026-09-19-internal.md:34](testing/2026-09-19-internal.md#L34) |
| PL-016 | Food search failures never reach Sentry | [testing/2026-09-19-internal.md:35](testing/2026-09-19-internal.md#L35) |
| PL-017 | fetchGoals errors for users with no goals row | [testing/2026-09-19-internal.md:36](testing/2026-09-19-internal.md#L36) |
| PL-018 | Today doesn't refetch after a foreground sync | [testing/2026-09-20-internal.md:20](testing/2026-09-20-internal.md#L20) |

The highest ID allocated is PL-034 ([testing/README.md](testing/README.md)). PL-029 is deliberately left unused. Kayce doesn't appear anywhere in `testing/`, and neither does a session doc for this round. The README says numbers are never reused, so these four should be logged as **PL-035 to PL-038** in a new session doc. This document keeps the brief's IDs as section headings so it matches the brief. I have not touched the testing record.

## Which build were they on?

Neither form recorded a build. What that changes:

- **Everything below is read against master @ `63be47c`.** 56 commits separate that from `48d09e1`.
- The **search re-ranker** (`rankResults`, [openfoodfacts.ts:153-222](src/lib/openfoodfacts.ts#L153-L222)) has shipped since `35742d5` (2026-07-11), and the unbranded bonus since `d4b7978` (2026-07-27). Any build either tester could plausibly have had includes both.
- The **meal chips on create** (`mealTypeChipActive`) date from `8b5bdf3` (2026-08-09), and so do the **recipe scanner's library picker** and **`RecipeScanScreen`**. The **forgot-password flow** dates from `5dde876` (2026-08-26).
- **`expo-image-picker`** has been in `package.json` and the `app.json` plugins since `2aa09e4` (2026-07-11). It is in every tester binary.
- Per [testing/2026-08-25-ian.md:3](testing/2026-08-25-ian.md#L3), no build before v8 (`af371df`, 26 Aug) has expo-updates. **A tester on a pre-v8 build receives none of the OTA fixes below.** Ian's Pixel 10 build from the August session was already unknown.

---

## PL-035 (brief: PL-015) — Generic whole foods missing from search (Major)

### What the code does now

**READ.** The screen the user types into is `AddIngredientScreen`. Today's single "+" opens a time picker, which navigates there with `{date, eatenAt}` ([TodayScreen.tsx:758-767](src/screens/TodayScreen.tsx#L758-L767)).

1. **Input.** `onChangeText={handleSearch}` ([AddIngredientScreen.tsx:274-282](src/screens/AddIngredientScreen.tsx#L274-L282)). It trims the text, needs at least 2 characters and debounces for 600 ms ([:117-130](src/screens/AddIngredientScreen.tsx#L117-L130)). Superseded requests are aborted and sequence-guarded ([:95-115](src/screens/AddIngredientScreen.tsx#L95-L115)).
2. **Sources.** The Search tab queries **only Open Food Facts**, through `searchFood` ([openfoodfacts.ts:347-385](src/lib/openfoodfacts.ts#L347-L385)). My Library (`saved_ingredients`) is a **separate tab**: an in-memory substring filter over the already-loaded array ([AddIngredientScreen.tsx:81-85](src/screens/AddIngredientScreen.tsx#L81-L85), [library.ts:49-60](src/lib/library.ts#L49-L60)). It is never merged into Search results. `core_ingredients` is **not queried**. There's no merging or cross-source dedupe, because there's only one source.
3. **The OFF request.** It uses `cgi/search.pl` with `page_size: "50"` and no `sort_by`, and adds `countries_tags: en:united-kingdom`, `lc`/`language: en` ([:358-373](src/lib/openfoodfacts.ts#L358-L373)). The query sent is `normalise(trimmed)`: lowercased, punctuation stripped, each word singularised ([:131-139](src/lib/openfoodfacts.ts#L131-L139), [:356](src/lib/openfoodfacts.ts#L356)).
4. **Ranking.** `rankResults` re-scores the 50 against the original query and returns the top 20 ([:384](src/lib/openfoodfacts.ts#L384)). The scores are: exact name +1000, `startsWith(query + " ")` +500, whole word +250, all words present +120 ([:159-179](src/lib/openfoodfacts.ts#L159-L179)); brevity `max(0, 40 − 8·words)` ([:183-184](src/lib/openfoodfacts.ts#L183-L184)); **unbranded +60, unless the brand contains the query** ([:190-193](src/lib/openfoodfacts.ts#L190-L193)); popularity `min(40, 12·log10(scans+1))` ([:197-198](src/lib/openfoodfacts.ts#L197-L198)); −80 when kcal, protein and carbs are all zero ([:202-204](src/lib/openfoodfacts.ts#L202-L204)).
5. **Plural handling.** `singularise` turns "apples" into "apple" ([:111-128](src/lib/openfoodfacts.ts#L111-L128)). Both the query sent and the ranking use it, so "apples" and "apple" send the same request. The earlier "apples returns nothing" symptom is covered by this.

### Does main search query `core_ingredients`?

**READ: no.** The only reader of `core_ingredients` in `src/` is `lookupStapleFromDb` ([ingredients.ts:281-300](src/lib/ingredients.ts#L281-L300)). It is reached only through `resolveIngredient` ([:197-267](src/lib/ingredients.ts#L197-L267)), which is wired in only by `RecipeConfirmScreen` ([RecipeConfirmScreen.tsx:75](src/screens/RecipeConfirmScreen.tsx#L75)). The CoFID staple tier is reachable only from the recipe scanner. `BatchIngredientPickerScreen` also calls plain `searchFood` ([:119](src/screens/BatchIngredientPickerScreen.tsx#L119)).

### Do apple and cucumber exist in `core_ingredients`?

**READ (seed input only, not the live table):**

- [scripts/seedStaples.ts:274](scripts/seedStaples.ts#L274) has `cucumber` with CoFID override `13-523` (Cucumber, raw, flesh and skin), no `unitGrams`.
- [:292](scripts/seedStaples.ts#L292) has `apple` with aliases `['eating apple','bramley apple']` and override `14-362`, which is **"Apples, cooking, raw, flesh only, peeled"**. **That's a cooking apple labelled "Apple" with the alias "eating apple".** No `unitGrams`.

A seeded override is written with `verified = true` ([seedCoreIngredients.ts:219-229](scripts/seedCoreIngredients.ts#L219-L229)). If the live table matches the seed, **"1 medium apple" can't be logged by count today**: `unit_grams` would be `{}`. Confirm with this query (columns from [20260808140000_core_ingredients.sql:32-64](supabase/migrations/20260808140000_core_ingredients.sql#L32-L64)):

```sql
-- PL-015 Q1: do apple / cucumber staples exist, can they be counted, are they verified?
-- Word-boundary regex so 'pineapple' isn't swept in by '%apple%'.
select slug, display_name, aliases, source, source_ref, verified,
       kcal_100g, protein_100g, carbs_100g, fat_100g,
       satfat_100g, sugar_100g, fibre_100g, salt_100g,
       unit_grams, density_g_per_ml
from public.core_ingredients
where slug in ('apple', 'cucumber')
   or display_name ~* '\m(apple|cucumber)s?\M'
   or exists (select 1 from unnest(aliases) a where a ~* '\m(apple|cucumber)s?\M')
order by slug;

-- PL-015 Q2: how much of the table could a main-search surface actually offer?
-- stapleToProduct() skips any row missing one of the big four.
select count(*)                                                        as total,
       count(*) filter (where kcal_100g is null or protein_100g is null
                          or carbs_100g is null or fat_100g is null)   as unofferable_big_four_null,
       count(*) filter (where unit_grams = '{}'::jsonb)                as no_count_units,
       count(*) filter (where verified)                                as verified
from public.core_ingredients;
```

If Q1 shows `source_ref = '14-362'` for `apple`, the row is the cooking apple.

### Why did apple juice outrank a plain apple?

**MEASURED (2026-09-25, live OFF, the app's exact parameters and the repo's own `parseProduct` + `rankResults`):**

- **"apple":** OFF's raw page of 50 includes an unbranded product named exactly **"Apple"** (barcode `20548735`, 51 kcal, 32 scans) at **position 12**. After the re-rank it is **#1**: 1000 exact + 32 brevity + 60 unbranded + ≈18 popularity. The #2 product is "APPLE + ELDERFLOWER" and #3 is "apple juice".
- **"cucumber":** "Cucumber | Nature's Pick" is **#1**, followed by "cucumber | Sainsbury's" and then two all-empty "Cucumber" rows (Asda, Co-op) with `missing_macros` = all four.
- **"Apple pie" isn't on today's page at all.**

**So on master with today's OFF data, Ian's symptom does not reproduce.** His page was different from today's, whether by time, data or build. The code can't settle which. Search failures and results aren't reported anywhere; that's the repo's own PL-016, "search failures never reach Sentry".

**What the ranking does structurally (READ + INFERRED):** when a plain entry is on the page, the ranker handles it well. An exact unbranded "Apple" scores ≈1110 against ≈530–560 for "Apple juice". It fails in two ways:

1. **The whole food isn't on the page (the dominant failure).** OFF's server-side order with no `sort_by` is its default popularity order (INFERRED from the raw order: scans fall monotonically from 105 to 15). The page is the 50 most-scanned products matching "apple". Loose produce is rarely scanned, and the plain "Apple" got in with 32 scans. Any whole food with fewer scans than the 50th branded match can't be surfaced, whatever the re-rank does. It can only reorder what came back.
2. **Varietal naming loses to prefix matches.** "British Gala Apples" normalises to "british gala apple". That's a whole-word match (+250), while "Apple Juice" gets a prefix match (+500). So a real apple named by variety or origin loses to juice and pie **by design**. INFERRED from [:159-169](src/lib/openfoodfacts.ts#L159-L169). The +60 unbranded bonus can't close a 250-point gap, and most supermarket produce is branded ("Tesco", "Nature's Pick") anyway.

A third, data-quality factor (MEASURED): **5 of the top 20 cucumber rows have no nutrition at all**. Those trip PL-028's manual-entry gate.

**Also MEASURED:** OFF answered **HTTP 503 "Page temporarily unavailable"** to 3 of my first 5 requests. `fetchOFF`/`searchFood` call `res.json()` with no `res.ok` check ([:375-376](src/lib/openfoodfacts.ts#L375-L376)), so a 503 surfaces as a JSON `SyntaxError`. The UI still shows "Couldn't search", correctly ([AddIngredientScreen.tsx:109-114](src/screens/AddIngredientScreen.tsx#L109-L114)). But it matters for P-TF02a: the outage is real, and today it's easy to hit.

`countries_tags=en:united-kingdom` is **not demonstrably a filter**. For "apple", OFF reported `count` = 2378 with it and 2132 without. A real filter can't return more with it than without. INFERRED: `search.pl` ignores it; the legacy API filters by `tagtype_0/tag_contains_0/tag_0`. Nothing currently depends on it, so I've left it out of the fix.

### Root cause

A **feature gap more than a defect**. Main search has a single source, crowd-sourced barcoded products selected by popularity, and that source structurally under-represents whole foods. The app already holds a curated generic-food table that main search never consults.

### Recommended fix

**Show CoFID staples in main search, as a "Generic foods" group above the OFF results, matched locally.**

- Load `core_ingredients` **once per session** into the store. It's around 190 rows ([verify.ts:519](scripts/seedIngredients/verify.ts#L519)), read-only reference data, and already SELECT-able by `authenticated`.
- Match it **in memory** on every keystroke, against `display_name` and `aliases` using the same `normalise()`.
- Show the top 3 matches that reach **at least a whole-word match**, above the OFF list.

Why this shape:

- **No extra network hop per keystroke.**
- **It still works when OFF returns 503.** Staples should render even when OFF errors: show them, and put the retry card under them.
- **No ODbL question.** It's our own OGL table, not a cache of OFF.

**The seed must be fixed first.** Remap `apple` from 14-362 (cooking) to CoFID's "Apples, eating, average, raw" row, and consider seeding `unitGrams` for count-eaten produce (`{"medium": …}`). That's a service-role importer run, a data step and not an app change. I haven't looked the code up; take it from the CoFID file. Surfacing the current row as "Apple" would under-log every eating apple.

**Files it touches:**

- `src/lib/ingredients.ts`: export `stapleToProduct` and set `source: "cofid"` on its output. Add a pure `matchStaples(rows, query)`.
- `src/types/index.ts`: add `"cofid"` to `ProductSource` ([:507](src/types/index.ts#L507)) and `"staple"` to `EntrySource` ([:31-39](src/types/index.ts#L31-L39)). There's no check constraint on `meal_entries.source` ([types :23-24](src/types/index.ts#L23-L24)). Confirm that with PL-017's constraint query below.
- `src/store/useStore.ts`: a `coreIngredients` slice and a loader.
- `src/screens/AddIngredientScreen.tsx`: render the group, and a CoFID list notice.
- `src/components/SourceNotice.tsx`: key the notices on the source rather than "OFF or nothing".
- `src/lib/macros.ts`: widen `needsManualEntry`/`canSubmitProduct`'s structural `source?: "off" | "custom"` ([:226](src/lib/macros.ts#L226), [:256](src/lib/macros.ts#L256)) to `ProductSource`. Exempt `"cofid"` the way `"custom"` is exempted. A measured all-zero CoFID row, such as salt's big four, must not trip the manual-entry gate.
- `src/screens/ProductScreen.tsx`: map `source: "cofid"` to entry source `"staple"` ([:594-600](src/screens/ProductScreen.tsx#L594-L600)).
- `src/lib/foodLookup.ts`: map `"staple"` back to `"cofid"` in `mealEntryToProduct` ([:136](src/lib/foodLookup.ts#L136)).

**Checks the brief asked for:**

- **(a) OGL attribution.** READ: `DATA_SOURCES` already carries a CoFID `inlineNotice` and a `listNotice` ([attributions.ts:68-69](src/content/attributions.ts#L68-L69)), but **neither is rendered anywhere**. `SourceNotice`/`SourceListNotice` return null for anything that isn't OFF ([SourceNotice.tsx:47](src/components/SourceNotice.tsx#L47), [:57](src/components/SourceNotice.tsx#L57)), and the header comment says CoFID "has no per-product UI surface" ([:18-22](src/components/SourceNotice.tsx#L18-L22)). This fix creates that surface. Render CoFID's `listNotice` above the staple group and its `inlineNotice` on ProductScreen, linked to the OGL v3.0 URL already in `licences`. The full OGL statement stays on About, unchanged. **Watch for this:** `stapleToProduct` currently sets no `source` ([ingredients.ts:164-175](src/lib/ingredients.ts#L164-L175)), and `isOpenFoodFactsSourced(undefined)` is **true** ([attributions.ts:112-114](src/content/attributions.ts#L112-L114)). If a staple is routed to ProductScreen without the `source: "cofid"` change, CoFID data is labelled **"Source: Open Food Facts (ODbL)"**. The attribution would be wrong, not just missing. The `platedapp.uk/attributions.html` mirror needs no change: the statement itself doesn't change.
- **(b) Same path, no third insert site.** READ: a staple row becomes a `FoodProduct` and goes through the existing `handleSelectProduct` → `navigate("Product")` → `handleSubmit` → `addEntry` ([AddIngredientScreen.tsx:136-142](src/screens/AddIngredientScreen.tsx#L136-L142), [ProductScreen.tsx:583-615](src/screens/ProductScreen.tsx#L583-L615)). No new insert or update. The small four go `staple.X ?? undefined` ([ingredients.ts:171-174](src/lib/ingredients.ts#L171-L174)), then `draft.X_per100 != null ? … : null` ([ProductScreen.tsx:534-537](src/screens/ProductScreen.tsx#L534-L537)), then `?? null` into the insert ([useStore.ts:920-923](src/store/useStore.ts#L920-L923)). NULL stays NULL. **One decision to make:** after logging, `saveIngredient(draft)` ([ProductScreen.tsx:636](src/screens/ProductScreen.tsx#L636)) copies the staple into My Library. `saved_ingredients` has no provenance column, so a re-add from Library comes back with `source` undefined and is labelled as OFF. I recommend skipping `saveIngredient` for `source === "cofid"`: staples are always one search away, and it avoids creating a new misattribution path.
- **(c) NULL big four from CoFID.** READ: `stapleToProduct` returns `null` when any of kcal, protein, carbs or fat is NULL ([ingredients.ts:159-163](src/lib/ingredients.ts#L159-L163)). Such rows are **skipped, not coalesced**, so nothing can reach the NOT NULL DEFAULT 0 columns (PL-011) as a fabricated zero. Reuse that function; don't write a second mapping. Q2 above counts how many rows that hides.

### OTA or build?

**OTA-eligible on both platforms, with the seed fix as a separate data step.** How I established that: every file listed is under `src/`. `runtimeVersion.policy` is `fingerprint` ([app.json:9-11](app.json#L9-L11)), and the fingerprint hashes native dependencies, config plugins and app config. No `package.json`, `app.json` or plugin change is involved. The Supabase read uses the already-bundled `supabase-js`.

### Risk to the invariants

- **`date`/`eaten_at`, `planned`, `MealEntryPatch`:** none. The staple path reuses the existing create path unchanged.
- **Two insert sites:** unchanged (see (b)).
- **NULL-not-zero:** preserved, per (b) and (c). Guard B+ ([nutrientCarriers.test.ts:551-](src/lib/__tests__/nutrientCarriers.test.ts#L551)) will scan the new code automatically.
- **No functions in navigation params:** a `FoodProduct` is plain data.
- **ODbL:** unaffected. Nothing from OFF is cached; CoFID is our own OGL table.

### Tests it needs

Write each one red first.

1. `matchStaples`, in `src/lib/__tests__/ingredients.test.ts`:
   - "apple" returns Apple and **not** Pineapple.
   - "apples" matches (singularised).
   - An alias hit works ("zucchini" finds Courgette).
   - At most 3 results.
   - A staple with a NULL big four is never returned.
   - **Sabotage:** drop the whole-word threshold (Pineapple appears), drop alias matching (zucchini fails), drop the NULL-skip (a null-kcal row is offered).
2. Merge order, as a pure `buildSearchSections(staples, offResults)`: staples come first. When OFF throws, staples still return. **Sabotage:** swap the order; make OFF's error clear the staples.
3. `stapleToProduct` sets `source: "cofid"`, and the small four stay `undefined`. **Sabotage:** remove `source`, then assert `isOpenFoodFactsSourced(product.source) === false` fails.
4. `needsManualEntry` returns false for an all-zero `source: "cofid"` product. **Sabotage:** remove the exemption.
5. `mealEntryToProduct` maps `source: "staple"` to `"cofid"` (in `foodLookup.test.ts`).
6. The existing `mealEntriesInsertSites.test.ts` must stay green unchanged. That's the proof there's no third site.

### Severity

**Agree with Major, with a caveat.** I couldn't reproduce Ian's exact screen on today's data. The structural gap is real, though. Popularity decides the page, varietal names lose to prefix matches, and produce nutrition is patchy. Measured 503s make search fragile today, and this fix also covers that. Logging a plain apple is core to a macro tracker.

---

## PL-036 (brief: PL-016) — AI scan is live-camera only (Minor, feature gap)

### What the code does now: every scan entry point

**READ.**

| Entry point | Where it's offered | Capture | Library? |
|---|---|---|---|
| Barcode | AddIngredient "Scan barcode" ([AddIngredientScreen.tsx:422-429](src/screens/AddIngredientScreen.tsx#L422-L429)); BatchIngredientPicker ([:162-167](src/screens/BatchIngredientPickerScreen.tsx#L162-L167)); RecipeConfirm ([:364](src/screens/RecipeConfirmScreen.tsx#L364)) | `expo-camera` `CameraView` + `onBarcodeScanned` ([ScannerScreen.tsx:10](src/screens/ScannerScreen.tsx#L10), [:189-192](src/screens/ScannerScreen.tsx#L189-L192)) | No (n/a) |
| Meal photo (AI) | AddIngredient "Scan meal" ([:430-437](src/screens/AddIngredientScreen.tsx#L430-L437) → [:150-181](src/screens/AddIngredientScreen.tsx#L150-L181)); BatchIngredientPicker ([:171-201](src/screens/BatchIngredientPickerScreen.tsx#L171-L201)) | `captureAndScanMealPhoto` → `launchCameraAsync` ([mealPhotoCapture.ts:36-57](src/lib/mealPhotoCapture.ts#L36-L57)), camera only by design ([:12-13](src/lib/mealPhotoCapture.ts#L12-L13)) | **No** |
| Nutrition label (AI) | CreateFood's photo sheet ([CreateFoodScreen.tsx:370-410](src/screens/CreateFoodScreen.tsx#L370-L410)); RecipeConfirm per-row "Scan label" ([:383](src/screens/RecipeConfirmScreen.tsx#L383)) | CreateFood: camera **or library** ([:309-333](src/screens/CreateFoodScreen.tsx#L309-L333)). RecipeConfirm: `captureAndScanLabel`, camera only ([labelCapture.ts:37-61](src/lib/labelCapture.ts#L37-L61)) | CreateFood yes; RecipeConfirm no |
| Recipe (AI) | BatchEditor "Scan recipe" ([BatchEditorScreen.tsx:415](src/screens/BatchEditorScreen.tsx#L415)) | `captureRecipePhoto` **or** `pickRecipeImage` → `launchImageLibraryAsync` ([recipeImageCapture.ts:43-69](src/lib/recipeImageCapture.ts#L43-L69), chosen at [RecipeScanScreen.tsx:84](src/screens/RecipeScanScreen.tsx#L84)) | **Yes** |

### Is a gallery picker already in the binary?

**READ: yes, on both platforms, in every tester build.**

- `expo-image-picker ~17.0.11` is in [package.json](package.json) and in the [app.json](app.json) plugins, with `photosPermission` set. Both have been there since `2aa09e4` (2026-07-11).
- `launchImageLibraryAsync` is **already called in shipped JS**: [CreateFoodScreen.tsx:327](src/screens/CreateFoodScreen.tsx#L327) and [recipeImageCapture.ts:61](src/lib/recipeImageCapture.ts#L61).
- **No new build is needed on Android or iOS.** Adding a library option to the meal scan is a JS change.

### Android permissions

**READ from `node_modules/expo-image-picker`:**

- The library manifest (`android/src/main/AndroidManifest.xml`) declares `CAMERA`, `READ_EXTERNAL_STORAGE` and `WRITE_EXTERNAL_STORAGE`, plus the `photopicker_activity:0:required` metadata for the Play-services photo picker backport.
- `launchImageLibraryAsync` uses `ActivityResultContracts.PickVisualMedia`, which is **the Android system photo picker** (`contracts/ImageLibraryContract.kt:40-79`).
- `requestMediaLibraryPermissionsAsync` asks for **nothing on API 33+**; `getMediaLibraryPermissions` returns an empty array. Below 33 it asks for READ/WRITE_EXTERNAL_STORAGE (`ImagePickerModule.kt:254-262`).
- **Nothing declares READ_MEDIA_IMAGES or READ_MEDIA_VIDEO.** The fix adds **no new permission**; the merged manifest is already whatever it is today.

**PREDICTED:** so nothing here triggers Google Play's photo and video permissions policy. To confirm, check the merged manifest of the current AAB in Play Console (App bundle explorer → Permissions) and look for any `READ_MEDIA_*`. A different dependency could add one; nothing in this repo does.

### Would a menu screenshot work through the current Edge Function?

**READ: no. It needs its own handling.** The prompt works against a menu in four places:

- The system prompt is written for "a plated meal from a photograph" ([scan-meal-photo/index.ts:141](supabase/functions/scan-meal-photo/index.ts#L141)).
- **Rule 7 says to ignore any printed nutrition in the image** ([:157](supabase/functions/scan-meal-photo/index.ts#L157)). A menu's printed kcal is the most reliable number on it.
- Rule 5 biases toward "home-style portions" ([:153](supabase/functions/scan-meal-photo/index.ts#L153)), which is wrong for a takeaway burger.
- `recognisable: false` is defined as "no identifiable food" ([:87-91](supabase/functions/scan-meal-photo/index.ts#L87-L91)).

**PREDICTED:**

- A text-heavy menu most likely comes back `no_food`. If it shows a hero photo, the model estimates that photo as a home-style plate and discards the printed kcal.
- A menu lists many items, and the plate prompt has no way to ask which one.
- A tall phone screenshot, around 1080×2400, is downscaled to 1568 px on the long edge ([imagePrep.ts:32](src/lib/imagePrep.ts#L32), [:83-89](src/lib/imagePrep.ts#L83-L89)), so about 706 px wide. Small menu text is probably still readable, but check that on a real screenshot.

### Recommended fix

**Give the existing `scan-meal-photo` a second entry path, `mode: "menu"`.** That follows the "one function, two entry paths" design `scan-recipe` already uses: one tool schema, and only the message content differs ([scan-recipe/index.ts:8-16](supabase/functions/scan-recipe/index.ts#L8-L16)). Don't add a third function.

**Edge Function** (`supabase/functions/scan-meal-photo/index.ts`):

- Accept `mode: "plate" | "menu"`, defaulting to `"plate"`.
- In menu mode, **require** `user_dish_label`: the item's name, which the user types before sending. This is the same field and the same server-side name override that the correction flow already uses ([:309](supabase/functions/scan-meal-photo/index.ts#L309)).
- Append a `MENU_ADDENDUM`, in the same way as `CORRECTION_ADDENDUM` ([:170-176](supabase/functions/scan-meal-photo/index.ts#L170-L176), [:510](supabase/functions/scan-meal-photo/index.ts#L510)). It should:
  - lift rule 7, and use printed kcal and weight for `cal` and `portionGrams` when they're shown;
  - lift rule 5's home-style bias in favour of the listed or typical restaurant portion;
  - estimate the other macros consistently with the printed kcal;
  - set `recognisable: false` only when the named item isn't on the image.
- In menu mode, push a note that says which numbers were printed and which were estimated.
- **The response contract is unchanged**, so `mealRecognition.ts`'s mirror type doesn't change.

**Client:**

- `mealPhotoCapture.ts` gains `pickAndScanMenuImage(label)`: `requestMediaLibraryPermissionsAsync` then `launchImageLibraryAsync`, following `recipeImageCapture.ts`.
- `mealRecognition.ts`'s `scanMealPhoto` gains an optional `mode`.
- AddIngredient's "Scan meal" becomes a two-option sheet: "Take photo" / "From a screenshot or menu". The second option asks for the item name, then picks.
- The draft still carries `aiEstimate`, so it logs as `ai_photo` through ProductScreen, and re-estimate resends the same bytes and the same mode.

Deploy order: **Edge Function first, then the OTA.** An old function ignores `mode`, so a new client talking to it would get plate behaviour. An old client never sends `mode`, so it's unaffected by the new function.

### Does the AI path let the user set a later `eaten_at` today, so it lands as planned?

**READ: yes, but on one of the two routes a lunchtime pick is silently moved to yesterday.** "Planned" is `eaten_at > now() + 30 min` on the DB clock ([20260712180000_meal_planning.sql:125](supabase/migrations/20260712180000_meal_planning.sql#L125)), and nothing redefines it later.

- **Route A works.** On Today's "+" picker, choose 19:00. `sameTimeOnDay` switches the roll-back off ([TodayScreen.tsx:758-767](src/screens/TodayScreen.tsx#L758-L767)). AddIngredient → Scan meal → ProductScreen then starts at 19:00 today (`initialEatenAt`, [ProductScreen.tsx:400](src/screens/ProductScreen.tsx#L400)). The UI reads "Plan a meal" ([:788-790](src/screens/ProductScreen.tsx#L788-L790)), and the trigger sets `planned = true`.
- **Route B doesn't.** Accept "now" on Today's picker, then change the time on ProductScreen's time chip. For today, when not editing and with the date untouched, `dayIsExplicit` is false ([:425-426](src/screens/ProductScreen.tsx#L425-L426)). That means `onTimeChange` calls `resolveEatenAt(h, m)` with no day ([:484-487](src/screens/ProductScreen.tsx#L484-L487)), and it **subtracts a day whenever the pick is more than 3 h ahead** ([time.ts:144-150](src/lib/time.ts#L144-L150)). At 12:00, picking 19:00 gives **yesterday 19:00**, saved as a logged meal (not planned) on the wrong day. The only visible cue is the date chip changing to "Yesterday".

Route B is exactly the "plan tonight's takeaway at lunchtime" flow Ian described. It exists today with the camera, independent of the screenshot feature. It's a defect in its own right; log it as its own PL. The fix is small: treat `initialEatenAt` from the time-first flow as an explicit day. Because it touches the CLAUDE.md roll-back rule, you should make the call, and I haven't folded it into the recommendation above.

### OTA or build?

- **App side: OTA-eligible on both platforms.** The picker is already native (see above), and the changes are all under `src/`. Same fingerprint reasoning as PL-015.
- **The Edge Function needs a `supabase functions deploy`.** That isn't an EAS build, and I haven't done it.
- **iOS copy caveat:** `NSPhotoLibraryUsageDescription` reads "…so you can add a picture to a food you've created" ([app.json](app.json), expo-image-picker plugin). It's already inaccurate for the recipe scanner. Changing it is an Info.plist change, so it changes the fingerprint (PREDICTED: on both platforms, since the fingerprint hashes the whole app config) and needs a new build. Fold it into the next planned native build rather than blocking this OTA.

### Risk to the invariants

- **`date`/`eaten_at`, `planned`, `MealEntryPatch`:** none. The result goes through the existing ProductScreen → `addEntry` path; no insert sites are added, and `planned` stays trigger-derived.
- **NULL-not-zero:** unaffected. The schema requires all eight macros, as today ([:113-120](supabase/functions/scan-meal-photo/index.ts#L113-L120)).
- **No functions in navigation params:** `captureAndScanMealPhoto` returns data, and the screen navigates with a `FoodProduct`.
- **Snake_case:** `ai_extractions` logging is unchanged.

### Tests it needs

1. A pure request builder, in `mealRecognition.test.ts`:
   - `mode` is omitted for plate, preserving the current body exactly.
   - `mode: "menu"` without a label is rejected client-side.
   - **Sabotage:** send menu without a label; drop `mode`.
2. Pure prompt selection in the function. Extract `buildSystemPrompt(mode, hasLabel)` into `_shared` so it's Vitest-reachable:
   - "menu" includes the addendum and lifts rule 7.
   - "plate" is byte-identical to today's prompt.
   - **Sabotage:** apply the menu addendum to plate.
3. The existing `mealPhotoCapture.test.ts` pattern for the picker branch: cancelled, permission denied, prep failed, ok.
4. For the route B defect, as its own PL: `resolveEatenAt` is already tested. The new test covers ProductScreen's "is the day explicit?" rule, extracted as a pure function. **Sabotage:** revert to today's rule; the 12:00 → 19:00 case must fail.

### Severity

**Agree with Minor (feature gap).** The route B finding is separate, and I'd rate it **Major**: it puts a meal on the wrong day as eaten, silently, which feeds the WHOOP correlation.

---

## PL-037 (brief: PL-017) — Can't change an entry's meal when editing (Major)

### How the slot is stored

**READ.**

- `meal_entries.meal_type` was set to NOT NULL with DEFAULT `'breakfast'` in [20260712180000_meal_planning.sql:370-372](supabase/migrations/20260712180000_meal_planning.sql#L370-L372).
- Per the bundles migration, **`meal_entries` has no check constraint on it** ([20260713120000_meal_bundles.sql:27-28](supabase/migrations/20260713120000_meal_bundles.sql#L27-L28)).
- The client type is `MealType = "breakfast" | "lunch" | "dinner" | "snacks"` ([types/index.ts:18](src/types/index.ts#L18), [:187](src/types/index.ts#L187)).
- The column **type** isn't in any tracked migration, because the table predates tracking.

**It is independent of `eaten_at`.** It's derived only once, as the default guess at create (`sectionForTime`, [AddIngredientScreen.tsx:67](src/screens/AddIngredientScreen.tsx#L67)). `retimeEntries` never touches it ([useStore.ts:1111-1140](src/store/useStore.ts#L1111-L1140)), and Today's bands "never reflect back into meal_type" ([TodayScreen.tsx:1117-1119](src/screens/TodayScreen.tsx#L1117-L1119)). No trigger derives it (confirm with the query below).

**Contributing cause:** `sectionForTime` never returns `snacks` ([time.ts:279-285](src/lib/time.ts#L279-L285)). A snack logged before 12:00 always defaults to Breakfast unless the user taps the chip. That matches Kayce's mis-log exactly.

```sql
-- PL-017 Q1 (run first): meal_entries has no tracked CREATE TABLE.
select column_name, data_type, udt_name, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'meal_entries'
order by ordinal_position;

-- PL-017 Q2: every constraint on the table (confirms no CHECK on meal_type or source).
select conname, contype, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.meal_entries'::regclass
order by conname;

-- PL-017 Q3: every user trigger (confirms nothing derives meal_type from eaten_at).
select tgname, pg_get_triggerdef(oid) as definition
from pg_trigger
where tgrelid = 'public.meal_entries'::regclass and not tgisinternal
order by tgname;

-- PL-017 Q4: is there any grouping column (bundle/composition/meal id)?
-- Build on Q1: if Q1 lists no such column, this returns nothing.
select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'meal_entries'
  and (column_name ilike '%composition%' or column_name ilike '%bundle%'
       or column_name ilike '%group%' or column_name ilike '%batch%');
```

### Where the edit path leaves the selector out

**READ.**

- **ProductScreen, edit mode.** The header renders a read-only pill when `isEditing`, and the four chips only on create ([ProductScreen.tsx:792-819](src/screens/ProductScreen.tsx#L792-L819)).
- **The comment explaining why is wrong.** It says "meal_type is sticky once a row exists (MealEntryPatch has no field for it — see CLAUDE.md's architecture invariants)" ([:282-285](src/screens/ProductScreen.tsx#L282-L285)). But `MealEntryPatch` **does** include `"meal_type"` ([useStore.ts:83](src/store/useStore.ts#L83)), and CLAUDE.md lists no such invariant. The UI restriction rests on a stale belief.
- **Other surfaces that edit an existing entry:**
  - **Today's bulk selection bar** offers confirm, "Set time" and delete ([TodayScreen.tsx:1291-1311](src/screens/TodayScreen.tsx#L1291-L1311)), but no slot change.
  - **CopyConfirm** has a slot picker ([CopyConfirmScreen.tsx:101](src/screens/CopyConfirmScreen.tsx#L101), [:235](src/screens/CopyConfirmScreen.tsx#L235)), but it **creates copies**; it doesn't edit.
  - **BundleApplyReview** shows each item's slot read-only ([:111](src/screens/BundleApplyReviewScreen.tsx#L111)) and is a create path.
  - **Batch entries** open in ProductScreen like any other entry.
  - ProductScreen is the only per-entry edit surface (`editEntryId` is set only at [TodayScreen.tsx:324](src/screens/TodayScreen.tsx#L324)).
- **Entries with `serving_g` NULL can't be opened for edit at all** ([TodayScreen.tsx:308-318](src/screens/TodayScreen.tsx#L308-L318)), so a selector on ProductScreen won't reach them.

### Is the slot in `MealEntryPatch`, and does `buildEditPatch` handle it?

**READ.**

- **Yes, `meal_type` is in `MealEntryPatch`** ([useStore.ts:78-97](src/store/useStore.ts#L78-L97)).
- **There is no `buildEditPatch` function.** The name is PL-010's label for the inline patch in `handleSubmit` ([ProductScreen.tsx:528-551](src/screens/ProductScreen.tsx#L528-L551)).
- That patch **always** sends `serving_g`, the eight macros recomputed from the lossy `draft`, and `eaten_at`. Its own comment describes the snap ([:503-521](src/screens/ProductScreen.tsx#L503-L521)).
- It never includes `meal_type`.
- **If you only added the chips, every slot change would resend all macros and snap them to the grid (PL-010).**

### Default `eaten_at` on a re-log after delete

**READ.**

- A re-log starts from Today's "+" picker, seeded to **now** on today's page ([TodayScreen.tsx:746-749](src/screens/TodayScreen.tsx#L746-L749)).
- ProductScreen takes that time unchanged ([ProductScreen.tsx:400](src/screens/ProductScreen.tsx#L400)).
- So **the default is now, not the original time**, unless Kayce moved the picker back.

**INFERRED:**

- Whatever time she chose on Today's picker, the new row gets `eaten_at_estimated = true`. `timeTouched` is set only by ProductScreen's own chip ([:474-476](src/screens/ProductScreen.tsx#L474-L476), [:610](src/screens/ProductScreen.tsx#L610)).
- **PREDICTED for WHOOP:** a morning snack re-logged in the afternoon usually stays in the same cycle, which runs wake to wake, so the recovery pairing (cycle N-1 → N) probably doesn't change. That cycle's `has_estimated_times` ([20260831120000_whoop_cycle_nutrition_known_meals.sql:140](supabase/migrations/20260831120000_whoop_cycle_nutrition_known_meals.sql#L140)) would flip to true if the original time was confirmed.
- I didn't query her data, as asked.

### Multi-item meals and bundles: should the others move?

**READ: no, the data model makes each row independent.**

- `applyEntries` writes one self-contained row per draft, with no composition or group id ([entries.ts:80-121](src/lib/entries.ts#L80-L121)).
- Bundle items carry **their own** `meal_type` and time by design ([20260713120000_meal_bundles.sql:27-28](supabase/migrations/20260713120000_meal_bundles.sql#L27-L28), "snapshot semantics").
- An AI multi-component photo is **one** entry.
- The row is the unit, so change only the edited row. Q4 above confirms no group column exists.
- Moving several at once belongs to Today's selection bar (a "Move to…" beside "Set time"), which you can add later. It isn't needed for this issue.

### Recommended fix

**Show the same four chips in edit mode, and replace the always-resend patch with a pure changed-fields builder.**

- Create `src/lib/entryEdit.ts` with `buildEditPatch({ original, mealType, servingText, eatenAt, timeTouched, dateTouched, draft })`. It returns only what changed:
  - `meal_type` when it differs from `routeMealType`;
  - `eaten_at` (plus `eaten_at_estimated: false` when the time was touched) only when the time or date was touched;
  - `serving_g` and the eight macros only when the serving changed.
  - It returns `{}` when nothing changed; then disable "Update entry", or pop without writing.
- A slot-only edit then sends `{ meal_type }` and nothing else, so the macros can't move.
- As a side effect, this is **the fix PL-010's own comment prescribes** ("only recompute when `serving` actually changed", [:517-518](src/screens/ProductScreen.tsx#L517-L518)). It closes PL-010 for every edit that doesn't change the serving. An edit that does change the serving still snaps once, as today.
- Correct the stale comment at [:282-285](src/screens/ProductScreen.tsx#L282-L285) in the same change.

**Files it touches:**

- `src/lib/entryEdit.ts` (new, pure);
- `src/screens/ProductScreen.tsx`: header [:792-819](src/screens/ProductScreen.tsx#L792-L819), `handleSubmit` [:528-551](src/screens/ProductScreen.tsx#L528-L551), comment [:282-285](src/screens/ProductScreen.tsx#L282-L285), and the delete dialog's label [:652](src/screens/ProductScreen.tsx#L652), which already reads `mealType` and so follows automatically.

### OTA or build?

**OTA-eligible on both platforms.** The only changes are `src/` TypeScript, with no dependency or config change, so the fingerprint is unchanged. That's established the same way as PL-015.

### Risk to the invariants

- **`date` from `eaten_at`:** preserved. `updateEntry` derives `date` only when `eaten_at` is present ([useStore.ts:984-987](src/store/useStore.ts#L984-L987)), and a slot-only patch doesn't send it. That's correct: the day hasn't changed.
- **`planned`:** not sent. The freeze trigger holds it ([20260712180000_meal_planning.sql:146-164](supabase/migrations/20260712180000_meal_planning.sql#L146-L164)).
- **`no_future_logged` guard** ([20260715161455:48-55](supabase/migrations/20260715161455_no_future_logged_guards_confirmed.sql#L48-L55)): a slot-only update on a past logged meal passes, and so does one on a planned meal.
- **`MealEntryPatch`:** unchanged. `meal_type` is already in it, and `date`/`planned` stay unrepresentable. Type the builder's return value as `MealEntryPatch` so that stays true.
- **Two insert sites:** untouched. This goes through the existing `updateEntry`, so no new update site. The update walker in `mealEntriesInsertSites.test.ts` sees the same call.
- **NULL-not-zero:** improved. An untouched small-four NULL is no longer re-sent at all.
- **PL-025 warning:** don't name a local `patch` in `useStore.ts`. The new builder lives in `lib/`, so this doesn't arise.

### Tests it needs

Write each one red first.

1. `buildEditPatch`:
   - slot only → exactly `{ meal_type }` (assert the key set);
   - time only → `eaten_at` plus the flag, **no** macros;
   - serving only → `serving_g` plus the eight macros;
   - small-four NULL with the serving changed → the NULL is kept;
   - nothing changed → `{}`.
2. **Sabotage runs:**
   - always include macros (the slot-only test must fail);
   - drop `meal_type`;
   - send `eaten_at_estimated: true` on an untouched time (PL's "only upgrade the flag" rule, [:542-545](src/screens/ProductScreen.tsx#L542-L545)).
3. A type-level test that `buildEditPatch`'s return value has no `date` or `planned` key. An `@ts-expect-error` assignment will do.

### How it interacts with PL-004

**PL-004 has already landed.** The KeyboardScreen wrapper is on master (`7a6b10e`), recorded Fixed and OTA'd (Android `ce5de6bb`, iOS `bf4b3ef8`) per [testing/README.md](testing/README.md). ProductScreen's footer is already inside it ([ProductScreen.tsx:764](src/screens/ProductScreen.tsx#L764), [:1231-1274](src/screens/ProductScreen.tsx#L1231-L1274)).

This fix touches the header, `handleSubmit` and a comment, **not the footer**, so the two don't share lines. Nothing needs sequencing against PL-004. It builds on master as it is.

### Severity

**Agree with Major.** The only workaround is delete and re-log, which moves `eaten_at` to "now", marks it estimated, and costs the user a re-entry.

---

## PL-038 (brief: PL-018) — Sign-up has one password field (Minor)

### What the code does now

**READ.** AuthScreen is in `App.tsx`, and sign-in and sign-up share one form.

- **The password field** ([App.tsx:589-595](App.tsx#L589-L595)) has `secureTextEntry` **only**. There's **no show/hide toggle**, no `autoComplete`, and no `textContentType`. The email field ([:579-588](App.tsx#L579-L588)) has no `autoComplete` either.
- **No client-side length check or hint.** `handleSubmit` requires only a non-empty password ([:464](App.tsx#L464)). The server's error text is shown raw in `Alert.alert("Error", e.message)` ([:489](App.tsx#L489)). By contrast, `ResetPasswordScreen` enforces 6 characters **and has a confirm field** ([ResetPasswordScreen.tsx:66-73](src/screens/ResetPasswordScreen.tsx#L66-L73)), so the two password surfaces are already inconsistent.
- **Autofill.**
  - **READ:** RN 0.81 maps `autoComplete="new-password"` to Android's `AUTOFILL_HINT_NEW_PASSWORD` and to iOS `newPassword` (`TextInput.js:830`, `:870`; `ReactTextInputManager.kt:1057`).
  - **PREDICTED:** without that hint, Google Password Manager or Samsung Pass may still offer to *save* after submit, based on the password input type. They won't reliably offer to *generate* a strong password on a field they can't tell is a new-password field.
  - **PREDICTED:** iOS strong-password generation also needs Associated Domains, which `app.json` doesn't declare. iOS is paused anyway.

### Is email confirmation on?

- **READ:** [supabase/config.toml:226](supabase/config.toml#L226) has `enable_confirmations = false`, and `minimum_password_length = 6` ([:182](supabase/config.toml#L182)). That file configures the **local** stack only (`site_url = "http://127.0.0.1:3000"`, [:159](supabase/config.toml#L159)), and says nothing about hosted.
- **Recorded:** P-TF01a measured `mailer_autoconfirm: true` on hosted on 2026-09-19 ([testing/README.md](testing/README.md)), so confirmation is **off**.
- **Where to look:**
  - **Confirm email:** Dashboard → Authentication → Sign In / Providers → Email → **"Confirm email"**.
  - **Minimum password length and requirements:** the same panel.
  - **SMTP sender:** Authentication → Emails → **SMTP Settings**. A Postmark sender would show host `smtp.postmarkapp.com`.
  - **"Reset Password" template:** Authentication → Emails → Templates.
  - **The repo doesn't mention Postmark anywhere**, so I can't confirm the provider from code.

### Does forgot-password work end to end?

**READ: it exists end to end in the app code, since `5dde876` (2026-08-26).**

1. "Forgot password?" appears in sign-in mode only ([App.tsx:597-604](App.tsx#L597-L604)), and opens `ForgotPasswordScreen` ([App.tsx:406-407](App.tsx#L406-L407)).
2. `requestPasswordReset` → `resetPasswordForEmail`, with `redirectTo: "https://platedapp.uk/reset-password"` ([supabase.ts:76-81](src/lib/supabase.ts#L76-L81)).
3. The email is sent by the dashboard-configured SMTP/template (not in this repo).
4. The `platedapp.uk/reset-password` bridge forwards to `plated://reset-password#access_token…` (the `plated-website` repo; not verified here). The `plated` scheme is in [app.json:8](app.json#L8).
5. `App.tsx` handles the link at both cold start and warm resume. `parseRecoveryLink` → `setSession` → `recoveryStatus` holds the navigator back ([App.tsx:149-220](App.tsx#L149-L220), [:396-404](App.tsx#L396-L404)).
6. `ResetPasswordScreen` → `updateUser({ password })` ([supabase.ts:86-89](src/lib/supabase.ts#L86-L89)).

**PREDICTED:** the email send and the website bridge can only be confirmed by requesting a reset on a device. A tester on a build before 26 Aug has none of this unless they're on v8+ and received the OTA.

### Recommended fix

**A show/hide toggle, not a confirm field. Also add the autofill hints and a length hint, both of which are free.**

Reasoning:

- A mistyped password at sign-up is **recoverable**: the reset flow exists end to end.
- A toggle lets the user *see* what they typed, which catches the mistake a confirm field catches without making everyone type it twice.
- A second field works against password managers: a generated password fills one field and leaves the user to repeat an unseen 20-character string.
- With `autoComplete="new-password"`, Google and Samsung autofill can generate and save the password, which removes typing altogether.

**Changes in `App.tsx` only:**

- A `showPassword` state and an eye `Pressable` beside the password input, driving `secureTextEntry={!showPassword}`.
- `autoComplete={mode === "signup" ? "new-password" : "current-password"}` on the password field; `autoComplete="email"` and `textContentType="emailAddress"` on the email field.
- On sign-up, an inline "At least 6 characters" hint and a client-side check that mirrors `ResetPasswordScreen`'s.
- Keep the 6 in one shared constant, beside the reset screen's.

**Related risk, not in the ask:** with Confirm email off, a **mistyped email** at sign-up is the error that *can't* be recovered. The account exists, and reset links go to the wrong address. That's a reason to revisit P-TF01a, not to add a confirm-password field.

### OTA or build?

**OTA-eligible on both platforms.** These are `App.tsx` JS changes using core RN TextInput props, with no dependency or config change, so the fingerprint is unchanged.

### Risk to the invariants

None. No `meal_entries` writes, no navigation params, no data paths.

### Tests it needs

Put the rule in a pure `validateSignUpPassword(pw)` in `src/lib/` and test it:

- 5 characters → error message;
- 6 → ok;
- a whitespace-only password → error;
- the constant is shared with the reset screen's check.

**Sabotage:** change the bound to `< 5`.

The toggle and autofill are UI wiring. Per CLAUDE.md, RNTL is deferred, so they go on the device checklist: the toggle flips; Google autofill offers "Use strong password" on the sign-up field.

### Severity

**Agree with Minor.** Arguably Polish, since the reset flow means nothing is lost.

---

## Out of scope — flagged, not fixed

1. **The `apple` staple is a cooking apple.** It's pinned to CoFID 14-362 "Apples, cooking, raw, flesh only, peeled", with the alias "eating apple" ([seedStaples.ts:292](scripts/seedStaples.ts#L292)). This already affects the **recipe scanner** today, for any recipe line "2 apples". Fix it before PL-015 surfaces the row.
2. **Non-OFF data is labelled "Source: Open Food Facts (ODbL)".** Wherever a `FoodProduct` has no `source`, `isOpenFoodFactsSourced(undefined)` is true ([attributions.ts:112-114](src/content/attributions.ts#L112-L114)). And `mealEntryToProduct` maps **every** non-custom entry to `"off"` ([foodLookup.ts:136](src/lib/foodLookup.ts#L136)). So editing an **AI photo, batch, label-scan, staple or copied** entry shows the OFF credit on ProductScreen ([ProductScreen.tsx:1004](src/screens/ProductScreen.tsx#L1004)). My Library rows re-added through `savedIngredientToProduct` (no `source`, [library.ts:25-40](src/lib/library.ts#L25-L40)) do the same. It's a mis-credit, not a missing credit, but CLAUDE.md treats attribution as exact.
3. **Route B planning trap** (PL-016 Q5). ProductScreen's time chip on today rolls any time more than 3 h ahead back to yesterday, saved as eaten. It deserves its own **Major** PL.
4. **OFF 503 surfaces as a JSON `SyntaxError`.** Measured today. `searchFood`/`lookupBarcode` never check `res.ok` ([openfoodfacts.ts:375-376](src/lib/openfoodfacts.ts#L375-L376), [:391-392](src/lib/openfoodfacts.ts#L391-L392)). The UI copes, but when the repo's PL-016 (search failures to Sentry) lands, every outage will be classed as a parse error. Throw a typed `OffHttpError(status)` first.
5. **`countries_tags=en:united-kingdom` is not demonstrably a filter.** The count went *up* with it: 2378 vs 2132. The comment "UK products first" ([:370](src/lib/openfoodfacts.ts#L370)) is probably untrue. INFERRED.
6. **The PL-028 cucumber repair used implausible OFF values.** OFF's Sainsbury's cucumber `5010251733911` currently reports **52 kcal, 2.1 g protein and 8.5 g carbs per 100 g**, which is roughly 3–4× any raw cucumber. The repair wrote 26 kcal per 50 g from it ([testing/2026-09-20-internal.md:521](testing/2026-09-20-internal.md#L521)). The two repaired days now likely *over*-state intake. MEASURED today; I don't know OFF's value on 2026-09-20.
7. **CLAUDE.md drift:** CLAUDE.md says `planned` is derived from "whether `eaten_at` is a future calendar day". The trigger uses `eaten_at > now() + 30 minutes` ([20260712180000_meal_planning.sql:125](supabase/migrations/20260712180000_meal_planning.sql#L125)), so a later meal *today* is planned. The code is right and the doc is wrong.
8. **Stale comment at [ProductScreen.tsx:282-285](src/screens/ProductScreen.tsx#L282-L285)** claims `MealEntryPatch` has no `meal_type`. Covered by PL-017's fix; listed here in case that fix is deferred.
9. **Functions in navigation params:** `Scanner`'s `onScanned` ([types/index.ts:687-689](src/types/index.ts#L687-L689)) is passed from [RecipeConfirmScreen.tsx:364](src/screens/RecipeConfirmScreen.tsx#L364) and [BatchIngredientPickerScreen.tsx:163](src/screens/BatchIngredientPickerScreen.tsx#L163). It's already flagged in the type's comment, but it isn't in the testing record.
10. **`RECORD_AUDIO` requested while both plugins block it.** [app.json](app.json) lists `android.permission.RECORD_AUDIO` in `android.permissions`, while `expo-image-picker` and `expo-camera` both set `microphonePermission: false`, which adds a `tools:node="remove"` block. The merged result depends on plugin order. PREDICTED: check the AAB's permission list. Nothing in `src/` records audio.
11. **The sign-up "Check your email" screen shows after every sign-up** ([App.tsx:476](App.tsx#L476)), although confirmation is off. That's P-TF01a's open question, still unverified on a device.
12. **Memory note is stale:** my own memory says "next free PL-018". The record's next free is PL-035. It isn't a repo issue, but it's how a collision like the one above happens.

---

## Proposed order of work

> **Superseded 2026-09-25** by the order agreed in reply: PL-039 first, then PL-037, then PL-043 (About build id), PL-038, the PL-035 data step (PL-042), PL-035 app with PL-040, and PL-036. The cucumber check (PL-041) sits outside the order but comes before any further data repair. The table below is kept as written.

| # | Issue | Why here | Files | Ship |
|---|---|---|---|---|
| 0 | Log PL-015 to PL-018 as **PL-035 to PL-038**, plus a new PL for route B (done 2026-09-25: PL-039) | The collision has to be settled before any commit message cites an ID | `testing/` | none |
| 1 | **PL-017** (slot on edit + `buildEditPatch`) | Major, small, contained; also closes most of PL-010 | `src/lib/entryEdit.ts` (new), `ProductScreen.tsx` (header, `handleSubmit`, comment) | OTA both |
| 2 | **PL-018** (toggle + autofill + length hint) | Tiny, no shared files; can ride the same OTA as #1 | `App.tsx`, a small `src/lib/` validator | OTA both |
| 3 | **Route B planning trap** (new PL) | Major, one rule in ProductScreen; needs your call on the roll-back rule | `ProductScreen.tsx` (`dayIsExplicit`/`onTimeChange`, :425-489) | OTA both |
| 4 | **PL-015 data step:** remap `apple` to eating apple; consider `unitGrams` for produce | Has to precede #5 | `scripts/seedStaples.ts` plus a service-role importer run | data only |
| 5 | **PL-015 app** (staples in main search) | Largest; after #1/#3 so ProductScreen edits don't collide | `ingredients.ts`, `types/index.ts`, `useStore.ts`, `AddIngredientScreen.tsx`, `SourceNotice.tsx`, `macros.ts`, `ProductScreen.tsx` (:594-600), `foodLookup.ts` | OTA both |
| 6 | **PL-016** (menu mode) | Feature; shares `AddIngredientScreen.tsx` with #5, so after it | `scan-meal-photo/index.ts` (**deploy first**), `mealPhotoCapture.ts`, `mealRecognition.ts`, `AddIngredientScreen.tsx` | Edge Function deploy, then OTA both; iOS purpose-string copy in the next native build |

**Shared files:**

- `ProductScreen.tsx` is touched by #1, #3 and #5, in three different regions: the header and `handleSubmit`; the time handlers; the source mapping. Landing them in that order keeps each diff reviewable.
- `AddIngredientScreen.tsx` is touched by #5 and #6.
- `types/index.ts` is touched only by #5.

**PL-004/005/006:** there's **nothing left to land**. All three are on master (`7a6b10e`) and recorded Fixed, OTA Android `ce5de6bb` + iOS `bf4b3ef8`. They're waiting for a tester to reach Verified. Put the three checks (keyboard on the 13 surfaces, BundleApplyReview grams, BatchEditor qty) on Ian's and Kayce's next checklist.

**Testers can't currently tell you their build.** About shows only the static `app.json` version, "Version 1.0.0" ([AboutScreen.tsx:19](src/screens/AboutScreen.tsx#L19), [:34](src/screens/AboutScreen.tsx#L34)). It shows no build number, no runtime version and no `Updates.updateId`, so a form can't record one. Showing `Updates.updateId` and `Updates.runtimeVersion` there would fix this (expo-updates is already native in v8+, so it's JS-only and OTA-eligible). It's worth doing before the next round: it removes this document's build caveat. It's the cheapest item on this list.
