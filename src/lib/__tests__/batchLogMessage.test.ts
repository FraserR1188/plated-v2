// ============================================================
// PL-020 — the batch log alert must name the day it actually logged to.
//
// The eat-time sheet lets you pick any day. The old alert branched on
// willBePlanned alone, so every non-future pick — yesterday, last Tuesday —
// was reported as "added to today's log".
// ============================================================

import { describe, it, expect } from "vitest";
import { batchLogAlert } from "../batchLogMessage";

// A fixed "now" in BST, mid-afternoon, so nothing here depends on when the
// suite runs. 2026-09-17 is a Thursday.
const NOW = new Date("2026-09-17T14:00:00+01:00");

const at = (iso: string) => new Date(iso);

describe("batchLogAlert", () => {
  it("says today's log for a time earlier today", () => {
    expect(batchLogAlert("Chilli", at("2026-09-17T08:30:00+01:00"), NOW)).toEqual({
      title: "Logged",
      body: "Chilli added to today's log.",
    });
  });

  it("names yesterday rather than claiming today", () => {
    expect(batchLogAlert("Chilli", at("2026-09-16T19:00:00+01:00"), NOW)).toEqual({
      title: "Logged",
      body: "Chilli added to yesterday's log.",
    });
  });

  // "Sept", not "Sep": that is what Intl's en-GB short month gives for
  // September, and formatDayLabel is the existing shared formatter.
  it("names the date for an older day", () => {
    expect(batchLogAlert("Chilli", at("2026-09-12T13:00:00+01:00"), NOW)).toEqual({
      title: "Logged",
      body: "Chilli added to the log for Sat 12 Sept.",
    });
  });

  // The 30-minute planning grace (PLANNING_GRACE_MINUTES) is the DB
  // trigger's rule, and this preview has to agree with it or the alert
  // contradicts what was stored.
  it("still counts as logged inside the planning grace", () => {
    expect(
      batchLogAlert("Chilli", at("2026-09-17T14:20:00+01:00"), NOW).title,
    ).toBe("Logged");
  });

  it("reports a genuinely future time as planned, with its time and day", () => {
    expect(batchLogAlert("Chilli", at("2026-09-18T19:00:00+01:00"), NOW)).toEqual({
      title: "Planned",
      body: "Chilli planned for 19:00, tomorrow.",
    });
  });

  it("reports a plan later the same day as planned, not logged", () => {
    expect(batchLogAlert("Chilli", at("2026-09-17T19:00:00+01:00"), NOW)).toEqual({
      title: "Planned",
      body: "Chilli planned for 19:00, today.",
    });
  });

  // A batch logged just after midnight belongs to the day it was eaten,
  // which is the case dateKey() exists for — a UTC date would call this
  // 2026-09-17 and report the wrong day under BST.
  it("uses the local day, not UTC, just after midnight in BST", () => {
    const justAfterMidnight = new Date("2026-09-18T00:15:00+01:00");
    const nowThen = new Date("2026-09-18T00:30:00+01:00");
    expect(batchLogAlert("Chilli", justAfterMidnight, nowThen).body).toBe(
      "Chilli added to today's log.",
    );
  });
});
