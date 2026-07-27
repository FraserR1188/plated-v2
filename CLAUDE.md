# CLAUDE.md — plated

Guidance for Claude Code working in this repo. Read this fully before editing.

## What this is

**plated** is a commercial nutrition and macro-tracking app for Android (iOS paused pending Apple Developer account), built by Fraser Analytics. Its strategic differentiator is correlating logged nutrition against WHOOP biometric data (recovery, sleep, strain) — a feature no mainstream tracker offers natively.

The app tracks **eight macros** (calories, protein, carbs, fat, saturated fat, salt, fibre, sugar) across **four meal sections** (Breakfast, Lunch, Dinner, Snacks). A per-macro colour language runs through the whole UI: blue/protein, amber/carbs, coral/fat, purple/salt, teal/fibre, pink/sugar.

## Stack & environment

- Expo SDK 54, React Native 0.81.5, React 19, React Navigation v7
- Zustand for state (`useStore.ts`), TypeScript throughout
- Supabase (Postgres, Edge Functions, Storage, RLS, RPCs), region eu-west-2
- External APIs: Open Food Facts, WHOOP API v2 (OAuth 2.0, token rotation lease), Anthropic (vision, via Edge Function — keys stay server-side)
- **Dev env:** Windows with Git Bash. Testing on a physical Pixel 9 (Android 15).
- **Builds are EAS cloud only** — no local builds on Windows. Dev client and preview share a package name and overwrite each other on install.
- Android package name `com.fraseranalytics.plated` is **locked** — cannot change after first build.

## Working style (follow these)

- **File-first.** Read the existing file(s) before writing anything. Don't generate a fix against assumed code.
- **Plan before build.** Propose the approach, get agreement, then implement. Don't jump to edits on non-trivial work.
- **Full-file replacements** for heavily changed files; a **PATCHES.md** with clearly marked hand-edit points for small changes.
- **Flag bugs even when out of scope.** This has repeatedly caught live data-integrity issues. Surface them; don't silently work around them.
- **Migrations ship with verification SQL and a manual test checklist**, every time.

## Architecture invariants — DO NOT VIOLATE

These are the source of most historical bugs. Each one is an invariant, not a preference.

- **`planned` is always derived by a DB `BEFORE INSERT` trigger** from whether `eaten_at` is a future calendar day. **Never written by the client.**
- **`date` is always derived from `eaten_at` via the local `dateKey()`** (local time). **Never** use `toISOString().split('T')[0]` — that's UTC and produces wrong dates under BST.
- **Never inherit `date` or `section` from a source entry.** When adding/copying/plating a food, the target `{date, section}` must be passed explicitly. Inheriting from the source is the root cause of the duplicate-on-wrong-day / wrong-section bug class.
- **`MealEntry` is snake_case throughout.** Never spread a camelCase object into a Supabase insert — map fields explicitly to snake_case. (A silent no-op bug was caused by exactly this.)
- **`MealEntryPatch` is a whitelist type** that makes `date` and `planned` _unrepresentable_, not merely discouraged. Preserve that property when extending it.
- **WHOOP correlation gate lives in the JOIN `ON` clause, not `WHERE`**, to preserve zero-meal cycles in the LEFT JOIN.
- **Recovery has a one-cycle lag** (nutrition cycle N-1 → recovery score cycle N). **Strain pairs with the same-cycle nutrition.** Don't pool or realign these.
- **WHOOP cycle intervals are stored in UTC. Never join on calendar dates.**
- **Plans count toward daily goals but not toward the WHOOP correlation.**

## Product/data rules

- Confirmation is **one batched banner keyed on days that have ended**; nothing auto-expires (an auto-flip would create ghost meals).
- `resolveEatenAt` midnight roll-back heuristic: if the picked time is more than 3 hours in the future, subtract a day.
- Wearable calorie estimates are systematically inflated (~27–93% error range in the literature). Gross-to-net conversion requires subtracting BMR for the exercise duration to avoid double-counting resting expenditure. A fixed percentage is not evidence-supported.
- **OFF search ranking:** fetch 50 results, re-rank locally — exact match +1000, prefix +500, whole-word +250, all-words-present +120, plus a brevity bonus, an unbranded bonus, popularity log-scaled and capped as a tiebreaker, and −80 for nutrition-empty products. Drop `sort_by=unique_scans_n` server-side.

## Supabase / Edge Functions gotchas

- `functions.invoke()` puts the error body on **`error.context`, not `error.message`** — use the shared `readErrorBody()` pattern.
- `supabase functions logs` **does not exist** in CLI 2.x — logs are dashboard-only.
- Docker is only required for `db pull` / `db diff` / `db dump` — not for deploys or `db push`.
- All Supabase CLI commands use the **`npx` prefix**.
- New function folders must be **siblings of `_shared`**, not children of it.
- `WHOOP_CLIENT_ID` belongs in **Supabase secrets only** — never as an `EXPO_PUBLIC_` var. Client ID as an EAS env var.

## React Native / Expo gotchas

- **RN 0.81 "Cannot assign to read-only property 'NONE'":** fixed via `patch-package` adding `configurable: true, writable: true` to `Event.js` property definitions in RN core. Caused by RN 0.81's locked-down DOM Event properties conflicting with Supabase's `event-target-shim` polyfill. Don't remove the patch.
- **React Navigation v7 custom themes must include a `fonts` object.** Spread `...DarkTheme` from `@react-navigation/native` as the base, then override colours. A missing `fonts` object causes a "Cannot read property 'regular' of undefined" crash.
- **`allowsEditing: true` on `ImagePicker` forces a square crop on iOS** regardless of `aspect` — bypass it for nutrition-label / meal capture.

## Testing

- **Vitest** for the pure-logic and store-action layer — that's where nearly all historical bugs live (`dateKey`, `resolveEatenAt`, `roundSalt`, the OFF re-ranker, `mealEntryToProduct`, `applyEntries`, `addEntry`).
- Logic tests should run in **CI on every push** (GitHub Actions), independent of the EAS build, so regressions are caught before a 15-minute cloud build rather than after.
- Tests cover what types can't: whether the _right_ value was computed (e.g. the correct local date), not merely a validly-typed one.
- When fixing a bug, **write the failing test first**, then fix, then confirm green.
- Component tests (RNTL) and E2E (Detox/Maestro) are deferred until after the UI redesign.

## Git hygiene

- `*.jks` is gitignored. Secrets never go in Git or `eas.json`.
- `schema.LEGACY-DO-NOT-USE.sql` is renamed with a warning header — don't reference it as current.

## Local identifiers (do NOT commit real values here if this repo is public)

Keep the test auth user ID, WHOOP user ID, Supabase project ref, and EAS project ID in a gitignored local notes file rather than in this committed file if the repo is or may become public. Reference them from there.
