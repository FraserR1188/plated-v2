# EAS Production Build Audit — plated

Read-only investigation. No files were modified. Generated 2026-08-21.

---

## 1. Tooling and project identity

**Evidence**

```
eas-cli/20.5.1 win32-x64 node-v24.14.1   (latest available: 22.2.0 — 2 major versions behind)
eas whoami        → fraserr1188 (fraserrobbie2@gmail.com)
eas project:info  → fullName @fraserr1188/plated-v2
                     ID       7b2c1a05-5a75-4a60-80bf-a09d4e09d768
```

**Reading:** Project ID and owner match app.json (`extra.eas.projectId`) and this brief exactly — no mismatch. `eas-cli` is notably out of date (20.5.1 vs current 22.2.0). This matters here because a behavior this report relies on — how EAS Build picks a hosted "environment" for a profile when `eas.json` doesn't say so explicitly (§2, §6) — is version-sensitive. Recommend upgrading eas-cli before the production build, or at minimum reading the "Resolved environment" line the build worker prints at the start of the build log.

---

## 2. eas.json

**Full contents**

```json
{
  "cli": {
    "appVersionSource": "remote"
  },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "android": { "gradleCommand": ":app:assembleDebug" },
      "env": { "EXPO_PUBLIC_SENTRY_ENV": "development" }
    },
    "preview": {
      "distribution": "internal",
      "android": { "buildType": "apk" },
      "env": { "EXPO_PUBLIC_SENTRY_ENV": "preview" }
    },
    "production": {
      "android": { "buildType": "app-bundle" },
      "env": { "EXPO_PUBLIC_SENTRY_ENV": "production" },
      "autoIncrement": true
    },
    "production-apk": {
      "extends": "production",
      "distribution": "internal",
      "android": { "buildType": "apk" }
    }
  }
}
```

**Reading, point by point**

- **`production` profile exists:** yes.
- **What it extends:** nothing (`production-apk` extends `production`, not the reverse).
- **`distribution: store`?** Not set explicitly. It is *absent*, which per Expo's convention defaults to `"store"`. I could not get first-party doc text to state this default in so many words (see §2 caveat below) — treat as high-confidence but unconfirmed by a directly-quotable doc line. Recommend confirming in the build summary output at build start, which prints the resolved profile.
- **`android.buildType`:** set to `"app-bundle"` on `production` (correct for Play) and `"apk"` on `development`, `preview`, and `production-apk`.
- **`developmentClient` true on production, directly or via inheritance?** No. `production` does not set it and does not extend a profile that does.
- **`autoIncrement`:** `true` on `production` only. Not set (defaults `false`) on `development`, `preview`. `production-apk` extends `production` and does not override it, so it inherits `autoIncrement: true`.
- **`environment` key on any profile:** **absent on all four profiles.** This is the single most consequential fact in this file — see below.
- **`channel`:** not present on any profile. Expected: `expo-updates` is not installed in this project (§5), so channels are moot.

**What the missing `environment` key means**

Per Expo's docs (`docs.expo.dev/eas/environment-variables/usage`), when a build profile has no explicit `environment` field, EAS CLI infers one from the profile's *configuration*, not its *name*:

> "If you don't set the `environment` option, we will set the environment automatically based on your build's configuration: `production` when `distribution` is set to `store`; `development` when `developmentClient` is `true`; `preview` for everything else."

Applying that rule to this file:

| Profile | distribution | developmentClient | Inferred hosted environment |
|---|---|---|---|
| `development` | internal | true | **development** ✓ matches name |
| `preview` | internal | — | **preview** ✓ matches name |
| `production` | *(unset → store)* | — | **production** ✓ matches name, provided `distribution` really does default to `store` on this eas-cli version |
| `production-apk` | internal | — | **preview**, not "production" — because it overrides `distribution` to `internal`, the name-vs-behavior mismatch bites here even though the profile is named after, and extends, `production` |

