// ============================================================
// PL-023 / PL-024 — how the Daily goals card behaves when the store does
// not know the user's targets, and when what's typed doesn't parse.
//
// Source text rather than a render: SettingsScreen needs a React Native
// runtime this project's Vitest setup deliberately doesn't provide (see
// vitest.setup.ts and the same note in insightsStub.test.ts). Every claim
// here is about what the file says — the *behaviour* behind these strings
// is covered by useStore.test.ts and goalInput.test.ts, which are real.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const source = fs
  .readFileSync(
    path.resolve(process.cwd(), "src/screens/SettingsScreen.tsx"),
    "utf8",
  )
  .replace(/\r\n/g, "\n");

const flattened = source.replace(/\s+/g, " ");

/** Source with comments removed. The assertions below look for the SHAPE of
 *  the old bug, and the comments explaining that bug contain it verbatim —
 *  matching them would be a test that can only pass by forgetting why. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/** The JSX guarded by `{<cond> && (` … up to the matching `)}` at the same
 *  indent. Enough to assert which copy sits under which condition. */
function blockGuardedBy(condition: string): string {
  const needle = `{${condition} && (`;
  const start = source.indexOf(needle);
  if (start === -1) return "";
  const end = source.indexOf("\n            )}", start);
  return source.slice(start, end === -1 ? undefined : end);
}

describe("the Daily goals load states", () => {
  it("shows the LOADING copy while the read is in flight", () => {
    expect(flattened).toContain("Loading your targets…");
  });

  it("shows the FAILURE copy and a Retry", () => {
    expect(flattened).toContain("Couldn't load your targets");
    expect(flattened).toContain(">Retry<");
  });

  // The point of the split. 'loading' is momentary and self-resolving, so
  // claiming it failed would be untrue, and offering a Retry would invite
  // a second read of something already in flight.
  it("the loading copy is gated on 'loading' ALONE — no Retry under it", () => {
    const block = blockGuardedBy('goalsState === "loading"');
    expect(block).toContain("Loading your targets…");
    expect(block).not.toContain("Couldn't load your targets");
    expect(block).not.toContain("Retry");
  });

  it("the failure copy and Retry are gated on 'error' ALONE", () => {
    const block = blockGuardedBy('goalsState === "error"');
    expect(block).toContain("Couldn't load your targets");
    expect(block).toContain("Retry");
    expect(block).not.toContain("Loading your targets");
  });

  it("neither block is gated on the old catch-all !goalsWritable", () => {
    // The first cut showed "Couldn't load your targets" in BOTH states.
    expect(code).not.toContain("{!goalsWritable && (");
  });
});

describe("the Daily goals write gate", () => {
  it("PL-024: no parseInt-or-default anywhere in the save path", () => {
    // The exact shape of the bug: `parseInt(values.x) || 2000` substituted
    // a default for a cleared field, a typo, and an explicit 0.
    expect(code).not.toMatch(/parseInt\([^)]*\)\s*\|\|/);
    expect(code).not.toMatch(/parseFloat\([^)]*\)\s*\|\|/);
  });

  it("PL-024: the save path takes the strictly parsed goals, nothing else", () => {
    expect(flattened).toContain("saveGoals(parsedGoals.goals)");
  });

  it("Save is disabled unless the store is writable AND the input parses", () => {
    expect(flattened).toContain(
      "const canSaveGoals = goalsWritable && goalsValid;",
    );
    expect(flattened).toContain("disabled={saving || !canSaveGoals}");
  });

  it("per-field errors are rendered, not swallowed", () => {
    expect(flattened).toContain("{fieldErrors[field.key]}");
  });
});
