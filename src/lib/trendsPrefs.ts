// ============================================================
// src/lib/trendsPrefs.ts — which nutrients Trends opens on, and over how
// many days.
//
// Same shape and the same safety property as whoopConnectionCache: the
// stored blob carries the user id it belongs to, and a mismatch is treated
// exactly like no stored value. Two accounts on one device is how this app
// gets tested and how a shared phone works, and a chart selection is a small
// but real statement about what someone is watching.
//
// It holds a selection and a range. NOTHING about what was eaten — no
// totals, no dates, no entries. A local store of nutrition values would be
// health data on the device with no expiry and no RLS behind it.
//
// Every read is validated against the current nutrient list and range
// options rather than trusted. A preference written by an older build could
// name a nutrient that no longer exists, and buildTrendSeries would then
// look for metadata that isn't there. Anything unrecognised falls back to
// the defaults, which is always a safe answer for a preference.
// ============================================================

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  MAX_SELECTED,
  RANGE_DAYS,
  TREND_NUTRIENTS,
  TrendNutrient,
  TrendRange,
} from "./trends";

export const TRENDS_PREFS_KEY = "plated.trendsPrefs.v1";

export interface TrendsPrefs {
  nutrients: TrendNutrient[];
  range: TrendRange;
}

interface StoredTrendsPrefs extends TrendsPrefs {
  userId: string;
}

const isNutrient = (v: unknown): v is TrendNutrient =>
  typeof v === "string" && TREND_NUTRIENTS.some((n) => n.key === v);

const isRange = (v: unknown): v is TrendRange =>
  typeof v === "number" && (RANGE_DAYS as readonly number[]).includes(v);

/**
 * The stored preference, but ONLY if it belongs to `userId` and still makes
 * sense. Returns null for anything else — no cache, a different user, junk,
 * a nutrient that no longer exists, a range no longer offered, an empty
 * selection or one longer than the cap.
 *
 * Never throws. AsyncStorage can be unavailable or hand back nonsense, and
 * opening on the default three charts is not a failure worth surfacing.
 */
export async function readTrendsPrefs(
  userId: string,
): Promise<TrendsPrefs | null> {
  try {
    const raw = await AsyncStorage.getItem(TRENDS_PREFS_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<StoredTrendsPrefs>;
    if (typeof parsed?.userId !== "string") return null;
    if (parsed.userId !== userId) return null;

    const { nutrients, range } = parsed;
    if (!Array.isArray(nutrients)) return null;
    if (nutrients.length === 0 || nutrients.length > MAX_SELECTED) return null;
    if (!nutrients.every(isNutrient)) return null;
    if (new Set(nutrients).size !== nutrients.length) return null;
    if (!isRange(range)) return null;

    return { nutrients: nutrients as TrendNutrient[], range };
  } catch {
    return null;
  }
}

/** Writes the preference. One key, overwritten — never accumulated. */
export async function writeTrendsPrefs(
  userId: string,
  prefs: TrendsPrefs,
): Promise<void> {
  try {
    const value: StoredTrendsPrefs = {
      userId,
      nutrients: prefs.nutrients,
      range: prefs.range,
    };
    await AsyncStorage.setItem(TRENDS_PREFS_KEY, JSON.stringify(value));
  } catch {
    // A preference that can't be written means the next visit opens on the
    // defaults. That is the behaviour we had before this existed.
  }
}

/** Removes it. Called on sign-out, via the store's reset(). */
export async function clearTrendsPrefs(): Promise<void> {
  try {
    await AsyncStorage.removeItem(TRENDS_PREFS_KEY);
  } catch {
    // Same reasoning as above.
  }
}
