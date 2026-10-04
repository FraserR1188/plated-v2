# Receipt scanner v1 — findings

Read-only investigation, run 2026-09-26 against master @ `177ed0a` (clean tree). Nothing was edited, committed, migrated or deployed except this file.

**Revised 2026-09-26** after the decisions recorded at the end:

- multi-image capture (up to 3 parts) is in v1;
- editing and deleting a saved receipt are in v1;
- the section is named "Grocery spending";
- all three brief changes are accepted.

**Revised 2026-09-27 with the bake-off (commit 0).** 13 real receipts, three model arms, three runs, 57 model calls, MEASURED. Its results decide the model, the image tier and the size limits, and correct four things in §3. The results are under commit 0 below. Sections changed carry a "Revised 2026-09-27" marker.

Every section changed by the revision carries a "Revised 2026-09-26" marker. Sections without one are as first written. Line references to `useStore.ts` are at `177ed0a`. PL-050 (`eec75b9`, since committed) moved `fetchEntries` down by about 15 lines.

**Labels.** **READ** means taken from the source at the cited line. **MEASURED** means I ran it and the output is quoted. **PREDICTED** means an expectation that hasn't been checked on a device, the database or the API.

**Scope as briefed.** Photograph or pick a supermarket receipt. The AI extracts store, date, printed total and lines. The user reviews and saves, and spending shows on the Data tab. No food matching, no pantry, no nutrition, and **nothing is ever written to `meal_entries`**. Raw line text is kept so a later version can match retroactively.

## Summary — Revised 2026-09-26

| # | Question | Answer in one line |
|---|---|---|
| 1 | Batches placement | Batches holds one list and one action. A receipt entry there reads as "turn a receipt into a batch", which v1 isn't. **Recommend the Data tab's new Spending segment** as the only entry point. |
| 2 | Data tab | It's two segments over one screen. Two range controls behave differently, and History's averages treat unknown macros as 0 while Trends treats them as gaps. **Recommend** `History \| Trends \| Spending` plus a tidy commit. |
| 3 | scan-meal-photo | Haiku 4.5, forced tool, 1024 max tokens, and no `stop_reason` check. **PL-036 menu mode is not started on master.** A receipt shares nothing with the meal contract. **Decided: a sibling function, `scan-receipt`.** One call takes 1–3 ordered image parts. MEASURED: 3 realistic parts fit every limit with room to spare. **Revised 2026-09-27:** the bake-off picks **`claude-sonnet-5`, high-res tier, thinking disabled**. Single photos are ready. Multi-photo is unproven either way: the only evidence is two receipts whose inputs are in doubt. |
| 4 | Library picker | Already in every binary. `recipeImageCapture.ts` is the camera-or-library template. The meal path has no library option yet. The capture screen collects 1–3 ordered parts, and a scan counts once against the hourly limit (READ). |
| 5 | Schema | No money tables or columns anywhere. Migration, three RPCs (`save_receipt`, `update_receipt`, `delete_receipt`), verification SQL and gate tests are below. |
| 6 | Money | Nothing stores or formats money. A locale-free `money.ts` is needed, following the Trends precedent that bans `toLocaleString`. |
| 7 | Privacy | Nothing is persisted by the function, and client Sentry reports carry only code/name. Two gaps: `reportError`'s `extra` and uncaught-exception messages. Needs a prompt exclusion, a server redaction pass and a guard test. |
| 8 | Structural guards | The `meal_entries` AST test can't see receipts and doesn't need to. Add a sibling guard, including "receipt code never touches `meal_entries`". |
| 9 | OTA vs build | **MEASURED:** runtime `c1907ba4…` (Android) / `5359dcce…` (iOS), and no `src/` or `supabase/` file is a fingerprint source. PREDICTED OTA-eligible, provided `app.json` isn't touched. Order: db push → function deploy → OTA. |

Seven out-of-scope candidates are listed at the end. **Revised 2026-09-26:** C is now filed and fixed as PL-050. B was already filed as PL-026, which I missed the first time.

---

## 1. Batches tab

### What it contains today (READ)

