# Phase 3 — no-silent-failures capture wiring: findings

Read-only investigation. No code, config, or dependencies were changed. All claims below are
sourced from the file/line noted, re-read live (not from memory of
[docs/sentry-readiness-findings.md](sentry-readiness-findings.md), which was written before
commits `9880589` (Phase 1), `1c23b03` (Phase 2), and `7aebf64` (Phase 2.1) landed). Where this
doc's findings differ from or extend the readiness doc, that's called out explicitly.

**Path correction**: the brief cites `src/store/compositions.ts`. That file is at
[src/lib/compositions.ts](../src/lib/compositions.ts) — `src/store/` contains only
`useStore.ts`. Read the correct file throughout.

**Confirmed unchanged since the readiness doc**: the seven "unexpected payload" sites (D), the
four `readErrorBody()` duplicates (A3 in the readiness doc), and `FriendsScreen.tsx:278` (E) are
all still exactly where and what they were. Phase 2/2.1 touched only `App.tsx`,
`instrument.ts`, and `AppNavigator.tsx` — none of the files this investigation covers.

---

## A) Degradation-site census

47 sites read in full across the six files. Columns: what it was doing, what it logs today,
what it returns on failure, and **call-frequency class** — the new column this brief asked for,
because it drives whether a site should get `captureException`, a throttled/fingerprinted
`captureMessage`, or nothing.

Frequency classes used: **one-shot** (discrete user action), **background** (screen-focus
refetch / fire-and-forget sync), **render-path** (called during JSX render, not an effect —
worse than "hot-path" for capture purposes because it can re-fire every frame, not just often).
No true per-keystroke site exists in these six files.

### `src/store/useStore.ts`

