// ============================================================
// src/lib/buildInfo.ts — what About shows about the running build (PL-043)
//
// A tester filing a report needs to say what they're running. Until About
// showed it, no report could be tied to a build. The values come from
// expo-updates, which is already native in every build since v8; this
// function only formats them, so it's testable without the native module.
//
// WHAT'S SHOWN
//   Runtime   first 8 characters of the runtime version (the fingerprint).
//             This is what decides which OTAs a binary can take, and builds
//             sharing one run identical native code.
//   Channel   the EAS Update channel.
//   Update    first 8 characters of the running update's id, or "embedded"
//             when the app is running the JS bundled in the binary.
//             isEmbeddedLaunch decides, not a null id: a production binary's
//             bundled JS carries an id of its own, and showing it would make
//             the binary's JS look like an OTA.
//   Build     the native build number, ONLY when one is supplied. There is no
//             source for it in the current binary: expo-constants dropped
//             nativeBuildVersion (it points to expo-application, which isn't
//             native here), and adding it would move the fingerprint. The
//             argument is here so it slots in with the next native build.
//
// Missing values read "unknown", never "undefined" or "null". Nothing
// user-identifying: no user id, email or token is ever passed in.
// ============================================================

export interface BuildInfoInput {
  /** Updates.runtimeVersion. */
  runtimeVersion: string | null | undefined;
  /** Updates.channel. */
  channel: string | null | undefined;
  /** Updates.updateId. */
  updateId: string | null | undefined;
  /** Updates.isEmbeddedLaunch — running the JS bundled in the binary. */
  isEmbeddedLaunch: boolean;
  /** Native build number, when a source exists (none in the binary yet). */
  buildNumber?: string | null;
}

export interface BuildInfo {
  /** Lines shown under the version line. */
  lines: string[];
  /** One line to copy into a report: full values, nothing user-identifying. */
  copyText: string;
}

const SHORT = 8;
const UNKNOWN = "unknown";

const present = (v: string | null | undefined): v is string =>
  typeof v === "string" && v.trim().length > 0;

export function formatBuildInfo(input: BuildInfoInput): BuildInfo {
  const runtime = present(input.runtimeVersion) ? input.runtimeVersion : null;
  const channel = present(input.channel) ? input.channel : UNKNOWN;
  const update =
    input.isEmbeddedLaunch || !present(input.updateId) ? null : input.updateId;
  const build = present(input.buildNumber) ? input.buildNumber : null;

  const lines = [
    ...(build ? [`Build ${build}`] : []),
    `Runtime ${runtime ? runtime.slice(0, SHORT) : UNKNOWN} · ${channel}`,
    `Update ${update ? update.slice(0, SHORT) : "embedded"}`,
  ];

  const copyText = [
    ...(build ? [`build ${build}`] : []),
    `runtime ${runtime ?? UNKNOWN}`,
    `channel ${channel}`,
    `update ${update ?? "embedded"}`,
  ].join(" · ");

  return { lines, copyText };
}
