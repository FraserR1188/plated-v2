# plated. — user testing log

Every round of testing on plated. gets a record here: what the tester said, and what was changed in response. Nothing gets fixed silently.

## What's in this folder

| File | What it's for |
|---|---|
| `testing/README.md` | This index — the master list of sessions and open issues |
| `testing/feedback-form-template.md` | Blank form to hand a tester (or fill in while watching them) |
| `testing/session-template.md` | The record format — raw feedback plus the rectification log |
| `testing/YYYY-MM-DD-<tester>.md` | One per session |
| `testing/YYYY-MM-DD-internal.md` | Issues found by the developer rather than a tester (Tester = "self (dev pass)") |
| `testing/archive/` | Files from the retired P-TF system (`register.md`, `incident-form-template.md`, `P-TF01.md`, `P-TF02.md`), kept unchanged |

## The loop

1. **Before the session** — note the build/version being tested and what you want to learn from this round.
2. **During** — capture raw feedback in the blank form. Tester's words, not your interpretation.
3. **After** — copy `session-template.md` to `testing/YYYY-MM-DD-<tester>.md`, paste the raw feedback in, and split it into numbered issues (`PL-001`, `PL-002`, … sequential across *all* sessions, never reused).
4. **As you fix** — update the issue's row in that session doc: what you changed, which commit/build, and how you confirmed it.
5. **Update the tables below** so the current state is readable without opening every session doc.

Issues you find yourself go in a dated `-internal.md` doc using the same template, so they share the PL- sequence and a later tester session can move them to `Verified`.

## Conventions

**Severity**

- `Blocker` — can't complete the task at all, or data loss
- `Major` — completes the task but with real friction, wrong numbers, or a workaround
- `Minor` — annoying, doesn't stop anything
- `Polish` — cosmetic, copy, spacing

**Status**

- `Logged` — captured, not started
- `In progress` — being worked on
- `Fixed` — change is in, not yet re-tested with a user
- `Verified` — a tester hit the same flow afterwards and it held up
- `Deferred` — real, not now (say why)
- `Won't fix` — deliberate decision (say why)

An issue only reaches `Verified` when a person exercises the flow again — your own re-test counts as `Fixed`, not `Verified`.

P-TF IDs predate the PL- scheme; they keep their IDs and are never reused. New issues use PL-.

**PL-029 was never assigned.** It appears in no session doc and in no table here. It is left unused rather than filled in: numbers are never reused, and a number that never meant anything is safer empty than given a second meaning later. Take the next number above the highest allocated one, and check the newest session doc as well as these tables — a row can exist in a doc without having reached here yet.

**Every device-pass record states the commit SHA it ran on.** Not the branch, not the date — the SHA. A pass is a statement about one build, and "passed on `feat/x`" is not one, because the branch moves. Before publishing, `git diff --stat <that SHA> HEAD` **must list only `testing/` files**: if anything under `src/`, `supabase/` or the build config differs, the thing that passed is not the thing being shipped, and the pass has to be redone. This convention comes out of PL-034 — a re-check recorded on 2026-09-20 named no SHA at all, and what it recorded as passing was not true of the commit that was published.

## Sessions