| Site | Operation | Logs today | Returns on failure | Frequency |
|---|---|---|---|---|
| [useStore.ts:406](../src/store/useStore.ts#L406) | `fetchEntries` | `console.warn(error.message)` | void (swallow) | **background** — `TodayScreen` `useFocusEffect` ([TodayScreen.tsx:217-223](../src/screens/TodayScreen.tsx#L217-L223)), also one-shot at sign-in ([App.tsx](../App.tsx)) and pull-to-refresh |
| [useStore.ts:432](../src/store/useStore.ts#L432) | `fetchWorkouts` | `console.warn(error.message)` | void (swallow) | background — same `TodayScreen` focus effect |
| [useStore.ts:458-479](../src/store/useStore.ts#L458-L479) | `fetchGoals` | **nothing — `error` is never destructured** | silently no-ops (goals stay stale) | one-shot (sign-in / auth-state-change) |
| [useStore.ts:481-490](../src/store/useStore.ts#L481-L490) | `fetchSavedIngredients` | **nothing — `error` never destructured** | silently no-ops | one-shot (sign-in) |
| [useStore.ts:411-419](../src/store/useStore.ts#L411-L419) | `fetchCompositions` | `console.warn(msg(e))` | void (swallow) | background — `TodayScreen`, `BatchEditorScreen:241`, `BatchesScreen:62/68` focus effects |
| [useStore.ts:544-547](../src/store/useStore.ts#L544-L547) | `addEntry` | `console.warn(error.message)` | void (swallow) | one-shot |
| [useStore.ts:553-558](../src/store/useStore.ts#L553-L558) | `deleteEntry` | `console.warn(error.message)` | void (swallow) | one-shot |
| [useStore.ts:568-571](../src/store/useStore.ts#L568-L571) | `deleteEntries` | `console.warn(error.message)` | **propagates** `WriteResult` | one-shot |
| [useStore.ts:593-611](../src/store/useStore.ts#L593-L611) | `updateEntry` | `console.warn(error.message)` | **propagates** `WriteResult` | one-shot |
| [useStore.ts:645-648](../src/store/useStore.ts#L645-L648) | `confirmEntries` (corrected-time branch) | `console.warn(error.message)` | void (swallow — outer fn has no return) | one-shot |
| [useStore.ts:667-670](../src/store/useStore.ts#L667-L670) | `confirmEntries` (bulk branch) | `console.warn(error.message)` | void (swallow) | one-shot |
| [useStore.ts:696-699](../src/store/useStore.ts#L696-L699) | `skipEntries` | `console.warn(error.message)` | void (swallow) | one-shot |
| [useStore.ts:740](../src/store/useStore.ts#L740) | `retimeEntries` (per-row) | **nothing — no console call**, reason goes into the returned object only | **propagates** `WriteResult` | one-shot |
| [useStore.ts:781-783](../src/store/useStore.ts#L781-L783) | `copyEntriesToDay` | **nothing** at this layer (underlying `applyEntries` logs — see below) | **propagates** `WriteResult` | one-shot |
| [useStore.ts:795-797](../src/store/useStore.ts#L795-L797) | `copyEntriesTo` | nothing at this layer | **propagates** | one-shot |
| [useStore.ts:808-810](../src/store/useStore.ts#L808-L810) | `saveBundleFromEntries` | nothing at this layer | **propagates** | one-shot |
| [useStore.ts:831-833](../src/store/useStore.ts#L831-L833) | `addEntriesToBundle` | nothing at this layer | **propagates** | one-shot |
| [useStore.ts:865-867](../src/store/useStore.ts#L865-L867) | `applyCompositionToDay` | nothing at this layer | **propagates** | one-shot |
| [useStore.ts:882-884](../src/store/useStore.ts#L882-L884) | `renameComposition` | nothing at this layer | **propagates** | one-shot |
| [useStore.ts:898-900](../src/store/useStore.ts#L898-L900) | `removeCompositionItem` | nothing at this layer | **propagates** | one-shot |
| [useStore.ts:910-912](../src/store/useStore.ts#L910-L912) | `removeComposition` | nothing at this layer | **propagates** | one-shot |
| [useStore.ts:922-924](../src/store/useStore.ts#L922-L924) | `saveBatch` | nothing at this layer | **propagates** | one-shot |
| [useStore.ts:936-938](../src/store/useStore.ts#L936-L938) | `saveBatchEdits` | nothing at this layer | **propagates** | one-shot |
| [useStore.ts:977-980](../src/store/useStore.ts#L977-L980) | `applyBatchNow` | nothing at this layer | **propagates** | one-shot |
| [useStore.ts:1053-1069](../src/store/useStore.ts#L1053-L1069) | `saveGoals` | **nothing — `upsert()` result isn't even captured**, and `set({goals})` runs unconditionally after | silently no-ops **but the UI shows the new goals as saved regardless** | one-shot |
| [useStore.ts:1087-1090](../src/store/useStore.ts#L1087-L1090) | `saveIngredient` (existing-item bump branch) | **nothing — `update()` result not captured** | optimistic local update regardless of remote outcome | one-shot |
| [useStore.ts:1100-1126](../src/store/useStore.ts#L1100-L1126) | `saveIngredient` (new-item insert branch) | **nothing — checks `error` but never logs it** | returns `null` | one-shot |
| [useStore.ts:1129-1134](../src/store/useStore.ts#L1129-L1134) | `deleteIngredient` | **nothing — `delete()` result not captured** | optimistic local removal regardless of remote outcome | one-shot |

### `src/lib/compositions.ts`

| Site | Operation | Logs today | Returns on failure | Frequency |
|---|---|---|---|---|
| [compositions.ts:70-73](../src/lib/compositions.ts#L70-L73) | `getCompositions` | `console.warn` + `throw` | propagates (throws to `fetchCompositions`'s catch) | background (see above) |
| [compositions.ts:190-193](../src/lib/compositions.ts#L190-L193) | `createBundleFromEntries` (composition insert) | `console.warn` + `throw` | propagates | one-shot |
| [compositions.ts:230-238](../src/lib/compositions.ts#L230-L238) | `createBundleFromEntries` (items insert) | `console.warn` + `throw`, also does a best-effort cleanup delete of the orphaned composition | propagates | one-shot |
| [compositions.ts:298-301](../src/lib/compositions.ts#L298-L301) | `appendEntriesToBundle` | `console.warn` + `throw` | propagates | one-shot |
| [compositions.ts:320-323](../src/lib/compositions.ts#L320-L323) | `renameComposition` | `console.warn` + `throw` | propagates | one-shot |
| [compositions.ts:333-336](../src/lib/compositions.ts#L333-L336) | `deleteCompositionItem` | `console.warn` + `throw` | propagates | one-shot |
| [compositions.ts:345-348](../src/lib/compositions.ts#L345-L348) | `deleteComposition` | `console.warn` + `throw` | propagates | one-shot |
| [compositions.ts:435-438](../src/lib/compositions.ts#L435-L438) | `previewComposition` (malformed bundle item) | `console.warn` — **the function's own doc comment says "RENDER PATH — DEGRADES, NEVER THROWS"** | `[]`-skips the item, never throws | **render-path** — called inline in `.map()` inside JSX at [TodayScreen.tsx:1405](../src/screens/TodayScreen.tsx#L1405), unmemoized: re-invoked on every render of the Bundles sheet for every bundle shown |
| [compositions.ts:549](../src/lib/compositions.ts#L549) | `applyComposition` (`bump_composition_use` RPC) | `console.warn` only — **deliberately swallowed**, per the function's own comment ("a bundle whose ordering hint didn't increment is not worth failing the user's meal over") | void (swallow), main insert already succeeded | one-shot |
| [compositions.ts:756](../src/lib/compositions.ts#L756) | `applyBatch` (`bump_composition_use` RPC) | same deliberate swallow | void | one-shot |
| [compositions.ts:924-929](../src/lib/compositions.ts#L924-L929) | `createBatchFromIngredients` (composition insert) | `console.warn` + `throw` | propagates | one-shot |
| [compositions.ts:943-951](../src/lib/compositions.ts#L943-L951) | `createBatchFromIngredients` (items insert) | `console.warn` + `throw` + cleanup delete | propagates | one-shot |
| [compositions.ts:997-999](../src/lib/compositions.ts#L997-L999) | `updateBatch` (composition update) | `console.warn` + `throw` | propagates | one-shot |
| [compositions.ts:1006-1009](../src/lib/compositions.ts#L1006-L1009) | `updateBatch` (delete old items) | `console.warn` + `throw` | propagates | one-shot |
| [compositions.ts:1018-1021](../src/lib/compositions.ts#L1018-L1021) | `updateBatch` (insert new items) | `console.warn` + `throw` | propagates | one-shot |

### `src/lib/foodLookup.ts`

| Site | Operation | Logs today | Returns on failure | Frequency |
|---|---|---|---|---|
| [foodLookup.ts:124-129](../src/lib/foodLookup.ts#L124-L129) | `lookupFood` (custom-food-by-barcode try) | **nothing** — bare `catch {}`, comment says "fall through and let OFF try anyway" | falls through to OFF lookup | one-shot per barcode scan — **frequency depends on `ScannerScreen`'s debounce, which is outside this read's file list; flagged as an open question below, not asserted** |
| [foodLookup.ts:132-139](../src/lib/foodLookup.ts#L132-L139) | `lookupFood` (OFF try) | nothing — bare `catch` | `{status:"network_error"}` | same caveat |
| [foodLookup.ts:158-161](../src/lib/foodLookup.ts#L158-L161) | `findCustomFoodByBarcode` | `console.warn` + `throw new Error(message)` | propagates (caught by `lookupFood`'s outer try, silently) | one-shot, called from `lookupFood` |
| [foodLookup.ts:205-212](../src/lib/foodLookup.ts#L205-L212) | `createCustomFood` | `console.warn` | returns `{food:null, error: <friendly>}` | one-shot |
| [foodLookup.ts:251-253](../src/lib/foodLookup.ts#L251-L253) | `setCustomFoodImages` | `console.warn` | returns `{food:null, error: <friendly>}` | one-shot |
| [foodLookup.ts:271-273](../src/lib/foodLookup.ts#L271-L273) | `searchCustomFoods` | `console.warn` | returns `[]` | **dead code — zero call sites anywhere in `src/`** (confirmed by grep); see Bugs Noticed |

### `src/lib/entries.ts`

| Site | Operation | Logs today | Returns on failure | Frequency |
|---|---|---|---|---|
| [entries.ts:119-121](../src/lib/entries.ts#L119-L121) | `applyEntries` (the single shared insert path) | `console.warn` + `throw` | propagates | one-shot — but reached from **four** different callers (`copyEntriesToDay`, `copyEntriesTo` in `useStore.ts`; `applyComposition`, `applyBatch` in `compositions.ts`), each a separate user action |

### `src/lib/ingredients.ts`

| Site | Operation | Logs today | Returns on failure | Frequency |
|---|---|---|---|---|
| [ingredients.ts:238-244](../src/lib/ingredients.ts#L238-L244) | `resolveIngredient` (OFF secondary-candidates try) | **nothing** — bare `catch {}`, comment: "A failed OFF search must not cost the user the staple hit" | `secondaries = []`, primary result still returned | one-shot, but fans out **N times per recipe-scan-confirm mount** (once per parsed line, in parallel — [RecipeConfirmScreen.tsx:111-120](../src/screens/RecipeConfirmScreen.tsx#L111-L120)) |
| [ingredients.ts:293-296](../src/lib/ingredients.ts#L293-L296) | `lookupStapleFromDb` | `console.warn` | returns `null` | same N-way fan-out as above — **quota hazard if capture is wired without fingerprinting**: one bad recipe with 20 unmatched lines would file 20 separate events without a shared fingerprint |

### `src/lib/customFoodImages.ts`

| Site | Operation | Logs today | Returns on failure | Frequency |
|---|---|---|---|---|
| [customFoodImages.ts:109-112](../src/lib/customFoodImages.ts#L109-L112) | `uploadCustomFoodImage` (storage upload) | `console.warn` | returns `{path:null, error}` | one-shot |
| [customFoodImages.ts:115-118](../src/lib/customFoodImages.ts#L115-L118) | `uploadCustomFoodImage` (catch) | `console.warn` | returns `{path:null, error}` | one-shot |
| [customFoodImages.ts:137-140](../src/lib/customFoodImages.ts#L137-L140) | `getSignedImageUrl` (sign failure) | `console.warn` | returns `null` (caller falls back to placeholder) | one-shot per `ProductThumb` mount — **not** a list renderer; only call site is [ProductScreen.tsx:172](../src/screens/ProductScreen.tsx#L172), one thumbnail per screen visit, not per list row |
| [customFoodImages.ts:142-145](../src/lib/customFoodImages.ts#L142-L145) | `getSignedImageUrl` (catch) | `console.warn` | returns `null` | same |
| [customFoodImages.ts:155-159](../src/lib/customFoodImages.ts#L155-L159) | `deleteCustomFoodImage` (catch) | `console.warn` | void — no propagation at all, fire-and-forget cleanup | one-shot |

### The one genuine render-path/hot-path finding

**[compositions.ts:435-438](../src/lib/compositions.ts#L435-L438) (`previewComposition`) is the only site in this census called from inside JSX render, unmemoized**, confirmed by tracing its one call site at
[TodayScreen.tsx:1404-1405](../src/screens/TodayScreen.tsx#L1404-L1405) — `bundles.map((bundle) => { const preview = previewComposition(bundle, dayKey); ... })`, directly in the returned JSX, not behind `useMemo`. Its own doc comment ([compositions.ts:409](../src/lib/compositions.ts#L409)) already states the design intent: *"RENDER PATH — DEGRADES, NEVER THROWS."* This is exactly the site the brief's frequency-class column exists to catch: wiring a naive `Sentry.captureException` here would (a) violate the function's own never-throw contract if anyone "upgrades" the warn to a throw alongside it, and (b) — even as a capture-without-throw — could refire on every re-render of the open Bundles sheet for as long as the malformed composition remains in the list, burning quota fast. **Disposition: leave log-only, or at most a heavily-throttled `captureMessage` with a fixed fingerprint keyed on `composition.id` (not `operation` alone) so repeated renders of the same bad bundle collapse to one issue** — see the per-site disposition table below.

---

## B) Error-type & leak surface (the scrub spec)

Every site above is one of these shapes:

| Error type | Where it shows up | Safe to send | Must scrub/drop |
|---|---|---|---|
| **Supabase `PostgrestError`** (`.select/.insert/.update/.delete/.rpc` failures) | Every `useStore.ts`/`compositions.ts` site with a `{data, error}` destructure | `error.code` (a stable Postgres/PostgREST error code, e.g. `23505`), `error.status` if present, the operation name we pass in ourselves | **`error.message`, `error.details`, `error.hint`** — PostgREST interpolates the failing predicate/constraint into these for many error classes (e.g. a unique-violation message echoes the conflicting column value; a check-constraint violation can echo the offending row's value). `useStore.ts:605-610`'s own regex-match against `error.message` (`/cannot move a logged meal into the future/i`) is proof the codebase already treats `.message` as containing semantically meaningful, potentially value-bearing text — never pass it through unscrubbed. |
| **Thrown `Error`** (`throw new Error(...)`, `throw error` re-throws of the above) | `applyEntries`, `createBundleFromEntries`, `deleteCompositionItem`, `findCustomFoodByBarcode` (wraps `error.message` in `new Error(...)`), etc. | `error.name`, a truncated/hashed version of `error.message` if it's one of the codebase's own hardcoded strings (e.g. `"Not authenticated"`, `"A bundle needs a name."`) | Any `Error` built from a Postgres message inherits the same risk as above — `findCustomFoodByBarcode` at [foodLookup.ts:160](../src/lib/foodLookup.ts#L160) does exactly this (`throw new Error(error.message)`), so the thrown `Error`'s `.message` is transitively a `PostgrestError.message` and must be treated with the same suspicion. |
| **Supabase Storage error** (`customFoodImages.ts`) | `uploadCustomFoodImage`, `getSignedImageUrl`, `deleteCustomFoodImage` | `error.name`/status | Storage errors can echo back the **object path**, which is `{user_id}/{custom_food_id}/{kind}.jpg` ([customFoodImages.ts:34](../src/lib/customFoodImages.ts#L34)) — i.e. the user's own UUID, embedded in a storage key. Same UUID-in-string risk the readiness doc already flagged for PostgREST query strings (B8) — `instrument.ts`'s `scrubUrl`/`UUID_RE` already redacts UUIDs in URLs, but a storage error's `.message` is not a URL, so the existing scrub wouldn't touch it unless the shared helper also scrubs arbitrary strings, not just URLs. |
| **`supabase.functions.invoke()` `FunctionsHttpError`** | The four `readErrorBody()` sites (not in this file set, but feed the same failure family) | the typed `error` code string (`"rate_limited"`, `"model_error"`, etc.) | Nothing sensitive today per the readiness doc's B7 — `error.context` only ever carries the edge function's own short envelope, not payload data. Out of scope for this brief's six files, noted for completeness since `reportError` will eventually wrap these call sites too. |
| **Network/fetch failure** (bare `catch (e)`, `e?.message ?? e`) | `lookupFood`'s two try/catches, `resolveIngredient`'s OFF-secondary catch, every `catch (e: any)` in `customFoodImages.ts` | `e.name` (e.g. `TypeError`), a generic "network unreachable" tag | `e.message` on a raw `TypeError`/fetch error is normally safe (no query values), but **do not assume** — treat uniformly with the PostgrestError rule rather than special-casing "this one's probably fine." |

**Scrub spec, concretely — what `reportError`'s `beforeSend`-equivalent must do to any error object before it leaves the device:**
1. Never forward `error.details` or `error.hint` (PostgrestError) at all — drop unconditionally, they're the highest-risk fields and carry no value `error.code` doesn't already give a developer.
2. Truncate/allowlist `error.message`: only forward it if it matches one of the codebase's own known hardcoded strings (the `throw new Error("...")` literals), or otherwise replace it with `error.code`/`error.name` alone. This is stricter than "scrub UUIDs out of it" — Postgres constraint-violation messages can carry non-UUID values too (numbers, text), so a UUID-only regex (today's `UUID_RE`) is insufficient for this new source.
3. Run any string field that *is* forwarded through the **same** `scrubUrl`/`UUID_RE` pattern already in `instrument.ts`, so a stray UUID that slips through rule 2 is still caught — this is the reuse case for extracting `scrub.ts` (see G).
4. For Storage errors specifically, never forward the object `path` field — it's a user-id-prefixed string by construction ([customFoodImages.ts:34](../src/lib/customFoodImages.ts#L34)).

---

## C) Contract-change audit — propagate vs. swallow, and double-report pairs

[useStore.ts:172](../src/store/useStore.ts#L172)'s doc comment, read in full: *"⚠ RETURNS AN ERROR NOW. It used to swallow failures into console.warn and return void — which was survivable until migration 5 gave the database a reason to REFUSE an update (moving a logged meal into the future). A refusal the UI can't see is a screen that closes as if it saved. Callers must check."* This describes `updateEntry` specifically, but the same "used to swallow, now propagates" shape applies to the whole `WriteResult`-returning family (`deleteEntries`, `retimeEntries`, `copyEntriesToDay`, `copyEntriesTo`, `saveBundleFromEntries`, `addEntriesToBundle`, `applyCompositionToDay`, `renameComposition`, `removeCompositionItem`, `removeComposition`, `saveBatch`, `saveBatchEdits`, `applyBatchNow` — 13 functions total).

**Every caller of a `WriteResult`-returning function was traced** (grep across `src/screens/`). The pattern is identical everywhere it's used:

```ts
const { error } = await updateEntry(editEntryId!, patch);   // ProductScreen.tsx:455
if (error) { Alert.alert("Can't save that", error, [...]); }
```

Confirmed at [ProductScreen.tsx:455-458](../src/screens/ProductScreen.tsx#L455-L458),
[TodayScreen.tsx:354-357](../src/screens/TodayScreen.tsx#L354-L357) (`deleteEntries`),
[TodayScreen.tsx:406-409](../src/screens/TodayScreen.tsx#L406-L409) (`copyEntriesToDay`),
[TodayScreen.tsx:427-430](../src/screens/TodayScreen.tsx#L427-L430) (`retimeEntries`),
[BatchesScreen.tsx:87-90](../src/screens/BatchesScreen.tsx#L87-L90) (`applyBatchNow`) — every caller
destructures `{ error }` and, if present, shows it via `Alert.alert`. **No screen does anything
else with it** — no logging, no re-throw, nothing that would today constitute a second report.

**This means there is no double-report happening today** (nothing captures anywhere yet), but it
gives a firm answer for where capture belongs once `reportError` exists: **instrument at the
store/lib layer, never at the screen layer, for every function in this propagating family.** The
screen only ever has the sanitized, user-facing string (`"Couldn't save that change. Check your
connection."`) — capturing *that* would be strictly worse than capturing at the origin, since the
original `PostgrestError` (code, which table, which operation) is already gone by the time it
reaches the screen. Concretely: the `if (error) { ... }` block inside `updateEntry` etc. (where
`console.warn` already fires today, or where a `throw` is caught inside `compositions.ts`) is the
one and only place `reportError` should be called for these 13 functions. **Treat "propagates a
`WriteResult`" as a hard rule: capture happens in the function that catches the raw Supabase
error, and the returned string is UI-only, never re-captured downstream.**

The pure-swallow family (`fetchEntries`, `fetchWorkouts`, `fetchCompositions`, `addEntry`,
`deleteEntry`, `confirmEntries`, `skipEntries`, and the five zero-logging sites) has no caller to
double-report against — there's nothing propagated to double up on. Capture there is a pure
addition, not a double-report risk.

---

## D) The seven "unexpected payload" sites — confirmed unchanged

All seven confirmed present, at the exact lines the brief cites, byte-for-byte unchanged since
the readiness doc (Phase 2/2.1 never touched these files):

- [mealRecognition.ts:119](../src/lib/mealRecognition.ts#L119) — `console.warn("scanMealPhoto: unexpected payload", data)`
- [labelExtraction.ts:126](../src/lib/labelExtraction.ts#L126) — `console.warn("extractNutritionLabel: unexpected payload", data)`
- [scanRecipe.ts:101](../src/lib/scanRecipe.ts#L101) — `console.warn("scanRecipe: unexpected payload", data)`
- [whoop.ts:176](../src/lib/whoop.ts#L176) — `whoop-auth-start: unexpected payload`
- [whoop.ts:249](../src/lib/whoop.ts#L249) — `whoop-auth-callback: unexpected payload`
- [whoop.ts:302](../src/lib/whoop.ts#L302) — `whoop-sync: unexpected payload`
- [whoop.ts:359](../src/lib/whoop.ts#L359) — `whoop-disconnect: unexpected payload`

**Confirmed against the live `beforeBreadcrumb` in [instrument.ts:21-24](../instrument.ts#L21-L24)**:

```ts
beforeBreadcrumb(breadcrumb) {
  if (breadcrumb.category === "console") return null;
  ...
```

This drops **every** console breadcrumb unconditionally — the code comment right above it
([instrument.ts:22-23](../instrument.ts#L22-L23)) reads *"Drop console breadcrumbs wholesale: the
'unexpected payload' sites can serialise nutrition/WHOOP data into the console message. Phase 3
fixes those at source"* — this is a direct, already-written forward reference to this exact
investigation, confirming the reasoning holds: today these seven sites are **fully inert** as
breadcrumbs (nothing reads console output — no Sentry breadcrumb, since the category is dropped
outright; nothing else consumes console in this RN app). The two-part fix the brief describes is
therefore still exactly right and still necessary:

1. **Source-fix** (all seven): swap the second `console.warn` argument from `data` to
   `Object.keys(data ?? {})` — a shape descriptor, not the payload. This is what makes it *safe*
   to later relax `beforeBreadcrumb`'s blanket console-drop, if that's ever wanted.
2. **Capture call** (all seven, additionally): these are genuine contract-drift signals — "the
   edge function answered something we don't recognize" — and today they leave zero trace beyond
   a console line nobody reads in production. A `reportError("scanMealPhoto:unexpected_payload",
   ...)` alongside the fixed `console.warn` is the actual value-add; the source-fix alone doesn't
   surface anything, it only makes future re-enablement of console breadcrumbs safe.

These seven are **one-shot** frequency (each fires once per scan/sync attempt, a discrete user or
foreground-triggered action) — no fingerprint-collision risk beyond the natural one (group by
`operation`, i.e. by function name, which is already the plan).

---

## E) Screen-layer sweep — confirmed, one site, unchanged

Re-grepped all of `src/screens/` for `console.*` calls. Two hits total:

- [FriendsScreen.tsx:278](../src/screens/FriendsScreen.tsx#L278) — `console.error("loadFollowing
  error:", err)` — **still the only site logging a raw error object instead of `.message`**,
  confirmed unchanged from the readiness doc.
- [BatchEditorScreen.tsx:208-210](../src/screens/BatchEditorScreen.tsx#L208-L210) — **new
  candidate, checked and cleared**: `console.warn(\`BatchEditor: skipping item ${item.id} — no
  usable serving_g...\`)` — this is a template-string message only, no object/payload argument.
  Consistent with the codebase's message-only convention; not a leak site.

No other file in `src/screens/` logs a raw object or payload. The readiness doc's finding stands
exactly as written.

---

## F) App.tsx — the fire-and-forget WHOOP sync, current lines

Restructured twice since the readiness doc (Phase 2 extracted `instrument.ts`, Phase 2.1 moved
branch selection above a single `Sentry.ErrorBoundary`), so the line numbers moved, but the
effect itself is byte-for-byte the same code. Current location:
[App.tsx:82-111](../App.tsx#L82-L111), swallow calls at **[App.tsx:105](../App.tsx#L105)** and
**[App.tsx:108](../App.tsx#L108)**:

```tsx
useEffect(() => {
  if (!session) return;
  syncWhoop().catch(() => {});                              // App.tsx:105
  const sub = AppState.addEventListener("change", (next) => {
    if (next === "active") syncWhoop().catch(() => {});      // App.tsx:108
  });
  return () => sub.remove();
}, [session]);
```

The surrounding comment block ([App.tsx:93-101](../App.tsx#L93-L101)) is unchanged and still
states the silence is deliberate: *"A failure here is silent BY DESIGN... An error banner on the
Today screen because a background poll timed out is the app complaining to someone who never
asked it to do anything."* That reasoning is about **UI** silence, not **observability**
silence — it argues against a user-facing banner, which a `Sentry.captureException` call doesn't
add. This is genuinely the one call site in the whole app with **zero** visibility into failures
today, not even a console line for local debugging during development.

**Recommendation for the brief to decide**: add `Sentry.captureException` (or
`reportError("whoopBackgroundSync", ...)`) inside both `.catch()` callbacks, with no UI change —
this satisfies the existing design rationale (still silent to the user) while closing the one
total-blackout site in the app. Frequency class: **background** (fires on session-start and every
app-foreground event) — should use a fixed, low-cardinality fingerprint (e.g.
`"whoop-background-sync"` alone, not including the underlying error message) so a WHOOP outage
that causes repeated foreground-triggered failures collapses to one issue, not one per
foreground.

---

## G) Shared-helper design

**Confirmed: no `reportError`, `src/lib/reportError.ts`, or any observability sink exists
anywhere in `src/` today** (grepped `reportError|observability`, zero hits).

### Proposed location and signature

`src/lib/reportError.ts`:

```ts
export function reportError(
  operation: string,
  error: unknown,
  opts?: { level?: "warning" | "error"; extra?: Record<string, unknown>; fingerprint?: string[] },
): void
```

- `operation` — a short, stable string (`"updateEntry"`, `"applyEntries"`,
  `"whoopBackgroundSync"`) — matches the naming already used in every existing
  `console.warn("<siteName>:", ...)` call, so adopting this helper is a mechanical
  find-and-wrap at each of the 47 sites above, not a rename exercise.
- `error: unknown` — accepts anything a `catch` block hands it (PostgrestError, thrown `Error`,
  network failure, `unknown`), and internally applies the scrub spec from (B) before handing off
  to Sentry.
- `opts.level` — defaults to `"warning"` (see below).
- `opts.extra` — for the rare site that wants to attach a non-sensitive tag (e.g.
  `{ table: "meal_entries" }`) — never raw error fields, never IDs.
- `opts.fingerprint` — overrides the default (see below); this is how `previewComposition` and
  `lookupStapleFromDb`'s fan-out get grouped without every call site having to think about it.

### Scrub reuse — `src/lib/scrub.ts`

**Recommend extracting.** `UUID_RE` and `scrubUrl` currently live inline in
[instrument.ts:4-11](../instrument.ts#L4-L11), used only by `beforeSend`/`beforeBreadcrumb`. Once
`reportError` also needs to scrub (B's spec: strip `.details`/`.hint`, truncate `.message`,
UUID-redact whatever's left), there are two consumers of the *same* redaction logic. Duplicating
`UUID_RE` a second time inside `reportError.ts` reintroduces exactly the kind of drift risk the
readiness doc already flagged for the four `readErrorBody()` copies (A3) — two UUID regexes that
quietly diverge over time is a worse outcome than one shared file. Move `UUID_RE` + `scrubUrl`
(unchanged) into `src/lib/scrub.ts`, have `instrument.ts` import them for `beforeSend`/
`beforeBreadcrumb`, and add the new PostgrestError-specific scrubbing (detail/hint drop,
message-allowlist) as a second exported function in the same file for `reportError` to call. One
file, two call sites, matching the project's own stated preference for centralizing exactly this
kind of shared logic (see the readiness doc's closing bug note on `readErrorBody`).

### Default level and fingerprint

- **Default level: `"warning"`.** Nearly every site in the census today already degrades
  gracefully (returns null/false/[]/generic-failure) rather than crashing — these are handled,
  expected-shape failures (a network blip, a constraint refusal), not unhandled exceptions. Sentry
  `"error"` level should be reserved for sites that currently have **zero** visibility at all
  (the five zero-logging `useStore.ts` sites, the WHOOP background sync) where the severity is
  "this has been silently broken with nobody knowing," which is a stronger claim than "a write
  failed and the user saw a retry message."
- **Default fingerprint: `["{{ default }}", operation]`** — i.e. group by the `operation` string
  alone, collapsing every occurrence of the same named failure into one Sentry issue regardless of
  the underlying error message. This is the direct quota control the brief asked for: without it,
  a transient Supabase outage causing 200 `updateEntry` failures in an hour would file (at worst)
  200 issues instead of 1. The two exceptions noted above should override this default:
  `previewComposition` should fingerprint on `[operation, composition.id]` (one issue per bad
  bundle, not one per render), and the `ingredients.ts` fan-out sites should fingerprint on
  `operation` alone with no per-line differentiator, so one bad recipe's N unmatched lines collapse
  to one issue rather than N.

### Should it also `console.warn` locally?

**Yes.** Every existing site's `console.warn` remains valuable for local dev debugging
(`CLAUDE.md`'s own testing philosophy leans on visible failures during development), and
removing it would be a net loss for zero gain — `reportError`'s internal `enabled: !__DEV__` gate
(inherited from `instrument.ts`'s `Sentry.init` config) already means dev builds never actually
send to Sentry anyway. Recommend `reportError` always calls `console.warn(operation, ...)`
internally as its first action, then attempts the Sentry capture — this also means the ~40
existing `console.warn` call sites can be **replaced** by `reportError` calls rather than kept
alongside them, which is the actual mechanical change this enables (one call instead of two at
every site).

### `readErrorBody()` consolidation — recommend deferring

The four `readErrorBody()` copies ([mealRecognition.ts:131](../src/lib/mealRecognition.ts#L131),
[labelExtraction.ts:138](../src/lib/labelExtraction.ts#L138),
[scanRecipe.ts:113](../src/lib/scanRecipe.ts#L113), [whoop.ts:380](../src/lib/whoop.ts#L380)) are
**not** in this brief's six target files, and none of the 47 census sites above call them. Merging
them would touch four files this phase has no other reason to open, for a benefit (avoiding
future divergence) that's real but not blocking — the four copies are already identical today and
nothing in this phase's capture wiring depends on them converging. **Recommend leaving as a
separate follow-up**, scoped with the seven "unexpected payload" sites (D) since those live in the
same four files and already need a source-fix pass — bundling the `readErrorBody` consolidation
into *that* pass (same files, same PR, one review) is more efficient than doing it here where it'd
be pure scope creep against six unrelated files.

---

## H) Test-harness impact — confirmed via direct empirical test, not inference

**This is the one finding in this brief that would have broken the suite outright if missed.**

[vitest.config.ts](../vitest.config.ts) runs with `environment: "node"`.
[vitest.setup.ts](../vitest.setup.ts) mocks `./src/lib/supabase` globally (`vi.mock(...)`,
[vitest.setup.ts:11-22](../vitest.setup.ts#L11-L22)) — every logic module under test imports it
transitively, so it's centralized once, per that file's own comment. **There is no mock for
`@sentry/react-native` or for any future `reportError` module.**

Tested directly (not assumed): a scratch Vitest test file (`import "@sentry/react-native"`,
created and immediately deleted — no trace left in the repo) run through the actual project
harness (`npx vitest run`) fails like this:

```
RolldownError: Parse failure: Parse failed with 1 error:
Flow is not supported
1: /**
2:  * Copyright (c) Meta Platforms, Inc. and affiliates.
...
At file: /node_modules/react-native/index.js:1:0
```

**`@sentry/react-native` transitively imports the real `react-native` package**, whose
`index.js` is written in Flow syntax. Vite's transform pipeline (which Vitest uses) cannot parse
Flow — this is a hard parse-time failure, not a runtime no-op, and not something
`Sentry.init()`-never-having-run would soften: the crash happens before any Sentry code executes,
purely from the module graph being loaded. **Every test file that imports, even transitively,
anything that imports `@sentry/react-native` would fail to even transform**, not just fail an
assertion — confirmed by running the probe test standalone and watching the whole file error out
at the transform stage. This is strictly worse than a normal test failure: it's the kind of error
that would look like "the test runner is broken" rather than "a test failed," if hit without this
investigation having flagged it first.

This is specifically a **new** exposure the current suite doesn't have: none of the six files in
this census, nor anything they currently import, pulls in the real `react-native` package — that's
*why* the existing 227-test suite (all logic/store-layer, per `CLAUDE.md`'s testing philosophy)
works under `environment: "node"` today. `reportError.ts` importing `@sentry/react-native` would
be the first thing in that whole import graph to do so.

**Required**: a `vi.mock("@sentry/react-native", ...)` (or a mock of `reportError` itself,
functionally equivalent but slightly less faithful) added to
[vitest.setup.ts](../vitest.setup.ts), alongside the existing supabase mock, **before** any of
the 47 census sites are wired to call it. Minimal shape needed to keep every test passing:

```ts
vi.mock("@sentry/react-native", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  // + whatever reportError.ts actually calls — keep this list in sync with reportError's usage,
  // not with the full SDK surface.
}));
```

Given (G)'s design has `reportError.ts` be the only file that imports `@sentry/react-native`
directly, mocking `@sentry/react-native` once at the setup-file level (as above) is sufficient —
every test that transitively pulls in `reportError.ts` gets the mock automatically, the same way
every test already gets the supabase mock without each test file doing its own `vi.mock`.
Mocking `reportError` itself instead (`vi.mock("../lib/reportError", ...)`) is the leaner
alternative if some future test wants to *assert* `reportError` was called with specific args —
worth having both patterns available, but the `@sentry/react-native`-level mock is the one that's
load-bearing for the suite not crashing, and should land first.

**[mealEntriesInsertSites.test.ts](../src/lib/__tests__/mealEntriesInsertSites.test.ts)
specifically**: read in full. It's a purely static/textual test — `fs.readFileSync` +
regex-matching against the *source text* of `entries.ts`/`useStore.ts`, never imports or executes
either module. It would stay green regardless of capture wiring, **as long as** the capture call
added to `addEntry`/`applyEntries` doesn't itself get inserted inside the `.insert("meal_entries")
... .select()` block the test slices out ([mealEntriesInsertSites.test.ts:85-91](../src/lib/__tests__/mealEntriesInsertSites.test.ts#L85-L91)) in a way that introduces a
`...spread` or a `planned:`/`confirmed_at:`/`skipped_at:` token — trivially avoidable (the
capture call belongs in the `if (error)` branch, nowhere near the row builder), but worth stating
explicitly since this test's whole purpose is catching exactly that class of accidental change.

With the `@sentry/react-native` mock in place, the full 227-test suite (18 files) and this
structural test specifically would stay green with capture wired into all 47 census sites.

---

## Per-site disposition table

Disposition options: **capture** (plain `reportError`, default fingerprint), **capture+fingerprint**
(needs an explicit non-default fingerprint), **source-fix-only** (fix the log call, no capture —
reserved for sites where capture would be redundant or harmful), **leave-log-only** (hot-path/
render-path — do not wire capture at all in this phase).

| Site | Disposition | Why |
|---|---|---|
| `useStore.ts` — `fetchGoals`, `fetchSavedIngredients`, `saveGoals`, `saveIngredient` (existing-bump branch), `deleteIngredient` | **capture** | The five zero-logging sites — highest priority, currently invisible even locally |
| `useStore.ts` — `saveIngredient` (new-item branch) | **capture** | Checks `error` but never logs it; same invisibility class as above |
| `useStore.ts` — all 13 `WriteResult`-propagating functions | **capture** (store layer only — see C) | One capture point per function, at the existing `if (error)`/`catch` block; screens must **not** also capture |
| `useStore.ts` — `fetchEntries`, `fetchWorkouts`, `fetchCompositions`, `addEntry`, `deleteEntry`, `confirmEntries` (both branches), `skipEntries` | **capture** | Already logging; mechanical console.warn → reportError swap |
| `compositions.ts` — all `console.warn`+`throw` sites (11 sites) | **capture** | Same mechanical swap; propagate to `useStore.ts` callers unaffected (single capture point stays at this layer per (C)) |
| `compositions.ts` — `applyComposition`/`applyBatch` `bump_composition_use` RPC swallow | **capture, level: warning, low priority** | Deliberately non-fatal per the code's own comment — capture is additive visibility, not a UX change; keep `level: "warning"` so it doesn't skew error-rate dashboards for a known-low-stakes failure |
| `compositions.ts` — `previewComposition` | **leave-log-only** (source-fix optional: shape-descriptor instead of raising severity) | Render-path, unmemoized, re-fires every render of the Bundles sheet while a malformed composition is present — see the dedicated finding in (A). If capture is wanted later, must be `captureMessage` (never `captureException`, preserves the "never throws" contract) with `fingerprint: [operation, composition.id]`, not the default |
| `foodLookup.ts` — `lookupFood` (both bare catches) | **source-fix-only**: add a `console.warn` (currently has none) before deciding on capture | Currently fully silent; needs a log line before a capture call is even meaningful. Frequency depends on `ScannerScreen` debounce, not confirmed in this read — see Open Questions before deciding capture vs. capture+fingerprint |
| `foodLookup.ts` — `findCustomFoodByBarcode`, `createCustomFood`, `setCustomFoodImages` | **capture** | One-shot, already logging |
| `foodLookup.ts` — `searchCustomFoods` | **source-fix-only, actually dead-code removal** | Zero call sites anywhere — see Bugs Noticed; capturing failures in unreachable code is pure noise |
| `entries.ts` — `applyEntries` | **capture** | One-shot per caller, four distinct call sites feed it — default fingerprint (`operation` = `"applyEntries"`) is correct here since all four callers represent the same underlying insert failure mode |
| `ingredients.ts` — `resolveIngredient` (OFF-secondary catch) | **source-fix-only**: add logging (currently silent) | Deliberately non-fatal by design (comment: "must not cost the user the staple hit") — a log line is enough; capturing a known-and-accepted degraded path isn't valuable |
| `ingredients.ts` — `lookupStapleFromDb` | **capture+fingerprint** | N-way fan-out per recipe-scan-confirm mount — must fingerprint on `operation` alone (not per-line detail) so one bad recipe doesn't file N issues |
| `customFoodImages.ts` — `uploadCustomFoodImage`, `getSignedImageUrl` (both branches each) | **capture** | One-shot, already logging |
| `customFoodImages.ts` — `deleteCustomFoodImage` | **capture, level: warning** | Fire-and-forget best-effort cleanup, non-fatal by design (no propagation at all) — same reasoning as the `bump_composition_use` swallow |
| `mealRecognition.ts:119`, `labelExtraction.ts:126`, `scanRecipe.ts:101`, `whoop.ts:176/249/302/359` | **source-fix + capture** | Both halves needed — see (D). Source-fix (shape descriptor) makes future console-breadcrumb re-enablement safe; capture is the actual value-add since breadcrumbs are currently inert |
| `App.tsx:105`/`108` (WHOOP background sync) | **capture+fingerprint** | See (F) — fixed fingerprint (`"whoop-background-sync"` alone), `level: warning`, no UI change, closes the one total-blackout site in the app |
| `FriendsScreen.tsx:278` | **source-fix-only** (fix to `.message`, then it falls into the normal screen-layer non-capture rule) | Screens don't capture per (C) — this site just needs to stop logging the raw object, independent of the capture rollout |

---

## Open questions

1. **`ScannerScreen`'s barcode-detection debounce** — not read in this investigation (outside the
   brief's six files). `lookupFood`'s two bare `catch {}` blocks ([foodLookup.ts:124-129](../src/lib/foodLookup.ts#L124-L129), [:132-139](../src/lib/foodLookup.ts#L132-L139)) could be one-shot
   (per confirmed scan) or borderline-hot-path (per camera frame, if undebounced) depending on
   that screen's logic. Confirm before finalizing capture+fingerprint vs. plain capture for these
   two sites.
2. **`openfoodfacts.ts`'s `lookupBarcode`** — also outside the six read files, but is the second
   leg of `lookupFood`'s try/catch and its own error handling wasn't traced. If it already logs
   internally, wiring capture at `foodLookup.ts`'s layer risks a second double-report pair beyond
   the ones traced in (C).
3. **Fingerprint cardinality for `previewComposition`** — if capture is wanted at all for this
   render-path site (this brief's default recommendation is log-only, no capture), confirm the
   product/observability owner is fine with a `composition.id`-keyed fingerprint persisting
   indefinitely (one open issue per malformed bundle until someone fixes the data), versus a
   time-windowed alternative.
4. **`reportError`'s relationship to the existing `msg()` helper** — [useStore.ts:358-359](../src/store/useStore.ts#L358-L359) already has a small `msg(e, fallback)` utility used throughout the
   `WriteResult`-returning catch blocks to build the user-facing string. `reportError` and `msg()`
   will often be called from the same `catch` block on the same `e` — worth deciding whether
   `reportError` returns anything `msg()` could consume (e.g. an event id for a "report this" UI
   affordance later) or stays fire-and-forget `void`, before implementation starts.
5. **Whether `searchCustomFoods` (dead code) should be deleted in this phase or a separate
   cleanup** — flagged in Bugs Noticed; not blocking the capture rollout either way since it's
   unreachable.

---

## Bugs noticed while reading (out of scope for this investigation, flagged per house rule)

- **Five call sites in `useStore.ts` never check the Supabase response's `error` at all**:
  `fetchGoals` ([useStore.ts:461-465](../src/store/useStore.ts#L461-L465)),
  `fetchSavedIngredients` ([useStore.ts:484-488](../src/store/useStore.ts#L484-L488)), `saveGoals`
  ([useStore.ts:1056-1067](../src/store/useStore.ts#L1056-L1067)), `saveIngredient`'s
  existing-item bump ([useStore.ts:1087-1090](../src/store/useStore.ts#L1087-L1090)), and
  `deleteIngredient` ([useStore.ts:1130](../src/store/useStore.ts#L1130)). This is a distinct and
  worse failure class than the "console.warn then degrade" pattern the rest of the codebase uses
  consistently — these five don't even destructure `error` from the Supabase response, so a
  failure is **completely invisible**, not just unlogged. `saveGoals` and `deleteIngredient` are
  the most concerning of the five: both unconditionally update local Zustand state (`set({goals})`
  / filter the deleted id out of `savedIngredients`) **after** an unchecked write — meaning a
  failed goals save or a failed ingredient delete shows the UI as if it succeeded, while the
  database silently kept the old row. This is exactly the class of bug `updateEntry`'s doc comment
  ([useStore.ts:172](../src/store/useStore.ts#L172)) describes as the reason that function was
  changed to propagate errors — the same reasoning applies here and these five sites appear to
  predate that fix, or were added after it without the same discipline.
- **`searchCustomFoods` ([foodLookup.ts:259-276](../src/lib/foodLookup.ts#L259-L276)) is dead
  code** — a grep across all of `src/` for `searchCustomFoods(` finds only its own definition, no
  call sites. Its own comment (`// For AddIngredientScreen (phase 1b): user's own foods in name
  search.`) suggests it was written ahead of a UI integration that either hasn't landed yet or
  landed differently. Not a correctness bug, but worth a decision (finish wiring it up, or delete
  it) rather than leaving working, tested-looking code that nothing calls.
- **The brief's own file path for the compositions module is stale**: `src/store/compositions.ts`
  doesn't exist; the file is `src/lib/compositions.ts`. Corrected at the top of this document —
  flagging in case the same stale path is copy-pasted into a future brief.
- **`retimeEntries` ([useStore.ts:733-741](../src/store/useStore.ts#L733-L741)) is the only
  member of the `WriteResult`-propagating family that never calls `console.warn` at all** — every
  sibling function in that family (`deleteEntries`, `updateEntry`, etc.) logs before/while
  returning the error, but `retimeEntries`'s per-row failure only ever reaches the returned
  `WriteResult.reason` string, with no local console trace. Inconsistent with the rest of the
  family; harmless today (the error isn't lost, just not echoed to the console during dev), but
  worth normalizing when `reportError` is wired in so every site in the family gets the same
  treatment.
