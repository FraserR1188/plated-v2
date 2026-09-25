# HealthKit inventory — what already exists, what doesn't

**Date:** 2026-09-21
**Scope:** read-only inventory of what in plated-v2 a HealthKit arm would plug into or reuse. Not a design, not a plan, no library recommendation.
**Working tree:** `master` @ `63be47c`, clean.

Every claim is labelled:

- **READ** — seen directly in code, config or a migration at the cited line.
- **INFERRED** — my reading of intent, or behaviour I did not trace end to end.

Schema facts come from `supabase/migrations/` only. No Docker, no `db pull`, no query against the remote. Where a question genuinely needs live database state, the answer is left blank and the query is in **SQL for you to run**.

---

## 1. Native layer and the current iOS binary

### 1.1 HealthKit dependencies — none, anywhere

**READ.** `package.json` has no HealthKit dependency. The full dependency list is at [package.json:17-49](package.json#L17-L49); there is no `react-native-health`, no `@kingstinct/react-native-healthkit`, no `expo-health`, nothing else touching HealthKit.

**READ.** The lockfile confirms it is not present transitively either. A case-insensitive grep of `package-lock.json` for `healthkit|react-native-health|kingstinct` returns four lines, all of them `react-native-health-connect` ([package-lock.json:37](package-lock.json#L37), [package-lock.json:9408-9421](package-lock.json#L9408-L9421)). No HealthKit package is resolved at any depth.

### 1.2 iOS config — no entitlements, no usage strings, no background modes

**READ.** There is no `app.config.js` / `app.config.ts`. `app.json` is the only app config.

**READ.** The entire `ios` block is [app.json:34-39](app.json#L34-L39):

```json
"ios": {
  "bundleIdentifier": "com.fraseranalytics.plated",
  "infoPlist": {
    "ITSAppUsesNonExemptEncryption": false
  }
}
```

That is the complete iOS surface. Specifically absent:

| Thing | Present? | Evidence |
|---|---|---|
| `com.apple.developer.healthkit` entitlement | **No** | grep of `app.json` for `com.apple.developer` returns nothing |
| `com.apple.developer.healthkit.background-delivery` | **No** | same |
| `NSHealthShareUsageDescription` | **No** | `infoPlist` holds one key, [app.json:36-38](app.json#L36-L38) |
| `NSHealthUpdateUsageDescription` | **No** | same |
| `UIBackgroundModes` | **No** | grep of `app.json` for `UIBackgroundModes` returns nothing |
| HealthKit config plugin | **No** | `plugins` array, [app.json:40-71](app.json#L40-L71) |

**READ.** There are no checked-in `ios/` or `android/` directories — the project is Continuous Native Generation, prebuilt on EAS. So there is no `.entitlements` file to inspect and none to edit by hand; entitlements would have to come from `app.json` or a config plugin.

**READ.** The `plugins` array ([app.json:40-71](app.json#L40-L71)) contains: `expo-dev-client`, `expo-updates`, `expo-image-picker`, `expo-camera`, `@react-native-community/datetimepicker`, `expo-web-browser`, `@sentry/react-native/expo`, `react-native-health-connect`, `expo-build-properties`. No HealthKit plugin.

### 1.3 The same questions at `950a276` (TestFlight build 3 source)

**READ.** `950a276` is `add iphone creds`, Mon 31 Aug 2026, and is an ancestor of `HEAD`.

**READ.** `git show 950a276:app.json` is **byte-identical to HEAD's `app.json`** in every respect relevant here: same empty-but-for-`ITSAppUsesNonExemptEncryption` `ios.infoPlist`, same `plugins` array including `react-native-health-connect`, no entitlements, no `UIBackgroundModes`, no HealthKit plugin.

**READ.** `git show 950a276:package.json` has no HealthKit dependency either. The only dependency difference from HEAD is that HEAD adds `@react-navigation/elements": "2.9.19"` — unrelated to health.

**Bottom line for build 3:** the binary testers have today contains **no HealthKit code, no HealthKit entitlement and no HealthKit usage strings**. Nothing about HealthKit is latent in it waiting to be switched on.

### 1.4 Health Connect dependency and plugin, for coexistence

**READ.** Dependency: `"react-native-health-connect": "^4.1.3"` ([package.json:43](package.json#L43)), resolved to exactly `4.1.3` ([package-lock.json:9408-9410](package-lock.json#L9408-L9410)).

**READ.** Config plugin: the bare string `"react-native-health-connect"` ([app.json:65](app.json#L65)) — the library ships its own plugin, invoked with no options.

**READ.** Android health permissions are declared in `app.json`, not by the plugin's defaults alone: `READ_SLEEP`, `READ_HEART_RATE_VARIABILITY`, `READ_RESTING_HEART_RATE`, `READ_EXERCISE`, `READ_HEALTH_DATA_HISTORY` ([app.json:20-26](app.json#L20-L26)).

**READ.** `minSdkVersion: 26` is forced via `expo-build-properties` ([app.json:66-73](app.json#L66-L73)) — an Android-only setting, no iOS counterpart is set.

**INFERRED.** Coexistence on Expo SDK 54 should be structurally clean: `react-native-health-connect` is Android-only (its plugin touches only the Android manifest and Gradle config), so it and a HealthKit library would not contend for the same native config. I have not verified this by reading the plugin's source, and I am not recommending a library.

**READ.** One environment constraint from [CLAUDE.md:15](CLAUDE.md#L15): builds are EAS cloud only, no local builds on Windows. Any native change here is a cloud build round trip.

---

## 2. The Health Connect arm, end to end

### 2.1 Permission request

**READ.** Permissions are requested from **SettingsScreen**, not a dedicated hook. `src/screens/SettingsScreen.tsx` imports the whole surface at [SettingsScreen.tsx:49-58](src/screens/SettingsScreen.tsx#L49-L58): `getHealthConnectAvailability`, `getHealthConnectGrantState`, `requestHealthConnectAccess`, `openHealthConnectSettingsScreen`, `openHealthConnectPlayStore`, `isHealthConnectFullyDenied`, and `syncHealthConnect`.

**READ.** Availability and grant state load on mount via `refreshHealthConnect` ([SettingsScreen.tsx:284-302](src/screens/SettingsScreen.tsx#L284-L302)). Grant state is deliberately never cached — [healthConnect.ts:266-272](src/lib/healthConnect.ts#L266-L272) explains why: a user can revoke from Android's own Health Connect settings app and the app cannot observe that any other way.

**READ.** The request itself is one call asking for everything at once, [healthConnect.ts:346-364](src/lib/healthConnect.ts#L346-L364):

```ts
await requestPermission([
  { accessType: "read", recordType: "SleepSession" },
  { accessType: "read", recordType: "HeartRateVariabilityRmssd" },
  { accessType: "read", recordType: "RestingHeartRate" },
  { accessType: "read", recordType: "ExerciseSession" },
  { accessType: "read", recordType: "ReadHealthDataHistory" },
]);
```

**READ.** Every native entry point is gated on `Platform.OS !== "android"` returning an inert result — [healthConnect.ts:57](src/lib/healthConnect.ts#L57), [:158](src/lib/healthConnect.ts#L158), [:274](src/lib/healthConnect.ts#L274), [:347](src/lib/healthConnect.ts#L347).

**READ.** Domain vocabulary is deliberately shared with the database: `HealthConnectDomain = "sleep" | "hrv" | "resting_hr" | "workouts"` ([healthConnect.ts:199](src/lib/healthConnect.ts#L199)), and the comment at [healthConnect.ts:176-180](src/lib/healthConnect.ts#L176-L180) states these use the exact same names as `biometric_source_preferences.domain` so a future per-domain provider picker needs no translation layer. **This is the single most reusable thing in the arm.**

### 2.2 Record types read

**READ.** One map, one source of truth, [healthConnect.ts:202-207](src/lib/healthConnect.ts#L202-L207):

| Domain | Health Connect record type |
|---|---|
| `sleep` | `SleepSession` |
| `hrv` | `HeartRateVariabilityRmssd` |
| `resting_hr` | `RestingHeartRate` |
| `workouts` | `ExerciseSession` |

**READ.** Notably **not** read: heart rate, total calories burned, distance, elevation. [mapping.ts:415-419](supabase/functions/health-connect-ingest/mapping.ts#L415-L419) records this as a deliberate scope decision — those are separate Health Connect record types behind permissions the app did not request.

### 2.3 What triggers a sync

**READ.** Two triggers, both in `App.tsx`, both fire-and-forget:

1. **Session set** — `runSyncs()` is called directly inside the `[session]` effect ([App.tsx:364](App.tsx#L364)).
2. **Foreground** — `AppState.addEventListener("change", ...)` on `next === "active"` ([App.tsx:365-368](App.tsx#L365-L368)).

**READ.** There is **no background sync**. No background task, no background delivery, no push-triggered sync.

**READ.** A manual "Sync now" button exists in Settings, calling `handleSyncHealthConnect` ([SettingsScreen.tsx:1050-1060](src/screens/SettingsScreen.tsx#L1050-L1060)).

**READ.** Concurrency control lives in the sync module, not at the call sites ([healthConnectSync.ts:760-798](src/lib/healthConnectSync.ts#L760-L798)): an unconditional single-flight promise, plus a 3-second floor for forced calls only. The header at [healthConnectSync.ts:692-759](src/lib/healthConnectSync.ts#L692-L759) explains that WHOOP's 15-minute throttle is deliberately *not* copied, because Health Connect reads are local and unmetered.

**READ.** PL-018 wiring: each sync promise is watched, and `fetchWorkouts()` is re-run if it wrote anything — [App.tsx:356-361](App.tsx#L356-L361), logic in [syncRefetch.ts](src/lib/syncRefetch.ts). [syncRefetch.ts:13-17](src/lib/syncRefetch.ts#L13-L17) notes only workouts are refetched because no sync can touch `meal_entries`.

### 2.4 Incremental vs fixed lookback — both, in a specific order

**READ.** This is the most intricate part of the arm and the least provider-neutral. Per record type:

- **No stored token** → `pullWidestAvailable()` ([healthConnectSync.ts:447-479](src/lib/healthConnectSync.ts#L447-L479)): attempt a 180-day `readRecords()`; on a `PERMISSION_ERROR`-coded rejection only, fall back to 30 days. Then mint a changes token.
- **Stored token, baseline < 180 days** → `tryBackfillHistoryGap()` ([healthConnectSync.ts:488-516](src/lib/healthConnectSync.ts#L488-L516)) reads only the `[180d ago, baseline)` slice, then widens and persists the baseline.
- **Then always** → `getChanges({ changesToken, recordTypes })` in a loop ([healthConnectSync.ts:586-621](src/lib/healthConnectSync.ts#L586-L621)), which is what propagates **deletions**. Token advances only after a successful post.
- **Token expired** → clear, re-pull widest available, re-bootstrap ([healthConnectSync.ts:592-598](src/lib/healthConnectSync.ts#L592-L598)).

**READ.** Constants: `INITIAL_WINDOW_DAYS = 180`, `NO_HISTORY_WINDOW_DAYS = 30`, `PAGE_SIZE = 200` ([healthConnectSync.ts:155-158](src/lib/healthConnectSync.ts#L155-L158)).

**READ.** The watermark is device-local, in AsyncStorage, one key per record type: `health_connect_changes_token:<recordType>` ([healthConnectSync.ts:203-205](src/lib/healthConnectSync.ts#L203-L205)). The stored value is `{ token, baselineWindowDays, baselineAt }` ([healthConnectSync.ts:207-213](src/lib/healthConnectSync.ts#L207-L213)).

**READ.** [healthConnectSync.ts:12-29](src/lib/healthConnectSync.ts#L12-L29) argues the token is *inherently* device-local — an opaque cursor into this device's Health Connect install — so server-side storage would not even be meaningful. **INFERRED:** that reasoning is transport-specific. HealthKit's anchored-object-query anchor is analogous but not the same object, and nothing here generalises.

**READ.** [healthConnectSync.ts:52-102](src/lib/healthConnectSync.ts#L52-L102) documents a library bug that shapes the whole design: `grants.history` is always `false` in `react-native-health-connect@4.1.3` regardless of the real OS grant, so the module determines the readable window **empirically** rather than by asking. `HISTORY_PERMISSION_DENIED_CODE = "PERMISSION_ERROR"` ([healthConnectSync.ts:428](src/lib/healthConnectSync.ts#L428)) is explicitly flagged as a hypothesis not yet confirmed on device.

### 2.5 How records are shaped on the client — they aren't

**READ.** This is the cleanest reuse boundary in the arm. [healthConnectSync.ts:4-10](src/lib/healthConnectSync.ts#L4-L10):

> The client does NOT normalise, does NOT map to table columns, and does NOT decide `ingest_transport`/`origin_package` trustworthiness — it reads whatever Health Connect hands back, batches it by record type, and forwards it to `health-connect-ingest`.

**READ.** The post body is exactly three fields ([healthConnectSync.ts:337-354](src/lib/healthConnectSync.ts#L337-L354)):

```ts
{ recordType, upserts, deletedRecordIds }
```

`upserts` is `unknown[]` — raw Health Connect record objects, untouched.

### 2.6 The Edge Function

**READ.** `supabase/functions/health-connect-ingest/` — `index.ts` (168 lines) plus `mapping.ts` (463 lines). The split is deliberate: `mapping.ts` has no Deno-only import so Vitest can import it directly ([mapping.ts:1-13](supabase/functions/health-connect-ingest/mapping.ts#L1-L13)).

**Authentication — READ.** `getCallerId(req)` ([index.ts:60-63](supabase/functions/health-connect-ingest/index.ts#L60-L63)) resolves the user from the `Authorization` header via an anon-key client's `auth.getUser()` ([_shared/auth.ts:21-37](supabase/functions/_shared/auth.ts#L21-L37)). **`user_id` is taken from the JWT, never from the body** — `userId` is threaded into every mapper as its first argument ([index.ts:117](supabase/functions/health-connect-ingest/index.ts#L117)) and each mapper writes `user_id: userId` explicitly. Writes then go through `adminClient()` (service role, bypasses RLS) ([index.ts:91](supabase/functions/health-connect-ingest/index.ts#L91)).

**Validation — READ.** Per record, before any database contact ([index.ts:99-121](supabase/functions/health-connect-ingest/index.ts#L99-L121)):

1. `validateOriginPackage(record?.metadata?.dataOrigin)` — must be a non-empty string matching `/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/` and must not end in `.direct` (case-insensitively) ([mapping.ts:34-57](supabase/functions/health-connect-ingest/mapping.ts#L34-L57)).
2. `providerRecordId(record?.metadata)` must resolve — prefers `metadata.clientRecordId`, falls back to `metadata.id`, null means skip ([mapping.ts:136-145](supabase/functions/health-connect-ingest/mapping.ts#L136-L145)).
3. The mapper runs inside a `try`; a throw skips that record.

A bad record is **skipped, not fatal to the batch** ([index.ts:96-98](supabase/functions/health-connect-ingest/index.ts#L96-L98)).

**What is NOT validated — READ.** There is no check on:

- **Future timestamps.** No mapper compares `r.startTime` / `r.time` against `now()`. No CHECK constraint in [20260829072742_biometric_provider_neutral_tables.sql](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql) bounds them either.
- **Duration bounds.** `period_end < period_start` is representable; `total_in_bed_ms` is computed as a raw subtraction ([mapping.ts:215-217](supabase/functions/health-connect-ingest/mapping.ts#L215-L217)) and could be negative.
- **Value ranges.** `num()` ([mapping.ts:18-21](supabase/functions/health-connect-ingest/mapping.ts#L18-L21)) only rejects non-finite. A resting heart rate of 4000 or a negative HRV inserts cleanly.

The one value that *is* normalised is `timezone_offset`, via `normalizeZoneOffsetId()` ([mapping.ts:107-126](supabase/functions/health-connect-ingest/mapping.ts#L107-L126)) — `'Z'` → `'+00:00'`, `±HH:MM[:SS]` passes, anything else becomes NULL and is logged. The header at [mapping.ts:71-80](supabase/functions/health-connect-ingest/mapping.ts#L71-L80) records that `'Z'` once aborted the entire `biometric_workouts` query for a user.

**Upsert conflict key — READ.** Identical across all four collections ([mapping.ts:442-463](supabase/functions/health-connect-ingest/mapping.ts#L442-L463)):

```
user_id, origin_package, provider_record_id
```

which is also each table's primary key ([20260829072742:106](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L106), [:174](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L174), [:233](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L233), [:298](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L298)).

**Deletions — READ.** Matched on `raw->metadata->>id`, not `provider_record_id` ([index.ts:142-147](supabase/functions/health-connect-ingest/index.ts#L142-L147)), because `provider_record_id` may be `clientRecordId` which a deletion event never carries. Best-effort: a failed sweep does not fail the upserts ([index.ts:149-158](supabase/functions/health-connect-ingest/index.ts#L149-L158)).

### 2.7 HC-specific vs reusable

| Piece | Verdict | Evidence |
|---|---|---|
| Four-domain vocabulary (`sleep`/`hrv`/`resting_hr`/`workouts`) | **Reusable** — already shared with the DB | [healthConnect.ts:176-207](src/lib/healthConnect.ts#L176-L207) |
| `{ recordType, upserts, deletedRecordIds }` envelope | **Reusable shape** | [healthConnectSync.ts:337-354](src/lib/healthConnectSync.ts#L337-L354) |
| "Client does not normalise" posture | **Reusable principle** | [healthConnectSync.ts:4-10](src/lib/healthConnectSync.ts#L4-L10) |
| `readErrorMessage()` `error.context` unwrap | **Reusable** (shared idiom) | [healthConnectSync.ts:317-328](src/lib/healthConnectSync.ts#L317-L328) |
| Single-flight + forced-repeat floor | **Reusable pattern**, module-scoped state | [healthConnectSync.ts:762-764](src/lib/healthConnectSync.ts#L762-L764) |
| `getCallerId` / `adminClient` | **Reusable** | [_shared/auth.ts](supabase/functions/_shared/auth.ts) |
| Upsert conflict key | **Reusable** — no HC-specific column in it | [mapping.ts:445](supabase/functions/health-connect-ingest/mapping.ts#L445) |
| Changes-token machinery | **HC-specific** | [healthConnectSync.ts:12-50](src/lib/healthConnectSync.ts#L12-L50) |
| 180/30-day probe + `PERMISSION_ERROR` | **HC-specific** (exists only because of the `grants.history` library bug) | [healthConnectSync.ts:52-102](src/lib/healthConnectSync.ts#L52-L102) |
| `EXERCISE_TYPE_NAMES` (84 entries) | **HC-specific vocabulary** | [mapping.ts:305-389](supabase/functions/health-connect-ingest/mapping.ts#L305-L389) |
| `SleepStageType` constants 0-6 | **HC-specific** | [mapping.ts:165-171](supabase/functions/health-connect-ingest/mapping.ts#L165-L171) |
| `normalizeZoneOffsetId` (java.time contract) | **HC-specific** by derivation | [mapping.ts:59-105](supabase/functions/health-connect-ingest/mapping.ts#L59-L105) |

### 2.8 Is there a provider/transport abstraction in TypeScript?

**READ. No.** `SettingsScreen.tsx` imports seven HC functions plus `syncHealthConnect` directly ([SettingsScreen.tsx:49-58](src/screens/SettingsScreen.tsx#L49-L58)), and `App.tsx` imports `syncHealthConnect` directly ([App.tsx:50](App.tsx#L50)). There is no `Provider` interface, no registry, no `providers/` directory. WHOOP and Health Connect are two parallel, separately-imported module sets — `src/lib/whoop.ts` and `src/lib/healthConnect.ts` + `src/lib/healthConnectSync.ts`.

The nearest thing to an abstraction is at the **database** layer (`ingest_transport` / `origin_package`), not in TypeScript.

### 2.9 Could a HealthKit client hit the same Edge Function?

**INFERRED, with READ-backed specifics.** Structurally the envelope fits — the function takes a record-type key and an opaque array. But four things in the current function would reject or corrupt a HealthKit payload:

1. **`COLLECTIONS` is a closed registry keyed on Health Connect record-type names** ([mapping.ts:442-463](supabase/functions/health-connect-ingest/mapping.ts#L442-L463)). An unknown `recordType` returns a 400 ([index.ts:76-82](supabase/functions/health-connect-ingest/index.ts#L76-L82)). `HKCategoryTypeIdentifierSleepAnalysis` would be rejected outright.

2. **`ingest_transport: "health_connect"` is a hard-coded literal in all four mappers** — [mapping.ts:191](supabase/functions/health-connect-ingest/mapping.ts#L191), [:246](supabase/functions/health-connect-ingest/mapping.ts#L246), [:280](supabase/functions/health-connect-ingest/mapping.ts#L280), [:398](supabase/functions/health-connect-ingest/mapping.ts#L398). [mapping.ts:154-155](supabase/functions/health-connect-ingest/mapping.ts#L154-L155) states this is deliberate: "a client-supplied transport value has nowhere to go because these mappers never look for one." A HealthKit record routed through the existing mappers would be **stamped `health_connect`**.

3. **`validateOriginPackage`'s regex rejects hyphens** ([mapping.ts:34](supabase/functions/health-connect-ingest/mapping.ts#L34)). See §3.2 — this is a live problem for real HealthKit bundle identifiers, not a hypothetical.

4. **Every mapper reads Health Connect field names** — `r.stages`, `r.startZoneOffset?.id`, `r.heartRateVariabilityMillis`, `r.beatsPerMinute`, `r.exerciseType`, `r.metadata.lastModifiedTime`. None exist on a HealthKit sample.

And if all four were somehow satisfied, the **database CHECK constraints would still reject a third transport** — see §3.1.

---

## 3. Schema readiness

### 3.1 The transport CHECK is a hard blocker

**READ.** Five tables carry the identical constraint pair. `ingest_transport`:

```sql
ingest_transport text not null check (ingest_transport in ('whoop', 'health_connect'))
```

- `biometric_sleep_sessions` — [20260829072742:63](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L63)
- `biometric_hrv_samples` — [:137](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L137)
- `biometric_resting_hr` — [:203](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L203)
- `biometric_workout_sessions` — [:267](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L267)
- `biometric_source_preferences` — [20260829111404:97](supabase/migrations/20260829111404_biometric_periods_resolved.sql#L97)

**A third value is unrepresentable on all five.**

**READ.** Worse, the coherence constraint is written as an exhaustive two-branch disjunction, not a pair of implications — e.g. [20260829072742:100-104](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L100-L104):

```sql
constraint biometric_sleep_sessions_transport_origin_check check (
  (ingest_transport = 'whoop'          and origin_package like '%.direct')
  or
  (ingest_transport = 'health_connect' and origin_package not like '%.direct')
)
```

A row with `ingest_transport = 'health_kit'` satisfies **neither** branch, so even if the `in (...)` list were widened, this second constraint would still reject every HealthKit row until it too is extended. The same disjunction appears at [:168-172](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L168-L172), [:227-231](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L227-L231), [:292-296](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L292-L296) and [20260829111404:98-102](supabase/migrations/20260829111404_biometric_periods_resolved.sql#L98-L102).

### 3.2 `origin_package` regex rejects real HealthKit bundle identifiers

**READ.** Identical regex on all five tables and duplicated in the Edge Function:

```
^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$
```

([20260829072742:64](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L64), [:138](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L138), [:204](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L204), [:268](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L268), [20260829111404:98](supabase/migrations/20260829111404_biometric_periods_resolved.sql#L98), [mapping.ts:34](supabase/functions/health-connect-ingest/mapping.ts#L34))

**Permitted:** letters, digits, underscore, dot. **Not permitted: the hyphen.**

**INFERRED (important):** HealthKit's `HKSource.bundleIdentifier` for data written by Apple's own devices commonly takes the form `com.apple.health.<UUID>`, and UUIDs contain hyphens. Third-party iOS bundle identifiers also routinely contain hyphens, which Apple permits. Under the current regex those rows would be **skipped by the Edge Function and rejected by the database**. I have not enumerated real bundle identifiers against a device, so the exact shape is inferred — but the regex is READ, and it has no hyphen.

**READ.** The case-sensitivity decision is settled and documented — [20260829072742:112](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L112) explains case is preserved verbatim because `com.fitbit.FitbitMobile` is real, and instructs not to re-add a `lower()` check. That decision carries over to HealthKit unchanged.

### 3.3 HRV — SDNN in ms is already representable; the sampling window is not recorded as such

**READ.** [20260829072742:158-164](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L158-L164):

```sql
hrv_method text not null check (hrv_method in ('rmssd', 'sdnn')),
hrv_window text not null check (hrv_window <> ''),
hrv_unit   text not null check (hrv_unit = 'ms'),
```

- **`hrv_method` accepts `'sdnn'`.** Yes, already. HealthKit's `HKQuantityTypeIdentifierHeartRateVariabilitySDNN` maps to `'sdnn'` with no schema change.
- **`hrv_unit` accepts `'ms'`.** Yes — it is the *only* permitted value.
- **All three are NOT NULL with NO DEFAULT**, deliberately: [20260829072742:149-157](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L149-L157) argues a default would let an ingest path silently forget to state the method, and RMSSD/SDNN are not interchangeable.

**READ.** On the sampling window: **`hrv_window` is the only column that records it**, and it is free text by design ([20260829072742:159-163](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L159-L163)) — "providers disagree on window vocabulary and a CHECK enumerating them would reject a real value." Health Connect writes the literal `'instantaneous'` ([mapping.ts:268](supabase/functions/health-connect-ingest/mapping.ts#L268)).

**So:** there is **no structured overnight-vs-daytime column**. `hrv_window` can carry a string such as `'sleep'`, but nothing enforces, parses or consumes it. **READ:** no view or client file reads `hrv_window` — it does not appear in [20260920140000_strain_updated_at.sql](supabase/migrations/20260920140000_strain_updated_at.sql)'s view bodies, and `hrv_method`/`hrv_unit` (but not `hrv_window`) are what travel with the HRV winner ([20260830180000:424](supabase/migrations/20260830180000_biometric_periods_resolved_cross_provider.sql#L424)).

**READ.** The one strong guarantee: `WhoopCorrelationRow`'s comment at [types/index.ts:930](src/types/index.ts#L930) already warns `hrv` is *not* guaranteed RMSSD, and the view comment at [20260901110000:294](supabase/migrations/20260901110000_whoop_correlation_sleep_join.sql#L294) says the same. So a mixed-method HRV series is already anticipated downstream.

### 3.4 `biometric_synthetic_cycles` is Health-Connect-only

**READ. Definitive answer: Health Connect sessions only, not any sleep session.**

[20260830170000:221-232](supabase/migrations/20260830170000_biometric_synthetic_cycles.sql#L221-L232):

```sql
create or replace view public.biometric_synthetic_cycles
with (security_invoker = on) as
...
  from public.biometric_sleep_sessions
  where ingest_transport = 'health_connect'
```

and the output stamps a literal at [:340](supabase/migrations/20260830170000_biometric_synthetic_cycles.sql#L340):

```sql
'health_connect'::text as ingest_transport,
```

**READ.** [20260830170000:208-215](supabase/migrations/20260830170000_biometric_synthetic_cycles.sql#L208-L215) states the filter is explicit rather than implicit on purpose, following the precedent in the workouts arm.

**READ.** The reconstruction logic itself is provider-neutral in substance — it partitions by `(user_id, origin_package)` and applies three guards: a 3-hour duration floor, a 4-hour same-night merge, and a 36-hour ceiling ([20260830170000:36-115](supabase/migrations/20260830170000_biometric_synthetic_cycles.sql#L36-L115)). **INFERRED:** those thresholds were calibrated against a Health Connect reference corpus (observed minimum real night 4.86h, minimum real waking gap 11.76h, max 24.35h) and nothing about them is Health-Connect-specific in principle — but they have not been checked against HealthKit-shaped sleep data.

**READ.** One caveat already flagged in-file: `is_nap` is a structural no-op for Health Connect ([20260830170000:36-49](supabase/migrations/20260830170000_biometric_synthetic_cycles.sql#L36-L49)) because `mapSleepSession` never sets it ([mapping.ts:204-209](supabase/functions/health-connect-ingest/mapping.ts#L204-L209)). HealthKit's sleep analysis does distinguish `inBed` from asleep stages, so this column could become meaningful for a HealthKit arm in a way it is not today.

### 3.5 `biometric_periods_resolved` — frame key and precedence with a third arm

The current deployed definition is [20260920140000_strain_updated_at.sql](supabase/migrations/20260920140000_strain_updated_at.sql) (generated from live `pg_get_viewdef()`, [:37-41](supabase/migrations/20260920140000_strain_updated_at.sql#L37-L41)). The structure originates in [20260830180000](supabase/migrations/20260830180000_biometric_periods_resolved_cross_provider.sql).

**Frame key — READ.** `frame_cycles.source_period_id`, and domain winners join on it as `frame_key` ([20260830180000:370](supabase/migrations/20260830180000_biometric_periods_resolved_cross_provider.sql#L370), [:530-533](supabase/migrations/20260830180000_biometric_periods_resolved_cross_provider.sql#L530-L533)). Frames come from `all_periods` = WHOOP arm `union all` synthetic arm ([:277-279](supabase/migrations/20260830180000_biometric_periods_resolved_cross_provider.sql#L277-L279)).

**How a third arm would be treated — four distinct problems, all READ:**

**(a) The overlap gate is pairwise on transport inequality.** [20260830180000:291-300](supabase/migrations/20260830180000_biometric_periods_resolved_cross_provider.sql#L291-L300):

```sql
join bounded_periods b
  on b.user_id = a.user_id
 and b.ingest_transport <> a.ingest_transport
 and b.cycle_start is distinct from a.cycle_start
 and a.cycle_start < b.candidate_effective_end
 and b.cycle_start < a.candidate_effective_end
```

Both members of an unreconciled cross-arm overlapping pair are **suppressed entirely** ([:302-312](supabase/migrations/20260830180000_biometric_periods_resolved_cross_provider.sql#L302-L312)). **INFERRED:** with three arms, an iPhone-plus-Android user could have a HealthKit frame overlapping a Health Connect frame at a non-identical onset, and *both* would vanish — the user loses the night entirely rather than getting one of them. The migration's own deferred-work note at [:556-560](supabase/migrations/20260830180000_biometric_periods_resolved_cross_provider.sql#L556-L560) flags that same-arm cross-`origin_package` overlaps are already out of scope; a third arm widens that hole.

**(b) Frame precedence is `whoop`-or-alphabetical.** [20260920140000:329](supabase/migrations/20260920140000_strain_updated_at.sql#L329):

```sql
ORDER BY (clean_periods.ingest_transport = 'whoop'::text) DESC, clean_periods.origin_package
```

A HealthKit frame and a Health Connect frame sharing an exact `cycle_start` would be resolved **alphabetically by `origin_package`** — arbitrary, with no user-facing meaning.

**(c) Domain candidate CTEs hard-filter `'health_connect'`.** All three, in the current deployed body — sleep [20260920140000:381,386](supabase/migrations/20260920140000_strain_updated_at.sql#L381), hrv [:425,429](supabase/migrations/20260920140000_strain_updated_at.sql#L425), resting_hr [:464,468](supabase/migrations/20260920140000_strain_updated_at.sql#L464). Each emits `'health_connect'::text AS ingest_transport` as a literal and reads `WHERE <table>.ingest_transport = 'health_connect'::text`. **A HealthKit row in `biometric_sleep_sessions` would be invisible to this view** even after the CHECK constraints are widened.

**(d) The frame-source column is literally named `whoop_or_hc`.** [20260920140000:359](supabase/migrations/20260920140000_strain_updated_at.sql#L359), consumed at [:375](supabase/migrations/20260920140000_strain_updated_at.sql#L375), [:418](supabase/migrations/20260920140000_strain_updated_at.sql#L418), [:459](supabase/migrations/20260920140000_strain_updated_at.sql#L459). A two-arm assumption baked into an identifier.

**Per-domain precedence order is shape-based and does generalise — READ.** [20260830180000:398-402](supabase/migrations/20260830180000_biometric_periods_resolved_cross_provider.sql#L398-L402):

1. explicit `biometric_source_preferences` match for that domain,
2. `origin_package like '%.direct'` (direct integration outranks an aggregator),
3. `origin_package asc`.

Tier 2 reads the *shape*, never a provider name ([20260829111404:319-330](supabase/migrations/20260829111404_biometric_periods_resolved.sql#L319-L330)). **INFERRED:** that tier works unchanged for HealthKit (a HealthKit `origin_package` is not `.direct`, so WHOOP-direct still wins). Tier 3 becomes arbitrary the moment there are two non-direct arms.

### 3.6 Every `_hc`-suffixed column in `whoop_correlation`

**READ.** Six, all sleep stage durations, all added by [20260901130000_whoop_correlation_hc_sleep_widening.sql](supabase/migrations/20260901130000_whoop_correlation_hc_sleep_widening.sql):

| Column | Source | Line |
|---|---|---|
| `total_in_bed_ms_hc` | `biometric_sleep_sessions.total_in_bed_ms` | [:254](supabase/migrations/20260901130000_whoop_correlation_hc_sleep_widening.sql#L254) |
| `total_deep_ms_hc` | `.total_deep_ms` | [:256](supabase/migrations/20260901130000_whoop_correlation_hc_sleep_widening.sql#L256) |
| `total_light_ms_hc` | `.total_light_ms` | [:257](supabase/migrations/20260901130000_whoop_correlation_hc_sleep_widening.sql#L257) |
| `total_rem_ms_hc` | `.total_rem_ms` | [:259](supabase/migrations/20260901130000_whoop_correlation_hc_sleep_widening.sql#L259) |
| `total_awake_ms_hc` | `.total_awake_ms` | [:261](supabase/migrations/20260901130000_whoop_correlation_hc_sleep_widening.sql#L261) |
| `total_sleep_ms_hc` | `.total_sleep_ms` | [:262](supabase/migrations/20260901130000_whoop_correlation_hc_sleep_widening.sql#L262) |

**Deliberately not surfaced — READ:** `sleep_efficiency_percentage_hc` ([:251](supabase/migrations/20260901130000_whoop_correlation_hc_sleep_widening.sql#L251), rationale [:65-71](supabase/migrations/20260901130000_whoop_correlation_hc_sleep_widening.sql#L65-L71)) and `is_nap_hc` ([:264](supabase/migrations/20260901130000_whoop_correlation_hc_sleep_widening.sql#L264), rationale [:72-80](supabase/migrations/20260901130000_whoop_correlation_hc_sleep_widening.sql#L72-L80)).

**What a HealthKit equivalent would need — the good news first.** The `hc_sleeps` CTE reads `biometric_sleep_sessions` with **no transport filter** ([20260901130000:150-157](supabase/migrations/20260901130000_whoop_correlation_hc_sleep_widening.sql#L150-L157)), and joins through the resolved sleep pointer ([:284-286](supabase/migrations/20260901130000_whoop_correlation_hc_sleep_widening.sql#L284-L286)):

```sql
left join hc_sleeps hs on hs.user_id            = rv.user_id
                       and hs.origin_package     = rv.sleep_origin_package
                       and hs.provider_record_id = rv.sleep_source_record_id
```

**INFERRED:** so once a HealthKit row could *win* the sleep domain in `biometric_periods_resolved` (which §3.5(c) says it currently cannot), these six columns would populate from it with no change to this CTE. The blocker is upstream, not here.

**The naming problem — READ.** [20260901110000:294](supabase/migrations/20260901110000_whoop_correlation_sleep_join.sql#L294) explains the `_whoop`/`_hc` suffix convention exists so "a future widening commit's `_hc` columns cannot collide" with the WHOOP ones. That convention assumes exactly two arms. A HealthKit value arriving in a column named `_hc` would be actively misleading about its provenance. **READ:** provenance is separately available — `sleep_data_source` and `sleep_origin_package` are emitted at [20260901130000:247-248](supabase/migrations/20260901130000_whoop_correlation_hc_sleep_widening.sql#L247-L248) — so the fact is recoverable, just not from the column name.

### 3.7 `security_invoker` — confirmed on every per-user view touched

**READ.** Verified by reading each `create ... view` line:

| View | `security_invoker = on` | Evidence |
|---|---|---|
| `biometric_periods` | Yes | [20260829111404:166-167](supabase/migrations/20260829111404_biometric_periods_resolved.sql#L166-L167) |
| `biometric_periods_resolved` | Yes | [20260830180000:199-200](supabase/migrations/20260830180000_biometric_periods_resolved_cross_provider.sql#L199-L200) |
| `biometric_workouts` | Yes | [20260830090000:167-168](supabase/migrations/20260830090000_biometric_workouts_health_connect_arm.sql#L167-L168) |
| `biometric_synthetic_cycles` | Yes | [20260830170000:221-222](supabase/migrations/20260830170000_biometric_synthetic_cycles.sql#L221-L222) |
| `whoop_cycle_nutrition` | Yes | [20260829111404:465-466](supabase/migrations/20260829111404_biometric_periods_resolved.sql#L465-L466) |
| `whoop_correlation` | Yes | [20260829111404:563-564](supabase/migrations/20260829111404_biometric_periods_resolved.sql#L563-L564) |

**READ.** The base tables back this: RLS enabled with a select-own policy and `revoke insert, update, delete ... from anon, authenticated` on each of the four `biometric_*` tables ([20260829072742:121-126](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L121-L126), [:187-192](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L187-L192), [:246-251](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L246-L251), [:309-314](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L309-L314)).

**READ.** `biometric_source_preferences` is the deliberate exception — full CRUD for the owner, no revoke, because it is a setting not a measurement ([20260829111404:119-131](supabase/migrations/20260829111404_biometric_periods_resolved.sql#L119-L131)).

---

## 4. Double counting

### 4.1 What stops a WHOOP-originated Health Connect record today

**Two different mechanisms for two different grains. Neither is an `origin_package` filter and neither is a primary-provider setting.**

**Workouts — read-time pairwise dedup by time overlap. READ.** [20260830160000_biometric_workouts_dedup.sql](supabase/migrations/20260830160000_biometric_workouts_dedup.sql).

Two rows are the same real-world event when **both** ([:73-76](supabase/migrations/20260830160000_biometric_workouts_dedup.sql#L73-L76)):

- `workout_start` values within **60 seconds**, and
- the `[workout_start, workout_end)` intervals overlap.

The loser is suppressed by a `NOT EXISTS (a strictly better, overlapping row)` test ([:253-278](supabase/migrations/20260830160000_biometric_workouts_dedup.sql#L253-L278)), ordered lexicographically:

```sql
and row(not b.is_preferred, not b.is_direct, b.origin_package, b.source_workout_id)
  < row(not a.is_preferred, not a.is_direct, a.origin_package, a.source_workout_id)
```

where `is_preferred` is a `biometric_source_preferences` match on `domain = 'workouts'` ([:223-229](supabase/migrations/20260830160000_biometric_workouts_dedup.sql#L223-L229)) and `is_direct` is `origin_package like '%.direct'` ([:226](supabase/migrations/20260830160000_biometric_workouts_dedup.sql#L226)).

**READ.** The header records the evidence: identical start timestamps, `drift_seconds = 0.000` across 20 rows, the direct row carrying strain/distance/energy and the Health Connect copy carrying none ([:4-11](supabase/migrations/20260830160000_biometric_workouts_dedup.sql#L4-L11)). **READ:** nothing is ever deleted — the losing row stays and starts winning if the direct integration is disconnected ([:13-23](supabase/migrations/20260830160000_biometric_workouts_dedup.sql#L13-L23)).

**Periods (sleep/hrv/resting HR) — frame reconciliation by exact onset. READ.** `biometric_periods_resolved` unions the WHOOP arm and the synthetic arm, reconciles a same-night pair **by exact `cycle_start` match** with WHOOP winning on merit ([20260830180000:15-19](supabase/migrations/20260830180000_biometric_periods_resolved_cross_provider.sql#L15-L19), ranking at [20260920140000:329](supabase/migrations/20260920140000_strain_updated_at.sql#L329)). The exact-match licence comes from a verified premise: all 56 WHOOP cycle starts equalled a Health Connect sleep `period_start` exactly, same physical device writing both paths ([20260830170000:25-26](supabase/migrations/20260830170000_biometric_synthetic_cycles.sql#L25-L26)). Non-exact cross-arm overlaps are suppressed, not reconciled ([20260830180000:291-312](supabase/migrations/20260830180000_biometric_periods_resolved_cross_provider.sql#L291-L312)).

### 4.2 The exact package names and rules

**READ.** The only place a WHOOP-via-aggregator package name is written down at all is a **display label map**, not a filter — [workoutLabels.ts:31-40](src/lib/workoutLabels.ts#L31-L40):

```ts
"whoop.direct": "WHOOP",
"com.whoop.android": "WHOOP · Health Connect",
"com.garmin.android.apps.connectmobile": "Garmin",
"com.fitbit.FitbitMobile": "Fitbit",
"com.sec.android.app.shealth": "Samsung Health",
"com.ouraring.oura": "Oura",
"com.alltrails.alltrails": "AllTrails",
"com.google.android.apps.fitness": "Google Fit",
```

**READ.** [workoutLabels.ts:17-24](src/lib/workoutLabels.ts#L17-L24) is explicit that `com.whoop.android` gets a *distinguishable* label precisely because dedup may not have collapsed a given pair — two identically-labelled cards would look like a bug.

**So, stated plainly:** there is **no `origin_package` filter** blocking `com.whoop.android` at ingest or in any view. Nothing prevents the row from being stored. Precedence at read time is what prevents double *counting*, and it is keyed on the `%.direct` **shape** plus time overlap — never on a vendor name.

### 4.3 Would the same mechanism cover a HealthKit `sourceRevision` bundle identifier?

**INFERRED, with READ-backed reasoning.**

**For workouts: yes in principle, no in practice today.** The dedup predicate is shape-and-time based, so a WHOOP-via-HealthKit workout at the same start time as a WHOOP-direct workout would lose on tier 2 (`is_direct`) exactly as the Health Connect copy does. But [20260830090000:254-255](supabase/migrations/20260830090000_biometric_workouts_health_connect_arm.sql#L254-L255) shows the view's second arm is `from public.biometric_workout_sessions bws where bws.ingest_transport = 'health_connect'` — a HealthKit row would never enter `biometric_workouts` in the first place.

**For periods: no.** The exact-`cycle_start`-match reconciliation was licensed by a measurement of *one device writing two paths on Android*. There is no equivalent evidence for HealthKit, and §3.5(a) shows a near-miss produces suppression of both frames rather than a winner.

**A three-way case has no rule at all.** A user with WHOOP direct + WHOOP-via-HealthKit + WHOOP-via-Health-Connect would have two non-`.direct` candidates tying at tier 2, resolved alphabetically by `origin_package` at tier 3 — arbitrary. **READ:** the cross-provider migration already names the analogous same-arm case as deferred work ([20260830180000:554-560](supabase/migrations/20260830180000_biometric_periods_resolved_cross_provider.sql#L554-L560)).

---

## 5. Workouts

### 5.1 Yes, workouts are stored — in both arms

**WHOOP arm — READ, and the scope is used, not idle.**

- Scope granted: `read:workout` is in `WHOOP_SCOPES` ([_shared/whoop.ts:46-53](supabase/functions/_shared/whoop.ts#L46-L53)), passed to the authorize URL at [whoop-auth-start/index.ts:92](supabase/functions/whoop-auth-start/index.ts#L92).
- Sync path exists: a `workouts` collection hitting `/activity/workout` into table `whoop_workouts` ([whoop-sync/index.ts:257-260](supabase/functions/whoop-sync/index.ts#L257-L260)).
- Table exists: `public.whoop_workouts`, PK `(user_id, id)`, with `sport_name`, `strain`, `average_heart_rate`, `max_heart_rate`, `kilojoule`, `distance_meter`, `altitude_gain_meter`, `altitude_change_meter` ([20260712120000:249-272](supabase/migrations/20260712120000_whoop_data.sql#L249-L272)).

**Health Connect arm — READ.** `ExerciseSession` is one of the four requested record types ([healthConnect.ts:206](src/lib/healthConnect.ts#L206)), mapped by `mapExerciseSession` ([mapping.ts:391-428](supabase/functions/health-connect-ingest/mapping.ts#L391-L428)) into `biometric_workout_sessions` ([mapping.ts:458-462](supabase/functions/health-connect-ingest/mapping.ts#L458-L462)).

**READ.** The Health Connect arm's workout rows are structurally thin: `average_heart_rate`, `max_heart_rate`, `energy_kilojoule`, `distance_meter`, `altitude_gain_meter` are **always NULL** ([mapping.ts:422-426](supabase/functions/health-connect-ingest/mapping.ts#L422-L426)) because those live on separate record types behind unrequested permissions ([mapping.ts:415-419](supabase/functions/health-connect-ingest/mapping.ts#L415-L419)). There is **no strain column at all** on `biometric_workout_sessions`, deliberately — [20260829072742:285-288](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L285-L288): strain is WHOOP-proprietary and synthesizing one "would be an invented metric presented as if it were the provider's own."

### 5.2 Do workouts reach the spine? Yes. The correlation views? No.

**Spine — READ.** `biometric_workouts` is a two-arm union: WHOOP from `whoop_workouts` ([20260830090000:194-196](supabase/migrations/20260830090000_biometric_workouts_health_connect_arm.sql#L194-L196)) `union all` Health Connect from `biometric_workout_sessions` ([:198-255](supabase/migrations/20260830090000_biometric_workouts_health_connect_arm.sql#L198-L255)), with the HC arm filtered `where bws.ingest_transport = 'health_connect'` ([:255](supabase/migrations/20260830090000_biometric_workouts_health_connect_arm.sql#L255)).

**READ.** A deliberate subtlety: on the HC arm, the back-compat `ingest_source` column is aliased to **`origin_package`, not `ingest_transport`** ([:218](supabase/migrations/20260830090000_biometric_workouts_health_connect_arm.sql#L218)), so the badge names the vendor rather than the pipe. Rationale at [:44-54](supabase/migrations/20260830090000_biometric_workouts_health_connect_arm.sql#L44-L54).

**Correlation — READ. Workouts do not reach it.** `whoop_correlation`'s current definition reads `whoop_cycle_nutrition`, `biometric_periods_resolved`, `whoop_sleeps` and `biometric_sleep_sessions` ([20260901130000:121-157](supabase/migrations/20260901130000_whoop_correlation_hc_sleep_widening.sql#L121-L157)). A grep of that migration for `biometric_workouts` returns one comment ([:61](supabase/migrations/20260901130000_whoop_correlation_hc_sleep_widening.sql#L61)) and no SQL reference.

### 5.3 How strain pairs — with the cycle, never with a workout

**READ.** Strain in the correlation is the **cycle's own** strain, not an aggregate over workouts. `biometric_periods` takes `c.strain` from `whoop_cycles` ([20260808150000:63-65](supabase/migrations/20260808150000_biometric_spine_views.sql#L63-L65), comment: "strain lives on the cycle"), and `20260920140000` adds `strain_updated_at` as the **cycle's** `whoop_updated_at` for exactly this reason ([20260920140000:29-32](supabase/migrations/20260920140000_strain_updated_at.sql#L29-L32)).

**READ.** Pairing rule, unchanged from CLAUDE.md: `*_same_cycle` nutrition pairs with strain; `*_prev_cycle` pairs with recovery/hrv/sleep ([20260901110000:294](supabase/migrations/20260901110000_whoop_correlation_sleep_join.sql#L294)).

**Consequence for HealthKit — INFERRED.** Because strain is a WHOOP cycle-level score with no HealthKit equivalent and no synthesized substitute, **a HealthKit-only user gets no strain at all**, so the same-cycle half of the correlation has nothing to correlate against. A HealthKit arm would deliver the recovery-side half (sleep, HRV, resting HR) and leave the strain side empty.

**READ.** `biometric_workouts` *is* consumed by the client — `fetchWorkouts()` at [useStore.ts:667-700](src/store/useStore.ts#L667-L700) — so workouts do reach the UI, just not the correlation.

---

## 6. Recovery metrics coverage

Every cell is backed by a `file:line`. Cells I cannot back are "none" or blank.

| Metric | Table / column that would receive it | Populated today by | What HealthKit would need that isn't there |
|---|---|---|---|
| **Sleep sessions** | `biometric_sleep_sessions.period_start` / `.period_end` / `.is_nap` ([20260829072742:72-74](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L72-L74)); WHOOP: `whoop_sleeps` ([20260712120000](supabase/migrations/20260712120000_whoop_data.sql)) | WHOOP ([whoop-sync/index.ts](supabase/functions/whoop-sync/index.ts)) + HC ([mapping.ts:157-233](supabase/functions/health-connect-ingest/mapping.ts#L157-L233)) | Transport value + coherence CHECK (§3.1); a mapper for `HKCategoryTypeIdentifierSleepAnalysis`; `COLLECTIONS` entry ([mapping.ts:443-447](supabase/functions/health-connect-ingest/mapping.ts#L443-L447)) |
| **Sleep stages** | `.total_awake_ms`, `.total_light_ms`, `.total_deep_ms`, `.total_rem_ms`, `.total_sleep_ms`, `.total_in_bed_ms` ([20260829072742:78-90](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L78-L90)) | WHOOP + HC ([mapping.ts:218-229](supabase/functions/health-connect-ingest/mapping.ts#L218-L229)) | A stage-vocabulary mapping. HC's is `SleepStageType` 0-6 ([mapping.ts:165-171](supabase/functions/health-connect-ingest/mapping.ts#L165-L171)); HealthKit's `HKCategoryValueSleepAnalysis` is a different enum. Column comment at [20260829072742:81-87](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L81-L87) forbids silently equating vocabularies |
| **Resting HR** | `biometric_resting_hr.resting_heart_rate` + `.measurement_scope` ([20260829072742:212-223](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L212-L223)); WHOOP: `whoop_recoveries.resting_heart_rate` ([20260712120000](supabase/migrations/20260712120000_whoop_data.sql)) | WHOOP + HC ([mapping.ts:273-299](supabase/functions/health-connect-ingest/mapping.ts#L273-L299)) | A `measurement_scope` decision — `'period'` or `'calendar_day'`, NOT NULL, no default ([20260829072742:223](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L223)). HC declares `'period'` ([mapping.ts:298](supabase/functions/health-connect-ingest/mapping.ts#L298)) |
| **HRV** | `biometric_hrv_samples.hrv_value` + `.hrv_method` / `.hrv_window` / `.hrv_unit` ([20260829072742:146-164](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L146-L164)); WHOOP: `whoop_recoveries.hrv_rmssd_milli` | WHOOP + HC *nominally*; HC yields **zero rows in practice** ([mapping.ts:236-242](supabase/functions/health-connect-ingest/mapping.ts#L236-L242): WHOOP writes no HRV to Health Connect) | `hrv_method='sdnn'` already accepted ([20260829072742:158](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L158)); `hrv_unit='ms'` already the only value ([:164](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L164)). Needs an `hrv_window` string; no structured overnight/daytime column exists (§3.3) |
| **Respiratory rate** | **`whoop_sleeps.respiratory_rate` only** ([20260712120000](supabase/migrations/20260712120000_whoop_data.sql), sleeps block). **No provider-neutral column** — absent from `biometric_sleep_sessions` ([20260829072742:59-107](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L59-L107)) | WHOOP only; surfaced unsuffixed at [20260901130000:252](supabase/migrations/20260901130000_whoop_correlation_hc_sleep_widening.sql#L252) | A new column on `biometric_sleep_sessions`, plus a `_whoop`/`_hc` disambiguation in `whoop_correlation` (it is currently unsuffixed precisely because nothing else can supply it — [20260901110000:294](supabase/migrations/20260901110000_whoop_correlation_sleep_join.sql#L294)) |
| **Sleeping wrist temperature** | **`whoop_recoveries.skin_temp_celsius` only** ([20260712120000](supabase/migrations/20260712120000_whoop_data.sql), recoveries block). **No provider-neutral column** | WHOOP only; passed through `biometric_periods` ([20260808150000:60](supabase/migrations/20260808150000_biometric_spine_views.sql#L60)) and `biometric_periods_resolved` | An entire new table or column set. Nothing provider-neutral exists. Note the naming mismatch: WHOOP's is skin temp from the wrist, HealthKit's is `HKQuantityTypeIdentifierAppleSleepingWristTemperature` — related, not identical |
| **Blood oxygen** | **`whoop_recoveries.spo2_percentage` only** ([20260712120000](supabase/migrations/20260712120000_whoop_data.sql), recoveries block). **No provider-neutral column** | WHOOP only; passed through at [20260808150000:59](supabase/migrations/20260808150000_biometric_spine_views.sql#L59) | Same as wrist temperature — new provider-neutral storage |
| **VO2 max** | **none** — no column anywhere; grep of `supabase/migrations/` for `vo2` returns nothing | none | Everything: table/column, mapper, view exposure |
| **Active energy** | Closest: `biometric_workout_sessions.energy_kilojoule` (per-workout, **always NULL from HC** — [mapping.ts:425](supabase/functions/health-connect-ingest/mapping.ts#L425)) and `whoop_cycles.kilojoule` → `biometric_periods.cycle_energy_kilojoule` ([20260808150000:48](supabase/migrations/20260808150000_biometric_spine_views.sql#L48)). **No daily active-energy column** | WHOOP (cycle-level) | A daily-grain column. Unit discipline is already settled: kJ not kcal, [20260829072742:281](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L281) — "Never expose a unit-free energy (4.184x trap)"; conversion at render only via `lib/energy.kjToKcal` ([types/index.ts:628](src/types/index.ts#L628)) |
| **Steps** | **none** — no column anywhere; grep of `supabase/migrations/` for `step` returns nothing relevant | none | Everything |
| **Workouts** | `biometric_workout_sessions` ([20260829072742:263-299](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L263-L299)); `whoop_workouts` ([20260712120000:249-272](supabase/migrations/20260712120000_whoop_data.sql#L249-L272)) | WHOOP ([whoop-sync/index.ts:257-260](supabase/functions/whoop-sync/index.ts#L257-L260)) + HC ([mapping.ts:391-428](supabase/functions/health-connect-ingest/mapping.ts#L391-L428)) | An `activity_type` vocabulary (HC's is 84 `EXERCISE_TYPE_NAMES` entries, [mapping.ts:305-389](supabase/functions/health-connect-ingest/mapping.ts#L305-L389)); a third arm in `biometric_workouts` (currently `where bws.ingest_transport = 'health_connect'`, [20260830090000:255](supabase/migrations/20260830090000_biometric_workouts_health_connect_arm.sql#L255)); a `getActivityLabel` branch (§9) |

---

## 7. App surfaces

### 7.1 Where connect / disconnect / status live

**READ. All of it is in one screen: `src/screens/SettingsScreen.tsx`.** There is no dedicated integrations screen.

**WHOOP:**

- Imports: [SettingsScreen.tsx:41-47](src/screens/SettingsScreen.tsx#L41-L47) — `getWhoopConnection`, `connectWhoop`, `disconnectWhoop`, `syncWhoop`.
- Status load: `refreshWhoop()` ([:264-278](src/screens/SettingsScreen.tsx#L264-L278)), which also writes `whoopConnected` into the store so connect and disconnect cannot disagree ([:268-272](src/screens/SettingsScreen.tsx#L268-L272)).
- Connect: `handleConnectWhoop` ([:370-386](src/screens/SettingsScreen.tsx#L370-L386)); button at [:925-940](src/screens/SettingsScreen.tsx#L925-L940), labelled "Reconnect Whoop" when revoked.
- Disconnect: `handleDisconnectWhoop` ([:388-405](src/screens/SettingsScreen.tsx#L388-L405)) with a confirm Alert whose copy states history is kept ([:390-391](src/screens/SettingsScreen.tsx#L390-L391)).

**Health Connect:**

- Section header `<SectionLabel title="Health Connect" />` at [:949](src/screens/SettingsScreen.tsx#L949).
- Five render branches: `hcLoading` → `unsupported` → `not_installed` → `hcNativeError` → granted / `hcHasRequested` ([:950-1080](src/screens/SettingsScreen.tsx#L950-L1080)).
- Granted state shows **per-domain rows**, not one flag: Sleep / Heart rate variability / Resting heart rate / Workouts ([:1018-1029](src/screens/SettingsScreen.tsx#L1018-L1029)).
- "Sync now" ([:1050-1060](src/screens/SettingsScreen.tsx#L1050-L1060)) and "Update access" ([:1066-1078](src/screens/SettingsScreen.tsx#L1066-L1078)).
- **There is no Health Connect disconnect.** No `disconnectHealthConnect` anywhere in `src/` or `supabase/` (grep returns nothing). The only exit is Android's own settings, via `openHealthConnectSettingsScreen` ([healthConnect.ts:378-380](src/lib/healthConnect.ts#L378-L380)).

### 7.2 Platform.OS branches around them — there are none

**READ.** `SettingsScreen.tsx` contains **no `Platform.OS` reference at all** (grep across `src/` and `App.tsx` returns hits only in `DateTimeField.tsx`, `KeyboardScreen.tsx` (a comment), `healthConnect.ts`, `CreateFoodScreen.tsx`, and two test files).

The platform gate lives entirely inside the lib: [healthConnect.ts:57](src/lib/healthConnect.ts#L57), [:158](src/lib/healthConnect.ts#L158), [:274](src/lib/healthConnect.ts#L274), [:347](src/lib/healthConnect.ts#L347).

### 7.3 What an iOS user sees there now

**READ. Not hidden, not disabled, and not "coming soon".**

On iOS, `getHealthConnectAvailability()` returns `{ status: "unsupported" }` without touching the native module ([healthConnect.ts:57-59](src/lib/healthConnect.ts#L57-L59)). Settings therefore renders the section header **"Health Connect"** followed by ([SettingsScreen.tsx:957-962](src/screens/SettingsScreen.tsx#L957-L962)):

> "This device can't use Health Connect — the version of Android on it is too old, and there's no update that adds support."

An iPhone user is told their **Android version** is too old. See out-of-scope defect **D1**.

### 7.4 Where the correlation / trend UI reads biometrics from

**READ. Two client read sites, both narrow:**

1. **`biometric_periods_resolved`** — `getWhoopScoresForDate()` ([whoopScores.ts:96-109](src/lib/whoopScores.ts#L96-L109)), selecting `local_date, recovery_score, recovery_score_state, sleep_performance, sleep_score_state, strain, strain_score_state, strain_updated_at, period_start`, filtered `.eq("local_date", date)`, ordered by `period_start desc`, `.limit(1)`.

2. **`biometric_workouts`** — `fetchWorkouts()` ([useStore.ts:667-700](src/store/useStore.ts#L667-L700)), `select("*")` with an explicit snake→camel mapping and no spread.

**READ. Nothing in `src/` reads `whoop_correlation` or `whoop_cycle_nutrition`.** Confirmed by grep, and independently asserted in the migration record ([20260829111404:26-28](supabase/migrations/20260829111404_biometric_periods_resolved.sql#L26-L28): "`WhoopCorrelationRow` is confirmed dead code"). `WhoopCorrelationRow` exists as a type ([types/index.ts:850+](src/types/index.ts#L850)) with no consumer.

**READ.** `InsightsScreen.tsx` is **a stub** ([InsightsScreen.tsx:2](src/screens/InsightsScreen.tsx#L2)). `TrendsPanel.tsx` and `lib/trends.ts` contain no biometric reference (grep for `biometric|whoop|workout` returns nothing) — trends are nutrition-only.

### 7.5 Does the UI assume WHOOP or HC shapes?

**Yes, in three places — all READ:**

1. **`WhoopScoresPanel` renders a hard-coded "WHOOP" brand string** ([WhoopScoresPanel.tsx:85](src/components/WhoopScoresPanel.tsx#L85)) while reading the cross-provider `biometric_periods_resolved`. It is currently gated on `whoopConnected` ([TodayScreen.tsx:981](src/screens/TodayScreen.tsx#L981)), so this is not live today — but it means **the only biometric surface on Today is WHOOP-gated**, and a HealthKit-only user would see no score panel at all.

2. **`getProviderLabel` falls through to `"Connected"`** for any unrecognised package on a non-`health_connect` transport ([workoutLabels.ts:57-65](src/lib/workoutLabels.ts#L57-L65)). A HealthKit workout would be badged "Connected", not "Apple Health". The function is total and will not crash — [workoutLabels.ts:51-55](src/lib/workoutLabels.ts#L51-L55) says the fallback exists for exactly this case.

3. **`getActivityLabel` has a two-branch vocabulary switch** ([workoutLabels.ts:100-112](src/lib/workoutLabels.ts#L100-L112)): `if (ingestTransport === "whoop")` use WHOOP overrides, **`else` assume Health Connect's `EXERCISE_TYPE_NAMES` shape**. A HealthKit activity string would fall into the HC branch and be title-cased under the wrong vocabulary assumption.

---

## 8. Deletion and privacy hooks

### 8.1 Account deletion — covered, by cascade

**READ.** All four `biometric_*` tables declare `user_id uuid not null references auth.users (id) on delete cascade` ([20260829072742:60](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L60), [:134](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L134), [:200](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L200), [:264](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L264)), as does `biometric_source_preferences` ([20260829111404:87](supabase/migrations/20260829111404_biometric_periods_resolved.sql#L87)) and the WHOOP tables ([20260712120000:250](supabase/migrations/20260712120000_whoop_data.sql#L250) and siblings).

**READ.** `delete-account` deletes the auth user with `shouldSoftDelete` explicitly false ([delete-account/index.ts:262-268](supabase/functions/delete-account/index.ts#L262-L268)) and deliberately does **not** delete `whoop_tokens` / `whoop_connections` directly, relying on that cascade ([:257-261](supabase/functions/delete-account/index.ts#L257-L261)).

**Conclusion: biometric rows from every arm are removed on account deletion, via cascade.** **INFERRED:** a HealthKit arm inherits this for free provided its rows land in the same tables with the same FK — no new deletion code needed.

**READ.** The function also best-effort revokes at WHOOP first ([:237-255](supabase/functions/delete-account/index.ts#L237-L255)) and sweeps storage ([:155-191](supabase/functions/delete-account/index.ts#L155-L191)).

### 8.2 Per-provider disconnect — WHOOP yes (tokens only), Health Connect none

**READ.** `whoop-disconnect` revokes at WHOOP then deletes `whoop_tokens` ([whoop-disconnect/index.ts:88-95](supabase/functions/whoop-disconnect/index.ts#L88-L95)) and `whoop_connections` ([:100-108](supabase/functions/whoop-disconnect/index.ts#L100-L108)). **It deletes no biometric data** — and the user-facing Alert says so: "Your existing recovery and sleep history is kept" ([SettingsScreen.tsx:391](src/screens/SettingsScreen.tsx#L391)).

**READ.** For Health Connect there is **no disconnect at all** — no Edge Function, no client function, no UI affordance. Grep for `disconnectHealthConnect|health-connect-disconnect|revokeAllPermissions` across `src/` and `supabase/` returns nothing.

**READ.** Retaining the losing row is a stated invariant, not an oversight — [20260830160000:13-23](supabase/migrations/20260830160000_biometric_workouts_dedup.sql#L13-L23): "NEVER DELETE… If the user later disconnects their direct WHOOP integration, the Health Connect copy is still there and simply starts winning."

**So: there is no per-provider data removal for any provider.** A HealthKit arm would inherit that same absence.

### 8.3 In-app consent and privacy strings mentioning Health Connect

**READ.** In-app strings naming Health Connect, all in `SettingsScreen.tsx`:

| Line | String (abbreviated) | Kind |
|---|---|---|
| [:949](src/screens/SettingsScreen.tsx#L949) | Section title "Health Connect" | Label |
| [:958-961](src/screens/SettingsScreen.tsx#L958-L961) | "This device can't use Health Connect — the version of Android on it is too old…" | Status (see **D1**) |
| [:964-970](src/screens/SettingsScreen.tsx#L964-L970) | "Health Connect isn't installed yet. Once it is, plated can see how your meals line up with sleep, heart rate variability, resting heart rate and workouts collected by apps like Fitbit or Garmin." | **Consent-adjacent** — names the data categories |
| [:976](src/screens/SettingsScreen.tsx#L976) | "Install Health Connect" | Button |
| [:990-993](src/screens/SettingsScreen.tsx#L990-L993) | "Health Connect couldn't be reached just now — this isn't about your permissions…" | Error |
| [:1018-1029](src/screens/SettingsScreen.tsx#L1018-L1029) | Per-domain rows: "Sleep", "Heart rate variability", "Resting heart rate", "Workouts" | **Consent disclosure** |
| [:1038-1041](src/screens/SettingsScreen.tsx#L1038-L1041) | "plated reads what you've granted from Health Connect so it can sit alongside what you've eaten." | **Purpose statement** |
| [:532,536](src/screens/SettingsScreen.tsx#L532) | "Some Health Connect data couldn't sync." | Error |

**READ.** Android-manifest-level consent strings are the `app.json` permission list ([app.json:20-26](app.json#L20-L26)) — declarative, no prose.

**INFERRED:** a HealthKit arm needs counterparts for the section title, the purpose statement, the per-domain disclosure, and the error strings, **plus** two things Health Connect never needed: `NSHealthShareUsageDescription` (and `NSHealthUpdateUsageDescription` if writing), which are Apple-reviewed prose with no Android analogue.

### 8.4 In-app references to the privacy policy

**READ.** One, and it is out-of-repo: `PRIVACY_URL = "https://platedapp.uk/plated-privacy.html"` ([AboutScreen.tsx:20](src/screens/AboutScreen.tsx#L20)), opened from a "Privacy policy" row ([AboutScreen.tsx:63](src/screens/AboutScreen.tsx#L63)).

The policy text lives in `plated-website`, out of scope as instructed. **Noted only:** the in-app reference is a URL, so a policy update needs no app change — but Apple's HealthKit review requires the privacy policy to cover health data specifically, and that content is in the other repo.

**READ.** Separately, [CLAUDE.md:45](CLAUDE.md#L45) records that attribution strings in `src/content/attributions.ts` are mirrored manually at `platedapp.uk/attributions.html` and must be updated together. That file contains no health-data reference (grep returns nothing) — it is Open Food Facts only.

---

## 9. Guards and leftovers

### 9.1 Tests that enumerate providers, transports or origin packages

**READ.** Three test files reference transports or packages. Only one meaningfully enumerates them.

**`src/lib/__tests__/workoutLabels.test.ts` — the main one. Would need extending.**

- Enumerates all seven package→label mappings ([:18-23](src/lib/__tests__/workoutLabels.test.ts#L18-L23)).
- Asserts case-sensitivity is real ([:29](src/lib/__tests__/workoutLabels.test.ts#L29)).
- Asserts the unknown-HC-package fallback is `"Health Connect"` ([:35-39](src/lib/__tests__/workoutLabels.test.ts#L35-L39)).
- **Already probes a third transport:** [:43-44](src/lib/__tests__/workoutLabels.test.ts#L43-L44) asserts `getProviderLabel("some.unknown.direct", "some_future_transport") === "Connected"`. So the "is this function total?" question is already covered; what is not covered is whether "Connected" is the *right* answer for Apple Health.
- Asserts the two activity vocabularies stay separate ([:71-75](src/lib/__tests__/workoutLabels.test.ts#L71-L75)).

**`src/lib/__tests__/healthConnectIngest.test.ts` — would need a sibling, not an extension.** Covers `validateOriginPackage` including `.direct` rejection and case-insensitive evasion ([:47-85](src/lib/__tests__/healthConnectIngest.test.ts#L47-L85)), `providerRecordId` ([:86-107](src/lib/__tests__/healthConnectIngest.test.ts#L86-L107)), `normalizeZoneOffsetId` ([:109-166](src/lib/__tests__/healthConnectIngest.test.ts#L109-L166)), and each mapper. One test is directly relevant: **"ignores a client-supplied `ingest_transport` on the raw record — always health_connect"** ([:222](src/lib/__tests__/healthConnectIngest.test.ts#L222)). That assertion is correct for HC and would need a deliberate decision for a HealthKit mapper.

Note: no test in this file asserts the origin-package regex **rejects hyphens** — the rejection cases are empty string, missing value, no dot at all, and `.direct` ([:63-85](src/lib/__tests__/healthConnectIngest.test.ts#L63-L85)). So the hyphen gap in §3.2 is untested in either direction.

**`src/lib/__tests__/dayStream.test.ts`** — uses `originPackage: "whoop.direct"` / `ingestTransport: "whoop"` as fixture values only ([:39-40](src/lib/__tests__/dayStream.test.ts#L39-L40)). Not an enumeration.

**AST-style guard tests — READ, none enumerate providers.** `noRawHexColors.test.ts`, `noRnKeyboardAvoidingView.test.ts`, `mealEntriesInsertSites.test.ts`, `tabStructure.test.ts`. None would need extending for a new arm.

**RLS tests — READ, none in the Vitest suite.** RLS verification lives in SQL verify files ([supabase/migrations/verify/](supabase/migrations/verify/), 12 files). [CLAUDE.md:55-58](CLAUDE.md#L55-L58) describes the throwaway plain-`postgres` container pattern for executing view fixtures, including a from-scratch `auth.uid()`/RLS rig — that pattern would carry over to a HealthKit view migration unchanged.

### 9.2 Every mention of HealthKit / Apple Health / HKQuantity

**READ.** A case-insensitive grep for `healthkit|apple health|hkquantity|HKWorkout|NSHealth` across all `.ts`, `.tsx`, `.sql`, `.md`, `.json`, `.js` outside `node_modules` returns **exactly one hit**:

**[supabase/migrations/20260808150000_biometric_spine_views.sql:222-224](supabase/migrations/20260808150000_biometric_spine_views.sql#L222-L224)**, under "NOT in this migration (deliberately deferred)":

> `-- HealthKit / Garmin branches. Each becomes a union all arm per view,`
> `-- carrying its own ingest_source, hrv_method, and energy unit. No`
> `-- normalisation across sources in these views.`

**Still accurate as stated intent.** §3.5 confirms the union-arm shape is how the Health Connect arm was in fact built, and `hrv_method` did become row-sourced as predicted.

**READ.** Three further "Apple" mentions that are design intent rather than HealthKit references:

| Location | Text | Status |
|---|---|---|
| [20260808150000:25](supabase/migrations/20260808150000_biometric_spine_views.sql#L25) | `source_period_id` is text because "Garmin/Apple ids won't be bigint" | **Vindicated** — widened bigint→text in [20260829111404:19-29](supabase/migrations/20260829111404_biometric_periods_resolved.sql#L19-L29) |
| [20260808150000:47](supabase/migrations/20260808150000_biometric_spine_views.sql#L47) | kJ named explicitly "for the future kcal-converting Garmin/Apple arm" | **Still live** — HealthKit reports energy in kcal; the kJ convention holds |
| [types/index.ts:609](src/types/index.ts#L609) | "so Garmin/Apple ride in free later via ingestSource" | **Optimistic** — §7.5 shows `getActivityLabel`/`getProviderLabel` would not "ride in free" |

**READ.** `CLAUDE.md` mentions Apple once ([CLAUDE.md:7](CLAUDE.md#L7)): "iOS paused pending Apple Developer account". Given TestFlight build 3 exists, **this line is now stale** — see **D3**.

**READ.** No HealthKit TODOs, no stale branches, no dead imports, nothing in `docs/` or `testing/` (greps return nothing).

---

## Gap list

What HealthKit needs that does not exist. One line each, no solutions.

### Native / build

- No HealthKit dependency in `package.json` or the lockfile ([package.json:17-49](package.json#L17-L49)).
- No `com.apple.developer.healthkit` entitlement ([app.json:34-39](app.json#L34-L39)).
- No `com.apple.developer.healthkit.background-delivery` entitlement ([app.json:34-39](app.json#L34-L39)).
- No `NSHealthShareUsageDescription` ([app.json:36-38](app.json#L36-L38)).
- No `NSHealthUpdateUsageDescription` ([app.json:36-38](app.json#L36-L38)).
- No `UIBackgroundModes` ([app.json:34-39](app.json#L34-L39)) — nothing to carry background delivery.
- No HealthKit config plugin in the `plugins` array ([app.json:40-71](app.json#L40-L71)).
- None of the above present in TestFlight build 3's source either (`git show 950a276:app.json`, `git show 950a276:package.json`).

### Client

- No provider/transport abstraction in TypeScript — Settings and App import HC modules directly ([SettingsScreen.tsx:49-58](src/screens/SettingsScreen.tsx#L49-L58), [App.tsx:50](App.tsx#L50)).
- No HealthKit availability/permission module; `getHealthConnectAvailability` returns `unsupported` on iOS by construction ([healthConnect.ts:57-59](src/lib/healthConnect.ts#L57-L59)).
- No HealthKit sync module; the changes-token watermark is Health-Connect-shaped and device-local ([healthConnectSync.ts:203-213](src/lib/healthConnectSync.ts#L203-L213)).
- No HealthKit anchor persistence; the AsyncStorage key namespace is `health_connect_changes_token:*` ([healthConnectSync.ts:203-205](src/lib/healthConnectSync.ts#L203-L205)).
- `syncRefetch.ts` types only two sync result shapes ([syncRefetch.ts:45-46](src/lib/syncRefetch.ts#L45-L46)).
- No background delivery path of any kind — both triggers are foreground-only ([App.tsx:364-368](App.tsx#L364-L368)).
- `getProviderLabel` has no Apple Health entry and falls through to "Connected" ([workoutLabels.ts:31-65](src/lib/workoutLabels.ts#L31-L65)).
- `getActivityLabel`'s `else` branch assumes Health Connect's vocabulary ([workoutLabels.ts:100-112](src/lib/workoutLabels.ts#L100-L112)).

### Edge Function

- `COLLECTIONS` is keyed on Health Connect record-type names; an unknown key is a 400 ([mapping.ts:442-463](supabase/functions/health-connect-ingest/mapping.ts#L442-L463), [index.ts:76-82](supabase/functions/health-connect-ingest/index.ts#L76-L82)).
- `ingest_transport: "health_connect"` is a hard-coded literal in all four mappers ([mapping.ts:191](supabase/functions/health-connect-ingest/mapping.ts#L191), [:246](supabase/functions/health-connect-ingest/mapping.ts#L246), [:280](supabase/functions/health-connect-ingest/mapping.ts#L280), [:398](supabase/functions/health-connect-ingest/mapping.ts#L398)).
- `validateOriginPackage`'s regex admits no hyphen, so hyphenated iOS bundle identifiers are skipped ([mapping.ts:34](supabase/functions/health-connect-ingest/mapping.ts#L34)).
- No mapper for any HealthKit sample type; all four read Health Connect field names ([mapping.ts:157-428](supabase/functions/health-connect-ingest/mapping.ts#L157-L428)).
- No HealthKit stage-vocabulary mapping; `SleepStageType` 0-6 is HC's enum ([mapping.ts:165-171](supabase/functions/health-connect-ingest/mapping.ts#L165-L171)).
- `normalizeZoneOffsetId` is derived from `java.time.ZoneOffset#getId()`'s contract, which HealthKit does not use ([mapping.ts:59-126](supabase/functions/health-connect-ingest/mapping.ts#L59-L126)).
- No validation of future timestamps, duration bounds or value ranges on any arm ([index.ts:99-121](supabase/functions/health-connect-ingest/index.ts#L99-L121)).

### Schema

- `ingest_transport` CHECK admits only `'whoop'`/`'health_connect'` on five tables ([20260829072742:63](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L63), [:137](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L137), [:203](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L203), [:267](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L267), [20260829111404:97](supabase/migrations/20260829111404_biometric_periods_resolved.sql#L97)).
- The transport↔origin coherence CHECK is an exhaustive two-branch disjunction that a third transport satisfies neither half of ([20260829072742:100-104](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L100-L104) and three siblings, [20260829111404:98-102](supabase/migrations/20260829111404_biometric_periods_resolved.sql#L98-L102)).
- `origin_package` regex rejects hyphens on all five tables ([20260829072742:64](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L64) and siblings).
- `biometric_synthetic_cycles` filters `where ingest_transport = 'health_connect'` and stamps that literal on output ([20260830170000:232](supabase/migrations/20260830170000_biometric_synthetic_cycles.sql#L232), [:340](supabase/migrations/20260830170000_biometric_synthetic_cycles.sql#L340)).
- All three domain candidate CTEs in `biometric_periods_resolved` hard-filter `'health_connect'` ([20260920140000:386](supabase/migrations/20260920140000_strain_updated_at.sql#L386), [:429](supabase/migrations/20260920140000_strain_updated_at.sql#L429), [:468](supabase/migrations/20260920140000_strain_updated_at.sql#L468)).
- Frame precedence is `whoop`-first then alphabetical `origin_package`; two aggregator arms tie arbitrarily ([20260920140000:329](supabase/migrations/20260920140000_strain_updated_at.sql#L329)).
- The cross-arm overlap gate suppresses **both** members of an unreconciled pair, assuming two arms ([20260830180000:291-312](supabase/migrations/20260830180000_biometric_periods_resolved_cross_provider.sql#L291-L312)).
- `frame_cycles.whoop_or_hc` encodes a two-arm assumption in an identifier ([20260920140000:359](supabase/migrations/20260920140000_strain_updated_at.sql#L359)).
- `biometric_workouts`' second arm filters `where bws.ingest_transport = 'health_connect'` ([20260830090000:255](supabase/migrations/20260830090000_biometric_workouts_health_connect_arm.sql#L255)).
- The `_hc` column-suffix convention in `whoop_correlation` assumes exactly two arms ([20260901130000:254-262](supabase/migrations/20260901130000_whoop_correlation_hc_sleep_widening.sql#L254-L262)).
- No provider-neutral column for respiratory rate, blood oxygen or wrist/skin temperature — all three are WHOOP-only ([20260712120000](supabase/migrations/20260712120000_whoop_data.sql) sleeps/recoveries blocks; absent from [20260829072742:59-107](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L59-L107)).
- No column anywhere for VO2 max, steps, or daily active energy (greps of `supabase/migrations/` return nothing).
- No structured overnight-vs-daytime sampling-window column; `hrv_window` is unconstrained free text with no consumer ([20260829072742:159-163](supabase/migrations/20260829072742_biometric_provider_neutral_tables.sql#L159-L163)).
- `biometric_source_preferences` cannot express a HealthKit preference — same two CHECKs ([20260829111404:97-102](supabase/migrations/20260829111404_biometric_periods_resolved.sql#L97-L102)).

### UI

- iOS users are shown Android-specific copy in a "Health Connect" section ([SettingsScreen.tsx:949](src/screens/SettingsScreen.tsx#L949), [:957-962](src/screens/SettingsScreen.tsx#L957-L962)).
- No connect / status / sync surface for a third provider; Settings hard-codes two sections.
- No disconnect for any non-WHOOP provider (grep: no `disconnectHealthConnect` anywhere).
- No per-domain source picker; `biometric_source_preferences` has full CRUD policies ([20260829111404:121-131](supabase/migrations/20260829111404_biometric_periods_resolved.sql#L121-L131)) and **no client writer** (grep of `src/` returns only a comment at [healthConnect.ts:177](src/lib/healthConnect.ts#L177)).
- The only Today biometric surface is gated on `whoopConnected` ([TodayScreen.tsx:981](src/screens/TodayScreen.tsx#L981)), so a HealthKit-only user would see none.
- `WhoopScoresPanel` hard-codes a "WHOOP" brand label over cross-provider data ([WhoopScoresPanel.tsx:85](src/components/WhoopScoresPanel.tsx#L85)).
- No in-app consent copy for Apple Health; the HC purpose statement and per-domain disclosure are HC-specific ([SettingsScreen.tsx:1018-1041](src/screens/SettingsScreen.tsx#L1018-L1041)).

---

## OTA vs build

**None of this can ship over the air on the current iOS runtime `5359dcce…`. It needs a new build.** Answered from the fingerprint sources, not assumed.

**READ.** `runtimeVersion` is `{ "policy": "fingerprint" }` ([app.json:11-13](app.json#L11-L13)). An OTA update is only delivered to a binary whose runtime version matches, so the question is entirely "does a HealthKit change alter the fingerprint?"

**READ.** `@expo/fingerprint`'s `getHashSourcesAsync` composes the hash from, among others ([node_modules/@expo/fingerprint/build/sourcer/Sourcer.js:29-45](node_modules/@expo/fingerprint/build/sourcer/Sourcer.js#L29-L45)):

- `getExpoAutolinkingIosSourcesAsync` (line 30) — the set of autolinked iOS native modules,
- `getExpoConfigSourcesAsync` (line 31) — the resolved Expo config, i.e. `app.json` in full,
- `getEasBuildSourcesAsync` (line 32),
- `getPackageJsonScriptSourcesAsync` (line 36),
- `getPatchPackageSourcesAsync` (line 45).

Every change HealthKit requires hits at least one, and most hit three:

| Change | Sourcer it changes |
|---|---|
| Add a HealthKit native module | `getExpoAutolinkingIosSourcesAsync` (line 30) |
| Add `com.apple.developer.healthkit` | `getExpoConfigSourcesAsync` (line 31) |
| Add `NSHealthShareUsageDescription` | `getExpoConfigSourcesAsync` (line 31) |
| Add `UIBackgroundModes` | `getExpoConfigSourcesAsync` (line 31) |
| Add a HealthKit config plugin | `getExpoConfigSourcesAsync` (line 31) |

So the fingerprint changes, the runtime version changes, and `5359dcce…` will not receive the update. **This is settled by the fingerprint sources, not by the general rule about entitlements** — even a pure `app.json` entitlement edit with no new dependency would change the fingerprint via line 31 alone.

**READ.** The project's own record confirms `5359dcce…` is the iOS runtime matching TestFlight build 3 ([testing/2026-09-19-internal.md:49](testing/2026-09-19-internal.md#L49)).

**What *could* ship OTA on `5359dcce…`:** pure-JS changes only. Of the gap list, that covers the label functions (`getProviderLabel`, `getActivityLabel`), the Settings copy fixes including **D1**, the `syncRefetch` typing, and any client-side reshaping — none of which is useful without the native arm underneath. Schema and Edge Function changes are server-side and independent of the runtime entirely: migrations and `supabase functions deploy` reach existing binaries without any app update.

**INFERRED:** so the work splits cleanly into (a) a server half — migrations plus a new/widened ingest function — deployable to today's binaries, and (b) a client half needing a new iOS build and a TestFlight round trip.

---

## SQL for you to run

Live-state questions I could not answer from `supabase/migrations/` alone. Each is read-only. Run as `authenticated` (or the test user) where RLS matters; the notes say which.

```sql
-- Q1. Which origin_packages actually exist today, per table, with row counts.
-- Purpose: confirms whether any stored value is already near the regex's
-- limits, and gives the real vendor spread before a third arm is added.
-- Run as postgres for a whole-project picture.
select 'sleep_sessions' as tbl, ingest_transport, origin_package, count(*) as n
  from public.biometric_sleep_sessions group by 1,2,3
union all
select 'hrv_samples', ingest_transport, origin_package, count(*)
  from public.biometric_hrv_samples group by 1,2,3
union all
select 'resting_hr', ingest_transport, origin_package, count(*)
  from public.biometric_resting_hr group by 1,2,3
union all
select 'workout_sessions', ingest_transport, origin_package, count(*)
  from public.biometric_workout_sessions group by 1,2,3
order by tbl, n desc;
```

```sql
-- Q2. Does any biometric_source_preferences row exist at all?
-- Migrations insert none and no client writes it, so this should be 0.
-- A non-zero result means something writes it that I did not find.
select domain, ingest_transport, origin_package, count(*) as n
from public.biometric_source_preferences
group by 1,2,3
order by 1;
```

```sql
-- Q3. What hrv_window values are actually stored?
-- Schema allows any non-empty string; the HC mapper writes 'instantaneous'.
-- Tells you whether any overnight-vs-daytime distinction is already latent
-- in the data before designing one for HealthKit.
select hrv_method, hrv_unit, hrv_window, count(*) as n,
       min(measured_at) as earliest, max(measured_at) as latest
from public.biometric_hrv_samples
group by 1,2,3
order by n desc;
```

```sql
-- Q4. How often does the cross-arm overlap gate actually suppress a frame?
-- This is the mechanism that would lose BOTH frames if a third arm
-- disagreed on onset. Counts today's suppressions so you know the current
-- baseline before widening the arm count.
with all_periods as (
  select user_id, source_period_id, ingest_transport, origin_package,
         period_start as cycle_start,
         coalesce(period_end, period_start + interval '36 hours') as eff_end
  from public.biometric_periods
  union all
  select user_id, source_period_id, ingest_transport, origin_package,
         cycle_start,
         coalesce(cycle_end, cycle_start + interval '36 hours')
  from public.biometric_synthetic_cycles
)
select a.user_id, count(*) as suppressed_rows
from all_periods a
join all_periods b
  on b.user_id = a.user_id
 and b.ingest_transport <> a.ingest_transport
 and b.cycle_start is distinct from a.cycle_start
 and a.cycle_start < b.eff_end
 and b.cycle_start < a.eff_end
group by a.user_id
order by suppressed_rows desc;
```

```sql
-- Q5. How many frames does each arm currently win?
-- Establishes whether the synthetic (Health Connect) arm ever wins a frame
-- in practice today, which determines whether a third arm would be
-- competing against a live arm or an empty one.
select period_ingest_transport, period_origin_package,
       count(*) as frames,
       count(*) filter (where sleep_ingest_transport = 'health_connect') as hc_sleep_wins,
       count(*) filter (where sleep_ingest_transport = 'whoop')          as whoop_sleep_wins
from public.biometric_periods_resolved
group by 1,2
order by frames desc;
```

```sql
-- Q6. Are the six _hc sleep columns actually populated, and on how many rows?
-- Confirms the pointer-bridge join is live, which is what determines whether
-- a HealthKit sleep winner would flow into those columns unchanged.
select count(*)                                          as total_rows,
       count(total_in_bed_ms_hc)                         as in_bed_hc,
       count(total_sleep_ms_hc)                          as sleep_hc,
       count(total_deep_ms_hc)                           as deep_hc,
       count(*) filter (where sleep_data_source = 'health_connect') as hc_won_sleep,
       count(*) filter (where sleep_data_source = 'whoop')          as whoop_won_sleep
from public.whoop_correlation;
```

```sql
-- Q7. RLS spot-check on the views a HealthKit arm would extend.
-- MUST be run as a signed-in user who owns no biometric data (a second
-- account), NOT as postgres. All four must return 0. Non-zero means
-- security_invoker is not taking effect on that view.
select 'periods'        as v, count(*) from public.biometric_periods
union all select 'resolved',  count(*) from public.biometric_periods_resolved
union all select 'workouts',  count(*) from public.biometric_workouts
union all select 'synthetic', count(*) from public.biometric_synthetic_cycles;
```

---

## Out-of-scope defects

Found while reading. Not fixed, no PL- IDs assigned, listed for triage.

**D1 — iOS users are told their Android version is too old.**
[src/screens/SettingsScreen.tsx:957-962](src/screens/SettingsScreen.tsx#L957-L962) — on iOS, `getHealthConnectAvailability()` returns `unsupported` ([healthConnect.ts:57-59](src/lib/healthConnect.ts#L57-L59)), so the Settings screen renders a "Health Connect" section reading "the version of Android on it is too old" to an iPhone user. Shippable OTA on the current iOS runtime.

**D2 — no ingest-side bounds on timestamps, durations or values.**
[supabase/functions/health-connect-ingest/index.ts:99-121](supabase/functions/health-connect-ingest/index.ts#L99-L121) — no check that `period_end >= period_start`, that timestamps are not in the future, or that heart rate / HRV values are physiologically plausible. `total_in_bed_ms` is a raw subtraction ([mapping.ts:215-217](supabase/functions/health-connect-ingest/mapping.ts#L215-L217)) and can be negative. Affects the live Health Connect arm today, not just a future one.

**D3 — `CLAUDE.md` says iOS is paused pending an Apple Developer account.**
[CLAUDE.md:7](CLAUDE.md#L7) — "(iOS paused pending Apple Developer account)". TestFlight build 3 exists with iOS runtime `5359dcce…` and OTAs have shipped to it ([testing/2026-09-19-internal.md:49](testing/2026-09-19-internal.md#L49), [:51](testing/2026-09-19-internal.md#L51)). The line is stale and, since it is the project's own orienting document, likely to mislead future work.

**D4 — `getActivityLabel` treats every non-WHOOP transport as Health Connect.**
[src/lib/workoutLabels.ts:100-112](src/lib/workoutLabels.ts#L100-L112) — the `else` branch assumes `EXERCISE_TYPE_NAMES` vocabulary. Its sibling `getProviderLabel` is deliberately total for an unknown transport ([workoutLabels.ts:51-55](src/lib/workoutLabels.ts#L51-L55)) and is tested for one ([workoutLabels.test.ts:43-44](src/lib/__tests__/workoutLabels.test.ts#L43-L44)); `getActivityLabel` has neither property. Dead code today (only two transports exist), live the moment a third is added.

**D5 — no test asserts the origin-package regex rejects a hyphen.**
[src/lib/__tests__/healthConnectIngest.test.ts:63-85](src/lib/__tests__/healthConnectIngest.test.ts#L63-L85) — rejection cases cover empty, missing, no-dot and `.direct`, but not hyphenated input. The regex ([mapping.ts:34](supabase/functions/health-connect-ingest/mapping.ts#L34)) excludes hyphens, and that behaviour is currently unpinned in either direction, so a future widening could change it silently.

**D6 — `WhoopScoresPanel` brands cross-provider data as WHOOP.**
[src/components/WhoopScoresPanel.tsx:85](src/components/WhoopScoresPanel.tsx#L85) renders a literal "WHOOP" while its data comes from `biometric_periods_resolved` ([whoopScores.ts:97](src/lib/whoopScores.ts#L97)), which resolves per domain across arms and can return a Health-Connect-sourced sleep winner ([20260920140000:381-386](supabase/migrations/20260920140000_strain_updated_at.sql#L381-L386)). Not reachable today because the panel is gated on `whoopConnected` ([TodayScreen.tsx:981](src/screens/TodayScreen.tsx#L981)), so a WHOOP-connected user is the only one who sees it — but the gate is the only thing making the label true.
