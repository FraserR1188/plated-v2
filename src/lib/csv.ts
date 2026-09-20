import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { MealEntry } from "../types";
import { dateKey } from "./time";

function cell(v: string | number): string {
  const s = String(v);
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

/**
 * PL-008. A stored NULL on the small four means "we never knew this" —
 * it is not a measurement of zero.
 *
 * The old export wrote `(e.sat_fat ?? 0).toFixed(1)`, which turned every
 * unknown into a confident 0.0 the moment it left the app. That is the same
 * fabrication PL-002 fixed in `saved_ingredients`, arriving at the user's
 * analysis by a different route — and worse here, because a spreadsheet has
 * no way to tell the invented zeros from the real ones.
 *
 * An empty cell is the honest answer: every spreadsheet, R and pandas reads
 * it as missing, and `AVERAGE()` skips it rather than dragging the mean down.
 */
function optionalCell(v: number | null | undefined, places: number): string {
  return v == null ? "" : v.toFixed(places);
}

/** Unchanged, and deliberately so: people have spreadsheets keyed on these
 *  columns. PL-007/PL-008 fix what is IN the cells, not which cells exist. */
export const CSV_HEADER =
  "date,eaten_time,logged_time,meal_type,ingredient,brand,serving_g," +
  "calories,protein_g,carbs_g,fat_g,sat_fat_g,salt_g,fibre_g,sugar_g,source";

/**
 * The export as a string. Split out from `exportCSV` so the part with the
 * rules in it can be tested without a filesystem or a share sheet.
 */
export function buildCsv(entries: MealEntry[]): string {
  const sorted = [...entries].sort(
    (a, b) => new Date(a.logged_at).getTime() - new Date(b.logged_at).getTime(),
  );

  const rows = sorted.map((e) => {
    const logged = new Date(e.logged_at);
    const eaten = e.eaten_at ? new Date(e.eaten_at) : logged;
    // PL-007: the LOCAL calendar day, via the one dateKey(). The old
    // `toISOString().slice(0, 10)` is UTC, so in BST every meal eaten
    // between midnight and 01:00 was exported under the previous day —
    // disagreeing with `e.date`, with Today, and with the WHOOP cycle it
    // actually belonged to.
    const date = dateKey(eaten);
    const eatenTime = eaten.toTimeString().slice(0, 5);
    const loggedTime = logged.toTimeString().slice(0, 5);
    return [
      cell(date),
      cell(eatenTime),
      cell(loggedTime),
      cell(e.meal_type),
      cell(e.name),
      cell(e.brand ?? ""),
      cell(e.serving_g != null ? e.serving_g.toFixed(1) : ""),
      cell(Math.round(e.calories)),
      cell(e.protein.toFixed(1)),
      cell(e.carbs.toFixed(1)),
      cell(e.fat.toFixed(1)),
      cell(optionalCell(e.sat_fat, 1)),
      cell(optionalCell(e.salt, 2)),
      cell(optionalCell(e.fibre, 1)),
      cell(optionalCell(e.sugar, 1)),
      cell(e.source),
    ].join(",");
  });

  return [CSV_HEADER, ...rows].join("\n");
}

export async function exportCSV(entries: MealEntry[]): Promise<void> {
  const csv = buildCsv(entries);
  // PL-007: local day here too — a file exported at 00:30 BST was named
  // for yesterday.
  const filename = `plated_${dateKey()}.csv`;
  const path = FileSystem.documentDirectory + filename;

  await FileSystem.writeAsStringAsync(path, csv, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) throw new Error("Sharing not available on this device");

  await Sharing.shareAsync(path, {
    mimeType: "text/csv",
    dialogTitle: "Export plated. data",
  });
}

export function filterByDateRange(
  entries: MealEntry[],
  from: string,
  to: string,
): MealEntry[] {
  return entries.filter((e) => e.date >= from && e.date <= to);
}

/** Inclusive of both ends, so the window is this many LOCAL calendar days. */
const WINDOW_DAYS = 30;

/**
 * PL-007. Two bugs lived in the two lines this replaces.
 *
 * 1. The bounds were UTC (`toISOString().slice(0, 10)`) while `e.date` is a
 *    LOCAL dateKey, so the comparison was between two different calendars.
 *    Exporting at 00:30 BST gave `to` = yesterday and silently dropped
 *    everything already logged today.
 *
 * 2. The start was `Date.now() - 30 * 864e5` — fixed milliseconds. That is
 *    not calendar arithmetic: crossing the night the clocks go back adds an
 *    hour, landing on the previous calendar day and quietly making the
 *    window 31 days. `setDate()` works on local calendar fields and has no
 *    such edge.
 *
 * Separately, the old range spanned `now - 30` to `now` INCLUSIVE, which is
 * 31 days, not 30. Now it is exactly WINDOW_DAYS local days ending today.
 */
export function last30Days(
  entries: MealEntry[],
  now: Date = new Date(),
): MealEntry[] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - (WINDOW_DAYS - 1));
  return filterByDateRange(entries, dateKey(start), dateKey(now));
}
