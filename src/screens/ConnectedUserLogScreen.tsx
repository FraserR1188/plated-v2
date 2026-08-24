// ============================================================
// src/screens/ConnectedUserLogScreen.tsx
// ============================================================
// Shows a connected user's log, ±HISTORY_WINDOW_DAYS around today, with a
// three-page swipe pager (same idiom as TodayScreen's own day pager).
// Viewer can copy individual ingredients, full meal sections,
// or the entire day into their own log.
//
// ⚠ todayKey() below is the VIEWER's own local "today" — the target day for
// a copy — and must not be confused with `selected`/`today` (this file's
// OWN `today` state), which track the FRIEND's log day being viewed (see the
// `route.params` destructure further down). Two different days, same screen.
//
// ─── WHY A CHUNKED FETCH, NOT ONE (HISTORY_WINDOW_DAYS + 1)-DAY QUERY ───
//
// The whole point of this screen is rendering ONE day at a time. A single
// request across the full window pulls a friend's entire month of entries
// to paint one page — fine on wifi, wasteful on a train, and it only gets
// worse if the window ever grows. So the fetch is chunked: an initial
// FETCH_CHUNK_DAYS-day window ending today, then another chunk backward
// each time the viewer swipes within REFETCH_THRESHOLD_DAYS of the earliest
// date already loaded — merged into one date-keyed map, never re-fetching a
// chunk already in hand.
//
// A date absent from the map (not yet fetched) renders exactly like a date
// present with zero entries — both are "nothing to show," and the map
// itself is never consulted to decide between a loading state and an empty
// one. That's deliberate: a per-page spinner would flicker in and out as
// chunks land while swiping, which is worse than briefly showing "nothing
// logged" for a day whose chunk hasn't arrived yet.
// ============================================================

import React, {
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";

import {
  Colors,
  Spacing,
  Typography,
  Radius,
  MacroColor,
  Fonts,
  withDefaultFont,
} from "../theme/tokens";
import { getEntriesForUserRange } from "../lib/social";
import { sectionForTime, addDays, formatDayLabel } from "../lib/time";
import { reportError } from "../lib/reportError";
import { todayKey, isPending, isEaten } from "../store/useStore";
import {
  RootStackParamList,
  MealEntry,
  MealType,
  CopyPayload,
  Profile,
  FoodProduct,
} from "../types";

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Route = RouteProp<RootStackParamList, "ConnectedUserLog">;

const MEALS: { key: MealType; label: string }[] = [
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "dinner", label: "Dinner" },
  { key: "snacks", label: "Snacks" },
];

/**
 * How far back a viewer can browse a friend's log. Named so it's changeable
 * in one place — there's no significance to 30 beyond "roughly a month,"
 * which is closer to how a friend's log actually gets used than the ±7 this
 * shipped with initially.
 *
 * Forward days are bounded separately by HISTORY_WINDOW_FORWARD_DAYS below.
 * Before 20260823150000_share_planned.sql, meal_entries_select_follower's
 * `(planned = false or confirmed_at is not null)` clause meant a friend's
 * unconfirmed future entries returned zero rows no matter what this screen
 * asked for, so a forward window was pointless. That clause now has a third
 * disjunct — a friend's own opt-in (profiles.share_planned) — so a friend
 * who has opted in can genuinely have visible planned rows ahead of today.
 * A friend who hasn't opted in still returns zero rows for those days; this
 * screen doesn't know or care which case it's in, and renders both
 * identically (an empty page, no "ask them to share" prompt) — see
 * emptyStateText.
 */
const HISTORY_WINDOW_DAYS = 30;

/**
 * How far forward a viewer can browse — i.e. into a friend's opted-in
 * planned meals. Small and fixed-fetch (see the initial-chunk effect below):
 * unlike the backward window, this is never chunked further forward, since
 * there's no "unbounded future" to page into — meal_entries_select_follower
 * still only ever surfaces rows that exist, and a friend doesn't plan
 * indefinitely far ahead.
 */
