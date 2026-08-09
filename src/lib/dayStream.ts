// ============================================================
// src/lib/dayStream.ts — chronological assembly for the Today rail
//
// Replaces the four-section (Breakfast/Lunch/Dinner/Snacks) rail with a
// single time-ordered pass over a day's rows, with a lightweight header
// inserted whenever the row crosses into a new time-of-day BAND.
//
// Bands are a DISPLAY constant, not data — never written to meal_entries,
// never compared against meal_type. bandForLocalHour is strictly increasing
// in local hour (0–23), which is what guarantees a time-sorted day never
// prints the same band header twice: once the walk moves past a band it can
// never re-enter it, because the input is monotonic and so is the mapping.
// ============================================================

import { MealEntry, Workout } from "../types";

export type Band = "overnight" | "morning" | "midday" | "evening" | "night";

export const BAND_LABELS: Record<Band, string> = {
  overnight: "Overnight",
  morning: "Morning",
  midday: "Midday",
  evening: "Evening",
  night: "Night",
};

/**
 * Overnight 00:00–04:59 · Morning 05:00–10:59 · Midday 11:00–16:59 ·
 * Evening 17:00–21:59 · Night 22:00–23:59.
 *
 * Tunable display boundary — moving these never touches any stored data.
 */
export function bandForLocalHour(hour: number): Band {
  if (hour <= 4) return "overnight";
  if (hour <= 10) return "morning";
  if (hour <= 16) return "midday";
  if (hour <= 21) return "evening";
  return "night";
}

/**
 * Commit 1 emits only 'band' and 'food' — workouts is always `[]`. The
 * 'workout' variant exists now so commit 2 (surfacing WHOOP workouts inline)
 * is additive to this union, not a signature change.
 */
export type StreamItem =
  | { kind: "band"; band: Band; key: string }
  | { kind: "food"; entry: MealEntry; key: string }
  | { kind: "workout"; workout: Workout; key: string };

/**
 * Merge entries (and, from commit 2, workouts) into one time-ordered stream,
 * inserting a band header wherever the band changes from the previous row.
 *
 * `entries` is expected already sorted by eaten_at (getEntriesForDate's
 * contract) — this re-sorts anyway so the function is correct on its own
 * terms, not merely because of what its caller happens to guarantee.
 */
export function buildDayStream(
  entries: MealEntry[],
  workouts: Workout[] = [],
): StreamItem[] {
  const rows: { at: string; item: StreamItem }[] = [
    ...entries.map((entry) => ({
      at: entry.eaten_at,
      item: { kind: "food" as const, entry, key: `food-${entry.id}` },
    })),
    ...workouts.map((workout) => ({
      at: workout.workoutStart,
      item: {
        kind: "workout" as const,
        workout,
        key: `workout-${workout.id}`,
      },
    })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  const stream: StreamItem[] = [];
  let lastBand: Band | null = null;

  for (const row of rows) {
    const band = bandForLocalHour(new Date(row.at).getHours());
    if (band !== lastBand) {
      stream.push({ kind: "band", band, key: `band-${band}` });
      lastBand = band;
    }
    stream.push(row.item);
  }

  return stream;
}
