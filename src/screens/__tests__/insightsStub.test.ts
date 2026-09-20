// ============================================================
// The Insights stub's copy, pinned.
//
// Product-approved wording, and the screen it sits on is deliberately
// static — so the risk isn't a logic regression, it's someone "tidying"
// the strings or wiring a live counter into a screen that must not read
// the store until the readiness query exists.
//
// Source text rather than a render: the screen needs a React Native
// runtime this project's Vitest setup deliberately doesn't provide (see
// vitest.setup.ts), and every claim here is about what the file says.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const source = fs
  .readFileSync(
    path.resolve(process.cwd(), "src/screens/InsightsScreen.tsx"),
    "utf8",
  )
  .replace(/\r\n/g, "\n");

/** Collapse JSX line wrapping so a string split across lines still matches. */
const flattened = source.replace(/\s+/g, " ");

describe("the Insights stub", () => {
  it("leads with the Coming soon eyebrow", () => {
    expect(flattened).toContain(">Coming soon<");
  });

  it("says insights WILL unlock, and after how long", () => {
    expect(flattened).toContain(
      "Insights will unlock after 31 days of tracking",
    );
  });

  it("keeps the body line", () => {
    expect(flattened).toContain(
      "We need about a month of your meals to find patterns worth showing you.",
    );
  });

  // The whole point of the stub: it must not claim a count it cannot
  // source. No store, no queries, no day arithmetic.
  it("reads nothing — no store, no supabase, no date maths", () => {
    expect(source).not.toMatch(/useStore|supabase|dateKey|new Date\(/);
  });
});
