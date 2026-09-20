// ============================================================
// src/lib/whoopScores.ts — the three WHOOP day scores for one local date.
//
// READS `biometric_periods_resolved`, keyed on `local_date`.
//
// Never `is_current` (PL-019: it is not unique per user — one production
// account has two rows returning true, because whoop-sync never closes a
// cycle WHOOP has dropped — and it is not a date).
//
// Never `biometric_periods.local_date` either: that view dates a cycle by
// when the user fell asleep, so a late night pushes the whole day onto the
// wrong date. `biometric_periods_resolved` is wake-anchored, which measured
// clean on live data (0 duplicate dates across all three WHOOP users,
// against 1/1/2 under the onset-anchored mapping).
// ============================================================

import { supabase } from "./supabase";
import { reportError } from "./reportError";
import { dateKey } from "./time";

export type WhoopScores = {
  /** 0-100, integer. null whenever the score is not a fact. */
  recovery: number | null;
  /** 0-100, integer. */
  sleep: number | null;
  /** 0-21, one decimal place. */
  strain: number | null;
  /**
   * The timestamp behind the strain caption ("as of 14:05"): when WHOOP
   * last CALCULATED this day's strain, not when plated last pulled it.
   * Decision, 2026-09-20 — WHOOP's own calculation time is the honest "as
   * of" for a score; our pull time says nothing about the number's
   * freshness. This supersedes the earlier "strain shows last-synced time"
   * default, and `whoop_connections.last_sync_at` is not used for it.
   *
   * Reads `strain_updated_at` (PR 6), which is the CYCLE's own
   * `whoop_updated_at` — strain lives on the cycle. Deliberately NOT
   * `source_updated_at`, which is `greatest(cycle, recovery, sleep)`: a
   * whole-FRAME signal that would show the sleep scoring time under a
   * strain number. The two coincide on all current production data (116
   * rows, zero divergence), so this is right by construction rather than
   * by WHOOP's current behaviour, which nothing enforces.
   *
   * NULL for a Health-Connect-sourced period: that arm of the view selects
   * `null::timestamptz`, because there is no cycle and so no strain
   * calculation.
   */
  asOf: string | null;
};

export const NO_SCORES: WhoopScores = {
  recovery: null,
  sleep: null,
  strain: null,
  asOf: null,
};

/**
 * WHOOP scores a cycle asynchronously. Until it has, the row exists with
 * the value column NULL and a state saying why — and a value is only a
 * fact when the state says `SCORED`.
 *
 * `PENDING_SCORE` and `UNSCORABLE` are WHOOP's other documented states;
 * production currently holds only `SCORED` and NULL. An UNRECOGNISED state
 * is treated as not-a-score too, deliberately: a new state WHOOP invents
 * should show "–" rather than whatever happens to be in the column.
 */
function scored(value: unknown, state: unknown): number | null {
  if (state !== "SCORED") return null;
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The scores for one local calendar day, or all-nulls.
 *
 * Returns nulls rather than throwing for every "we don't know" case, so the
 * panel has exactly one thing to render for all of them: no row, an undated
 * row, a pending score, an unscorable cycle, a future date, or a failed
 * read. The column stays put in every one of those, which is the point —
 * the ring must not move between pages.
 */
export async function getWhoopScoresForDate(
  date: string,
  now: Date = new Date(),
): Promise<WhoopScores> {
  // A future date cannot have been lived yet, so there is nothing to ask
  // for. Short-circuited before the query rather than after, because a
  // planned day is an ordinary thing to swipe to and it should not cost a
  // round trip to learn that WHOOP has no opinion about tomorrow.
  if (date > dateKey(now)) return NO_SCORES;

  let rows: Record<string, unknown>[];
  try {
    const { data, error } = await supabase
      .from("biometric_periods_resolved")
      .select(
        "local_date, recovery_score, recovery_score_state, " +
          "sleep_performance, sleep_score_state, " +
          "strain, strain_score_state, strain_updated_at, period_start",
      )
      .eq("local_date", date)
      // PL-019: a user can hold more than one row for a date (a dropped
      // cycle that was never closed). Order so the winner is the same one
      // every render — an unstable pick would make the panel flicker
      // between two values with no input from the user.
      .order("period_start", { ascending: false })
      .limit(1);

    if (error) throw error;
    rows = (data as unknown as Record<string, unknown>[]) ?? [];
  } catch (e) {
    // One report, from the one place that owns this failure (PL-003 /
    // PL-014). The panel shows "–" and carries nothing stale forward.
    reportError("getWhoopScoresForDate", e, {
      fingerprint: ["whoop-scores-for-date"],
    });
    return NO_SCORES;
  }

  const row = rows[0];
  if (!row) return NO_SCORES;

  // An undated row is not placed on any day. `local_date` is derived from
  // the cycle's wake time and its timezone offset, and a cycle missing
  // either has no local day — guessing one from period_start would put a
  // WHOOP frame on a date WHOOP never assigned it.
  if (row.local_date == null) return NO_SCORES;

  const recovery = scored(row.recovery_score, row.recovery_score_state);
  const sleep = scored(row.sleep_performance, row.sleep_score_state);
  const strain = scored(row.strain, row.strain_score_state);

  return {
    recovery: recovery == null ? null : Math.round(recovery),
    sleep: sleep == null ? null : Math.round(sleep),
    // One decimal place, per the design. Rounded here rather than at the
    // call site so every consumer gets the same number.
    strain: strain == null ? null : Math.round(strain * 10) / 10,
    // Only meaningful alongside a strain value: a caption reading "as of
    // 14:05" under a "–" says the dash is fresh, which is nonsense.
    asOf: strain == null ? null : ((row.strain_updated_at as string) ?? null),
  };
}

/**
 * "as of 14:05" when the timestamp falls on the same local day as `now`,
 * "as of Fri 14:05" otherwise.
 *
 * Split out of the component so the branch is testable, and because the
 * same-day test is a LOCAL calendar comparison — the exact thing the
 * dateKey invariant exists for. Comparing the ISO strings, or the UTC
 * days, would read "Fri 23:30" as a different day from "Sat 00:30 BST"
 * that it is genuinely part of, and vice versa.
 */
export function formatStrainCaption(
  asOf: string | null,
  now: Date = new Date(),
): string | null {
  if (!asOf) return null;
  const at = new Date(asOf);
  if (Number.isNaN(at.getTime())) return null;

  const time = at.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (dateKey(at) === dateKey(now)) return `as of ${time}`;

  const day = at.toLocaleDateString("en-GB", { weekday: "short" });
  return `as of ${day} ${time}`;
}
