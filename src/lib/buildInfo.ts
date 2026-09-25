// ============================================================
// src/lib/buildInfo.ts — what About shows about the running build (PL-043)
//
// RED-COMMIT STUB: a naive formatter that interpolates the raw values, so the
// tests in __tests__/buildInfo.test.ts fail on behaviour rather than on a
// missing module. Nothing imports it yet. The next commit replaces the body.
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

export function formatBuildInfo(input: BuildInfoInput): BuildInfo {
  const lines = [
    `Build ${input.buildNumber}`,
    `Runtime ${input.runtimeVersion}`,
    `Channel ${input.channel}`,
    `Update ${input.updateId}`,
  ];
  return { lines, copyText: lines.join(" · ") };
}