So: **if** the undocumented-here `distribution` default holds and this eas-cli version implements the same inference logic as current docs describe, the real `production` profile should correctly pull the hosted "production" environment's variables. I cannot fully confirm this without either running a build or a newer CLI — flagging as a pre-flight check, not a proceed-blindly green light (see BLOCKERS).

`production-apk` silently building against the **preview** hosted environment (different Supabase URL/key/Sentry env than the profile name implies) is a real inconsistency worth knowing about even though it's an internal-only distribution profile, not the store path.

---

## 3. app.json

No `app.config.js`/`.ts` exists (glob for `app.config.*` returned nothing) — app.json is authoritative, not shadowed by a dynamic config.

**Full contents**

```json
{
  "expo": {
    "name": "plated",
    "slug": "plated-v2",
    "version": "1.0.0",
    "orientation": "portrait",
    "userInterfaceStyle": "dark",
    "scheme": "plated",
    "android": {
      "package": "com.fraseranalytics.plated",
      "permissions": ["android.permission.CAMERA"]
    },
    "plugins": [
      "expo-dev-client",
      ["expo-image-picker", { "photosPermission": "...", "cameraPermission": "..." }],
      ["expo-camera", { "cameraPermission": "plated needs camera access to scan food barcodes." }],
      "@react-native-community/datetimepicker",
      "expo-web-browser",
      ["@sentry/react-native/expo", { "url": "https://de.sentry.io/", "organization": "fraser-analytics", "project": "plated", "experimental_android": { "enableAndroidGradlePlugin": true } }]
    ],
    "extra": { "eas": { "projectId": "7b2c1a05-5a75-4a60-80bf-a09d4e09d768" } },
    "owner": "fraserr1188"
  }
}
```

**Reading**

- **`version`:** `1.0.0`.
- **`android.versionCode`:** **not present at all.** Expected and correct: `cli.appVersionSource` is `"remote"` (§2), meaning EAS itself tracks and injects the versionCode server-side at build time — a local `android.versionCode` would be ignored (and its presence would be a code smell under remote versioning). Current remote counter, per build history (§8), is **3**; the next `production` build (which has `autoIncrement: true`) will produce **versionCode 4**.
- **`android.package`:** `com.fraseranalytics.plated` — matches the locked package name.
- **`scheme`:** `plated` — used for the WHOOP OAuth redirect (`plated://whoop-callback`).
- **`android.permissions`:** only `CAMERA` is declared explicitly here. The *resolved* list is much larger — see §4.
- **`plugins`:** `expo-dev-client`, `expo-image-picker`, `expo-camera`, `@react-native-community/datetimepicker`, `expo-web-browser`, `@sentry/react-native/expo`. No `expo-build-properties`, no `expo-system-ui`, no `expo-updates`.
- **Icon / adaptiveIcon / splash:** **no icon, adaptiveIcon, or splash keys exist anywhere in app.json.** The app is currently building with Expo's bare default icon/splash placeholders.
- **Asset files on disk:** despite not being referenced in app.json, the following exist under `assets/`: `adaptive-icon.png`, `favicon.png`, `icon.png`, `splash-icon.png`. They are present but **orphaned** — nothing in app.json points to them, so they are not currently being used for the app icon or splash screen.

This is a genuine finding, not a config nuance: a Play Store internal-testing submission will ship with Expo's stock default launcher icon unless this is fixed before the AAB is built.

---

## 4. Resolved config (`npx expo config --type introspect`)

Full `android` section from the resolved output:

```js
android: {
  package: 'com.fraseranalytics.plated',
  permissions: [
    'android.permission.CAMERA',
    'android.permission.RECORD_AUDIO',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
    'android.permission.INTERNET'
  ]
}
```