| Date | Tester | Build / version | Device | Issues raised | Still open | Doc |
|---|---|---|---|---|---|---|
| 2026-09-26 | self (dev pass; found in the receipt-scanner investigation) | investigation against master @ `177ed0a`; row counts measured on the live DB | none | 1 | 1 | `testing/2026-09-26-internal.md` |
| 2026-09-25 | self (read-only investigation; PL-039 fix + device pass) | investigation against master @ `63be47c`, plus live OFF probes; PL-039 fixed at `ba9b8f8`, device-passed on a Pixel dev build | Pixel (PL-039 pass only) | 11 | 11 | `testing/2026-09-25-internal.md` |
| 2026-09-21 | Kayce | Not recorded — the form has no build field and About can't show one (PL-043) | Samsung Galaxy S23 Ultra, Android version not recorded | 2 | 2 | `testing/2026-09-21-kayce.md` |
| 2026-09-21 | Ian | Not recorded — the form has no build field and About can't show one (PL-043) | Google Pixel 10, Android 17 | 2 | 2 | `testing/2026-09-21-ian.md` |
| 2026-09-21 | self (dev pass) | defect seen on the production OTA, master @ `1d6babb`; fix device-passed at `aa1e060`, shipped at `3a3f937` — OTA Android `b4ff5ee0` + iOS `b5e27de5` (runtimes `c1907ba4…` / `5359dcce…`) | Google Pixel 9, Android 15 (default + `wm density 480` + largest font); iOS owed | 1 | 1 | `testing/2026-09-21-internal.md` |
| 2026-09-20 | self (dev pass) | master @ `5d03ebf`; three OTAs — Android `faa10722`/`875be285`/`7c0b4336`/`63f5a117`, iOS `75060c2b`/`b3285525`/`6f4454b1`/`3930c7e2` | Pixel (default + 360dp + largest font); iOS owed | 15 | 15 | `testing/2026-09-20-internal.md` |
| 2026-09-19 | self (dev pass) | production OTA, master @ `48d09e1` (fixes since shipped to `5ab80ea`) | Pixel (Android) | 17 | 16 | `testing/2026-09-19-internal.md` |
| 2026-08-25 | Ian | Not recorded (newest Android store build then: v6, `f48184c`) | Google Pixel 10, Android 17 | 4 | 4 | `testing/2026-08-25-ian.md` |

## Open issues across all sessions