- **One job:** a list of compositions with `kind === "batch"` ([BatchesScreen.tsx:73](src/screens/BatchesScreen.tsx#L73)). Bundles are deliberately excluded and live in Today's sheets ([:4-9](src/screens/BatchesScreen.tsx#L4-L9)).
- **Header:** the title, plus one green pill, "＋ New", that opens `BatchEditor` ([:122-132](src/screens/BatchesScreen.tsx#L122-L132)).
- **Empty state:** the explainer "A batch is a recipe…" and a "Create a batch" button ([:146-164](src/screens/BatchesScreen.tsx#L146-L164)).
- **Rows:**
  - A tap opens the editor ([:177-181](src/screens/BatchesScreen.tsx#L177-L181)).
  - A long-press deletes ([:182](src/screens/BatchesScreen.tsx#L182)).
  - "Log" opens `ScheduleBatchSheet`, a date/time sheet that calls `applyBatchNow`, which writes `meal_entries` ([:78-102](src/screens/BatchesScreen.tsx#L78-L102), [:238-398](src/screens/BatchesScreen.tsx#L238-L398)).
- **Navigation:** a bottom tab. The root stack pushes `BatchEditor`, `BatchIngredientPicker`, `RecipeScan` and `RecipeConfirm` as modals ([AppNavigator.tsx:111-115](src/navigation/AppNavigator.tsx#L111-L115), [:212-243](src/navigation/AppNavigator.tsx#L212-L243)).
- **Tab order is pinned** by [tabStructure.test.ts:124](src/navigation/__tests__/tabStructure.test.ts#L124). Neither placement adds a tab, so that test is unaffected.

### Does a receipt entry point fit?

Physically, yes. The header has room for a second control. **I recommend against it, for three reasons:**

1. **Semantics.**
   - Every action on Batches ends in a `meal_entries` write (Log) or builds something that will (New).
   - A "Scan receipt" button beside "＋ New" tells the user a receipt becomes food here. v1 deliberately does the opposite.
   - That's the expectation that would generate the first tester report ("I scanned my shop but nothing appeared in my batches").
2. **Crowding.**
   - The header is a title and one pill. Two green pills at 360 dp compete, and "＋ New" is the tab's primary action.
   - The empty-state explainer is about recipes, so a receipt CTA there would need its own explainer on a screen that isn't about spending.
3. **Distance from the result.** The spending shows on Data. Capturing on Batches and reading on Data puts the action two tabs from its outcome.

### Recommendation

**Put the only entry point on the Data tab's Spending segment:**

- a "Scan a receipt" action in the segment header;
- the same action as the empty-state CTA.

Capture sits beside the thing it feeds, and Batches stays single-purpose.

If you still want Batches for discoverability, use a **secondary text row under the list**, not a second header pill: "Track food spending → Data". It navigates to Data/Spending rather than launching capture. That keeps one entry flow.

---

## 2. Data tab — Revised 2026-09-26

### Current structure (READ)

**[DataScreen.tsx](src/screens/DataScreen.tsx)** (90 lines):

- a title and a `SegmentedControl` with two options, History and Trends ([:32-37](src/screens/DataScreen.tsx#L32-L37), [:44-54](src/screens/DataScreen.tsx#L44-L54));
- no nested navigator, on purpose, to protect the OTA fingerprint ([:5-9](src/screens/DataScreen.tsx#L5-L9));
- always opens on History ([:11-16](src/screens/DataScreen.tsx#L11-L16)).

**History ([HistoryScreen.tsx](src/screens/HistoryScreen.tsx)), rendered with `embedded`:**

| Element | Source | Notes |
|---|---|---|
| Range pill, 7 / 30 days | [:157-171](src/screens/HistoryScreen.tsx#L157-L171) | Green "on" style |
| Daily average card: 4 big macros + 4 small | [:175-244](src/screens/HistoryScreen.tsx#L175-L244) | Averages over days with ≥1 eaten row |
| "N of D days logged", "% on goal" | [:180-187](src/screens/HistoryScreen.tsx#L180-L187), [:127-134](src/screens/HistoryScreen.tsx#L127-L134) | ±10% of `goals.calories` |
| Daily breakdown rows | [:257-358](src/screens/HistoryScreen.tsx#L257-L358) | Tap → `setViewedDate` + Today tab |
| Data | `getDaySummaryForDate` over the store's `entries` | Eaten only; pending shown separately ([:50-79](src/screens/HistoryScreen.tsx#L50-L79)) |

**Trends ([TrendsPanel.tsx](src/components/TrendsPanel.tsx)):**

- a range toggle for 7 / 14 days, styled differently from History's pill ([:128-146](src/components/TrendsPanel.tsx#L128-L146), [:214-235](src/components/TrendsPanel.tsx#L214-L235));
- a nutrient chip picker capped at `MAX_SELECTED` ([:149-178](src/components/TrendsPanel.tsx#L149-L178));
- one `TrendChart` per nutrient ([:185-189](src/components/TrendsPanel.tsx#L185-L189));
- a targets-loading note ([:191-197](src/components/TrendsPanel.tsx#L191-L197));
- all aggregation in `lib/trends.ts`, with preferences remembered per user.

**Queries:** none are Data-specific. Both segments read the store's `entries`, which come from the unbounded `fetchEntries` ([useStore.ts:638-649](src/store/useStore.ts#L638-L649)). The CSV export is in **Settings**, not Data ([SettingsScreen.tsx:571-585](src/screens/SettingsScreen.tsx#L571-L585)).

### What's stale, duplicated or awkward (READ)

1. **Two range controls with different vocabularies.**
   - History offers 7/30 in a green pill with the header row. Trends offers 7/14 in a grey pill, right-aligned on its own row.
   - Switching segments moves the control and changes both its options and its look.
2. **History and Trends disagree about unknown macros.**
   - History coalesces a day's null small-four to 0 before averaging ([:66-72](src/screens/HistoryScreen.tsx#L66-L72), averaged at [:96-107](src/screens/HistoryScreen.tsx#L96-L107)).
   - Trends draws no point for the same null ([trends.ts:826-830](src/lib/trends.ts#L826-L830)).
   - So the same week gives two answers, and History's is dragged down by days where fibre was never known. This is a real bug; see candidate **A**.
3. **"% on goal" ignores whether the goals loaded** ([:127-134](src/screens/HistoryScreen.tsx#L127-L134)). Trends checks `goalsState`. See candidate **B**.
4. **Dead code path.**
   - `HistoryScreen` still carries a non-embedded mode with its own SafeAreaView and heading ([:26-35](src/screens/HistoryScreen.tsx#L26-L35), [:139-154](src/screens/HistoryScreen.tsx#L139-L154)).
   - Its only caller passes `embedded` (grep: [DataScreen.tsx:56](src/screens/DataScreen.tsx#L56) is the only import).
5. **Hand-rolled date keys.**
   - `dayArray` and `fmtDate` build `YYYY-MM-DD` with `padStart` three times ([:44-48](src/screens/HistoryScreen.tsx#L44-L48), [:114](src/screens/HistoryScreen.tsx#L114), [:117](src/screens/HistoryScreen.tsx#L117)) instead of `dateKey()`.
   - They're correct today because they use local getters, but they're three more places the date invariant has to be re-checked.
6. **Inline number formatting.**
   - History uses `.toFixed` and `Math.round` inline ([:84-108](src/screens/HistoryScreen.tsx#L84-L108), [:301](src/screens/HistoryScreen.tsx#L301), [:326-337](src/screens/HistoryScreen.tsx#L326-L337)).
   - Trends is locked by test to a single `formatNutrientValue` ([trendsUi.test.ts:251-271](src/components/__tests__/trendsUi.test.ts#L251-L271)).
   - So the two segments can format the same number differently.
7. **The export sits in Settings.** It's a data action, and a spending CSV would be a second one.

### Recommended layout — Revised 2026-09-26

**Naming.** The segment label stays "Spending", because the control is capped at 220 dp. The section it opens is titled **"Grocery spending"** (decision 1). The printed total includes non-food items, and the name says so.

`Data`: a `History | Trends | Spending` segmented control, still opening on History and still with no nested navigator.

- **One shared range control component.** Each segment passes its own option set: History 7/30, Trends 7/14, Spending Week/Month. They share one style and one position, top-right under the segmented control.
- **History:** unchanged content. The average card uses the null-honest rule, "—" or a partial count, never a coalesced 0. Adherence shows "—" until `goalsState === "loaded"`.
- **Spending** (new), top to bottom:
  1. A header with the range control (This week / This month) and a "Scan a receipt" action.
  2. A headline card: the total for the period in the dominant currency, with "N receipts". A second line appears only if receipts in another currency exist; currencies are never summed.
  3. A disclosure when needed: "2 receipts have no readable total", listed rather than counted as £0.
  4. **By store:** rows of store → total → receipt count, sorted by total. Null store shows as "Unknown store".
  5. **Receipts:** newest first. Each row shows date, store, total, and a reconcile badge when lines ≠ total. **A tap opens the review screen in edit mode** (decision 3), with Save and Delete.
     - The list is read with the PL-050 pager (`fetchAllPages`, ordered `purchased_on desc, id desc`), not an unpaged select. The bug PL-050 fixed shouldn't be reintroduced in a new table.
  6. A footer action, "Export spending (CSV)".
- **Export:** keep meal export in Settings for now. Moving it is a separate UX decision; don't bundle it.

**PREDICTED:** the three-label control fits the `maxWidth: 220` wrap ([DataScreen.tsx:84-88](src/screens/DataScreen.tsx#L84-L88)) at 360 dp. That's about 70 dp per option at `Typography.xs`. Check on the Pixel before the tidy commit lands.

---

## 3. scan-meal-photo, and what a receipt needs — Revised 2026-09-26

### Current shape (READ, [supabase/functions/scan-meal-photo/index.ts](supabase/functions/scan-meal-photo/index.ts))

| Aspect | Detail |
|---|---|
| Request | `POST { imageBase64, mediaType?, user_dish_label? }` ([:434-446](supabase/functions/scan-meal-photo/index.ts#L434-L446)); no `mode` field |
| Limits | base64 ≤ 6,800,000 chars (413 above), media type in jpeg/png/webp ([:448-460](supabase/functions/scan-meal-photo/index.ts#L448-L460)) |
| Auth | `verify_jwt` default, plus `getCallerId` via `auth.getUser()` → 401 ([:419-422](supabase/functions/scan-meal-photo/index.ts#L419-L422), [_shared/auth.ts:26-43](supabase/functions/_shared/auth.ts#L26-L43)) |
| Rate limit | 20/hour per user, counted from `ai_extractions`. **Fails open** if the count query errors ([:464-484](supabase/functions/scan-meal-photo/index.ts#L464-L484)). Shared with the label and recipe scanners. |
| Model | `Deno.env.get("MODEL") ?? "claude-haiku-4-5-20251001"` ([:50](supabase/functions/scan-meal-photo/index.ts#L50), [:429](supabase/functions/scan-meal-photo/index.ts#L429)). **`MODEL` is one project-wide secret read by all three AI functions.** |
| Call | Raw `fetch`, 30 s abort, `max_tokens: 1024`, forced `tool_choice` ([:492-535](supabase/functions/scan-meal-photo/index.ts#L492-L535)) |
| Prompt | Dietitian estimating a plate. Rule 7 ignores printed labels; rule 5 assumes home-style portions ([:141-159](supabase/functions/scan-meal-photo/index.ts#L141-L159)). Correction addendum at [:170-176](supabase/functions/scan-meal-photo/index.ts#L170-L176). |
| Output | `MealScanSuccess`: dish, portion, per-100 g derived server-side, confidence, notes ([:198-238](supabase/functions/scan-meal-photo/index.ts#L198-L238)). Mirrored by hand in [mealRecognition.ts](src/lib/mealRecognition.ts) and shape-checked at [:215](src/lib/mealRecognition.ts#L215). |
| Errors | `fail(code, userMessage, status)`, and upstream text never goes to the user ([_shared/cors.ts:36-45](supabase/functions/_shared/cors.ts#L36-L45)). Codes: unauthorized, bad_request, rate_limited, no_food, model_error, server_error. The client digs the body out of `error.context` ([mealRecognition.ts:133-155](src/lib/mealRecognition.ts#L133-L155)). |
| Telemetry | One `ai_extractions` row: user, outcome, model, tokens, ms. No content ([:385-407](supabase/functions/scan-meal-photo/index.ts#L385-L407)). |
| `stop_reason` | **Never read**, here or in the other two AI functions (grep for `stop_reason` in `supabase/functions` has no hits). |

### PL-036 menu mode on master (READ)

**Not started.**

- There's no `mode` field in the function, and no library option in `mealPhotoCapture.ts`, which is still camera-only ([:12-13](src/lib/mealPhotoCapture.ts#L12-L13), [:36-57](src/lib/mealPhotoCapture.ts#L36-L57)).
- No branch holds it (`git branch -a`: `feat/trends-axes` and `fix/friend-copy-one-path` only).
- The register row reads "Agreed … Edge Function deploy before the OTA" ([testing/README.md:107](testing/README.md)). The agreed design is in [docs/2026-09-21-tester-findings.md](docs/2026-09-21-tester-findings.md) § PL-036.
- **Nothing to reuse yet.** The "plumbing" the brief refers to is a plan.

### `mode: "receipt"` vs a sibling function — Revised 2026-09-26 (decided)

PL-036's `mode: "menu"` works as a mode because **its tool schema and response contract are unchanged**. It's still a dish estimate, and only the addendum differs. That's the same rule scan-recipe's two modes follow: "one tool, one schema … only the `messages` content block differs" ([scan-recipe/index.ts:8-16](supabase/functions/scan-recipe/index.ts#L8-L16)).

A receipt fails that test on every axis:

| | Meal / menu | Receipt |
|---|---|---|
| Request | One image | 1–3 ordered image parts |
| Tool schema | dish, portion, 8 macros | store, date, total, currency, lines[] with a part index |
| Response contract and client mirror | `MealScanSuccess` | New type, new shape check |
| Task | Estimate | Transcribe printed figures |
| Error vocabulary | `no_food` | `no_receipt`, `too_long` |
| `max_tokens` | 1024 is enough | Up to about 12k for a 3-part, 150-line receipt (PREDICTED, below) |
| Image tier | 1568 px is fine for a plate | High-res tier, sized to its token cap (below) |
| Model | Haiku | `claude-sonnet-5`, thinking disabled (bake-off, Revised 2026-09-27) |

**Decided (decision 5): a new sibling function, `supabase/functions/scan-receipt/`,** a sibling of `_shared` per CLAUDE.md. It reuses:

- `_shared/cors.ts` and `_shared/auth.ts` unchanged;
- the `ai_extractions` bucket, so receipts count toward the same 20/hour (§4 confirms a 3-part scan is one count);
- the telemetry insert, with explicit snake_case;
- the client `readErrorBody` pattern.

It gets its own `RECEIPT_MODEL` secret, falling back to its own default and never to `MODEL`, plus its own limits.

**Candidate E lands in the same commit.** The "bump via the MODEL secret, no redeploy needed" comments in the three existing AI functions are replaced with a warning: forced `tool_choice` is a 400 on Claude Opus 5.5 and Claude Fable 5.1, and Sonnet 5's default adaptive thinking counts toward `max_tokens`. The sites are [scan-meal-photo/index.ts:48-49](supabase/functions/scan-meal-photo/index.ts#L48-L49), [scan-recipe/index.ts:54-55](supabase/functions/scan-recipe/index.ts#L54-L55) and [extract-nutrition-label/index.ts:46-47](supabase/functions/extract-nutrition-label/index.ts#L46-L47). The last names `claude-sonnet-5` explicitly, at `max_tokens: 2048` ([:496](supabase/functions/extract-nutrition-label/index.ts#L496)), which is exactly the adaptive-thinking truncation case. It's a comment-only change to those three, so no redeploy is needed.

### What makes printed figures unreliable — Revised 2026-09-26, 2026-09-27

**Image:**

- Thermal paper fades, curls and glares (PREDICTED).
- **A camera photo is a 3:4 frame, not a strip.** `allowsEditing: false` means no crop, so a receipt photo is the full camera frame with the receipt somewhere in it. `prepareImage` resizes the long edge ([imagePrep.ts:32](src/lib/imagePrep.ts#L32)).
- **The model's token cap binds before its long-edge limit on a 3:4 frame.** READ from the Anthropic vision docs, fetched 2026-09-26: an image costs ⌈w/28⌉ × ⌈h/28⌉ visual tokens and is downscaled past either limit. The limits are 1568 px / 1568 tokens on the standard tier (Haiku 4.5) and 2576 px / 4784 tokens on the high-res tier (Claude 4.7 and later, including Sonnet 5).

  | Prepared size (3:4) | Visual tokens | Standard tier | High-res tier |
  |---|---|---|---|
  | 1176 × 1568 (today's `MAX_EDGE`) | 2,352 | Downscaled again, to about 1270 long edge | Kept |
  | 952 × 1270 | 1,564 | **Largest that is kept** | Kept |
  | 1659 × 2212 | 4,740 | — | **Largest that is kept** |
  | 1932 × 2576 | 6,348 | — | Downscaled again, to about 2212 |

  So Haiku reads a 3:4 photo at about **1270 px**, not 1568, and Sonnet 5 at about **2212 px**, not 2576. Pixels above those are uploaded and then thrown away.

  - **Revised 2026-09-27:** the standard-tier row said 945 × 1260 (1,530 tokens). The bake-off harness's exact search over rounded sizes found **952 × 1270 (1,564 tokens)** is the largest 3:4 size kept. The standard tier is no longer used for receipts (§3, commit 0), but `fitToVisionBudget` still implements both tiers.
  - **Recommendation:** a pure `fitToVisionBudget(w, h, tier)` in `imagePrep.ts` that implements the documented rule for both limits, instead of a single `MAX_EDGE`.
  - **It never upscales (Revised 2026-09-27).** An image within both limits is sent at its own size. A 1080 × 2400 screenshot (3,354 tokens, long edge 2400) is **unchanged** on the high-res tier. The earlier "1159 × 2576" figure is what a *larger* tall screenshot (such as 1440 × 3200) is scaled to, where the long edge binds.
  - The `imagePrep.ts` header's "downscales anything over 1568px on the long edge" is incomplete for 3:4 photos. It's a comment fix; the meal photo is unaffected in practice.
- **Legibility (PREDICTED):** a 50 cm receipt filling the frame height at 2212 px is about 4.4 px/mm, roughly 11 px per 2.5 mm character; at 1270 px, about 6 px.
  - This is why multi-image is in v1 (decision 2). Three overlapping parts of a 50 cm receipt give each part about 17–20 cm of receipt height, so about 11–13 px/mm on the high-res tier.

**Layout:**

- **Discounts appear in three forms.**
  - As a separate line under the item ("CLUBCARD PRICE -0.50" or "0.50-", with the minus as a suffix).
  - As a multibuy saving in a block at the end ("3 FOR £5 SAVING 1.25").
  - As a total-savings summary line that must **not** also be counted.
- **Quantity lines are split:** "2 @ £1.25" on its own line under the item.
- **Weighed items have non-integer quantities:** "0.512 kg @ £2.20/kg". So `qty` must be numeric, not an integer, and `unit_price` is sometimes per kg.
- **VAT code letters sit after prices** ("1.50 A", "1.50 *"), and can be read as digits.
- **Voids** ("ITEM VOID", "CANCELLED") produce negative lines. **Revised 2026-09-27, MEASURED:** Sainsbury's prints a void as the item line, then `ITEM CANCELLED` and a negative line of the same amount. Every arm listed both. Spec: **keep both** (it's what's printed and the user can see it), with the cancel line negative and `is_discount: true`, so the lines still add up. The pair nets to 0 items.
- **Loyalty prices are real discounts (Revised 2026-09-27, MEASURED).** Sainsbury's prints `Nectar Price Saving -0.75` under the item. It's a discount line and must be kept, not dropped as a loyalty line (see the redaction fix below).
- **Several figures compete for "the total":** SUBTOTAL, TOTAL, BALANCE DUE, TOTAL SAVINGS, the card payment amount, CHANGE and CASHBACK. Cashback in particular makes the card amount exceed the goods total. The one wanted is **the amount due for goods after all savings.**
- **Non-food lines:** carrier bags, toiletries, household goods and gift cards. Decision 1 names the section "Grocery spending" rather than classifying lines.
- **Dates:** "25/09/26" is DD/MM/YY in the UK, and an ambiguous day ≤12 can be read either way by a US-biased model. Some receipts print only a time on the header and the date at the foot.
- **Currency:** NI and ROI receipts can be in €. Mixed currencies must never be summed.
- **Seams (multi-image):** each overlap of "a line or two" is read twice, once at the bottom of part *k* and once at the top of part *k+1*. A line cut through by the frame edge may be half-legible in both, or in neither.

**Number handling.** The model returns every amount as the **string exactly as printed** ("12.30", "0.50-"). The server parses it with one strict function into integer pence, and an unparseable string gives NULL. This is the house rule: *the model transcribes, the server calculates* ([scan-meal-photo/index.ts:17-23](supabase/functions/scan-meal-photo/index.ts#L17-L23)).

### Receipt mode spec — Revised 2026-09-26, 2026-09-27

**Request (client → `scan-receipt`):**

```
POST { parts: [{ imageBase64: string, mediaType: "image/jpeg" }, ...] }   // 1..3, in receipt order
```

- **One Messages call, no stitching.**
  - Each part is sent as its own `image` block, preceded by a short text label (`Part 1 of 3:`), following the vision docs' guidance for multiple images.
  - The final text block carries the instruction.
  - The client never stitches images together: stitching needs overlap alignment that the model already does better, and a stitched strip would hit the long-edge cap again.
- **Part count:**
  - 0 parts → `bad_request` (400).
  - **4 or more → `too_long` (413)** (decision 2), with "Photograph long receipts in up to 3 overlapping parts".
  - Both are rejected before the rate-limit check, so they don't count (as with `bad_request` today, [scan-meal-photo/index.ts:448-460](supabase/functions/scan-meal-photo/index.ts#L448-L460)).

**Tool schema (forced tool, `additionalProperties: false`):**

```
recognisable:  boolean           // false: not a till receipt / unreadable
same_receipt:  boolean           // false if the parts look like different receipts
store_name:    string | null     // from part 1 — chain or brand ONLY, no address/branch/phone
purchase_date: string | null     // from part 1 (or the foot, if only printed there) — YYYY-MM-DD, only if unambiguous
currency:      "GBP" | "EUR" | null
total_printed: string | null     // amount due for goods after all savings, as printed
total_printed_part: integer | null  // which part it was read from
lines: Array<{
  part:       integer            // 1-based part the line was read from
  raw_text:   string             // one physical item line, as printed
  qty:        string | null
  qty_unit:   "each" | "kg" | null
  unit_price: string | null
  line_total: string | null      // as printed, including a trailing "-"
  is_discount: boolean
}>
```

**Prompt rules, in priority order:**

1. **Transcribe; don't compute or correct.** If a figure is unreadable, return null. Never guess a digit, and never make lines add up to the total.
2. **Parts.**
   - The images are consecutive parts of ONE receipt, top to bottom. Each overlaps the next by a line or two.
   - **List every physical item line exactly once.** A line that appears in the overlap of two parts is listed once, from the part where it is fully legible, with that `part`.
   - If the parts don't look like the same receipt, set `same_receipt: false`.
   - **Revised 2026-09-27, unproven, so it's settled before commit 3.** On multi-photo receipts Sonnet 5's lines added up in 3 of 8 reads, against 13 of 14 per arm on single photos. But six of the eight reads are r08, whose ground truth is in doubt, and the other two are r10, whose photo order is in doubt (commit 0). So this rule isn't shown to fail, and it isn't shown to work either. Commit 3's prompt may need more about overlap. For example: "Before listing the first lines of part k+1, find the last line you listed from part k in it, and continue after it." Settle it by re-running the multi-photo arm on about four new multi-photo receipts, with clean inputs.
   - **DRAFT — Revised 2026-10-04, shipped in commit 3 pending the multi-photo re-run.** Commit 3 went ahead before the extra multi-photo receipts, because the prompt can be redeployed without an OTA and nothing calls the function until the UI ships. So `SYSTEM_PROMPT` rule 2 in `supabase/functions/_shared/receipt.ts` carries the overlap guidance above as a first draft: *"Before you list the first lines of part k+1, find in part k+1 the last line you listed from part k, and continue after it: the lines before it in part k+1 are the overlap and were already listed."* It's unmeasured. Re-run the bake-off's multi-photo arm with this exact prompt on the new receipts, then keep, revise or drop it, and redeploy `scan-receipt` if it changes.
   - The same prompt also carries rule 4's loyalty-price-saving clause and rule 5's voids clause (both Revised 2026-09-27). Those are measured: every bake-off arm already behaved that way.
3. **Header and total.**
   - Store and date come from part 1: the header.
   - `total_printed` comes from **the last part that shows one**, with its part number in `total_printed_part`.
4. **Item and discount lines only. EXCLUDE:**
   - payment and tender lines (card type, masked or full card numbers, AID, auth codes, merchant/terminal IDs);
   - change, cash, cashback;
   - loyalty-card numbers, points balances, member names;
   - VAT summary tables;
   - store address, phone, VAT number, till/operator/transaction numbers, barcodes and QR text;
   - total-savings summary lines.
   - **Revised 2026-09-27:** a price saving named after a loyalty scheme (`Nectar Price Saving -0.75`, "Clubcard Price") is **not** a loyalty line. It's a discount, rule 5.
5. **Discounts** are their own lines with `is_discount: true`, including multibuy savings printed at the end. **Revised 2026-09-27:** so is a void's cancel line (`ITEM CANCELLED` and its negative amount). List the voided item and its cancel line both.
6. **`total_printed`** is the final amount due for goods (after savings), not SUBTOTAL and not the card or cash tendered.
7. **Dates** are UK DD/MM unless the receipt clearly shows otherwise. If the day and month are ambiguous, return null rather than guess.
8. If a part is cut off, return what's visible. The client warns when lines don't reconcile.

**Server validation, deterministic and unit-tested** (in `_shared/receipt.ts`, so vitest can import it; `_shared/__tests__/whoop.test.ts` is the precedent):

- **`parsePence(s)`:**
  - strict pattern: an optional leading `-` or trailing `-` (never both), an optional `£`/`€`, 1–5 digits, `.`, exactly 2 digits;
  - no float arithmetic (split on ".");
  - `is_discount` forces the sign to ≤ 0.
  - **Decided cases:** `"-0.50-"` → null (both minus forms at once); `"1,234.56"` → null. A thousands comma isn't accepted; the review screen shows the field empty for the user to type. The full table is in commit 2.
- **Line caps:** at most 150 lines across all parts (more → `too_long`); `raw_text` trimmed, 1–120 characters, empty lines dropped.
- **`part`:** an integer in 1..n, else the line's `part` becomes null. Parts must be non-decreasing down the list; if not, add a note ("Lines may be out of order at a join").
- **Redaction pass on `raw_text` and `store_name`** (defence in depth, §7):
  - digit runs of 4+ preceded by `*`, `X` or `#`;
  - runs of 12+ digits with optional spaces;
  - UK postcodes;
  - any line matching tender keywords (`VISA|MASTERCARD|AMEX|CONTACTLESS|CARD NO|AID|AUTH|CHANGE|CASHBACK`) is dropped, not redacted;
  - **Revised 2026-09-27:** a line with a loyalty keyword (`CLUBCARD|NECTAR|POINTS`) is dropped **only when it also carries an identifier**: a 4+ digit run, "card no", or "points balance". The first rule dropped any `NECTAR` or `POINTS` line. That would delete Sainsbury's `Nectar Price Saving` discounts (MEASURED on real receipts) and break reconcile. The bake-off harness's leak check already works this way.
- **`store_name`:** at most 60 characters, postcode stripped.
- **`purchase_date`:**
  - a real calendar date (round-trip through `Date.UTC` fields, **not** `new Date("YYYY-MM-DD")`);
  - not more than 1 day after server UTC today;
  - not before 2 years ago;
  - otherwise null.
- **`currency`:** from the enum, else null.
- **`same_receipt: false`** → `no_receipt` (422), with "These photos look like they're from different receipts".
- **`total_printed_part`:** in 1..n, else null. If n > 1 and it's less than n, add a note: "Total read from part k of n — check it's the final total".
- **Seam check: flag, never delete.** For each join between part *p* and part *p+1*, compare the last 1–2 lines read from *p* with the first 1–2 lines read from *p+1*.
  - If a suffix of *p* equals a prefix of *p+1*, with equal normalised `raw_text` (case, spacing, VAT letters stripped) **and** equal non-null `line_total_pence`, the *p+1* copies get `possibleSeamDuplicate: true`.
  - **Why only flag.** Two identical consecutive lines are also a genuine purchase (two bananas scanned separately print as two identical lines). The server can't tell a seam echo from a repeat purchase; only the person holding the receipt can.
  - **Why only across a join.** Within one part, identical adjacent lines are never flagged, because the model can't have read the same printed line twice inside one image.
- **Reconcile is the safety net for what the flag can't see:** a line dropped at a seam shows as "lines are under the total", and a duplicate the flag missed (say, a different `line_total` reading) as "over".
- **`stop_reason === "max_tokens"`** → `fail("too_long", …)`. **Never return a truncated `lines` array** (candidate D).
- **`recognisable: false`** → `no_receipt` (422).

**Review-screen treatment of a flagged line (recommended):**

- The line is **kept, but marked**: an amber tag reading "Possible repeat at the join between photos 1 and 2", with a one-tap Remove.
- The reconcile banner links the two. When lines exceed the total by exactly the sum of the flagged lines, it says "Lines are £0.85 over the total — the same as the flagged possible repeat."
- Keeping by default means a real repeat purchase is never silently lost. The banner makes removing a real seam echo a single, well-evidenced tap.
- The flag is **not stored** (no `part` or flag column); it only lives in the draft. Edit mode, loaded from saved rows, has no parts and no flags.

**Size limits — MEASURED 2026-09-26, bounded proxies.** I don't have real receipt photos, so this uses synthetic proxies:

- **The proxies:** a 3072×4096 frame (the 12.5 MP 3:4 camera output) with a textured worktop background, a rotated receipt strip covering about 38% of the width, rows of item text and prices, and Gaussian sensor noise.
- **The processing:** resized with LANCZOS on the long edge and encoded as JPEG quality 85 in Pillow 12. That approximates `prepareImage`'s manipulator, not byte-for-byte.
- **The bound:** a pure-noise frame is the practical upper bound, since no photograph compresses worse than noise.
- **The script:** `jpegsize.py` in the session scratchpad.

| Proxy | Long edge | Base64 chars, 1 part | 2 parts | 3 parts |
|---|---|---|---|---|
| Receipt, sensor noise σ=3 | 1288 | 146,032 | 292,064 | 438,096 |
| Receipt, sensor noise σ=3 | 2268 | 400,872 | 801,744 | 1,202,616 |
| Receipt, sensor noise σ=3 | 2576 | 520,488 | 1,040,976 | 1,561,464 |
| Receipt, heavy noise σ=10 | 1288 | 213,208 | 426,416 | 639,624 |
| Receipt, heavy noise σ=10 | 2268 | 790,984 | 1,581,968 | 2,372,952 |
| Receipt, heavy noise σ=10 | 2576 | 1,081,892 | 2,163,784 | 3,245,676 |
| Pure noise (upper bound) | 1288 | 663,680 | 1,327,360 | 1,991,040 |
| Pure noise (upper bound) | 2268 | 2,888,564 | 5,777,128 | 8,665,692 |
| Pure noise (upper bound) | 2576 | 3,959,500 | 7,919,000 | 11,878,500 |

(Measured at 1288 and 2268; the recommended 1260 and 2212 are slightly smaller. 2- and 3-part columns are the 1-part figure × 2 and × 3.)

**The limits these are measured against:**

| Limit | Value | Source |
|---|---|---|
| App guard per image today | 6,800,000 chars | [imagePrep.ts:54](src/lib/imagePrep.ts#L54), [scan-meal-photo/index.ts:53](supabase/functions/scan-meal-photo/index.ts#L53) |
| Anthropic, per image | 10 MB base64 (Claude API direct) | Vision docs, "Request limits", fetched 2026-09-26 |
| Anthropic, per request | 32 MB | Same page, linking the API overview's request size limits |
| Supabase Edge Function request body | **Not documented** | [supabase.com/docs/guides/functions/limits](https://supabase.com/docs/guides/functions/limits), fetched 2026-09-26. Documented: 256 MB memory, 150 s idle timeout, 150 s (free) / 400 s (paid) wall clock, 2 s CPU. |

**Real photos — MEASURED 2026-09-27 (Revised).** The bake-off prepared 15 real phone photos of 13 receipts. The harness uses Pillow, LANCZOS, JPEG quality 85, and the exact vision-budget fit, which approximates `prepareImage` rather than matching it byte for byte.

| Tier | Heaviest single part | Heaviest request (3 parts) |
|---|---|---|
| High-res (1659–1666 × 2212) | **933,208 chars** | **2,244,212 chars** |
| Standard (952 × 1265–1270) | 351,140 chars | 846,484 chars |

- The real photos are about 10–18% heavier than the heaviest realistic proxy at a similar size (791k), as predicted, and well below the pure-noise bound.
- The heaviest part is **27% of 3.5M**, under the "revisit above about a third" line. The heaviest request is 25% of 9M. **The limits below are confirmed, no longer provisional.** Nothing needs raising and quality doesn't need to drop.

**Proposal — was PROVISIONAL until commit 0 re-measured real photos; confirmed 2026-09-27 (above).** The proxies are clean renders plus Gaussian noise. A real phone photo of crumpled, curled thermal paper, with glare and background texture, compresses worse. The limits below are fixed only after the bake-off measures the base64 size of your real photos at the chosen size, **especially the multi-photo receipts**. If the heaviest real part is more than about a third of 3.5M, raise the per-part cap or lower the quality before fixing the numbers.

- **Per part:** `MAX_PART_BASE64_CHARS = 3,500,000`.
  - That's 3.2× the heaviest realistic proxy (heavy noise at 2576, 1.08M), and above the pure-noise bound at the recommended 2212 px (under 2.89M).
  - `prepareImage("receipt")` re-encodes once at quality 0.7 if a part exceeds it, then fails with `prep_failed`.
- **Total:** `MAX_TOTAL_BASE64_CHARS = 9,000,000`, checked on the client before invoking and again in the function (413).
- **Neither quality nor edge needs to drop for 3 parts.** The heaviest realistic 3-part request is 2.4M chars at 2268 px, 27% of the total cap. Only three pure-noise frames at 2576 px (11.9M) would exceed it, and 2576 is above the useful size anyway.
- **The undocumented Supabase body limit must be MEASURED, not assumed.** Commit 3's smoke test posts a 9.0M-char body to the deployed function and must get the function's own response (200 or its own 413), not a platform 413 or 502.
- The CPU limit is **PREDICTED** not to bind: `req.json()` on 9 MB is I/O-dominated and the model call is async. That's confirmed only by the same smoke test.

**Tokens, `max_tokens` and timeout — PREDICTED, confirmed by the bake-off:**

| | 1 part | 3 parts |
|---|---|---|
| Visual tokens, high-res at 1659×2212 | 4,740 | 14,220 |
| Visual tokens, standard at 952×1270 | 1,564 | 4,692 |
| Prompt + tool schema | about 1.5–2k | about 1.5–2k |
| Output | about 45–55 tokens per line with `part` (Sonnet 5's tokenizer is about 30% heavier). A 60-line shop is about 3.3k; the 150-line cap is about 8.3k. | |

**MEASURED by the bake-off (Revised 2026-09-27):**

- **Input tokens on Sonnet 5:** 6,402 for 1 part, 11,165 for 2, and 15,918 for 3.
- **Output on Sonnet 5 is about 71 tokens per line**, consistently: 5,693 for 80 lines, 3,952 for 55, 3,342 for 47. That's heavier than the prediction above, which it replaces. **So the 150-line cap is about 10.7k output tokens**, and the largest seen was 5,897. There were no `max_tokens` stops in 57 calls.
- **Latency:** Sonnet 5 took 3–23 s for 1 part, about 28 s for 2 and 38–39 s for 3 (80+ lines). At the measured ~150 output tokens/s, a 150-line receipt is about **75 s**. That's inside `ANTHROPIC_TIMEOUT_MS = 120_000` and the 150 s idle timeout, so **the keys don't need compacting and the line cap stays at 150.**

- **`max_tokens` — Revised 2026-09-27: 16,000, with thinking disabled.** At about 10.7k for 150 lines plus the header, 12,000 leaves under 10% margin, too thin for a measured rate taken from 13 receipts. 16,000 was already judged within the non-streaming guidance. (It was 12,000 without thinking, or 16,000 with adaptive thinking, which counts toward `max_tokens`.)
- **Latency:** output-bound. At about 60–90 output tokens/s, a 60-line receipt is about 40–55 s, and a 150-line receipt about 90–140 s.
  - The upper end is close to Supabase's documented **150 s request idle timeout**. The function sends nothing until the model returns, so the connection is idle the whole time.
  - So: `ANTHROPIC_TIMEOUT_MS = 120_000`, and the bake-off must record p95 latency for the longest receipt. (MEASURED above: 39 s for the longest.)
  - If p95 is over about 110 s, shorten the output keys (`t`/`q`/`u`/`p`/`d`), which cuts about 30% of output tokens, or lower the line cap to 120. Don't raise the timeout.

**Other settings:**

- **Model — decided by the bake-off, Revised 2026-09-27:** `RECEIPT_MODEL` defaults to **`claude-sonnet-5`**, with images sized for the **high-res tier**. The request sets **`thinking: { type: "disabled" }` explicitly**, because omitting `thinking` on Sonnet 5 runs adaptive thinking. Adaptive thinking bought nothing measurable (commit 0), and disabling it keeps the `max_tokens` budget for output.
- **Telemetry:** one `ai_extractions` row per request, whatever the part count (§4). Outcomes stay inside the existing set (`success | no_label | model_error | rate_limited`), because the table's constraints can't be read from the repo (candidate F). `no_receipt` logs as `no_label`, and `too_long` from `max_tokens` as `model_error`.
- **Nothing else is written. Never `console.*` the tool input.**

**Response (mirrored by hand in `src/lib/receiptScan.ts`, with an `isReceiptScanSuccessShape` check like [mealRecognition.ts:215](src/lib/mealRecognition.ts#L215)):**

```
{ ok: true, partCount: number, store: string|null, purchasedOn: string|null,
  currency: "GBP"|"EUR"|null,
  printedTotalPence: number|null, totalPrintedPart: number|null,
  lines: { part: number|null, rawText, qty: number|null, qtyUnit,
           unitPricePence: number|null, lineTotalPence: number|null,
           isDiscount, possibleSeamDuplicate: boolean }[],
  notes: string[] }
```

This is camelCase on the wire and in the draft. It's mapped explicitly to snake_case at save (CLAUDE.md invariant). `part` and `possibleSeamDuplicate` aren't saved.

---

## 4. Capture and expo-image-picker — Revised 2026-09-26

**READ:**

- `expo-image-picker ~17.0.11` is in [package.json](package.json) and [app.json:44-51](app.json) with `photosPermission` set. `launchImageLibraryAsync` already ships in JS:
  - [CreateFoodScreen.tsx:318-331](src/screens/CreateFoodScreen.tsx#L318-L331);
  - [recipeImageCapture.ts:57-69](src/lib/recipeImageCapture.ts#L57-L69).
- The PL-036 investigation found the Android path uses the system photo picker and needs no `READ_MEDIA_*` permission ([tester-findings § PL-036](docs/2026-09-21-tester-findings.md)).
- **Meal path:** camera-only (`captureAndScanMealPhoto`, [mealPhotoCapture.ts:36-57](src/lib/mealPhotoCapture.ts#L36-L57)), used by AddIngredient ([:153](src/screens/AddIngredientScreen.tsx#L153)) and BatchIngredientPicker ([:177](src/screens/BatchIngredientPickerScreen.tsx#L177)). No library option.
- **Recipe path:** camera **or** library, stopping at prepared bytes so the screen can preview before spending a scan ([recipeImageCapture.ts:1-17](src/lib/recipeImageCapture.ts#L1-L17), [:43-69](src/lib/recipeImageCapture.ts#L43-L69)). **This is the template a receipt needs.** A receipt wants a preview too ("is the whole receipt in frame?") before using one of 20 hourly scans.

**What's shared with the menu path:** today, only `prepareImage` and the `ImagePicker` calls.

- When PL-036 lands, it adds `pickAndScanMenuImage` in `mealPhotoCapture.ts`. That helper scans immediately and returns a `FoodProduct`, so it doesn't fit receipts.
- **Recommendation:** extract the tiny permission→launch→prepare helper from `recipeImageCapture.ts` into a shared `imageCapture.ts` (`captureImage(kind)` / `pickImage(kind)`). Recipe, receipt and (later) menu all call it.
- If you prefer, do the extraction in the receipt UI commit rather than separately. It changes recipe code, so it needs the recipe flow re-checked on device.

### `imagePrep` — Revised 2026-09-26

`MAX_EDGE` is a single constant ([imagePrep.ts:32](src/lib/imagePrep.ts#L32)). Add `"receipt"` to `PrepareKind` ([:40](src/lib/imagePrep.ts#L40)) and size it with `fitToVisionBudget(w, h, tier)`, the documented long-edge **and** token rule (§3):

- a 3:4 photo prepares to about 1659×2212 on the high-res tier, or 952×1270 on the standard tier;
- the tier follows the bake-off's model. **Revised 2026-09-27: high-res**, since the model is Sonnet 5.

Keep quality at 0.85, like label and recipe. The receipt kind uses `MAX_PART_BASE64_CHARS` (3.5M) with one re-encode at 0.7 before failing, instead of the 6.8M guard ([:54](src/lib/imagePrep.ts#L54)). MEASURED sizes are in §3: 0.15–0.79M chars per realistic part at those sizes.

### Capture UX (multi-part) — Revised 2026-09-26

A root-stack modal, `ReceiptScan`, opened from Data → Spending. It follows RecipeScanScreen's preview-before-scan shape, extended to an ordered list:

1. **Empty state:** "Take photo" / "Choose from library", plus a one-line hint, **"Long receipt? Photograph it in parts from the top, overlapping each by a line or two."**
2. **Parts list:** ordered thumbnails labelled Part 1, Part 2, Part 3, top of receipt first. Each has:
   - **↑ / ↓** to reorder (hidden at the ends);
   - **✕** to remove;
   - a tap to view full screen, to check legibility before spending a scan.
3. **"Add another part"** (camera or library) while there are fewer than 3. At 3 it's replaced by "3 parts is the most per receipt". The server also refuses 4 or more with `too_long`.
4. **Scan** is enabled with 1–3 parts. It sends all parts in one request; the client checks `MAX_TOTAL_BASE64_CHARS` first.
5. A scan failure keeps the parts on screen (the PL-003 rule applied to capture), so a retry doesn't mean re-photographing.

**No drag-to-reorder.** Drag libraries need `react-native-gesture-handler`, which isn't a dependency ([package.json](package.json)) and is native code, so it would change the fingerprint (§9). Arrow buttons are JS-only.

Parts live in the store's receipt-draft slice as `{ uri, base64 }[]`, never in route params (§7). Memory at 3 parts: at most about 2.4M chars of base64 as JS strings (§3, MEASURED proxies). That's acceptable, and it's cleared on Save, Cancel and sign-out (`reset()`).

### Rate limit: a multi-part scan is one scan — READ, Revised 2026-09-26

The limit counts `ai_extractions` rows for the user in the last hour with `outcome <> 'rate_limited'` ([scan-meal-photo/index.ts:464-477](supabase/functions/scan-meal-photo/index.ts#L464-L477)). Every exit path after that check calls `logExtraction` **exactly once**:

- the rate-limited path ([:478](supabase/functions/scan-meal-photo/index.ts#L478));
- Anthropic non-OK ([:542](supabase/functions/scan-meal-photo/index.ts#L542));
- thrown or timeout ([:561](supabase/functions/scan-meal-photo/index.ts#L561));
- no tool_use ([:586](supabase/functions/scan-meal-photo/index.ts#L586));
- not recognisable ([:600](supabase/functions/scan-meal-photo/index.ts#L600));
- unusable output ([:618](supabase/functions/scan-meal-photo/index.ts#L618));
- success ([:633](supabase/functions/scan-meal-photo/index.ts#L633)).

`scan-receipt` copies that shape: one request, one row, **whatever the part count**, so a 3-part receipt costs one of the 20 hourly scans. Validation failures (0 parts, 4 or more, oversize, bad media type) return before the count and aren't logged, matching [:448-460](supabase/functions/scan-meal-photo/index.ts#L448-L460).

**Note the asymmetry (PREDICTED):** a 3-part scan costs about 3× the image tokens of a 1-part scan (§3) but counts the same. That's fine at 20/hour. If cost ever needs capping, weight the count with a `units` column, which belongs with candidate F's baseline migration for `ai_extractions`.

**Guard:** commit 3's function tests add "a 3-part request inserts exactly one `ai_extractions` row", via a mocked admin client.

---

## 5. Schema — Revised 2026-09-26

### Confirmed absent

**READ, and grep MEASURED:**

- No hits for `pence|currency|price|spend|receipt|purchas|£|GBP|Intl.NumberFormat` across `src/`, `supabase/migrations/` or `supabase/functions/`.
- The only matches are unrelated English: "cost", "budget", "isPending".
- No table, column, view or RPC stores money.

### Proposed migration: `supabase/migrations/2026MMDDhhmmss_receipts.sql` — Revised 2026-09-26

**Design notes:**

- **Explicit grants.** `config.toml` notes new public objects are not auto-exposed to the Data API ([supabase/config.toml:19-24](supabase/config.toml)), so grant explicitly. That's the house pattern anyway ([20260713120000_meal_bundles.sql:243-247](supabase/migrations/20260713120000_meal_bundles.sql#L243-L247)).
- **Child-row RLS** checks the parent's ownership, copied from `meal_bundle_items` ([:202-240](supabase/migrations/20260713120000_meal_bundles.sql#L202-L240)).
- **Cascade from `auth.users`.** Account deletion relies on that cascade ([delete-account/index.ts:257-266](supabase/functions/delete-account/index.ts#L257-L266)).
- **Every write is an RPC** (decision 5): `save_receipt`, `update_receipt` and `delete_receipt`.
  - The precedent is two inserts plus a compensating delete ([compositions.ts:185-238](src/lib/compositions.ts#L185-L238)). For receipts, a failed compensating delete leaves a receipt with a total and no lines, and that *does* count toward spending. An RPC is one transaction.
  - All three are `security invoker` with `set search_path = ''`, so RLS still applies. They take `user_id` from `auth.uid()`, **never from the payload**.
- **Direct DML stays granted.** With `security invoker`, the RPCs run as the caller, so `authenticated` must keep insert, update and delete on both tables.
  - A user could therefore still write **their own** rows directly through PostgREST, bypassing the RPCs. RLS stops them touching anyone else's.
  - "Only through the RPCs" is enforced on the client by the write-site guard (§8), not by the server.
  - The alternative is `security definer` RPCs, explicit `auth.uid()` checks, and revoked DML. That makes the RPCs the only door server-side, but it moves the RLS logic into function bodies. Not recommended for v1, and noted so the trade-off is on record.
- **`updated_at`** (added in this revision) is maintained by a `before update` trigger on `receipts`, not by the RPC body. It's then true for any update path, including a direct PostgREST update the guard can't see.
  - It's a dedicated trigger function, `receipts_touch_updated_at()`. It doesn't reuse `handle_updated_at` or `set_updated_at`, the two competing touch functions [20260713120000_meal_bundles.sql:16-20](supabase/migrations/20260713120000_meal_bundles.sql#L16-L20) warns about.
  - Line edits go through `update_receipt`, which always updates the header row, so the trigger fires for a lines-only edit too.
- **No view in v1.** Receipts are few per user, so the Spending segment computes client-side from `receipts` alone. That avoids a `security_invoker` surface entirely. If a view is added later, it's `security_invoker = on` with throwaway-postgres fixtures (CLAUDE.md pattern).
- **`purchased_on_estimated`** gets its meaning written down *before* any code writes it, which is the lesson of PL-048: **true if and only if the date was not read from the receipt and the user didn't set it on the review screen** (the review defaulted it to today's `dateKey()`).
  - `update_receipt` enforces the edit half server-side: **changing `purchased_on` sets it false; otherwise it's left as it was.**
- **Nothing added for multi-image.** Neither `part` nor the seam flag is stored (§3).

```sql
create table public.receipts (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users (id) on delete cascade,
  store                  text,
  purchased_on           date not null,
  purchased_on_estimated boolean not null,
  printed_total_pence    integer,
  currency               char(3) not null default 'GBP',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint receipts_store_len       check (store is null or length(btrim(store)) between 1 and 60),
  constraint receipts_total_nonneg    check (printed_total_pence is null or printed_total_pence >= 0),
  constraint receipts_currency_iso    check (currency ~ '^[A-Z]{3}$')
);
create index receipts_user_date_idx on public.receipts (user_id, purchased_on desc, id desc);

create function public.receipts_touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
create trigger receipts_touch_updated_at before update on public.receipts
  for each row execute function public.receipts_touch_updated_at();

create table public.receipt_lines (
  id                uuid primary key default gen_random_uuid(),
  receipt_id        uuid not null references public.receipts (id) on delete cascade,
  user_id           uuid not null references auth.users (id) on delete cascade,
  position          integer not null check (position >= 0),
  raw_text          text not null check (length(btrim(raw_text)) between 1 and 120),
  qty               numeric(10,3) check (qty is null or qty > 0),
  qty_unit          text check (qty_unit is null or qty_unit in ('each','kg')),
  unit_price_pence  integer check (unit_price_pence is null or unit_price_pence >= 0),
  line_total_pence  integer,
  is_discount       boolean not null default false,
  constraint receipt_lines_sign check (
    line_total_pence is null
    or (is_discount and line_total_pence <= 0)
    or (not is_discount and line_total_pence >= 0)),
  unique (receipt_id, position)
);
create index receipt_lines_receipt_idx on public.receipt_lines (receipt_id, position);

-- RLS: receipts own-rows x4; receipt_lines select/delete own, insert/update own AND parent owned
-- (exists (select 1 from public.receipts r where r.id = receipt_id and r.user_id = auth.uid())).
-- grant select, insert, update, delete on both to authenticated; nothing to anon.

-- save_receipt(p_receipt jsonb, p_lines jsonb) returns public.receipts
--   security invoker, set search_path = ''.
--   insert header with user_id = auth.uid(); insert lines from jsonb_to_recordset with
--   explicit columns and user_id = auth.uid(); return the header row.

create function public.update_receipt(p_id uuid, p_receipt jsonb, p_lines jsonb)
returns public.receipts
language plpgsql security invoker set search_path = ''
as $$
declare r public.receipts;
begin
  update public.receipts t
     set store                  = p_receipt->>'store',
         purchased_on           = (p_receipt->>'purchased_on')::date,
         -- PL-048 lesson: a changed date is a user-set date. Unchanged → keep the flag.
         purchased_on_estimated = case
           when (p_receipt->>'purchased_on')::date is distinct from t.purchased_on then false
           else t.purchased_on_estimated end,
         printed_total_pence    = (p_receipt->>'printed_total_pence')::integer,
         currency               = p_receipt->>'currency'
   where t.id = p_id
     and t.user_id = auth.uid()          -- belt and braces; RLS already hides others' rows
  returning t.* into r;

  if not found then
    -- Someone else's id, a deleted id, or a typo: never a silent success.
    raise exception 'update_receipt: no receipt % for this user', p_id
      using errcode = 'P0002';            -- no_data_found; the client maps it to "no longer exists"
  end if;

  delete from public.receipt_lines where receipt_id = p_id;

  insert into public.receipt_lines
    (receipt_id, user_id, position, raw_text, qty, qty_unit,
     unit_price_pence, line_total_pence, is_discount)
  select p_id, auth.uid(), x.position, x.raw_text, x.qty, x.qty_unit,
         x.unit_price_pence, x.line_total_pence, coalesce(x.is_discount, false)
    from jsonb_to_recordset(p_lines) as x(
      position integer, raw_text text, qty numeric, qty_unit text,
      unit_price_pence integer, line_total_pence integer, is_discount boolean);

  return r;
end $$;
-- One function call is one statement inside PostgREST's per-request transaction: if the
-- insert fails (a CHECK on any line), the header update AND the delete roll back with it.

create function public.delete_receipt(p_id uuid) returns void
language plpgsql security invoker set search_path = ''
as $$
begin
  delete from public.receipts where id = p_id and user_id = auth.uid();   -- lines cascade
  if not found then
    raise exception 'delete_receipt: no receipt % for this user', p_id using errcode = 'P0002';
  end if;
end $$;

revoke all on function public.save_receipt(jsonb, jsonb),
                       public.update_receipt(uuid, jsonb, jsonb),
                       public.delete_receipt(uuid) from public, anon;
grant execute on function public.save_receipt(jsonb, jsonb),
                          public.update_receipt(uuid, jsonb, jsonb),
                          public.delete_receipt(uuid) to authenticated;
```

**NULL, never 0:**

- `printed_total_pence` and `line_total_pence` are nullable with no default, and the client sends `null` for unreadable. A 0 is only ever a printed "0.00".
- `(p_receipt->>'printed_total_pence')::integer` is NULL for a JSON null and for a missing key alike, so an omitted total can't become 0.
- `currency` does have a default, 'GBP', because the review screen shows it and the user confirms it. Say so in the column comment.

**Delete: `delete_receipt` RPC, not `.from("receipts").delete()`.** Recommended for three reasons:

1. **Zero rows is an error on the server.** A PostgREST delete that matches nothing returns success. That covers someone else's id (hidden by RLS), an already-deleted id, and a stale edit screen. The client could chain `.select()` and check the length, but that makes loudness a client convention; the RPC makes it a server guarantee.
2. **The guard stays absolute.** "No direct insert, update, upsert or delete on either table" has no exceptions (§8).
3. **Same shape as update.** Both raise `P0002`, so the review screen handles "this receipt no longer exists" once, for both.

### Verification SQL: `supabase/migrations/verify/<ts>_verify.sql` — Revised 2026-09-26

This follows [20260919120000_verify.sql](supabase/migrations/verify/20260919120000_verify.sql). Each block is read-only or rolls itself back, with PREDICTED and MEASURED lines.

- **V1 — snapshot, before and after:** `meal_entries` row count and an md5 content hash over explicit columns. **This proves the migration wrote nothing to consumption.** It must be identical before and after.
- **V2 — schema:** `information_schema.columns` for both tables (types, nullability, defaults, **including `updated_at`**) and `pg_constraint` defs. Plus the trigger: `pg_trigger` shows `receipts_touch_updated_at`, `BEFORE UPDATE`, `FOR EACH ROW`.
- **V3 — security surface:**
  - `relrowsecurity = true` on both tables;
  - `pg_policies` lists 4 + 4 policies, with the parent check present in lines insert/update;
  - `has_table_privilege('anon', …)` is false;
  - for each of the three RPCs: `prosecdef = false`, `proconfig` contains `search_path=`, and anon has no execute privilege.
- **V4 — RLS with two accounts, rolled back.** Each runs `set local role authenticated` with `request.jwt.claims` set to the account's `sub`:
  - (a) As A `a8435663-…`: `save_receipt` with 2 lines, then select. Expect 1 receipt and 2 lines, all with `user_id = A`.
  - (b) Same transaction, as B `4dbf04ae-…`: `select count(*)` from both tables. Expect 0 and 0.
  - (c) As B: `insert into receipt_lines (receipt_id = A's id, user_id = B, …)`. Expect `new row violates row-level security policy`.
  - (d) As B: `update receipts set store='x' where id = A's id`. Expect 0 rows.
  - (e) As B: `save_receipt` with a payload containing `"user_id": "<A>"`. Expect the row to have `user_id = B`.
- **V5 — constraints, rolled back:**
  - negative total → check violation;
  - a discount with a positive total → check violation;
  - an empty `raw_text` → violation;
  - NULL total and NULL line totals **accepted, and they read back NULL, not 0**;
  - `qty 0.512` accepted.
- **V6 — cascade:** `delete_receipt` on A's probe receipt; its lines are gone. Rolled back.
- **V7 — cross-account update raises** (new):
  - Superuser: record md5(header + lines) for A's probe receipt.
  - As B: `select update_receipt(<A's id>, '{"store":"hijack",…}', '[]')`. Expect `ERROR: update_receipt: no receipt …`, SQLSTATE `P0002`.
  - Superuser: A's hash is unchanged.
- **V8 — update replaces lines exactly** (new):
  - As A: save with 3 lines (positions 0–2), then `update_receipt` with 2 different lines (positions 0–1).
  - Expect exactly 2 rows for that receipt, matching the payload column for column, and **none of the 3 original line ids remaining**.
- **V9 — a mid-update failure leaves the old receipt intact** (new):
  - As A: save with 3 lines; record md5(header + lines).
  - Then `update_receipt` with a new store and 2 lines, the second of which is `is_discount = true, line_total_pence = 250`, violating `receipt_lines_sign` after the delete has run.
  - Expect a check violation, **and** the hash unchanged: the old store, the old 3 lines, and `updated_at` unmoved.
  - Run the failing call inside `savepoint v9; … rollback to savepoint v9;` and read the hash after that. Once a statement fails, the transaction is aborted and can't read anything back. In the app, PostgREST's per-request transaction rolls back the whole call the same way.
- **V10 — `updated_at` moves, and the date flag:** (new)
  - Needs **two transactions**, because `now()` is the transaction start time: inside one rolled-back transaction, insert and update share the same `now()` and `updated_at` couldn't move even when it's working. So this block runs only in the throwaway container (below), and commits a probe that its last step deletes.
  - T1: save with `purchased_on_estimated = true`.
  - T2: update with the **same** date. Expect `updated_at > created_at`, and the flag **still true**.
  - T3: update with a **different** date. Expect the flag **false**.
- **V11 — delete is loud** (new):
  - As B: `delete_receipt(<A's id>)` → `P0002`, and A's row still exists.
  - As A: `delete_receipt(<own id>)` → lines gone.
  - Again → `P0002`.

**Rig:** run V2–V11 for real in a throwaway `postgres:16-alpine` container **before** the push, with a stub `auth` schema, `auth.uid()` reading the claims GUC, and an `auth.users` table. The `20260831120000` verify file is the rig pattern. Then run V1, V3, V4, V7, V8, V9 and V11 against remote, all rolled back. V10 is container-only, because it must commit.

**Sabotage runs (in the container), each of which must turn its check red:**

1. Drop the `exists (… r.user_id = auth.uid())` from the lines insert policy → V4c succeeds.
2. Make `save_receipt` `security definer` → V4b sees A's rows through the function / V3 fails.
3. Take `user_id` from `p_receipt->>'user_id'` in `save_receipt` → V4e stores A.
4. Add `default 0` to `line_total_pence` and omit the key in a probe → V5 NULL read-back fails.
5. Remove `on delete cascade` on `receipt_id` → V6 fails.
6. **`update_receipt` doesn't raise on 0 rows** (delete the `if not found` block) → V7's call returns normally instead of `P0002`.
7. **The update deletes lines outside the transaction.** Two variants, both must turn V9 red with "0 lines remain":
   - (a) Wrap the insert in `begin … exception when others then return r; end`, so a failing line is swallowed after the delete has committed within the function.
   - (b) A client-side split: `delete_receipt_lines(p_id)` and `insert_receipt_lines(...)` as two RPC calls. Run it by hand as two statements in autocommit, the second one failing on the CHECK.
8. **`update_receipt` takes `user_id` from the payload** (`set user_id = (p_receipt->>'user_id')::uuid`, and the same in the lines insert). With A's JWT and a payload naming B, the row must stay A's.
   - The unsabotaged function ignores the key, so the row stays A's. The sabotaged one either hands the row to B or hits the policy's `with check`. Both are red against "row still A's, call succeeded".
9. **`delete_receipt` without its `if not found`** → V11's second delete returns normally.

### Manual checklist for the schema commit(s) — Revised 2026-09-26

- [ ] Docker daemon up (`docker ps`); container rig V2–V11 green; sabotages 1–9 each red, then restored.
- [ ] V1 before the push (record the hash).
- [ ] `npx supabase db push`.
- [ ] V1 after the push: identical. V2/V3 as predicted.
- [ ] V4 a–e, V7, V8, V9 and V11 on remote as predicted, both accounts, all rolled back.
- [ ] Dashboard → Table editor: both tables show RLS enabled.
- [ ] Update [docs/account-deletion-runbook.md](docs/account-deletion-runbook.md) if it lists per-table checks (PREDICTED; not read here).

---

## 6. Money — Revised 2026-09-26

**READ:** no currency or money helper exists. The only `toLocaleString` uses are calorie displays ([CalorieRing.tsx:167-189](src/components/CalorieRing.tsx#L167-L189), [TodayScreen.tsx:987-1011](src/screens/TodayScreen.tsx#L987-L1011)).

**Precedent against locale formatting.** The Trends UI test bans `toLocaleString` so that "2,800" can't read as "2.800" on another locale ([trendsUi.test.ts:251-256](src/components/__tests__/trendsUi.test.ts#L251-L256)). Money is worse: "£12.30" versus "12,30 £".

**Proposed `src/lib/money.ts`** (pure, fully tested):

- `parsePenceInput(text: string): number | null`
  - for review-screen fields;
  - accepts "12.3", "12.30", "£12.30", "0.50-" and "-0.50";
  - rejects "12.305", "abc" and "";
  - no floats: split on "." and pad.
  - **Revised 2026-09-26, decided:** rejects `"-0.50-"` (both minus forms at once) and `"1,234.56"` (no thousands separator is accepted). Both return null, so the field shows empty, never a guessed number.
- `formatPence(pence: number, currency: "GBP" | "EUR" | string): string`
  - "£12.30", "−£0.50", "€3.00";
  - unknown code → "12.30 XYZ";
  - thousands separator done by hand.
  - `trends.ts` has a private `withThousands` ([trends.ts:691](src/lib/trends.ts#L691)). Lift it to a shared helper rather than write a second one.
- `sumPence(values: (number | null)[]): number | null` — null only if every value is null, the same "nothing known ≠ zero" rule as `sumBucket` ([entries.ts:333-366](src/lib/entries.ts#L333-L366)).

The server's `parsePence` (from printed strings) is a separate function in `_shared/receipt.ts`, because Deno and RN module resolution are split (see the mirror comment at [mealRecognition.ts:16-18](src/lib/mealRecognition.ts#L16-L18)). The two get the same test table.

**Spending rules** (pure, in `src/lib/spending.ts`):

- **A receipt's amount:**
  - `printed_total_pence` if it isn't null;
  - else the sum of lines, if every line total is non-null (flagged "from lines");
  - else **excluded and counted as unknown**. Never 0.
- **Aggregate per currency.** Never add GBP to EUR.
- **Revised 2026-09-26:** `fetchReceipts` reads through `fetchAllPages` (PL-050, [paging.ts](src/lib/paging.ts)), ordered `purchased_on desc, id desc`, which is a total order for stable pages. Page size is a named constant below `max_rows`. The CSV's line read is paged the same way, ordered `receipt_id, position`.
- **"This week"** is Monday–Sunday in the local calendar via `dateKey` arithmetic (the `setDate` pattern from [csv.ts:127-134](src/lib/csv.ts#L127-L134), not fixed milliseconds). **"This month"** is the calendar month to date.
- **`purchased_on` is a calendar date, never an instant.**
  - It's compared as a `YYYY-MM-DD` string and never parsed with `new Date("YYYY-MM-DD")`, which is UTC midnight. That's the PL-007 class of bug in a new form.
  - To display it, use the `T12:00:00` pattern ([HistoryScreen.tsx:112](src/screens/HistoryScreen.tsx#L112)).

**CSV:** `plated_spending_<dateKey()>.csv`, one row per line.

- Receipt columns repeat on each row; a receipt with no lines gives one row with empty line cells.
- Header: `purchased_on,date_estimated,store,currency,receipt_total,line_no,item_text,qty,qty_unit,unit_price,line_total,is_discount`.
- Money is written as "12.30", with an **empty cell for NULL** (PL-008 `optionalCell`, [csv.ts:26-28](src/lib/csv.ts#L26-L28)).
- Dates are the stored `purchased_on` string as-is: already a local calendar date, so no conversion (PL-007).
- Reuse `cell()` for quoting. Receipt text has commas.

---

## 7. Privacy

### What the function persists and reports (READ)

- **Nothing but the `ai_extractions` metadata row:** user, outcome, model, tokens, ms ([scan-meal-photo/index.ts:398-405](supabase/functions/scan-meal-photo/index.ts#L398-L405)).
- **The image is never stored.** It exists in the request body only.
- **No Sentry in Edge Functions.** None of them import it.
- **Console logs** are the Anthropic error body (≤500 chars) and generic strings ([:540-541](supabase/functions/scan-meal-photo/index.ts#L540-L541)). PREDICTED: Anthropic error bodies describe the request fault, not its content.

### The filters before anything persists

1. **The prompt** excludes tender, card, loyalty, address and identifier lines (§3).
2. **A deterministic server redaction pass** drops tender lines and loyalty lines carrying an identifier, and masks card-like digit runs and postcodes. It's tested in vitest with fixture strings: masked PANs in several formats, "CLUBCARD NO 634004…" and postcodes. **Revised 2026-09-27:** a loyalty *price saving* line is kept (§3).
   - **MEASURED in the bake-off:** 0 of 57 model outputs contained a card, tender or loyalty identifier, **before** any redaction. The prompt alone held on these receipts, so the server pass is defence in depth, as intended.
3. **The review screen.** The user sees every line before save and can delete any.
4. **The schema** only has the columns listed. There's nowhere to put a card number except `raw_text` or `store`, and both went through step 2.

### Client Sentry path

**READ:**

- `reportError` sends only `code`/`name` through `scrubErrorForReport`, never `.message`, `.details` or `.hint` ([scrub.ts:21-44](src/lib/scrub.ts#L21-L44), [reportError.ts:37-58](src/lib/reportError.ts#L37-L58)).
- Console breadcrumbs are dropped wholesale ([instrument.ts:16](instrument.ts)).
- Request bodies are deleted ([instrument.ts:36](instrument.ts)).
- `sendDefaultPii: false`, no replay.

**Two gaps on a receipt path:**

1. **`opts.extra` is forwarded unscrubbed** ([reportError.ts:50](src/lib/reportError.ts#L50)). It's documented as "caller-provided, NON-sensitive only", but nothing enforces that.
2. **Uncaught exceptions and ErrorBoundary catches keep their real message**, with only UUIDs scrubbed ([instrument.ts:46-52](instrument.ts)). A `throw new Error(\`Couldn't save ${store} £${total}\`)` would ship store and amount.

**Required, as a guard test in the receipts structural suite (§8):**

- receipt modules never pass `extra` to `reportError`;
- they never construct `new Error(` with a template literal or concatenation;
- they never `console.*` the draft or scan result. The console is dropped by Sentry, but it's still in device logs and Metro.

The receipt draft travels in a **store slice, not route params**. PL-046 already argues against non-serialisable params, and a 150-line draft is large for navigation state. Navigation breadcrumbs carry the route name only ([AppNavigator.tsx:138-148](src/navigation/AppNavigator.tsx#L138-L148)).

### Disclosure

The receipt image, card digits included, is sent to Anthropic for extraction. Plated doesn't store it. The privacy notice at platedapp.uk should say so before this ships. That's a website change, outside the repo.

---

## 8. Structural guards — Revised 2026-09-26

**Does the `meal_entries` AST test need to know?** **No**, and it can't.

- It finds sites by the literal `.from("meal_entries").insert(` / `.update(`, and pins the file set to `lib/entries.ts` and `store/useStore.ts` ([mealEntriesInsertSites.test.ts:66](src/lib/__tests__/mealEntriesInsertSites.test.ts#L66), [:487-496](src/lib/__tests__/mealEntriesInsertSites.test.ts#L487-L496)).
- Receipt code writes to other tables, so the test stays green and says nothing about it.
- **It stays unchanged, and that's the proof no third `meal_entries` site was added.**

**Should an equivalent exist? Yes:** `src/lib/__tests__/receiptWriteSites.test.ts`. Hard gates, **Revised 2026-09-26** for edit and delete:

1. **Exactly three write doors, all in one file.**
   - Across `src/`, the only receipt writes are `.rpc("save_receipt"`, `.rpc("update_receipt"` and `.rpc("delete_receipt"`, **each exactly once, all in `lib/receipts.ts`**.
   - **No file anywhere under `src/`** chains `.insert(`, `.update(`, `.upsert(` or `.delete(` on `.from("receipts")` or `.from("receipt_lines")`.
   - Reads (`.from("receipts").select(`, `.from("receipt_lines").select(`) are allowed, and only in `lib/receipts.ts`.
   - Two detection methods, as in the `meal_entries` test: a regex count and an AST walk that must agree.
2. **Receipts never touch consumption.** No file matching `receipt*` under `src/lib`, `src/screens` or `src/store/receipts*` contains the string `meal_entries`, or imports `addEntry`, `applyEntries` or `applyBatchNow`.
3. **The payloads are explicit.**
   - The object literals passed as `p_receipt` to `save_receipt` and `update_receipt`, and the `.map()` building `p_lines` (one shared builder is fine), have no spread and only snake_case keys.
   - They include `purchased_on`. `save_receipt`'s also includes `purchased_on_estimated`.
   - They never contain `user_id`, `id`, `created_at` or `updated_at`.
   - `update_receipt`'s `p_receipt` also has no `purchased_on_estimated`: the server decides it on edit (§5).
   - `p_id`, for update and delete, is a function parameter, never read off a draft object that could carry another row's id. This is asserted structurally: the `p_id` initializer is an identifier bound to the enclosing function's parameters.
   - Reuse the AST machinery. Today it's private to `mealEntriesInsertSites.test.ts`, so move the helpers to `src/lib/__tests__/helpers/astWrites.ts` in the same commit, with the existing test importing them unchanged in behaviour.
4. **No UTC date keys.** Receipt modules contain no `toISOString().split("T")[0]` or `.slice(0, 10)`, and no `new Date(` applied to `purchased_on`.
5. **Privacy (§7):** no `extra:` in `reportError(` calls, no `new Error(\`…${` or `new Error(... +`, and no `console.` referencing the draft identifiers.
6. **Reads are paged** (Revised 2026-09-26, the PL-050 lesson). Every `.from("receipts").select(` and `.from("receipt_lines").select(` in `lib/receipts.ts` either:
   - sits inside a `fetchAllPages(` callback, with an ORDER BY ending in a unique column; or
   - is a single-receipt read filtered by `.eq("id", …)` / `.eq("receipt_id", …)`.

Each gate gets a sabotage run, listed in the plan.

---

## 9. OTA vs build — Revised 2026-09-26

**MEASURED 2026-09-26 at `177ed0a`:** `npx expo-updates runtimeversion:resolve`

- Android `c1907ba4619df4d22e128f15df609529906eae2a`
- iOS `5359dccea82b8462c0d3d81501d9748bbb241baf`

Both match the runtimes recorded for the last OTAs ([docs/2026-09-19-findings.md:32-34](docs/2026-09-19-findings.md), PL-043 row). In the Android fingerprint source list, **no path under `src/` or `supabase/` appears.**

The raw `@expo/fingerprint` library hash (`444e5488…`) differs because expo-updates resolves with its own options. Use `runtimeversion:resolve`, not the bare library, for these checks.

**PREDICTED OTA-eligible on both platforms**, because every change is:

- `src/`: screens, lib, store, tests;
- `supabase/`: migration and function, which ship server-side;
- existing native modules only: `expo-image-picker`, `expo-image-manipulator`, `expo-file-system`, `expo-sharing`, `react-native-svg` if a bar is drawn.

**Things that would break it (don't bundle):**

- Rewording the iOS `photosPermission` string ([app.json:48](app.json)). It's already inaccurate per PL-036's notes, and receipts make it more so. It's native config, so the fingerprint changes and it needs a build. Ship it with the next native build.
- Any new npm dependency with native code, or a config plugin. None is needed.
- **Revised 2026-09-26: drag-to-reorder for parts.**
  - Every mainstream drag list for RN needs `react-native-gesture-handler`, which isn't in [package.json](package.json). It's native code, and would need a build on both platforms.
  - `react-native-reanimated` *is* present, but it doesn't provide gesture recognition on its own.
  - The parts list uses ↑/↓ buttons (§4), which are JS-only.
- **Thumbnails** use RN's core `Image` on the local file URI `prepareImage` already returns ([imagePrep.ts:56-59](src/lib/imagePrep.ts#L56-L59)). No image library is needed.

**Re-measured after PL-050 (`eec75b9`), MEASURED 2026-09-26:** `runtimeversion:resolve` still gives `c1907ba4…` / `5359dcce…`. The `supabase/config.toml` edit in that commit isn't a fingerprint source.

**Deploy order — Revised 2026-09-26:**

1. `npx supabase db push` (schema; one migration, or two if commit 1 is split, pushed together) → run the verify file.
2. `npm run check:functions`, then `npx supabase functions deploy scan-receipt`, then the smoke test:
   - a real 1-part and 3-part receipt from a dev client;
   - **the 9.0M-char body probe** for the undocumented Supabase body limit (§3);
   - 4 parts → `too_long`.
   - The three existing functions get only comment changes (candidate E), so they aren't redeployed.
3. OTA. Re-run `runtimeversion:resolve` first and confirm both hashes are unchanged.

Old clients never call `scan-receipt` or any of the three RPCs, so steps 1–2 are safe at any time. The OTA is the only step with an ordering dependency.

---

## Out-of-scope candidates — Revised 2026-09-26

Unnumbered unless stated; allocate from the register.

**A. History's daily average counts unknown small-four as 0.** Proposed **Major**, by analogy with PL-008. **Revised 2026-09-27: filed and fixed as PL-058**, with red tests at `dd702e1` and the fix at `9ed4956`. The production OTA went out from `f44b90c` on 2026-09-27 and was confirmed on the production app by Robbie. Kept below as first written.

- **Where:** [HistoryScreen.tsx:66-72](src/screens/HistoryScreen.tsx#L66-L72) coalesces a null bucket to 0, and [:96-107](src/screens/HistoryScreen.tsx#L96-L107) averages it.
- **Contradiction:** Trends draws a gap for the same day ([trends.ts:826-830](src/lib/trends.ts#L826-L830)).
- **Effect:** a user who logs foods without fibre data sees a lower average fibre on History than the Trends line implies. It's a fabricated zero the user reads directly.
- **Fix shape:** average over days where the macro is known, and show "n of N days" when partial.
- **Red test:** a week with 3 known-fibre days and 4 unknown must average over 3.

**B. History "% on goal" is computed against default goals when the user's goals didn't load.** **Already filed as PL-026** (2026-09-20-internal). I missed it on the first pass. Nothing new to file.

**C. `fetchEntries` was unbounded while PostgREST caps responses at `max_rows`.** **Filed and fixed as PL-050**, Major (`testing/2026-09-26-internal.md`):

- red tests at `be8ed92`, fix at `eec75b9`;
- hosted Max rows raised to 2000 the same day as a stopgap;
- OTA and device checklist owed. **Revised 2026-09-27:** both done; the OTA went out from `beefa7a` on 2026-09-26.

The same pass swept every other per-user select. Its highest-risk candidate is `fetchWorkouts`, which is unbounded and has **no ORDER BY at all**, so past the cap it would drop an arbitrary set of rows. That one is unnumbered and listed in PL-050's sweep table. **Revised 2026-09-27:** filed and fixed as PL-056, and shipped in the same OTA as PL-050.

**D. No AI function checks `stop_reason`.** Proposed **Minor**. PREDICTED; the `max_tokens` behaviour isn't observed.

- **Where:** grep for `stop_reason` in `supabase/functions` gives 0 hits.
- **Effect:** scan-recipe returns a list at `max_tokens: 4096` ([scan-recipe/index.ts:421](supabase/functions/scan-recipe/index.ts#L421)). A long recipe cut off by the cap can come back as a shorter, valid ingredient list, with ingredients silently dropped from a batch.
- The meal and label scanners fail closed on missing required fields, so they're lower risk.
- `scan-receipt` checks it from day one (§3). The existing three stay open.

**E. The `MODEL` secret is shared, and its "bump it, no redeploy" advice is unsafe for current models.** Proposed **Minor**, latent. **The comment half is folded into commit 3** (decided).

- **Where:** all three functions read one `MODEL` secret, and their comments invite bumping it:
  - [scan-meal-photo/index.ts:48-49](supabase/functions/scan-meal-photo/index.ts#L48-L49);
  - [scan-recipe/index.ts:54-55](supabase/functions/scan-recipe/index.ts#L54-L55);
  - [extract-nutrition-label/index.ts:46-47](supabase/functions/extract-nutrition-label/index.ts#L46-L47), which names `claude-sonnet-5` outright.
- **Per the bundled Claude API reference:**
  - Claude Opus 5.5 and Claude Fable 5.1 return a **400 on forced `tool_choice`**, and all three functions force it ([scan-meal-photo:512](supabase/functions/scan-meal-photo/index.ts#L512), [extract-nutrition-label:505](supabase/functions/extract-nutrition-label/index.ts#L505), [scan-recipe:427](supabase/functions/scan-recipe/index.ts#L427)). Setting `MODEL` to either would break every AI scan at once.
  - Claude Sonnet 5 runs adaptive thinking when `thinking` is omitted, and it counts toward `max_tokens`. That's a truncation risk for scan-meal-photo (1024) and extract-nutrition-label (2048), the one whose comment recommends Sonnet 5.
- **Commit 3** replaces the three comments with that warning and gives `scan-receipt` its own `RECEIPT_MODEL`.
- **Still open, as the candidate:** per-function secrets for the existing three, and an explicit `thinking` setting.

**F. `ai_extractions` has no migration.** Proposed **Minor**.

- **Where:** it's not in `supabase/migrations/`, and the legacy schema header lists it as missing ([schema.legacy…sql:1-3](supabase/schema.legacy-v2.LEGACY-DO-NOT-USE..sql)). Its columns, constraints and RLS can't be read from the repo.
- **Why it matters:**
  - The rate limit is only as good as the insert. A new `outcome` value rejected by an unknown check would make `logExtraction` fail silently ([scan-meal-photo:406](supabase/functions/scan-meal-photo/index.ts#L406)), leaving an **uncounted scan**.
  - The limit also **fails open** on a count error ([:473-476](supabase/functions/scan-meal-photo/index.ts#L473-L476)).
- **Measure:** `select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.ai_extractions'::regclass;`, then fold it into the baseline-migration work already noted in CLAUDE.md.

**G. History hand-rolls `YYYY-MM-DD` keys three times.** **Polish.**

- **Where:** [HistoryScreen.tsx:44-48](src/screens/HistoryScreen.tsx#L44-L48), [:114](src/screens/HistoryScreen.tsx#L114), [:117](src/screens/HistoryScreen.tsx#L117).
- They're correct today, because they use local getters, but they duplicate `dateKey()`. Folded into commit 7 below. Filed only if you want it tracked.

**H. (new) `imagePrep`'s header understates the vision downscale rule.** **Polish**, comment only.

- It says Anthropic "downscales anything over 1568px on the long edge" ([imagePrep.ts:19-21](src/lib/imagePrep.ts#L19-L21)).
- Per the vision docs there's also a visual-token cap, and on a 3:4 photo it binds first (§3). So today's 1176×1568 meal photos are downscaled again server-side on the standard tier.
- Harmless for meals, but the comment is the stated reason for `MAX_EDGE`, and it's wrong for this frame shape.

---

## Decisions taken — Revised 2026-09-26

Replaces "Product decisions needed before build". Recorded as given, 2026-09-26.

1. **The section is "Grocery spending".** No per-line food classification in v1. (The Data segment label stays "Spending"; §2.)
2. **Multi-image is in v1.** Up to 3 overlapping photos of one receipt, sent in one request; 4 or more → `too_long` (§3, §4).
3. **Human-in-the-loop editing is in v1.** Review before save, **and** re-opening a saved receipt to edit or delete it (§5, §8, commit 5b).
4. **Model: decided by the bake-off**, not here (commit 0). **Revised 2026-09-27, resolved:** `claude-sonnet-5`, high-res tier, thinking disabled, `max_tokens` 16,000. The size limits of 3.5M per part and 9M per request are confirmed.
5. **All three brief changes accepted:**
   - `scan-receipt` is its own function;
   - the entry point is on Data → Spending only;
   - every write goes through an RPC: `save_receipt`, `update_receipt`, `delete_receipt`. Delete is an RPC by recommendation (§5).
6. **Decided in the brief:** `parsePence("-0.50-")` → null; `parsePence("1,234.56")` → null.
7. **Decided in the brief:** candidate E's comment fix ships in the same commit as `RECEIPT_MODEL`.

---

## Recommended implementation plan — Revised 2026-09-26

Each commit uses the house style: a two-`-m` conventional commit, red tests before fixes, sabotage runs recorded as MEASURED, and no deploy unless asked. **⚑ marks a commit whose scope grew enough in this revision that it should be split**, with the split shown.

### Commit 0 — bake-off (docs only; gates commits 2–3)

`docs(receipts): model, resolution and multi-part bake-off on real receipts`

- **Run:** a throwaway scratchpad script (not committed), calling the Messages API with the §3 tool schema and prompt.
- **Receipts:** 10 of yours:
  - 3 short;
  - 4 weekly shops;
  - 1 faded;
  - 1 with € or multibuys;
  - 1 with a loyalty block.
- **Model arms:**
  - (A) Haiku 4.5, prepared to 945×1260;
  - (B) Sonnet 5 at 1659×2212, `thinking: disabled`;
  - (C) Sonnet 5 at 1659×2212, adaptive.
- **Multi-photo arm (new):** your multi-photo receipts. Each long receipt is photographed in 2–3 overlapping parts and run through each of A–C. Where possible, the same receipt is also run as a single photo, so part-count effects are visible.
- **Measure per receipt, every arm:**
  - total exact match;
  - date exact match;
  - line recall (hand-counted);
  - line-total exact rate;
  - sum(lines) = total;
  - card or loyalty digits in output **before** redaction;
  - output tokens, latency, `stop_reason`.
- **Extra multi-photo metrics:**
  - **seam lines duplicated:** a line at a join listed twice;
  - **seam lines dropped:** a line at a join listed zero times;
  - **total taken from the correct part:** `total_printed_part` equals the last part that shows a total, checked by hand;
  - **seam-flag hits and false flags:** run the §3 seam check on the output, and count flags on true seam echoes vs flags on genuine repeat purchases;
  - **p95 latency and output tokens on the longest receipt**, against the 150 s idle timeout.
- **Re-measure image sizes on the real photos** (every arm, especially the multi-photo ones): the base64 length of each prepared part at the chosen size and quality 0.85, the heaviest part, and the heaviest 3-part total. This replaces §3's synthetic-proxy figures, and **fixes `MAX_PART_BASE64_CHARS` and `MAX_TOTAL_BASE64_CHARS`**.
- **Decides:**
  - the `RECEIPT_MODEL` default and its tier (and so `fitToVisionBudget`'s tier);
  - `max_tokens`;
  - whether the output keys need compacting or the line cap lowering (§3);
  - whether the seam flag is worth showing, or should be demoted to the reconcile banner alone;
  - the per-part and total base64 limits (§3, currently provisional).
- **Note:** this sends your receipts to Anthropic, the same as the feature will.

#### Results — MEASURED 2026-09-27 (Revised)

**Setup, as run:**

- **The harness:** `bakeoff.py`, kept outside the repo in a scratch folder and never committed, making raw HTTP calls to the Messages API with the §3 tool schema and prompt (forced tool, parts as labelled image blocks).
- **Robbie's four conditions, each enforced in code:**
  - ground truth hand-recorded by Robbie, with scoring only against it;
  - the photos folder refused if it sits inside a git work tree;
  - the API key read from the environment only, in Robbie's shell;
  - results recording yes/no for card, tender or loyalty identifiers, never the digits.
  - Raw model outputs were deleted after each scoring pass. Only the metrics were kept.
- **The receipts:** 13 real ones, mostly Sainsbury's, plus M&S.
  - Two are multi-photo: r08 in 3 parts (123.73) and r10 in 2 parts (93.16).
  - Eleven are single photos, from one item to 47 lines.
  - None was faded or in €, and none had a separate loyalty-number block. **Those gaps are still open.**
- **The arms:**
  - (A) `claude-haiku-4-5-20251001`, standard tier, no thinking, `max_tokens` 12,000;
  - (B) `claude-sonnet-5`, high-res, `thinking: disabled`, 12,000;
  - (C) `claude-sonnet-5`, high-res, adaptive, 16,000.
- **The runs:** run 1 and run 2 covered the first three receipts, and run 3 all 13. That's 57 calls, all successful.
- **Ground-truth columns:** printed total, date, `item_lines` (lines printed), `take_home_items` and `total_part`.
  - `take_home_items` (added at Robbie's request) is the physical products that went home. A multibuy line counts its quantity; discount lines count 0; a void and its cancel line net to 0; a weighed item counts 1.
  - `total_part` is the photo that shows the TOTAL.

**Single photos, run 3 (10 receipts):**

| Arm | Total exact | Date exact | Take-home exact | Lines add up to total |
|---|---|---|---|---|
| A Haiku 4.5 | 10/10 | 9/10 | 4/10 | 2/10 (only the one-item receipts) |
| B Sonnet 5, thinking disabled | 10/10 | 10/10 | **10/10** | 9/10 |
| C Sonnet 5, adaptive | 10/10 | 10/10 | **10/10** | **10/10** |

**Single photos, across all three runs:** B's lines add up in **13 of 14** reads and C's in **13 of 14**, each missing a different receipt. Every Sonnet total and date was exact, and every take-home count where scored (runs 2 and 3). **B and C are tied.** Their output lengths are within about 2% of each other, so adaptive thinking barely engages on this task.

**Multi-photo, all runs:**

| Receipt | Arm | Runs | Total | Date | Lines add up | Take-home vs truth |
|---|---|---|---|---|---|---|
| r08 (3 parts) | B | 3 | 3/3 | 3/3 | 1/3 | not scored in run 1; +2, +2 |
| r08 (3 parts) | C | 3 | 3/3 | 3/3 | 2/3 | not scored in run 1; +2, +6 |
| r08 (3 parts) | A | 3 | 3/3 | 3/3 | 0/3 | not scored in run 1; +27, +24 |

(Take-home was added to the ground truth after run 1, whose raw outputs had already been deleted.)
| r10 (2 parts) | B, C | 1 | ✓ | **✗ none found** | ✗ | +3 |
| r10 (2 parts) | A | 1 | ✓ | ✗ none found | ✗ | +15 |

- **Multi-photo is not ready, but not proven bad either.** Totals are always right. Sonnet's lines add up in **3 of 8** reads, with the extra lines at or near the joins. That's weaker evidence than it looks: six of the eight reads are one receipt, r08, whose ground truth is in doubt, and the other two are r10, whose photo order is in doubt. There's no clean multi-photo test yet.
- **r08's ground truth is most likely a definition mismatch, not a miscount.** The models read 67 items plus 13 discount and void lines, and Robbie's 65 is close to the 67. So the count was probably of items, without the discount lines. Recount it with the rule stated: **`item_lines` is every printed line with a price, discounts and voids included.** Also record which photo shows the total.
- **r10 is suspect as an input.** All three arms said the total is on part 1 and found no date on either part. The part order was guessed by Claude when renaming the files, which contaminates what would have been the one clean multi-photo test. The order may be reversed, or the date line cropped. **Rule from now on: part order comes from Robbie.** Robbie names each part at the time of shooting, `rNN-part1.jpg` from the top.

**Other results, all runs:**

- **The add-up check is the safety net, and it mostly works.** Every Sonnet read with a wrong take-home count also failed the add-up check, apart from run 2's two r08 reads. Those added up at +2 items, and r08's ground truth is itself in doubt. The review screen's reconcile banner (§3) would have flagged all the others.
- **Seam flag:** it flagged `GREEN LENTILS 0.50` read at the foot of part 1 and again at the head of part 2 (Haiku, a clear echo). As designed, it never compared repeats within one part, such as two `JS CHICKPEAS` lines. Sonnet usually resolves the joins itself. Across the Sonnet multi-photo reads in runs 1 and 3, it raised one flag, and whether that was an echo or a real repeat can't be told without the paper. **Keep it** as a cheap backstop; its false-flag rate is unmeasured.
- **Card, tender and loyalty identifiers in the output, before redaction: 0 of 57.**
- **`stop_reason: max_tokens`: 0 of 57.** Largest Sonnet output 5,897 tokens.
- **Haiku 4.5 is out.** It got every total right but its lines rarely added up (2 of 19 reads across all runs, both one-item receipts). It misread a date, and on r08 it listed 105–107 lines against Sonnet's 80.
- **Voids:** every arm listed both lines of a void, `*MOMENT HANDWASH DUO 8.50` and its `ITEM CANCELLED … -8.50`. That's now the spec (§3).
- **Latency and sizes:** see §3's MEASURED blocks.

**Decisions from commit 0:**

| Item | Decision |
|---|---|
| `RECEIPT_MODEL` default | `claude-sonnet-5` |
| Image tier and `fitToVisionBudget` target | High-res: 1659 × 2212 for a 3:4 photo, never upscaled |
| Thinking | `{ type: "disabled" }`, set explicitly. It's tied with adaptive on accuracy, and disabling it keeps `max_tokens` for output. Revisit if multi-photo work shows C pulling ahead. |
| `max_tokens` | 16,000 (about 71 output tokens per line, so the 150-line cap is about 10.7k) |
| Output keys and line cap | Unchanged: full keys, 150 lines. The measured 39 s for 80+ lines leaves room. |
| Seam flag | Kept |
| `MAX_PART_BASE64_CHARS` / `MAX_TOTAL_BASE64_CHARS` | 3,500,000 / 9,000,000, confirmed |
| Spec corrections (§3) | 952 × 1270 standard size; no upscaling; the loyalty redaction rule needs an identifier; voids kept as two lines |

**Still owed before commit 3's prompt is final:**
- more multi-photo receipts with hand counts (at least 4 more), including one faded and one with a loyalty-number block;
- r08 recounted by the stated rule, and r10's part order checked;
- new receipts named by Robbie as they're shot, part 1 from the top;
- then re-run the multi-photo arm with the revised overlap guidance.

### Commit 1 ⚑ — schema: split into 1a and 1b (two migration files, one push)

It grew from one RPC with 6 checks and 5 sabotages to three RPCs, a trigger, 11 checks and 9 sabotages. The update path's transaction semantics deserve their own review and their own revert point.

- **1a** `feat(db): receipts and receipt_lines with updated_at, save_receipt and delete_receipt, per-user RLS`
  - Tables, the trigger, RLS, grants, `save_receipt`, `delete_receipt`.
  - Verify: V1–V6, V10 (container), V11.
  - Sabotages: 1–5 and 9.
- **1b** `feat(db): update_receipt — replace a receipt's header and lines in one transaction`
  - `update_receipt` and its grants.
  - Verify: V2/V3 addenda, V7, V8, V9, V10's date-flag half.
  - Sabotages: 6, 7a, 7b and 8.
- **Checklist:** §5's manual checklist. Push 1a and 1b together.

### Commit 2 — red tests for the pure logic

`test(receipts): parse, redact, parts and seams, reconcile, vision fit, spend buckets and CSV`

- **`_shared/__tests__/receipt.test.ts`:**
  - **`parsePence` table:** "12.30", "£12.30", "€3.00", "0.50-", "-0.50" pass. "12.3", "12.305", "", "abc", **"-0.50-"** and **"1,234.56"** → null.
  - **Redaction fixtures:** masked PANs in several formats, "CLUBCARD NO 634004…", postcodes, and tender lines dropped. **Revised 2026-09-27:** `Nectar Price Saving -0.75` and "Clubcard Price -0.50" are **kept** (no identifier), and "NECTAR POINTS BALANCE 1234" is dropped.
  - **Voids (Revised 2026-09-27):** an item line followed by `ITEM CANCELLED` and a negative line of the same amount parses as two lines, the second with `is_discount: true`, and reconcile holds.
  - **Date validation:** 29/02 on a non-leap year → null; future → null; 2+ years old → null.
  - **Parts:** 0 → bad_request, 4 → too_long; line `part` out of range → null; non-decreasing parts; `total_printed_part` < n → note; `same_receipt: false` → no_receipt.
  - **Seam flag:**
    - a 1-line echo across a join is flagged;
    - a 2-line echo is flagged on both copies;
    - **identical adjacent lines within one part are not flagged**;
    - equal text with a different total is not flagged;
    - a null total is not flagged;
    - only the *p+1* copies are flagged, never *p*.
  - **`stop_reason: "max_tokens"`** → failure, never a partial array.
  - **The handler, through injected deps** (admin client and fetch): a 3-part request inserts **exactly one** `ai_extractions` row, and a 4-part request inserts none.
- **`money.test.ts`:** `parsePenceInput` with the same decided cases; `formatPence` (no locale); `sumPence` null rules.
- **`spending.test.ts`:**
  - Monday-start weeks across the BST change;
  - month ends;
  - total → lines → unknown;
  - per-currency separation;
  - a `purchased_on` string never going through `new Date("YYYY-MM-DD")`;
  - **reconcile:** equal / over / under / unknown, plus the "over by exactly the flagged lines" message.
- **`imagePrep.test.ts` (new):** `fitToVisionBudget`:
  - 3072×4096 → 1659×2212 on high-res and 952×1270 on standard (Revised 2026-09-27, was 945×1260);
  - 1080×2400 → unchanged on high-res (Revised 2026-09-27: within both limits, so it's never upscaled); 1440×3200 → long edge binds at 2576;
  - 800×600 → unchanged;
  - **the output never exceeds either documented limit**, as a property check over a grid of sizes;
  - **the output is never larger than the input** (Revised 2026-09-27). The bake-off harness's property check found 0 violations of either over 2,788 cases.
- **`csv.test.ts` additions:** spending header pinned; NULL → empty cell; a receipt with no lines → one row; a comma in `raw_text` quoted.
- All tests are red (modules absent). Commit them red, following the `e4d3ca4` precedent.

### Commit 3 — Edge Function (and candidate E's comments)

`feat(fn): scan-receipt — transcribe a 1–3 part till receipt into structured lines`

- `supabase/functions/scan-receipt/index.ts` is a thin `Deno.serve` around `handleReceiptScan(req, deps)` in `_shared/receipt.ts`. The handler is importable, so commit 2's handler tests reach it.
- `RECEIPT_MODEL`, `max_tokens`, the 120 s timeout, the part and size limits from §3.
- Commit 2's function tests go green.
- **Same commit:** the three "bump via the MODEL secret, no redeploy" comments are replaced with the §3 warning. Comment-only, so those functions aren't redeployed.
- **Checklist:**
  - [ ] `npm run check:functions` (deno check). `functions deploy` doesn't type-check.
  - [ ] `npx vitest run`: all green. Record the count (baseline **1033/1033, 54 files, MEASURED at `eec75b9`**; **1055/1055, 58 files at `9ed4956`**, Revised 2026-09-27).
  - [ ] After deploy, when asked:
    - [ ] a real 1-part and 3-part receipt → 200 with the expected shape;
    - [ ] a non-receipt → 422 `no_receipt`;
    - [ ] two parts from different receipts → 422;
    - [ ] 4 parts → 413 `too_long`;
    - [ ] **a 9.0M-char body → the function's own response, not a platform error** (records the undocumented Supabase limit as MEASURED);
    - [ ] no JWT → 401;
    - [ ] the 21st scan in an hour → 429, counted together with meal scans;
    - [ ] **one `ai_extractions` row for the 3-part scan**;
    - [ ] the dashboard logs contain no receipt text.
- **Sabotage:**
  - (1) Remove the `stop_reason` guard → the truncation test goes red.
  - (2) Remove the tender-line drop → the redaction test goes red.
  - (3) Replace `parsePence` with `Math.round(parseFloat(s) * 100)` → "0.50-", "12.3" and "-0.50-" go red.
  - (4) Accept `new Date(dateStr)` → the leap-day case goes red.
  - (5) Call `logExtraction` once per part → the one-row test goes red.
  - (6) Let the seam check compare lines within one part → the within-part-repeat test goes red.
  - (7) Accept 4 parts → the 4-part test goes red.
  - (8) Ignore `same_receipt` → the mixed-receipt test goes red.

### Commit 4 ⚑ — client libraries: split into 4a and 4b

It now carries a refactor of a shipped flow (recipe capture), the vision-fit sizing, three RPC clients, paged reads and the guard. The refactor needs its own device check on a flow unrelated to receipts, so it shouldn't share a commit with new code.

- **4a** `refactor(capture): shared camera/library helper and a vision-budget receipt size`
  - `imageCapture.ts`, with `recipeImageCapture.ts` moved onto it;
  - the `"receipt"` `PrepareKind`, plus `fitToVisionBudget` and `MAX_PART_BASE64_CHARS` with one re-encode;
  - the header comment fix (candidate H).
  - **Checklist:**
    - [x] `tsc` 0 and vitest green (the receipt red tests aside): MEASURED 2026-10-04 at `f1bf2af`, 1083 passing, 129 expected-red.
    - [x] **device:** the recipe scan by camera and by library still previews and scans; cancel from either returns cleanly.
    - [x] meal-photo capture unchanged: from Add Ingredient and from the batch picker, camera only, results as before.
    - [x] label and front-of-pack photos in Create Food unchanged (they share `prepareImage`).
    - **Device pass 2026-10-04**, Robbie, Pixel dev client on `f1bf2af`: all passed.
  - **Sabotage:** make `fitToVisionBudget` ignore the token cap → the 3:4 high-res case goes red (2576 > 2212). **MEASURED 2026-10-04:** 6 red, 1932×2576 instead of 1659×2212; restored byte-identical.
- **4b** `feat(receipts): scan client, save/update/delete RPCs, paged reads, draft slice and the write-site guard`
  - `receiptScan.ts`, with its shape check including `part` and `possibleSeamDuplicate`;
  - `receipts.ts`: three RPC wrappers that **return the row or throw**, with `P0002` mapped to a typed "no longer exists" error, plus paged `fetchReceipts` and `fetchReceiptLinesForExport`, and single-receipt `fetchReceipt(id)`;
  - `money.ts` and `spending.ts`;
  - the store's receipt-draft slice (parts, lines, mode), cleared in `reset()`;
  - `receiptWriteSites.test.ts` with the AST helpers extracted.
  - **Checklist:**
    - [ ] `tsc` 0;
    - [ ] vitest green with `mealEntriesInsertSites.test.ts` **unchanged and green**;
    - [ ] `fetchEntriesPaging.test.ts` unchanged and green.
  - **Sabotage, one per §8 gate:**
    - add `supabase.from("receipts").update(...)`;
    - add `supabase.from("receipt_lines").delete()`;
    - call `.rpc("save_receipt"` from a screen file;
    - add `supabase.from("meal_entries")` to `receipts.ts`;
    - spread the draft into `p_receipt`;
    - add `user_id` or `purchased_on_estimated` to the update payload;
    - read `p_id` off the draft;
    - add `reportError(…, { extra: { store } })`;
    - add a `.toISOString().slice(0,10)`;
    - replace `fetchReceipts`' pager with a plain select.
    - Each must turn the guard red.
  - **Sabotage, save paths:** make `updateReceipt` return `null` on error instead of throwing → a unit test with a mocked failing `rpc` goes red. The same for `deleteReceipt`.

### Commit 5 ⚑ — UI: split into 5a (capture) and 5b (review, create and edit)

Multi-part capture and edit-after-save each doubled the screen work. They have separate device checklists, and neither depends on the other's UI.

- **5a** `feat(receipts): multi-part capture — add, reorder and remove up to three parts`
  - The `ReceiptScan` modal (§4): parts list, ↑/↓/✕, full-screen view, "Add another part" up to 3, hint, Scan.
  - **Checklist (Pixel 9):**
    - [ ] Camera and library each add a part.
    - [ ] Reorder with ↑/↓, and the order is what's sent (check the part labels on review).
    - [ ] ✕ removes.
    - [ ] A 4th add is not offered.
    - [ ] Cancel at each step returns cleanly.
    - [ ] Airplane mode → Scan fails → **all parts still on screen**, and a retry works once online.
- **5b** `feat(receipts): review screen — create and edit modes, delete, reconcile and seam flags`
  - One `ReceiptReview` component with the route param `{ mode: "create" } | { mode: "edit", receiptId }`. Edit loads via `fetchReceipt(id)`.
  - Same live-text fields in both modes, using CopyConfirm's pattern ([CopyConfirmScreen.tsx:108-135](src/screens/CopyConfirmScreen.tsx#L108-L135)).
  - The reconcile banner, including the flagged-sum message; seam-flag tags with one-tap Remove (create mode only).
  - Delete in edit mode, with a confirm.
  - Keep-input-on-failure in both modes. `P0002` → "This receipt no longer exists", and the screen closes on acknowledgement.
  - Wrapped in `KeyboardScreen` (PL-004 guard).
  - **Checklist (Pixel 9):**
    - [ ] Edit a price and tap Save without blurring → the saved row has the edited value, **in create and in edit mode** (the PL-005/006 regression check).
    - [ ] Airplane mode → Save → error, and all edits still there, in both modes.
    - [ ] Unreadable total → NULL in SQL, "—" in the UI.
    - [ ] An unread date → `purchased_on_estimated` true.
    - [ ] **Edit with the same date → still true; change the date → false** (SQL).
    - [ ] Edit: remove a line and add one → SQL shows exactly the new set; `updated_at` moved.
    - [ ] Delete → the row and lines are gone, and Spending updates.
    - [ ] Delete on a second device first, then Save here → "no longer exists", with no row resurrected.
    - [ ] A 3-part scan with a seam echo → the flag shows, the banner quotes the matching amount, and Remove fixes the reconcile.
    - [ ] SQL: `select count(*) from meal_entries` is unchanged across save, edit and delete.
- **Sabotage:** switch one price field to commit-on-blur → the "Save without blurring" step fails on device (record it once).

### Commit 6 — Data tab: Grocery spending segment

`feat(data): Spending segment — grocery spending by week, month and store, receipts, CSV`

- The segment described in §2, titled "Grocery spending". The entry point is here, Batches is untouched, and a receipt row tap opens 5b in edit mode.
- **Checklist:**
  - [ ] The 3-way control fits at 360 dp without truncation.
  - [ ] Week/Month totals match a hand sum in SQL.
  - [ ] A € receipt shows on its own line, not added.
  - [ ] Unknown-total receipts are listed and not counted.
  - [ ] After an edit or delete, totals update on return.
  - [ ] The CSV opens in Sheets with empty cells for NULL and correct dates.
  - [ ] `tabStructure.test.ts` unchanged and green.
- **Sabotage:** coalesce an unknown total to 0 in `spending.ts` → the null-rule test goes red.

### Commit 7 — Data tab tidy (separate, no behaviour change)

`refactor(data): one range control, dateKey in History, drop the unused standalone mode`

- Unchanged from the first version.
- Candidate A, if you number it, gets its own red-test-then-fix pair. PL-026 (was B) likewise.

### Revised commit list

| # | Commit | Status vs the first version |
|---|---|---|
| 0 | `docs(receipts)`: bake-off, **with the multi-photo arm** | Grew (one more arm, five more metrics); still one docs commit. **Done 2026-09-27**; multi-photo follow-up owed before commit 3 |
| 1a | `feat(db)`: tables, `updated_at` trigger, RLS, `save_receipt`, `delete_receipt` | **⚑ Split** |
| 1b | `feat(db)`: `update_receipt` | **⚑ Split** |
| 2 | `test(receipts)`: red tests for all the pure logic | Grew; still one commit (all red, no behaviour) |
| 3 | `feat(fn)`: `scan-receipt`, plus candidate E's comment warnings | Grew moderately; kept whole, since the E comments are tiny and decided to ride along |
| 4a | `refactor(capture)`: shared capture helper, vision-budget sizing | **⚑ Split** (touches the shipped recipe flow) |
| 4b | `feat(receipts)`: scan client, 3 RPCs, paged reads, draft slice, guard | **⚑ Split** |
| 5a | `feat(receipts)`: multi-part capture | **⚑ Split** |
| 5b | `feat(receipts)`: review, create and edit modes, delete | **⚑ Split** |
| 6 | `feat(data)`: Grocery spending segment | Slightly grew (edit on tap) |
| 7 | `refactor(data)`: tidy | Unchanged |

### Deploy (only when you ask)

1. `db push` of 1a and 1b together → verify file.
2. Function deploy (3) → smoke test, including the 9.0M-char body probe.
3. `runtimeversion:resolve` unchanged (`c1907ba4…` / `5359dcce…`) → OTA of 4a–7.
4. Record it all in `testing/` under the IDs you allocate.
