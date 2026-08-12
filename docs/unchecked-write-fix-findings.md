# Unchecked-write correctness fix — findings

Read-only investigation. No code was changed. All claims sourced from the live file/line noted,
read post-Phase-3b (commit `a6095cf`) and post-Phase-3c (commit `1fa52f9`) — `useStore.ts` was
re-read in full for this investigation and matches exactly what Phase 3b left it as: `reportError`
capture is present and additive at all three sites; control flow is unchanged.

---

## A) The three write sites — current mechanics

### `saveGoals` — [useStore.ts:1070-1087](../src/store/useStore.ts#L1070-L1087)

```ts
saveGoals: async (goals) => {
  const { userId } = get();
  if (!userId) return;
  const { error } = await supabase.from("goals").upsert({ ...snake_case fields... });
  if (error) reportError("saveGoals", error, { level: "error" });
  set({ goals });
},
```

1. Write: `supabase.from("goals").upsert(...)`.
2. Optimistic state: `set({ goals })` — **unconditional**, runs immediately after the capture
   check regardless of `error`'s value. This is the whole bug: it's not "the revert is missing,"
   it's that nothing ever gated it in the first place.
3. Signature: `saveGoals: (goals: Goals) => Promise<void>` ([useStore.ts:179](../src/store/useStore.ts#L179)).
4. `reportError` confirmed present ([useStore.ts:1085](../src/store/useStore.ts#L1085)).

### `saveIngredient`, existing-item bump branch — [useStore.ts:1099-1117](../src/store/useStore.ts#L1099-L1117)

```ts
if (existing) {
  const { error } = await supabase
    .from("saved_ingredients")
    .update({ use_count: existing.use_count + 1 })
    .eq("id", existing.id);
  if (error) reportError("saveIngredient", error, { level: "error" });
  const updated = { ...existing, use_count: existing.use_count + 1 };
  set((s) => ({ savedIngredients: s.savedIngredients.map((i) => i.id === existing.id ? updated : i) }));
  return updated;
}
```

Same shape as `saveGoals`: `set()` and `return updated` both run unconditionally after the
capture check. A failed use-count bump shows the UI a higher count than the database has.

### `saveIngredient`, new-item insert branch — [useStore.ts:1119-1147](../src/store/useStore.ts#L1119-L1147)

```ts
const { data, error } = await supabase.from("saved_ingredients").insert({...}).select().single();

if (!error && data) {
  set((s) => ({ savedIngredients: [data as SavedIngredient, ...s.savedIngredients] }));
  return data as SavedIngredient;
}
if (error) reportError("saveIngredient", error);
return null;
```

**This branch is already correctly gated** — `set()` only runs `if (!error && data)`, and it
already returns `null` on failure. This is *not* one of the three broken sites; it's the
existing-item branch's sibling doing it right. The question the brief asked — "does its caller
respect the null" — is answered in section C: **no**, the only caller discards the return value
entirely, so the correct signal here is currently thrown away one layer up, not lost at this
layer.

### `deleteIngredient` — [useStore.ts:1149-1158](../src/store/useStore.ts#L1149-L1158)

```ts
deleteIngredient: async (id) => {
  const { error } = await supabase.from("saved_ingredients").delete().eq("id", id);
  if (error) reportError("deleteIngredient", error, { level: "error" });
  set((s) => ({ savedIngredients: s.savedIngredients.filter((i) => i.id !== id) }));
},
```

Signature: `deleteIngredient: (id: string) => Promise<void>` ([useStore.ts:280](../src/store/useStore.ts#L280)). `set()` unconditional — a failed delete still removes the item from the visible
list; the row survives server-side until the next `fetchSavedIngredients()` quietly resurrects it,
which for a user is indistinguishable from a bug ("I deleted this, why is it back?").

---

## B) The propagation convention to match

[useStore.ts:134-136](../src/store/useStore.ts#L134-L136) — the shape every other write action in
this file already uses:

```ts
/** What a write action reports back. `null` error means it worked. */
export interface WriteResult {
  error: string | null;
}
```

[useStore.ts:359-360](../src/store/useStore.ts#L359-L360) — the helper that builds the string for
the `catch`-based half of the family (thrown errors, not `{error}`-destructured ones):

```ts
const msg = (e: unknown, fallback: string): string =>
  e instanceof Error ? e.message : fallback;
```

Two sub-conventions already coexist, and the fix should pick whichever one each site's own
error type matches — do not invent a third:

- **Direct-`{error}` family** (`deleteEntries`, `updateEntry`, `retimeEntries` — errors come
  straight off a `{data, error}` destructure, no `try/catch`): returns a **hardcoded, short,
  user-facing string** chosen by the call site, e.g. `"Couldn't remove those. Check your
  connection."` ([useStore.ts:573](../src/store/useStore.ts#L573)), not `error.message` itself
  (which per the Phase 3 findings doc can carry PostgREST predicate values — this hardcoded-string
  discipline is *why* the WriteResult family has never had a leak, and must not be broken by this
  fix).
- **`try/catch` family** (`copyEntriesToDay`, `saveBundleFromEntries`, etc.): returns
  `msg(e, "<fallback string>")`.

`saveGoals`, `saveIngredient`, and `deleteIngredient` are all direct-`{error}` sites — none of
them wrap a `try/catch`. **The fix should use the first sub-convention**: a hardcoded string
per site, never `error.message`. `reportError` already receives the *real* error object
separately (and scrubs it per the Phase 3 scrub spec) — the string returned to the UI layer has
always been a distinct, deliberately generic thing in this codebase, and that separation should
hold here too.

`ProductScreen.tsx`'s handling of `updateEntry` is the concrete precedent for what a caller does
with this shape once a site is converted — see [ProductScreen.tsx:438-460](../src/screens/ProductScreen.tsx#L438-L460), whose own comment block is effectively the design rationale this
fix should reuse verbatim: *"check, tell them, and STAY."*

---

## C) Caller-impact table

Grepped `saveGoals(`, `deleteIngredient(`, `saveIngredient(` across all of `src/` — **two screen
files, three call sites total**, confirmed exhaustive (no other file references any of the three).

| Call site | What it does today | What it needs once the function returns an error |
|---|---|---|
| [SettingsScreen.tsx:283-297](../src/screens/SettingsScreen.tsx#L283-L297) (`handleSave`, calls `saveGoals`) | `setSaving(true)` → `await saveGoals(...)` (return value ignored — currently `void`) → unconditionally `setSaving(false); setSaved(true)`. `saved` drives a button style swap ([SettingsScreen.tsx:631](../src/screens/SettingsScreen.tsx#L631), `saveBtnSaved`) — **the Save button visibly flips to its "saved" state on a failed write, today, confirmed.** | Destructure `{ error }`. On error: `setSaving(false)`, show `Alert.alert("Can't save that", error)` (mirroring `ProductScreen`'s `updateEntry` handling verbatim), do **not** call `setSaved(true)`. On success: unchanged. |
| [SettingsScreen.tsx:315-328](../src/screens/SettingsScreen.tsx#L315-L328) (`handleDeleteIngredient`, calls `deleteIngredient`) | Fire-and-forget: `onPress: () => deleteIngredient(id)` — not awaited, no result read at all. | **No change required** if `deleteIngredient` stays `Promise<void>` (recommended — see E). The gate fix alone means a failed delete simply leaves the item visible (correct), with Sentry visibility from the existing `reportError` call. Optionally, the `onPress` could `await` and show an `Alert` on failure for a more informative UX, but that's a UX enhancement, not a correctness requirement — flagged as optional in Open Questions. |
| [ProductScreen.tsx:461-463](../src/screens/ProductScreen.tsx#L461-L463) (non-edit "Log" path, calls `saveIngredient`) | `await saveIngredient(draft);` — **return value fully discarded, not even assigned to a variable** — then unconditionally proceeds to `await addEntry({...})`. | **Genuinely open, see Open Questions.** `saveIngredient` failing today already returns `null` (new-item branch) without the caller checking it — so gating the existing-item branch to also return `null` on failure changes nothing for this caller *unless* the product decision is that a failed library-save should surface something. Recommend: do **not** block `addEntry` on this — logging the meal is the primary action and a failed "remember this for next time" save is a reasonable best-effort miss — but this is a product call, not a pure correctness one. |

---

## D) The two fetch sites — confirmed read-only, no false success

`fetchGoals` ([useStore.ts:459-481](../src/store/useStore.ts#L459-L481)) and
`fetchSavedIngredients` ([useStore.ts:483-493](../src/store/useStore.ts#L483-L493)) both follow
`if (data) set({...})` — `set()` is **never** called when `data` is null (which it will be
whenever `error` is set, since `.single()`/a failed select don't return partial data). **Confirmed
characterization: these do not paint false success** — on failure, local state is simply left at
whatever it was before the call (the in-memory default, or last successfully-fetched value),
never overwritten with something claiming to be fresher than it is.

**One nuance worth flagging, not blocking**: neither function is called from any screen — grepped
`src/screens/` for both names, zero matches. They're only invoked from
[App.tsx](../App.tsx)'s auth effect, once per sign-in/auth-state-change. So a `fetchGoals` failure
at sign-in means the user sees `DEFAULT_GOALS` (2000 kcal etc., [useStore.ts:18-27](../src/store/useStore.ts#L18-L27)) instead of their real goals for the **entire session** — there is no
retry, no pull-to-refresh path for goals specifically (unlike `fetchEntries`, which
`TodayScreen`'s pull-to-refresh does re-trigger). This is a staleness/UX gap, not a false-success
bug, and is out of this investigation's scope (which is specifically about optimistic-write
divergence) — noting it so it isn't rediscovered as if new.

**Recommendation: leave both fetch sites exactly as they are.** They already fail closed (stale,
not wrong), Phase 3b already made the failure visible in Sentry, and there's no UI divergence to
fix — converting them to some other shape would be scope creep against files this investigation
was asked to look at for a different reason.

---

## E) Gate vs. revert — per site

**Gate is correct for all three**, and for `deleteIngredient` specifically there is already a
directly-analogous, already-shipped precedent in the same file to mirror rather than invent:

- **`saveGoals` → GATE.** Trivial: Zustand's `set()` simply doesn't run until the write is
  confirmed. No snapshot/restore needed because nothing was ever written to state yet — "gate"
  and "revert" collapse to the same one-line change here (move `set({goals})` inside `if
  (!error)`).
- **`saveIngredient` existing-bump branch → GATE**, and note it converges the two branches onto
  one shared contract instead of two diverging ones. Move the `set()`/`return updated` inside
  `if (!error)`; on error, `return null` — the exact value the sibling new-item branch already
  returns on its own failure path. This is the cleanest of the three: it doesn't just fix a bug,
  it removes an inconsistency between two branches of the same function that should have always
  agreed.
- **`deleteIngredient` → GATE, mirroring `deleteEntry` almost verbatim.** [useStore.ts:554-563](../src/store/useStore.ts#L554-L563) (the singular meal-entry delete) already has this exact
  shape, with an explicit comment stating the rationale:

  ```ts
  deleteEntry: async (id) => {
    const { error } = await supabase.from("meal_entries").delete().eq("id", id);
    if (error) {
      // Do NOT drop it locally. A failed delete that vanishes from the UI comes
      // back to life on the next fetch, which looks like a ghost.
      reportError("deleteEntry", error, { level: "error" });
      return;
    }
    set((s) => ({ entries: s.entries.filter((e) => e.id !== id) }));
  },
  ```

  This is direct, already-shipped, in-file precedent that the codebase already prioritizes
  delete-correctness over the sub-100ms perceived-responsiveness gain from removing the item
  before the network round-trip completes. `deleteIngredient` should adopt the identical
  shape — same early-`return` structure, same comment reused (the "ghost" framing applies
  identically: a saved ingredient that silently un-deletes on the next `fetchSavedIngredients()`
  is the exact same user-facing symptom `deleteEntry`'s comment describes for meal entries).

No site in this trio has a strong enough perceived-responsiveness argument to justify keeping an
optimistic-then-revert pattern over a plain gate — none of these three actions are on a
tight interaction loop (rapid-fire taps) the way, say, a "like" button might be, where a
visible round-trip delay would read as janky. A goals save, a favorite-ingredient bump, and a
library deletion are all deliberate, infrequent, single-tap actions where a few hundred
milliseconds of round-trip latency before the UI updates is unremarkable.

---

## F) Test impact

**Zero existing Vitest coverage of any of the three functions.** Grepped
`src/store/__tests__/useStore.test.ts` for every `describe`/`it` block — the file covers
`addEntry`, `copyEntriesToDay`, `copyEntriesTo`, and the synchronous batch-draft setters only.
`saveGoals`, `saveIngredient`, `deleteIngredient`, `fetchGoals`, `fetchSavedIngredients`,
`updateEntry`, `deleteEntry`, `deleteEntries`, `confirmEntries`, `skipEntries`, `retimeEntries`,
and every `compositions.ts`-backed `WriteResult` function are **all** currently untested at the
store layer. (The only other hit for these three names anywhere under `__tests__/` is
`reportError.test.ts`, which uses `"saveIngredient"` merely as an example operation-string
literal — it does not exercise the real store function.)

**Consequence for this fix**: changing `saveGoals`'s and `deleteIngredient`'s return types from
`Promise<void>` to `Promise<WriteResult>` (see the per-site contracts below) **cannot break any
existing test** — there is nothing exercising their current signatures to break. This also means
the fix is free to add real coverage without touching a single existing assertion.

**Minimal proposed test additions** (three new `describe` blocks in `useStore.test.ts`, mirroring
the existing `mockInsertSingle`-style helper pattern already used for `addEntry`/
`copyEntriesToDay` at [useStore.test.ts:39-51](../src/store/__tests__/useStore.test.ts#L39-L51)):

1. **`useStore.saveGoals`**
   - success: mocks `supabase.from("goals").upsert()` to resolve `{ error: null }` — assert
     `useStore.getState().goals` equals the new goals, and the returned `WriteResult.error` is
     `null`.
   - **failure (the regression test)**: mocks `upsert()` to resolve `{ error: <PostgrestError> }`
     — assert `useStore.getState().goals` is **unchanged** from whatever it was before the call
     (this is the assertion that would have caught today's bug), and the returned
     `WriteResult.error` is a non-null string.
2. **`useStore.saveIngredient`** (existing-item branch specifically, since the new-item branch's
   gate is already correct and effectively already covered by symmetry once the existing branch
   test exists)
   - success: seed `savedIngredients` with one entry, mock `update()` to resolve `{ error: null
     }`, assert the matching entry's `use_count` incremented and the function returned the
     updated object.
   - **failure**: same seed, mock `update()` to resolve `{ error: <PostgrestError> }`, assert
     `savedIngredients` is **byte-for-byte unchanged** (no bumped count) and the function returned
     `null`.
3. **`useStore.deleteIngredient`**
   - success: seed one entry, mock `delete()` to resolve `{ error: null }`, assert it's removed
     from `savedIngredients`.
   - **failure**: same seed, mock `delete()` to resolve `{ error: <PostgrestError> }`, assert the
     entry is **still present** in `savedIngredients` (the direct test for the "ghost" bug this
     fix closes).

All six are straightforward extensions of the existing mocking idiom already in the file — no new
test infrastructure needed. The `@sentry/react-native` mock from Phase 3a already makes the
`reportError` calls inside these functions no-op safely during the test run, so nothing further
needs mocking for these tests to pass once the fix lands.

---

## Proposed per-site contract (summary)

| Site | New signature | Gate/revert | Caller must do |
|---|---|---|---|
| `saveGoals` | `(goals: Goals) => Promise<WriteResult>` | Gate — move `set({goals})` inside `if (!error)` | `SettingsScreen.handleSave`: check `{error}`, `Alert.alert` + skip `setSaved(true)` on failure |
| `saveIngredient` (existing-item branch) | *(no signature change — stays `Promise<SavedIngredient \| null>`)* | Gate — move `set()`/`return updated` inside `if (!error)`, `return null` on error, matching the sibling branch | `ProductScreen`: no change required for correctness (open product question on whether to surface a failed library-save at all) |
| `deleteIngredient` | *(no signature change — stays `Promise<void>`, mirroring `deleteEntry`)* | Gate — move `set()` inside `if (!error)`, early-return on error, reusing `deleteEntry`'s exact shape/comment | `SettingsScreen.handleDeleteIngredient`: no change required; optionally await + Alert for better UX (not required) |
| `fetchGoals` / `fetchSavedIngredients` | unchanged | N/A — already correctly gated (reads) | No change |

A hardcoded, generic string (not `error.message`) should be the `WriteResult.error` value for
`saveGoals`, consistent with every other direct-`{error}` site in the file (see B) — e.g.
`"Couldn't save your goals. Check your connection."`.

---

## Open questions

1. **`saveIngredient`'s caller (`ProductScreen.tsx:462`) discards the return value entirely, on
   both branches, today.** Should this investigation's follow-up fix the store-layer state
   consistency only (recommended, low-risk), or also decide whether a failed "save to your
   library" should surface *any* signal to the user (a toast, a silent log-only acceptance, or
   continue exactly as now)? This is a product call, not something inferable from the code.
2. **Should `deleteIngredient`'s caller be upgraded to await + show an error**, closing the gap
   that its sibling `deleteEntry` also still has (neither surfaces a user-facing message on
   failure today, only prevents the "ghost" symptom)? Recommend treating this as optional/
   deferred, consistent with `deleteEntry`'s own precedent, rather than inventing a stronger
   contract for `deleteIngredient` alone.
3. **`fetchGoals` staleness for a whole session** (D) — worth a separate, small follow-up (e.g. a
   retry-on-Settings-mount) independent of this fix, or accepted as-is? Not blocking.
4. **Whether the `WriteResult.error` string for `saveGoals` should differentiate a constraint
   refusal from a generic connection failure**, the way `updateEntry` special-cases the
   no-future-logged trigger message ([useStore.ts:608-613](../src/store/useStore.ts#L608-L613)).
   Nothing found in this read suggests the `goals` table has an analogous business-rule trigger to
   special-case — a single generic string is likely sufficient, but flagging since `updateEntry`'s
   precedent explicitly exists for exactly this reason and shouldn't be assumed absent without
   checking the migrations.

---

## Bugs noticed while reading (out of scope for this investigation, flagged per house rule)

- **`SettingsScreen.tsx`'s Save Goals button visibly confirms success on a failed write, today,
  confirmed by tracing the `saved` state through to its style binding** ([SettingsScreen.tsx:283-297](../src/screens/SettingsScreen.tsx#L283-L297) → [:631](../src/screens/SettingsScreen.tsx#L631)) — this is the concrete, user-visible
  symptom of the `saveGoals` bug, not a hypothetical one. A user who edits their calorie goal
  while offline sees the button flip to "Saved" and has no way to know the value never left the
  device.
- **`ProductScreen.tsx:462`'s `await saveIngredient(draft);` discards the return value even
  though `saveIngredient` already has a well-formed nullable return type** — this predates this
  investigation's scope but is directly relevant to it (see Open Question 1): the function's
  contract was already correct on one branch and already being ignored by its only caller, before
  any of the fixes proposed here.