const HISTORY_WINDOW_FORWARD_DAYS = 7;

/** Fetch chunk size for the backward-paging history fetch. */
const FETCH_CHUNK_DAYS = 14;

/** Fetch the next chunk backward once the viewer swipes within this many
 *  days of the earliest date already loaded. */
const REFETCH_THRESHOLD_DAYS = 3;

// ─── Helpers ─────────────────────────────────────────────────

function sumEntries(entries: MealEntry[]) {
  return entries.reduce(
    (acc, e) => ({
      calories: acc.calories + e.calories,
      protein: acc.protein + e.protein,
      carbs: acc.carbs + e.carbs,
      fat: acc.fat + e.fat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
}

function entryToProduct(entry: MealEntry): FoodProduct {
  // Reconstruct per-100g values from the stored totals + serving_g
  const factor =
    entry.serving_g != null && entry.serving_g > 0 ? 100 / entry.serving_g : 1;
  return {
    name: entry.name,
    brand: entry.brand ?? "",
    cal_per100: Math.round(entry.calories * factor),
    protein_per100: parseFloat((entry.protein * factor).toFixed(1)),
    carbs_per100: parseFloat((entry.carbs * factor).toFixed(1)),
    fat_per100: parseFloat((entry.fat * factor).toFixed(1)),
    // NULL stays NULL — a friend's unknown salt/fibre/sugar must not become
    // an asserted zero the moment you copy their entry into your own log.
    // See foodLookup.mealEntryToProduct for the same fix on the edit path.
    salt_per100:
      entry.salt != null
        ? parseFloat((entry.salt * factor).toFixed(2))
        : undefined,
    fibre_per100:
      entry.fibre != null
        ? parseFloat((entry.fibre * factor).toFixed(1))
        : undefined,
    sugar_per100:
      entry.sugar != null
        ? parseFloat((entry.sugar * factor).toFixed(1))
        : undefined,
    serving_g: entry.serving_g ?? undefined,
  };
}

function formatMacros(
  calories: number,
  protein: number,
  carbs: number,
  fat: number,
) {
  return `${Math.round(calories)} kcal · ${protein.toFixed(1)}p · ${carbs.toFixed(1)}c · ${fat.toFixed(1)}f`;
}

/** Day-aware empty-state copy — was hardcoded to "today," which read wrong
 *  the moment this screen could show any other day. */
function emptyStateText(displayName: string, date: string, today: string): string {
  if (date === today) return `${displayName} hasn't logged anything today yet.`;
  if (date === addDays(today, -1)) {
    return `${displayName} didn't log anything yesterday.`;
  }
  return `${displayName} didn't log anything on ${formatDayLabel(date)}.`;
}

/** Seed every date key in [start, end] with an empty array if it isn't
 *  already present, so "this date has been fetched" is exactly "this date
 *  is a key in the map" — even for a day with zero real entries. Bounded to
 *  at most FETCH_CHUNK_DAYS iterations per call; addDays + string
 *  comparison only, no ms arithmetic. */
function seedDateRange(
  map: Map<string, MealEntry[]>,
  start: string,
  end: string,
) {
  let d = start;
  while (d <= end) {
    if (!map.has(d)) map.set(d, []);
    d = addDays(d, 1);
  }
}

// ─── Day summary bar ─────────────────────────────────────────
//
// Mirrors useStore.getSplitTotalsForDate exactly: the headline figure and
// macro chips are EATEN entries only (isEaten — a normal logged entry, or a
// planned one the friend confirmed). Planned-but-unconfirmed entries
// (isPending) are never folded into that sum; their calories surface only
// as a separate note, same wording/structure as TodayScreen.tsx's own
// "+N kcal planned, not yet eaten" line. skipped_at rows never reach this
// component at all — getEntriesForUserRange filters them server-side.

function DaySummary({ entries }: { entries: MealEntry[] }) {
  const eatenTotals = sumEntries(entries.filter(isEaten));
  const plannedCalories = Math.round(
    sumEntries(entries.filter(isPending)).calories,
  );

  return (
    <View style={styles.daySummary}>
      <Text style={styles.daySummaryCalories}>
        {Math.round(eatenTotals.calories)}
      </Text>
      <Text style={styles.daySummaryLabel}>kcal</Text>
      <View style={styles.daySummaryMacros}>
        {[
          {
            label: "protein",
            value: eatenTotals.protein,
            color: MacroColor.protein,
          },
          { label: "carbs", value: eatenTotals.carbs, color: MacroColor.carbs },
          { label: "fat", value: eatenTotals.fat, color: MacroColor.fat },
        ].map((m) => (
          <View key={m.label} style={styles.macroChip}>
            <View style={[styles.macroChipDot, { backgroundColor: m.color }]} />
            <Text style={styles.macroChipText}>{m.value.toFixed(1)}g</Text>
            <Text style={styles.macroChipLabel}> {m.label}</Text>
          </View>
        ))}
      </View>
      {plannedCalories > 0 && (
        <Text style={styles.daySummaryPlannedNote}>
          <Text style={styles.daySummaryPlannedNoteStrong}>
            +{plannedCalories.toLocaleString()} kcal
          </Text>{" "}
          planned, not yet eaten
        </Text>
      )}
    </View>
  );
}

// ─── Copy button (icon + label) ──────────────────────────────

function CopyBtn({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={styles.copyBtn}
      hitSlop={6}
    >
      <Text style={styles.copyBtnIcon}>＋</Text>
      <Text style={styles.copyBtnText}>{label}</Text>
    </TouchableOpacity>
  );
}

// ─── Ingredient row ──────────────────────────────────────────

function IngredientRow({
  entry,
  onCopy,
}: {
  entry: MealEntry;
  onCopy: () => void;
}) {
  // Same predicate and treatment as TodayScreen's StreamFoodRow: a 🕐
  // prefix plus a dimmed row, nothing heavier — this is a browsing list,
  // not a decision context, so the explicit "Planned"/"Logged" pill (used
  // in CopyTargetPicker/bundle previews) doesn't belong here.
  const pending = isPending(entry);
  return (
    <View
      style={[styles.ingredientRow, pending && styles.ingredientRowPending]}
    >
      <View style={styles.ingredientMeta}>
        <Text style={styles.ingredientName} numberOfLines={1}>
          {pending ? "🕐 " : ""}
          {entry.name}
        </Text>
        <Text style={styles.ingredientSub}>
          {entry.serving_g}g · {Math.round(entry.calories)} kcal
        </Text>
      </View>
      <CopyBtn label="Copy" onPress={onCopy} />
    </View>
  );
}

// ─── Meal section ─────────────────────────────────────────────

interface MealSectionProps {
  mealType: MealType;
  label: string;
  entries: MealEntry[];
  onCopyIngredient: (entry: MealEntry) => void;
  onCopySection: (entries: MealEntry[], label: string) => void;
}

function MealSection({
  mealType,
  label,
  entries,
  onCopyIngredient,
  onCopySection,
}: MealSectionProps) {
  const totals = sumEntries(entries);

  return (
    <View style={styles.mealSection}>
      {/* Section header */}
      <View style={styles.mealHeader}>
        <View style={styles.mealHeaderLeft}>
          <Text style={styles.mealLabel}>{label}</Text>
          {entries.length > 0 && (
            <Text style={styles.mealHeaderSub}>
              {formatMacros(
                totals.calories,
                totals.protein,
                totals.carbs,
                totals.fat,
              )}
            </Text>
          )}
        </View>
        {entries.length > 0 && (
          <CopyBtn
            label={`Copy ${label}`}
            onPress={() => onCopySection(entries, label)}
          />
        )}
      </View>

      {/* Ingredient rows */}
      {entries.length === 0 ? (
        <Text style={styles.emptyMeal}>Nothing logged</Text>
      ) : (
        entries.map((entry) => (
          <IngredientRow
            key={entry.id}
            entry={entry}
            onCopy={() => onCopyIngredient(entry)}
          />
        ))
      )}
    </View>
  );
}

// ─── One day's page in the pager ──────────────────────────────
//
// Mirrors TodayScreen's DayPage: keyed on its own date by the caller, so
// paging to a new day is always a fresh mount (scroll position resets for
// free). `entries` is already resolved by the caller (map.get(date) ?? []) —
// this component doesn't know or care whether that's a real empty day or a
// not-yet-fetched one; both render identically, which is the point.

interface FriendDayPageProps {
  date: string;
  today: string;
  width: number;
  displayName: string;
  entries: MealEntry[];
  onCopyIngredient: (entry: MealEntry) => void;
  onCopySection: (entries: MealEntry[], label: string) => void;
  onCopyFullDay: (entries: MealEntry[]) => void;
}

function FriendDayPage({
  date,
  today,
  width,
  displayName,
  entries,
  onCopyIngredient,
  onCopySection,
  onCopyFullDay,
}: FriendDayPageProps) {
  const entriesByMeal = useMemo(() => {
    const map: Record<MealType, MealEntry[]> = {
      breakfast: [],
      lunch: [],
      dinner: [],
      snacks: [],
    };
    entries.forEach((e) => {
      if (map[e.meal_type]) map[e.meal_type].push(e);
    });
    return map;
  }, [entries]);

  return (
    <View style={{ width }}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Day summary */}
        {entries.length > 0 && <DaySummary entries={entries} />}

        {/* Copy full day CTA */}
        {entries.length > 0 && (
          <TouchableOpacity
            onPress={() => onCopyFullDay(entries)}
            activeOpacity={0.8}
            style={styles.copyDayBtn}
          >
            <Text style={styles.copyDayBtnText}>
              Copy {displayName}'s full day
            </Text>
          </TouchableOpacity>
        )}

        {/* Meal sections */}
        <View style={styles.sections}>
          {MEALS.map((m) => (
            <MealSection
              key={m.key}
              mealType={m.key}
              label={m.label}
              entries={entriesByMeal[m.key]}
              onCopyIngredient={onCopyIngredient}
              onCopySection={onCopySection}
            />
          ))}
        </View>

        {entries.length === 0 && (
          <View style={styles.centred}>
            <Text style={styles.emptyIcon}>🍽️</Text>
            <Text style={styles.emptyText}>
              {emptyStateText(displayName, date, today)}
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ─── Main screen ─────────────────────────────────────────────

export function ConnectedUserLogScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const { profile, date } = route.params;

  const displayName = profile.display_name ?? profile.username;

  // ── Window bounds ──────────────────────────────────────────
  // `today` captured once at mount (this screen isn't meant to be kept open
  // across a midnight boundary) — the upper bound for both the pager and
  // the header, and the anchor the lower bound is computed from.
  const [today] = useState(() => todayKey());
  const lowerBound = useMemo(
    () => addDays(today, -HISTORY_WINDOW_DAYS),
    [today],
  );
  const upperBound = useMemo(
    () => addDays(today, HISTORY_WINDOW_FORWARD_DAYS),
    [today],
  );
  const clampToLowerBound = useCallback(
    (key: string) => (key < lowerBound ? lowerBound : key),
    [lowerBound],
  );

  // ── Paging cursor ───────────────────────────────────────────
  const [selected, setSelected] = useState(date);

  // ── History fetch: chunked backward, merged into a date-keyed map ──
  const [entriesByDate, setEntriesByDate] = useState<Map<string, MealEntry[]>>(
    () => new Map(),
  );
  const [loadedFrom, setLoadedFrom] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchingMoreRef = useRef(false);

  // Initial chunk: FETCH_CHUNK_DAYS of history ending today, PLUS the full
  // forward window through upperBound in the same request — the forward
  // window is small and fixed, so unlike the backward history it never
  // needs its own chunking/refetch pass. rangeStart is clamped at the lower
  // bound; the fetch's end and seedDateRange's end must both be upperBound,
  // not today, or a friend's opted-in forward entries would be fetched and
  // then silently dropped (map.get(e.date)?.push — a date that was never
  // seeded as a key finds no array to push into).
  useEffect(() => {
    let cancelled = false;
    setInitialLoading(true);
    setError(null);

    const rangeStart = clampToLowerBound(
      addDays(today, -(FETCH_CHUNK_DAYS - 1)),
    );

    getEntriesForUserRange(profile.user_id, rangeStart, upperBound)
      .then((data) => {
        if (cancelled) return;
        const map = new Map<string, MealEntry[]>();
        seedDateRange(map, rangeStart, upperBound);
        data.forEach((e) => map.get(e.date)?.push(e));
        setEntriesByDate(map);
        setLoadedFrom(rangeStart);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load their log. Try again.");
      })
      .finally(() => {
        if (!cancelled) setInitialLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [profile.user_id, today, upperBound, clampToLowerBound]);

  // Backward chunk fetch: fires once `selected` is within
  // REFETCH_THRESHOLD_DAYS of the earliest date already loaded. A day
  // absent from the map (this chunk hasn't landed yet) renders as empty via
  // FriendDayPage's `entries` default below — never as a loading state.
  useEffect(() => {
    if (!loadedFrom || loadedFrom <= lowerBound) return;
    if (fetchingMoreRef.current) return;
    if (selected > addDays(loadedFrom, REFETCH_THRESHOLD_DAYS)) return;

    fetchingMoreRef.current = true;
    const chunkEnd = addDays(loadedFrom, -1);
    const chunkStart = clampToLowerBound(addDays(loadedFrom, -FETCH_CHUNK_DAYS));

    getEntriesForUserRange(profile.user_id, chunkStart, chunkEnd)
      .then((data) => {
        setEntriesByDate((prev) => {
          const next = new Map(prev);
          seedDateRange(next, chunkStart, chunkEnd);
          data.forEach((e) => next.get(e.date)?.push(e));
          return next;
        });
        setLoadedFrom(chunkStart);
      })
      .catch((err) => {
        // Not surfaced to the user: loadedFrom doesn't advance on failure,
        // so the next render near the same edge simply retries.
        reportError("ConnectedUserLogScreen.fetchMoreHistory", err);
      })
      .finally(() => {
        fetchingMoreRef.current = false;
      });
  }, [selected, loadedFrom, lowerBound, profile.user_id, clampToLowerBound]);

  // ── Header: title carries the day, updates as the pager moves ──

  useLayoutEffect(() => {
    navigation.setOptions({
      title: `${displayName} · ${formatDayLabel(selected)}`,
      headerBackTitle: "Friends",
    });
  }, [navigation, displayName, selected]);

  // ── Pager: [prev?, selected, next?], clamped at both window edges ──
  //
  // Same 3-page sliding-window idiom as TodayScreen, with one addition:
  // TodayScreen's window is unbounded in both directions, so its array is
  // always exactly 3 wide and the centre is always index 1. This screen's
  // window is NOT unbounded — sitting on `upperBound` must not render a page
  // one day further forward (a friend's opted-in plans only reach so far
  // ahead; beyond that it's not "empty," it's out of range and shouldn't be
  // swipeable to at all), and sitting on `lowerBound` must not render a page
  // for one day further back. So the array is built conditionally and the
  // centre index is DERIVED from it, never assumed to be 1 — both the
  // scroll-reset effect and the scroll-end handler read it from the same
  // `pageDates`/`centreIndex` pair, so an edge page (a 2-wide array, centre
  // at 0 or 1) can't disagree with itself the way a hardcoded "page === 1"
  // would.
  const pageDates = useMemo(() => {
    const dates: string[] = [];
    const prev = addDays(selected, -1);
    if (prev >= lowerBound) dates.push(prev);
    dates.push(selected);
    const next = addDays(selected, 1);
    if (next <= upperBound) dates.push(next);
    return dates;
  }, [selected, lowerBound, upperBound]);

  const centreIndex = pageDates.indexOf(selected);

  const pagerRef = useRef<ScrollView>(null);
  const [pagerWidth, setPagerWidth] = useState(0);

  useLayoutEffect(() => {
    if (pagerWidth > 0) {
      pagerRef.current?.scrollTo({
        x: pagerWidth * centreIndex,
        animated: false,
      });
    }
  }, [selected, pagerWidth, centreIndex]);

  const handlePagerLayout = (e: any) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0 && w !== pagerWidth) setPagerWidth(w);
  };

  // Android's pagingEnabled ScrollView can dispatch onMomentumScrollEnd
  // twice for a single swipe — once for the fling settling, once more for
  // the snap-to-page correction, both reporting the same landed offset.
  // Ported verbatim from TodayScreen's pager: this is a bug someone already
  // paid for, not something to reimplement.
  const hasHandledRef = useRef(false);

  const handlePagerScrollBegin = () => {
    hasHandledRef.current = false;
  };

  const handlePagerScrollEnd = (e: any) => {
    if (pagerWidth === 0) return;
    if (hasHandledRef.current) return;
    const page = Math.round(e.nativeEvent.contentOffset.x / pagerWidth);
    if (page === centreIndex) return; // bounced back to the centre — no day change
    hasHandledRef.current = true;
    setSelected(pageDates[page]);
  };

  // ── Copy: single ingredient ───────────────────────────────
  // Opens ProductScreen pre-filled so the viewer can adjust serving size

  const handleCopyIngredient = useCallback(
    (entry: MealEntry) => {
      const product = entryToProduct(entry);
      // ⚠ NOT entry.meal_type. That was inheriting the FRIEND's section as
      // this copy's target — exactly the bug class CLAUDE.md's architecture
      // invariants call out ("never inherit date or section from a source
      // entry"). This screen lands the copy at eaten_at = now (ProductScreen
      // seeds "now" for date: todayKey()), so sectionForTime(now) is the
      // correct STARTING default: a fresh section derived from THIS copy's
      // own time, not borrowed from the source. ProductScreen's meal-type
      // tag is editable on creation, so a wrong guess here is one tap to
      // fix, not a re-navigation.
      navigation.navigate("Product", {
        product,
        date: todayKey(),
        mealType: sectionForTime(new Date().toISOString()),
      });
    },
    [navigation],
  );

  // ── Copy: meal section ────────────────────────────────────

  const handleCopySection = useCallback(
    (sectionEntries: MealEntry[], label: string) => {
      const payload: CopyPayload = {
        scope: "meal_section",
        entries: sectionEntries,
        sourceName: `${displayName}'s ${label}`,
      };
      navigation.navigate("CopyConfirm", { payload });
    },
    [navigation, displayName],
  );

  // ── Copy: full day ────────────────────────────────────────
  // Takes the day's entries as an argument now — with the pager, "the
  // entries currently on screen" is a per-page fact, not screen-level state.

  const handleCopyFullDay = useCallback(
    (dayEntries: MealEntry[]) => {
      if (dayEntries.length === 0) return;

      const payload: CopyPayload = {
        scope: "full_day",
        entries: dayEntries,
        sourceName: `${displayName}'s full day`,
      };
      navigation.navigate("CopyConfirm", { payload });
    },
    [navigation, displayName],
  );

  // ── Render ────────────────────────────────────────────────

  if (initialLoading) {
    return (
      <SafeAreaView style={styles.root} edges={["bottom"]}>
        <View style={styles.centred}>
          <ActivityIndicator color={Colors.green} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.root} edges={["bottom"]}>
        <View style={styles.centred}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={["bottom"]}>
      <View style={styles.pager} onLayout={handlePagerLayout}>
        {pagerWidth > 0 && (
          <ScrollView
            ref={pagerRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onScrollBeginDrag={handlePagerScrollBegin}
            onMomentumScrollEnd={handlePagerScrollEnd}
          >
            {pageDates.map((d) => (
              <FriendDayPage
                key={d}
                date={d}
                today={today}
                width={pagerWidth}
                displayName={displayName}
                entries={entriesByDate.get(d) ?? []}
                onCopyIngredient={handleCopyIngredient}
                onCopySection={handleCopySection}
                onCopyFullDay={handleCopyFullDay}
              />
            ))}
          </ScrollView>
        )}
      </View>
    </SafeAreaView>
  );
}

// ─── Styles ──────────────────────────────────────────────────

const styles = StyleSheet.create(
  withDefaultFont({
  root: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  pager: {
    flex: 1,
  },
  scroll: {
    paddingBottom: Spacing.xxl,
  },
  centred: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: Spacing.xl,
    gap: Spacing.sm,
  },
  errorText: {
    color: Colors.danger,
    fontSize: Typography.base,
    textAlign: "center",
  },
  emptyIcon: { fontSize: 40 },
  emptyText: {
    fontSize: Typography.base,
    color: Colors.textMuted,
    textAlign: "center",
  },

  // Day summary
  daySummary: {
    margin: Spacing.md,
    padding: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 4,
  },
  daySummaryCalories: {
    fontSize: Typography.xxl,
    fontWeight: Typography.bold,
    fontFamily: Fonts.mono.bold,
    color: Colors.green,
  },
  daySummaryLabel: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
  },
  daySummaryMacros: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  // Same treatment as TodayScreen's plannedNote/plannedNoteStrong — this
  // card's own `gap: 4` layout means a positive marginTop, not TodayScreen's
  // negative one (that one pulls the note up under a hero card; this one
  // just sits below the macro chips).
  daySummaryPlannedNote: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
    fontFamily: Fonts.sans.medium,
    marginTop: Spacing.xs,
  },
  daySummaryPlannedNoteStrong: {
    color: Colors.textSub,
    fontWeight: Typography.bold,
    fontFamily: Fonts.mono.bold,
  },
  macroChip: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface2,
    borderRadius: Radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  macroChipDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 5,
  },
  macroChipText: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    fontFamily: Fonts.mono.semibold,
    color: Colors.text,
  },
  macroChipLabel: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
  },

  // Copy full day button
  copyDayBtn: {
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.md,
    padding: Spacing.md,
    backgroundColor: Colors.green,
    borderRadius: Radius.control,
    alignItems: "center",
  },
  copyDayBtnText: {
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.bg,
  },

  // Sections container
  sections: {
    gap: Spacing.xs,
  },

  // Meal section
  mealSection: {
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.sm,
    backgroundColor: Colors.surface,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  mealHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderSub,
  },
  mealHeaderLeft: { flex: 1 },
  mealLabel: {
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.text,
  },
  mealHeaderSub: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    marginTop: 2,
  },

  // Ingredient row
  ingredientRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderSub,
  },
  // Same dimming as TodayScreen's rowPending — a planned entry that hasn't
  // been eaten (or confirmed) yet.
  ingredientRowPending: {
    opacity: 0.62,
  },
  ingredientMeta: {
    flex: 1,
    marginRight: Spacing.xs,
  },
  ingredientName: {
    fontSize: Typography.base,
    fontWeight: Typography.medium,
    color: Colors.text,
  },
  ingredientSub: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
    marginTop: 2,
  },

  // Copy button
  copyBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface2,
    borderRadius: Radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 4,
  },
  copyBtnIcon: {
    fontSize: 13,
    color: Colors.green,
    fontWeight: Typography.bold,
  },
  copyBtnText: {
    fontSize: Typography.sm,
    fontWeight: Typography.medium,
    color: Colors.text,
  },

  // Empty meal placeholder
  emptyMeal: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  }),
);