The generated AndroidManifest.xml mod additionally carries `SYSTEM_ALERT_WINDOW` and `VIBRATE` (added by autolinked native modules, not by the `permissions` array above — Expo's manifest merge picks up permissions some native modules declare in their own `AndroidManifest.xml`, which bypasses the app.json `permissions` allow-list entirely).

**Resolved plugins list**, from `_internal.pluginHistory`: `expo-dev-client` (6.0.21), `expo-dev-menu` (7.0.19, pulled in by expo-dev-client), `expo-dev-launcher` (6.0.21, ditto), `expo-image-picker` (17.0.11), `expo-camera` (17.0.10), `expo-web-browser` (15.0.11), `@sentry/react-native` (7.2.0). No `expo-build-properties` anywhere in the plugin history.

**targetSdkVersion / compileSdkVersion / minSdkVersion:** **not pinned anywhere.** No `expo-build-properties` plugin is installed or configured (confirmed absent from both `app.json` plugins and `package.json` dependencies), so these values fall through to whatever Expo SDK 54's prebuild template defaults to. There is no explicit override to inspect or misconfigure, which is low-risk by itself, but it also means there's no local record of what SDK level the AAB will actually target — that's only knowable from the EAS build logs.

**Merged permission list (transitive):** `CAMERA`, `RECORD_AUDIO`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`, `INTERNET`, plus `SYSTEM_ALERT_WINDOW` and `VIBRATE` via native-module manifest merge. Only `CAMERA` (and implicitly `INTERNET`) look intentional given what the app does. `RECORD_AUDIO`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`, `SYSTEM_ALERT_WINDOW`, and `VIBRATE` are not declared in app.json and have no permission-rationale strings configured anywhere — they're arriving silently through autolinked modules (most plausibly `expo-image-picker`/`expo-camera`'s Android manifests, which request broader media/camera capabilities than this app's UI exposes, e.g. video+audio capture support neither the barcode scanner nor the food-photo picker uses).

**Intent filters for the `plated` scheme:** present and correctly wired. On `.MainActivity` (`launchMode: singleTask`, `exported: true`):

```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW"/>
  <category android:name="android.intent.category.DEFAULT"/>
  <category android:name="android.intent.category.BROWSABLE"/>
  <data android:scheme="plated"/>
  <data android:scheme="exp+plated-v2"/>
</intent-filter>
```

This correctly covers `plated://whoop-callback` for the WHOOP OAuth redirect. `singleTask` launch mode is appropriate for this so the redirect doesn't spawn a second Activity instance.

**Other notable items in the introspected output, unrelated to what was asked but worth flagging:**
- `ios.bundleIdentifier` is the Expo-generated placeholder `com.placeholder.appid` — harmless while iOS is paused, but worth remembering to set before ever building iOS.
- `androidStatusBar.backgroundColor` / `colorPrimaryDark` are both `#ffffff` while `colorPrimary` is a dark blue — looks like an unintentional light/dark inversion given `userInterfaceStyle: "dark"`, but cosmetic, not a build blocker.
- Running `expo config --type introspect` printed a stderr warning: `» android: userInterfaceStyle: Install expo-system-ui in your project to enable this feature.` — `userInterfaceStyle: "dark"` in app.json is currently a **no-op** on Android without `expo-system-ui` installed.
- `expo.modules.updates.ENABLED` is `false` in the manifest meta-data, consistent with `expo-updates` not being installed (§5) — no OTA update path exists yet, which is fine for a first store build but means any post-submission fix requires a new build, not a JS-bundle push.

---

## 5. package.json

**dependencies**
```
@expo-google-fonts/hanken-grotesk ^0.4.3
@expo-google-fonts/jetbrains-mono ^0.4.1
@react-native-async-storage/async-storage 2.2.0
@react-native-community/datetimepicker 8.4.4
@react-navigation/bottom-tabs ^7.16.2
@react-navigation/native ^7.2.5
@react-navigation/native-stack ^7.16.0
@sentry/react-native ~7.2.0
@supabase/supabase-js ^2.108.0
expo ~54.0.0
expo-camera ~17.0.10
expo-dev-client ~6.0.21
expo-file-system ~19.0.23
expo-font ~14.0.12
expo-image-manipulator ~14.0.8
expo-image-picker ~17.0.11
expo-linking ~8.0.12
expo-sharing ~14.0.8
expo-status-bar ~3.0.9
expo-web-browser ~15.0.11
react 19.1.0
react-native 0.81.5
react-native-safe-area-context ~5.6.0
react-native-screens ~4.16.0
react-native-svg ^15.15.5
react-native-url-polyfill ^2.0.0
zustand ^4.5.7
```

**devDependencies**
```
@babel/core ^7.25.0
@babel/plugin-transform-class-properties ^7.25.0
@babel/plugin-transform-private-methods ^7.25.0
@types/react ~19.1.0
babel-preset-expo ~54.0.10
patch-package ^8.0.1
supabase ^2.109.1
typescript ^5.3.0
vitest ^4.1.10
```

**Reading**

- `expo-dev-client`: **present** — expected, this has been a dev-client-only project to date. Note this stays in `dependencies` for a store build too (it's fine to ship — it's inert unless a dev menu is explicitly invoked — but confirm that's the intended posture for a Play submission rather than something to strip).
- `expo-updates`: **absent.**
- `expo-build-properties`: **absent** — consistent with §4's finding of no pinned SDK levels.
- `expo-constants`: **absent as a direct dependency** — it's present transitively (pulled in by `expo` and `expo-linking`), which is exactly what `expo-doctor` flags as a duplicate-dependency problem (§9).

---

## 6. Environment variables and secrets

### Hosted EAS environments (`eas env:list`)

All three environments — `production`, `development`, `preview` — report the **same three variable names**:

```
EXPO_PUBLIC_SUPABASE_ANON_KEY   — sensitive
EXPO_PUBLIC_SUPABASE_URL        — sensitive
SENTRY_AUTH_TOKEN               — secret (build-worker only, unreadable via CLI/UI)
```

No values were retrieved (redacted per instructions; `--include-sensitive` was not passed and `env:pull` was not run). **I cannot tell you from this alone whether the "production" environment's Supabase URL/key actually point at a different Supabase project than "development"/"preview", or whether all three environments were seeded with the same dev credentials.** Given the variable names are identical across all three environments and nothing here differentiates them, this needs a manual check on your end (e.g. compare project refs in the Supabase dashboard against what each environment is set to) before treating this as separated dev/prod data.

### Local `.env` files

Only one exists: **`.env`** (root). It defines:

```
EXPO_PUBLIC_SUPABASE_URL=<redacted>
EXPO_PUBLIC_SUPABASE_ANON_KEY=<redacted>
```

Both variable names match the hosted "development"/"preview"/"production" variable names exactly — same names, unknown (from this audit) whether same values.

`.env` is git-ignored (`git check-ignore -v` confirms: `.gitignore:7:.env → .env`) and is **not tracked** in git (`git ls-files -- .env` returned nothing). Good hygiene, no leak.

### `.gitignore` env-related lines

```
7:  .env
8:  .env.local
```

### `.easignore`

**Does not exist.** No file present at the repo root.

**Reading:** because `.env` is listed in `.gitignore` and there is no `.easignore` overriding that, `.env` is **not uploaded to EAS Build** when the project archive is created (EAS Build respects `.gitignore` when no `.easignore` is present). This is consistent with expectations — the two local `EXPO_PUBLIC_SUPABASE_*` values in `.env` are for local `expo start` only, and any cloud build must get these from the hosted EAS environment instead (§2's `environment` field discussion is the load-bearing mechanism here).

---

## 7. Runtime config consumption

Grep across all `.ts`/`.tsx` (excluding `node_modules`) for `process.env`, `Constants.expoConfig`, `Constants.manifest`, and `expo-constants` imports:

| Variable | File(s) : line(s) | `EXPO_PUBLIC_` prefixed | Fallback if absent? |
|---|---|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | `src/lib/supabase.ts:4` | yes | **No** — `process.env.EXPO_PUBLIC_SUPABASE_URL!` (non-null assertion). Undefined at runtime → passed as `undefined` to `createClient`. |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | `src/lib/supabase.ts:5` | yes | **No** — same `!` assertion pattern. |
| `EXPO_PUBLIC_SENTRY_ENV` | `instrument.ts:7` | yes | **Yes** — `process.env.EXPO_PUBLIC_SENTRY_ENV ?? "development"`. Falls back safely. |
| `FDC_API_KEY` | `scripts/seedCoreIngredients.ts:110` | no | Not app runtime — a standalone Node seeding script, not bundled into the app. Irrelevant to the AAB. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | `scripts/seedIngredients/db.ts:16-17` | no | Same — standalone seeding script, not app runtime, not `EXPO_PUBLIC_`-prefixed so it wouldn't be inlined into the client bundle even if it were imported (it isn't). |
| `TZ` | `src/lib/__tests__/*.test.ts` (multiple) | no | Test-only, Vitest process, not shipped. |

No `Constants.expoConfig`, `Constants.manifest`, or direct `expo-constants` imports exist anywhere in the source tree — this app does not read anything through Expo's Constants API at runtime.

**How the Supabase URL/anon key reach the client:** exclusively via `process.env.EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY`, inlined at **build time** by Expo's Metro/env-var substitution (this is why they need `EXPO_PUBLIC_` — anything without that prefix is stripped from client bundles by design). There is no runtime fetch, no `Constants.expoConfig.extra` indirection, nothing dynamic — whatever value is present in the environment at the moment `npx expo` / the EAS builder invokes the bundler is baked into the JS bundle permanently for that build. **This is the single point of failure for the whole app if the production build doesn't have these two vars available** (see BLOCKERS).

Nothing else the app needs at runtime is read via `process.env` or Constants — WHOOP client ID, per CLAUDE.md, is meant to live as an EAS *build* env var (not `EXPO_PUBLIC_`) plus a Supabase secret for the server side; it does not show up in this grep, meaning either it's not yet wired into client code (expected — WHOOP client ID belongs server-side per your own CLAUDE.md invariant) or it's read some other way not covered by these four search patterns. Worth a quick manual check if WHOOP OAuth is part of what you're testing in this internal track.

---

## 8. Build history (`eas build:list --platform android --limit 10`)

| Profile | Distribution | Type | Status | Version | VersionCode | Commit | Finished |
|---|---|---|---|---|---|---|---|
| preview | internal | apk | finished | 1.0.0 | 3 | `4e777f8` | 2026-08-19 15:48 |
| development | internal | apk | finished | 1.0.0 | 3 | `92a5f90` | 2026-08-19 12:00 |
| preview | internal | apk | finished | 1.0.0 | 3 | `92a5f90` | 2026-08-19 12:03 |
| **production-apk** | internal | apk | finished | 1.0.0 | 3 | `5c0daa4` | 2026-08-18 16:57 |
| **production** | **store** | **aab** | finished | 1.0.0 | **2** | `36fc38e` | 2026-08-18 16:39 |
| preview | internal | apk | finished | 1.0.0 | 1 | `b341c3c` | 2026-08-18 15:39 |
| preview | internal | apk | finished | 1.0.0 | 1 | `0a009cf` | 2026-08-18 10:03 |
| preview | internal | apk | finished | 1.0.0 | 1 | `b455309` | 2026-08-15 12:07 |
| preview | internal | apk | finished | 1.0.0 | 1 | `b2a9b7a` | 2026-08-14 19:34 |
| preview | internal | apk | finished | 1.0.0 | 1 | `13703ae` | 2026-08-12 11:07 |

**This directly contradicts one premise of the ask:** a store-distribution AAB **has** already been built once — build `e3acf2d7…`, profile `production`, distribution `store`, versionCode 2, from commit `36fc38e`, finished 2026-08-18 16:39. It is not "every build to date has been a dev client build" — most have been `preview`/`development` internal APKs, but one real store AAB exists from three days ago, from an older commit than current HEAD (`4e777f8`). Worth checking whether that AAB was ever actually uploaded to Play Console, since if it wasn't, the "first" framing is still substantively true for Play's purposes even though EAS has already produced (and incremented the version counter for) a store artifact.

**Version counter implication:** the remote versionCode counter (per `cli.appVersionSource: remote`) currently sits at **3** — bumped from 2→3 by the `production-apk` build on 2026-08-18 (it extends `production`, inherits `autoIncrement: true`, and does not override it). The next `production`-profile build will produce **versionCode 4**. If you'd already uploaded versionCode-2 or -3 artifacts to Play under a different track, make sure 4 doesn't collide with anything already there — Play requires monotonically increasing versionCodes across all tracks, gaps are fine, duplicates are rejected.

---

## 9. `npx expo-doctor`

**Full output**

```
env: load .env
env: export EXPO_PUBLIC_SUPABASE_ANON_KEY EXPO_PUBLIC_SUPABASE_URL
Running 18 checks on your project...
16/18 checks passed. 2 checks failed.

✖ Check that no duplicate dependencies are installed
Found duplicates for expo-constants:
  ├─ expo-constants@18.0.13 (at: node_modules\expo\node_modules\expo-constants)
  └─ expo-constants@18.0.13 (at: node_modules\expo-linking\node_modules\expo-constants)
Advice: node_modules may be corrupted for this package — same version, two copies. Delete
node_modules and reinstall.

✖ Check that packages match versions required by installed Expo SDK
⚠️ Minor version mismatches
  react-native-svg    expected 15.12.1   found 15.15.5
🔧 Patch version mismatches
  expo                expected ~54.0.37  found 54.0.35
  expo-file-system    expected ~19.0.24  found 19.0.23
3 packages out of date. Run `npx expo install --check`.
```

**Reading:** the duplicate-dependency failure is same-version-two-copies (both `18.0.13`), which `expo-doctor` itself describes as likely `node_modules` corruption rather than a real version conflict — low risk, but cheap to fix (`rm -rf node_modules && npm install`) before a build you care about. The version-mismatch failure is minor/patch-level drift, `expo` itself is two patch versions behind what SDK 54's current baseline expects — again low risk but worth `npx expo install --check` before the AAB build, since EAS cloud builds use whatever is in your lockfile, not the latest compatible versions.

---

## 10. Signing

- `credentials.json`: **does not exist** in the repo (glob returned no matches).
- Keystore files: **one found** — `@fraserr1188__plated-v2.jks` at the repo root.
- Gitignore coverage: `.gitignore` line 17 is `*.jks`, which matches it (`git check-ignore -v` confirms: `.gitignore:17:*.jks → @fraserr1188__plated-v2.jks`). `.gitignore` line 18 is `*.keystore` (no matching files present).
- `git ls-files` for this filename returns nothing — **the keystore is not tracked in git.** No finding to flag here; this is the correct, safe state (EAS-managed credentials, keystore present locally/synced but not committed).

Per your constraint, `eas credentials` was **not** run, so I cannot confirm what EAS's server-side credential store thinks the current Android keystore/key alias is, whether it matches this local `.jks`, or whether Play App Signing is enabled. That's an explicit gap in this audit, not an oversight — you'll need to check that interactively yourself when ready.

---

## BLOCKERS

Ranked roughly by how likely each is to actually bite on the next `production` build:

1. **No app icon or splash screen configured in app.json.** `assets/icon.png`, `adaptive-icon.png`, `splash-icon.png` exist on disk but are not referenced anywhere in app.json — no `icon`, `android.adaptiveIcon`, or `splash` keys exist. The AAB will build and install with Expo's stock default icon/splash. This won't cause a Play *rejection* by itself, but it will visibly ship your first internal-testing build (and potentially your first real listing) with a placeholder icon — fix before this matters to anyone outside your own device.

2. **`environment` key absent from every `eas.json` build profile, including `production`.** Per current Expo docs, EAS infers the hosted environment from `distribution`/`developmentClient` when this key is missing, and by that logic `production` *should* correctly resolve to the "production" hosted environment (§2 table) — but this inference behavior is undocumented for eas-cli 20.5.1 specifically, which is two majors behind current. If the inference doesn't fire the way current docs describe, `EXPO_PUBLIC_SUPABASE_URL`/`EXPO_PUBLIC_SUPABASE_ANON_KEY` will be **undefined** in the build (there's no local `.env` fallback in cloud builds — it's git-ignored and there's no `.easignore` to override that), and `src/lib/supabase.ts:4-5`'s non-null assertions (`process.env.EXPO_PUBLIC_SUPABASE_URL!`) mean the app will construct a Supabase client with `undefined` URL/key and fail at startup — install-and-crash, not a build failure, so this wouldn't be caught until you actually open the app. **Recommend explicitly setting `"environment": "production"` on the `production` profile before building** — it costs nothing and removes the ambiguity entirely, rather than relying on inferred defaults for the build that matters most.

3. **Unverified whether "production" and "development"/"preview" hosted env vars actually point at different Supabase projects.** All three EAS environments define identically-named variables (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`); values are redacted from this audit by design. If "production" was seeded with the same dev-project credentials as the others (e.g. copy-pasted during setup), your first Play-track build would silently write real tester data into your dev Supabase project. Worth a manual diff before shipping.

4. **eas-cli is 20.5.1 against a current 22.2.0** — two majors of build-profile/environment-variable behavior changes sit between what this audit could confirm from docs and what your CLI actually does. Given blocker #2 hinges partly on exactly this, upgrading (`npm install -g eas-cli`) before the production build is cheap insurance.

## OBSERVATIONS

- **A store-distribution AAB has already been built once** (`e3acf2d7…`, versionCode 2, commit `36fc38e`, 2026-08-18) — contradicts "every build to date has been a dev client build." Worth checking whether it was ever uploaded to Play Console; if not, your "first" framing still holds for Play's purposes.
- **Remote versionCode counter is currently 3**, bumped by the `production-apk` profile (which inherits `autoIncrement: true` from `production` without overriding it) rather than by any real production build. The next `production` build will be versionCode 4. Not a problem, just a heads-up so 4 isn't a surprise.
- **`production-apk` resolves to the "preview" hosted environment, not "production"**, because it overrides `distribution` to `internal` (see §2 table). If you use this profile to sanity-check what you're about to ship, be aware it's exercising different env vars than the real `production` profile will.
- **Undeclared, unexplained Android permissions**: `RECORD_AUDIO`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`, `SYSTEM_ALERT_WINDOW`, `VIBRATE` all appear in the resolved manifest despite app.json declaring only `CAMERA`. These arrive transitively from autolinked native modules and have no permission-rationale strings configured. Play's Data Safety / permissions review can flag apps requesting broad storage/audio access with no visible feature using it — worth auditing whether `expo-image-picker`/`expo-camera` need trimming down (e.g. `microphone: false` option on `expo-camera` if video-with-audio capture isn't a feature) before a real listing, even though it won't block internal testing.
- **`userInterfaceStyle: "dark"` is currently a no-op on Android** — `expo config --type introspect` warns `expo-system-ui` isn't installed, which is required for this setting to take effect. Given the app is dark-mode-only per its design language, this is probably worth fixing regardless of the Play submission.
- **`expo-doctor` reports two failing checks**: a same-version duplicate `expo-constants` (likely `node_modules` corruption — cheap reinstall fixes it) and three packages patch/minor behind SDK 54's expected baseline (`expo`, `expo-file-system`, `react-native-svg`). Neither is a hard blocker but both are one command away from clean (`npx expo install --check`, and reinstalling `node_modules`).
- **No `expo-build-properties` plugin** — no explicit `targetSdkVersion`/`compileSdkVersion`/`minSdkVersion` anywhere in the repo. Not inherently wrong (SDK 54's default template should already satisfy current Play target-API requirements), but it means this repo carries no record of what SDK level ships — only the build logs know.
- **`ios.bundleIdentifier` is still the Expo placeholder** `com.placeholder.appid` — irrelevant while iOS is paused, but a landmine for future-you if an iOS build is ever kicked off before this is set.
- **Distribution default for the `production` profile ("store") could not be confirmed with an exact quotable doc line** — treated as high-confidence from general EAS convention, but genuinely worth eyeballing the build summary line EAS prints ("Distribution: store") at the very start of your first production build, before it runs 15 minutes and you find out otherwise.