| ID | Severity | Summary | Status | Raised in | Fix / note |
|---|---|---|---|---|---|
| PL-023 | Blocker | A failed goals read makes Settings persist the defaults over real targets | Fixed | 2026-09-20-internal | goalsState loading/loaded/absent/error, session gate on the read, changed-columns-only UPDATE, insert on absent, Settings re-syncs + Save disabled unless writable, foreground retry. 17 tests, 9 sabotage runs. Master @ 5f347c3; OTA Android faa10722 + iOS 75060c2b. Pixel pass OK (single-column write confirmed in SQL); iOS owed. Needs a tester |
| PL-003 | Blocker | addEntry swallows insert errors; log silently lost | Fixed | 2026-09-19-internal | Master @ 5abcbcb; OTA Android 6219ac78 + iOS 939f4f9d. Device pass OK. Needs a tester log |
| PL-001 | Major | Friend copy drops sat_fat to NULL | Fixed | 2026-09-19-internal | Rerouted via CopyConfirm → applyEntries; guards A + C. Post-copy destination changed 2026-09-20 — now lands on Today on the copied day (OTA Android 10b5ab16 + iOS 7f5a5b0b). Needs a tester copy |
| PL-002 | Major | saved_ingredients coerces unknown small four to 0 | Fixed | 2026-09-19-internal | Migration 20260919120000 + guard B+. Existing zeros not backfilled |
| PL-004 | Major | Android keyboard covers inputs on 13 surfaces | Fixed | 2026-09-19-internal | KeyboardScreen wrapper. Master @ 4c2d2f1; OTA Android ce5de6bb + iOS bf4b3ef8. Device pass OK (Pixel, all 13 surfaces; iOS ProductScreen). Needs a tester |
| PL-005 | Major | BundleApplyReview applies last-blurred grams | Fixed | 2026-09-19-internal | Commit-on-change (live text). Master @ 4c2d2f1; OTA Android ce5de6bb + iOS bf4b3ef8. Device pass OK (150 g applied, twice). Needs a tester |
| PL-006 | Major | BatchEditor Save can miss an uncommitted qty | Fixed | 2026-09-19-internal | Commit-on-change (live text). Master @ 4c2d2f1; OTA Android ce5de6bb + iOS bf4b3ef8. Device pass OK; yield/portion clearing while typing accepted. Needs a tester |
| PL-024 | Major | Clearing or mistyping a goal field silently saved the hard-coded default (0 too) | Fixed | 2026-09-20-internal | Strict parsing in src/lib/goalInput.ts; per-field errors, Save disabled until valid. 0 valid for the seven macros, calories min 1. 16 tests, 6 sabotage runs. Master @ 5f347c3; OTA Android faa10722 + iOS 75060c2b. Pixel pass OK; iOS owed. Needs a tester |
| PL-007 | Major | CSV export and last30Days use UTC dates | Fixed | 2026-09-19-internal | dateKey for the date column, filename and last30Days bounds; calendar arithmetic, not fixed ms. Window is now exactly 30 local days (was 31). Suite pinned to Europe/London. 14 tests, 4 sabotage runs. Master @ 5ab80ea; OTA Android 875be285 + iOS b3285525. Pixel pass OK; iOS owed. Needs a tester |
| PL-008 | Major | CSV exports NULL small four as 0.0 | Fixed | 2026-09-19-internal | optionalCell: empty for NULL, 0.0 for a measured zero. Header and column order pinned by test. Master @ 5ab80ea; OTA Android 875be285 + iOS b3285525. Pixel pass OK; iOS owed. Needs a tester |
| PL-028 | Major | Product with no OFF nutrition data stored all-zero; a bundle freezes it | In progress | 2026-09-20-internal | OFF has 0 of 8 nutriment keys for these barcodes; parseProduct coalesces the BIG four to 0 (openfoodfacts.ts:254, 313-316) while the small four correctly stay undefined. 3 real bundle items / 2 users; 32 zeroed chia entries. Chia repairable from a known-good sibling, onions not. PL-011 with a measured cost. Ingestion holes now closed (missingMacros + bundle prompt); the all-zero barcode path was already closed by cb51fd5 on 2026-08-15 and all four products predate it. Data repair pending |
| PL-031 | Major | The PL-028 repair backup was created in `public`, so `anon`/`authenticated` had full DML on 41 rows across 3 accounts, RLS off | Fixed | 2026-09-20-internal | Moved to `maintenance.pl028_repair_backup` the same day; live ~20 minutes, caught by the post-commit readback. Rule: a scratch table never goes in `public` |
| PL-011 | Major | meal_entries big four can't represent unknown | Deferred | 2026-09-19-internal | Riskier schema change; separate decision |
| P-TF01b | Major | Never asked for calorie or macro targets | Logged | 2026-08-25-ian | No onboarding; new accounts run on DEFAULT_GOALS (2000 kcal) until set in Settings. No fix found |
| P-TF02a | Major | Food search kept erroring; worked after numerous retries | Logged | 2026-08-25-ian | Probable fix, unconfirmed: e958f4d (OFF User-Agent + timeout), Android v8+ and iOS build 3. Symptom not tied to it |
| PL-018 | Major | Today/workouts don't refetch when a foreground sync resolves | Fixed | 2026-09-20-internal | syncRefetch.ts watches each sync; refetches only when it wrote. Master @ 2f8195f; OTA Android 10b5ab16 + iOS 7f5a5b0b. Device pass OK (Pixel + iOS). Needs a tester |
| PL-039 | Major | Time chip rolls a forward plan on today back to yesterday, saved as eaten | Fixed | 2026-09-25-internal | Roll back only before 04:00 (SMALL_HOURS_END_H), and there to the nearer of today's/yesterday's reading (tie → today). Master @ ab51d71 (red) + ba9b8f8 (fix); 998/998, tsc 0; fingerprints unchanged (Android 0/158, iOS 0/142). Device pass OK (Pixel dev build, 2026-09-25: route B, backward pick, 23:58 same-day); route A and edit not recorded. OTA Android dd7aa75a + iOS 090fd176 (master @ 7da6665, 2026-09-25). Detection run 2026-09-26: 19 candidates, 13 ruled out by the estimated flag, ≤6 left (all a8435663, catch-up logging); no rows repaired. Re-run Q2 on/after 2026-10-03: a8435663 last_logged must stay 2026-09-25. Needs a tester |
| PL-037 | Major | Can't change an entry's meal when editing | Fixed | 2026-09-21-kayce | Chips on edit + pure buildEditPatch diffing against the row as loaded (slot-only sends {meal_type}; eaten_at at minute precision; macros only on a serving change; nothing changed → no write). Delete dialog names the stored slot. Closes PL-010 for edits that don't change the serving; untouched times keep their seconds. Master @ 7801f20 (red) + 6a879aa (fix); 1009/1009, tsc 0; fingerprints unchanged. Device pass OK (Pixel dev build, 2026-09-25: all six checks, incl. float-noise row digit for digit and xmin unchanged on no-change). OTA Android 4e4a04c5 + iOS cea9b54b (master @ fe2a3bd, 2026-09-25). Needs a tester |
| PL-035 | Major | Generic whole foods missing from search ("apple" shows juice and pie) | Logged | 2026-09-21-ian | Not reproduced on 2026-09-25 data (plain Apple ranks #1). Structural gap: main search is OFF-only, popularity-ordered page. Agreed: PL-042 data step first, then CoFID staples above OFF results; skip saveIngredient for cofid. Lands with PL-040 |
| PL-040 | Major | Non-OFF data shown as "Source: Open Food Facts (ODbL)" | Logged | 2026-09-25-internal | isOpenFoodFactsSourced(undefined) is true; mealEntryToProduct maps all non-custom to "off". CoFID notices never rendered. Lands with PL-035 |
| PL-041 | Major | PL-028 cucumber repair wrote a single OFF row's values (52 kcal/100 g) — not raw cucumber | Logged | 2026-09-25-internal | Identification plan and SELECTs in the session doc (backup table + barcode across three tables, grouped by user_id). No repair from a single OFF row. Check before any further data repair |
| PL-042 | Major | `apple` staple is CoFID's cooking apple, aliased "eating apple" | Logged | 2026-09-25-internal | seedStaples.ts:292 → 14-362. Live in the recipe scanner today. Agreed: remap from the CoFID file + seed produce unitGrams, as PL-035's data step |
| PL-050 | Major | fetchEntries reads meal_entries in one unpaged request; PostgREST silently caps it at max_rows | In progress | 2026-09-26-internal | MEASURED 2026-09-26: user A 787 rows at 8.4/day from 2026-06-24; crosses 1000 around 2026-10-21 if hosted Max rows = 1000 (setting not yet confirmed). Hosted Max rows raised 1000 → 2000 the same day as a stopgap (dashboard, no deploy); A now crosses around mid-Feb 2027. Fix: page with .range(), order logged_at desc + id desc |
| PL-034 | Minor | Trends y-axis labels render outside the card — "2,800" shows as ",800" | Fixed | 2026-09-21-internal | The labels were absolutely positioned inside a column with no width, so the column measured zero and every label hung off its left edge. Nice-number ticks, gridlines, dated x labels and a computed gutter, all from one pure buildChartLayout. Device pass OK at `aa1e060` (Pixel, default + 480 density + largest font, 7 and 14 days, three nutrients). Master @ `3a3f937`; OTA Android `b4ff5ee0` + iOS `b5e27de5`, 2026-09-21 19:56 BST. The goal-on-a-tick gridline dedupe is tested but not yet seen on a device. Needs a tester |
| PL-032 | Minor | "Three bean chilli and avocado salsa" holds two identical 6 g Salt items; possibly a duplicate insert | Logged | 2026-09-20-internal | Not reproduced; needs the composition's history checked before anything is deleted |
| PL-010 | Minor | buildEditPatch snaps edits to the rounding grid | Deferred | 2026-09-19-internal | Bounded drift, not urgent |
| PL-014 | Minor | Copy-a-day failures double-report to Sentry | Logged | 2026-09-19-internal | Audit applyEntries callers |
| PL-012 | Minor | Tesco Gold Coffee library row saved all-zero | Deferred | 2026-09-19-internal | Check the OFF source first |
| PL-015 | Minor | Clearing an AI macro cell on ProductScreen stores 0, not NULL | Logged | 2026-09-19-internal | Hard to reach: the AI fills all eight |
| PL-016 | Minor | Food search failures never reach Sentry | Logged | 2026-09-19-internal | No searchFood caller reports; P-TF02a can't be confirmed or ruled out if it recurs |
| PL-017 | Minor | Users without targets report fetchGoals errors to Sentry | Fixed | 2026-09-19-internal | `.maybeSingle()` + no-row path, superseded by PL-023's goalsState. Master @ 5f347c3; OTA Android faa10722 + iOS 75060c2b. Pixel pass OK; iOS owed. Sentry count still owed: no credentials on the dev machine |
| P-TF01a | Minor | No confirmation email after sign-up | Logged | 2026-08-25-ian | None is sent: Confirm email is off (mailer_autoconfirm true, measured 2026-09-19). 87e16cf fixed the false copy; 8eb2e5e's "Check your email" screen may still show. A new-account sign-up check decides. Blocker if Confirm email is turned on and mail doesn't arrive |
| P-TF02b | Minor | Search "sometimes seems to need a space after the item name" | Logged | 2026-08-25-ian | Symptom of P-TF02a: queries are trimmed, so the space only re-fires the same search. Closes when P-TF02a does |
| PL-019 | Minor | whoop-sync never closes/deletes dropped cycles; orphan open cycle, is_current returns 2 rows | Logged | 2026-09-20-internal | Contained by the 36h guard. Constraint: never select "today's cycle" via is_current — readiness query included |
| PL-025 | Minor | Structural update-site test resolves variables by name file-wide | Logged | 2026-09-20-internal | A local named `patch` in useStore.ts makes updateEntry's spread look traceable and flips the test into its "delete me" branch. Needs a scope-aware resolver. Don't name a local `patch` there |
| PL-026 | Minor | History adherence % ignores goalsState, so `error` reports adherence against defaults | Logged | 2026-09-20-internal | Show "–" unless loaded/absent. Constraint: Insights may only compute against goals when goalsState is `loaded` — `absent` means defaults, not the user's targets |
| PL-027 | Minor | Today shows the default 2,000 kcal ring and macro targets as the user's own while goals are in `error` | Logged | 2026-09-20-internal | Display only; PL-023 already blocks the write. Show "–" or a hint in `error` only — `absent` keeps the defaults. Do it with PL-026 in one pass |
| PL-030 | Polish | ProductScreen preview shows 0.0 for a small-four value stored as NULL | Logged | 2026-09-20-internal | computeServingTotals coalesces for display; the insert at ProductScreen.tsx:528-539 preserves NULL correctly. Preview disagrees with the row |
| PL-020 | Minor | Batches "Logged" alert says "today's log" when a past day was picked | Fixed | 2026-09-20-internal | batchLogAlert names the picked day via dateKey. Master @ 2f8195f; OTA Android 10b5ab16 + iOS 7f5a5b0b. Combined device pass OK (Pixel + iOS). Needs a tester |
| PL-021 | Minor | Today header overflows at 360dp, off-today pages with the Bundles chip | Fixed | 2026-09-20-internal | "Return to today" moved into the eyebrow; right row is the Bundles chip + calendar. Master @ 2f8195f; OTA Android 10b5ab16 + iOS 7f5a5b0b. Combined pass OK (Pixel default/360dp/largest font, iOS). Needs a tester |
| PL-036 | Minor | AI scan is live-camera only; a menu screenshot can't be used to plan | Logged | 2026-09-21-ian | Feature gap. Picker already native. Agreed: mode "menu" on scan-meal-photo (one function, two entry paths); Edge Function deploy before the OTA |
| PL-038 | Minor | Sign-up has one password field | Fixed | 2026-09-21-kayce | show/hide toggle, autofill hints (new-password / current-password / email), one rule (validateSignUpPassword, MIN_PASSWORD_LENGTH = 6) used by sign-up and reset. Master @ e19d155 (red) + fb8b5c9; 1022/1022, tsc 0; fingerprints unchanged. Confirm field deliberately not taken. Device checklist results not recorded. OTA Android 4e4a04c5 + iOS cea9b54b (master @ fe2a3bd, 2026-09-25). Needs a tester |
| PL-043 | Minor | About shows no build, runtime or OTA id | Fixed | 2026-09-25-internal | runtime (8) · channel, update id (8) or 'embedded' via isEmbeddedLaunch; tap to copy (core Clipboard, deprecated). No native build number: not readable without expo-application (a build). Master @ 559945e (red) + 2b644a8; 1016/1016, tsc 0; fingerprints unchanged. Post-publish check passed 2026-09-26 (production Android: channel production, runtime c1907ba4, real update id); dev-client steps not recorded. OTA Android 4e4a04c5 + iOS cea9b54b (master @ fe2a3bd, 2026-09-25). Needs a tester |
| PL-044 | Minor | OFF non-OK response surfaces as a JSON SyntaxError | Logged | 2026-09-25-internal | No res.ok check in searchFood/lookupBarcode. 503s measured 2026-09-25. Pairs with PL-016 |
| PL-046 | Minor | Scanner's onScanned is a function in navigation params | Logged | 2026-09-25-internal | RecipeConfirm + BatchIngredientPicker. Precedent: onPick moved to a store slice |
| PL-047 | Minor | app.json requests RECORD_AUDIO while both camera plugins block it | Logged | 2026-09-25-internal | Predicted; check the AAB permission list first. Removal changes the fingerprint (build) |
| PL-048 | Minor | eaten_at_estimated true on every planned meal and on Today-picker times, so has_estimated_times discriminates nothing | Logged | 2026-09-25-internal | ProductScreen.tsx:619 `isPlanned ? true : !timeTouched`. All 10 most recent rows on Robbie's account true (2026-09-25). Column is NOT NULL DEFAULT true. The flag encodes 'time not set on ProductScreen's chip', not 'guess': the fix is deciding what it means. Severity revisited 2026-09-26: still Minor; Major if anything acts on has_estimated_times. Open: does confirming clear it? |
| PL-049 | Minor | sectionForTime never returns Snacks; a snack before noon defaults to Breakfast | Logged | 2026-09-25-internal | Candidate, product decision pending. Contributing cause of PL-037. Also writes meal_type with no chip for anchored bundles and batches (compositions.ts:504, :928), so any rule change moves those too. Proposed: bands with Snacks in the gaps |
| PL-013 | Polish | RecipeConfirm doubles the bottom inset | Fixed | 2026-09-19-internal | SafeAreaView edge kept, footer inset dropped. Master @ 4c2d2f1; OTA Android ce5de6bb + iOS bf4b3ef8. Device pass OK. Needs a tester |
| PL-033 | Polish | Today's "so far" point is visually identical to an incomplete one — both hollow | Logged | 2026-09-20-internal | `isHollow` is `incomplete \|\| soFar`. Options: a different stroke for `soFar`, or mark today some other way — the dashed leg already arrives there |
| PL-022 | Polish | whoop_data.sql:125-127 describes an upsert gate that doesn't exist | Logged | 2026-09-20-internal | Sync upserts blindly (whoop-sync/index.ts:290-297); comment-only drift |
| PL-045 | Polish | `countries_tags` isn't demonstrably a filter; "UK products first" comment probably untrue | Logged | 2026-09-25-internal | count 2378 with vs 2132 without (measured 2026-09-25) |

## Closed issues

| ID | Severity | Summary | Status | Raised in | What changed |
|---|---|---|---|---|---|
| PL-009 | Polish | Float noise in stored small four | Won't fix | 2026-09-19-internal | Round-at-display-only is deliberate; never visible, can't move stats. Don't compare small four as text in SQL |
