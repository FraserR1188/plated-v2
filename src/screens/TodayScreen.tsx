import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  View,
  Text,
  ScrollView,
  Animated,
  StyleSheet,
  Alert,
  RefreshControl,
  Pressable,
  ActivityIndicator,
  Modal,
  TextInput,
} from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SafeAreaView } from "react-native-safe-area-context";
import DateTimePicker from "@react-native-community/datetimepicker";
import { CalorieRing } from "../components/CalorieRing";
import { MacroBar } from "../components/MacroBar";
import { useStore, todayKey } from "../store/useStore";
import { mealEntryToProduct } from "../lib/foodLookup";
import { previewComposition, bundlesOnly } from "../lib/compositions";
import { draftsFromDay, sharedMealType } from "../lib/entries";
import { roundSalt } from "../lib/macros";
import { dayHeaderInfo } from "../lib/dayHeader";
import { buildDayStream, BAND_LABELS } from "../lib/dayStream";
import { kjToKcal } from "../lib/energy";
import {
  formatTime,
  formatDayLabel,
  formatTimeOfDay,
  localHM,
  minutesSinceLocalMidnight,
  isFutureDay,
  parseDateKey,
  dateKey,
  addDays,
  parseTimeOfDay,
  earliestTimeOfDay,
  sameTimeOnDay,
  willBePlanned,
  TimeOfDay,
  DEFAULT_HOUR,
} from "../lib/time";
import {
  Colors,
  MacroColor,
  Spacing,
  Radius,
  Typography,
  Fonts,
  Shadow,
} from "../theme/tokens";
import {
  RootStackParamList,
  MealEntry,
  MealCompositionWithItems,
  MealType,
  MEAL_TYPES,
  MEAL_LABELS,
  Workout,
} from "../types";

/** Awaiting an answer. Mirrors the store's predicate; kept local for row styling. */
const isPending = (e: MealEntry) =>
  e.planned && !e.confirmed_at && !e.skipped_at;

/** Pending AND its planned time has already passed — eligible for an inline
 *  "Ate it?". A dinner planned for tonight at 19:00, seen at 15:00, is pending
 *  but NOT overdue: it hasn't happened yet, so we don't ask. This is recomputed
 *  on render, so the button appears when the screen next re-renders after the
 *  time passes (a focus or pull-to-refresh forces that). */
const isOverduePending = (e: MealEntry): boolean =>
  isPending(e) && new Date(e.eaten_at).getTime() <= Date.now();

/** serving_g is nullable in the DB. Math.round(null) is 0, which renders "0g". */
const servingLabel = (g: number | null): string =>
  g != null && g > 0 ? `${Math.round(g)}g` : "—";

/** Consumed/goal, clamped to a fillable [0,1] fraction. A zero or unset goal
 *  reads as empty rather than Infinity/NaN — the sticky strip's a proportion,
 *  not a warning light. */
const frac = (consumed: number, goal: number): number =>
  goal > 0 ? Math.min(consumed / goal, 1) : 0;

/** How far the sticky bar's crossfade runs, in px of scroll. */
const STICKY_FADE_RANGE = 40;

export function TodayScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const {
    compositions,
    getDuePendingEntries,
    confirmEntries,
    skipEntries,
    retimeEntries,
    deleteEntry,
    deleteEntries,
    copyEntriesToDay,
    copyEntriesTo,
    saveBundleFromEntries,
    addEntriesToBundle,
    applyCompositionToDay,
    fetchEntries,
    fetchCompositions,
    fetchWorkouts,
  } = useStore();

  // Bundles-only view — see bundlesOnly() in lib/compositions.ts for why
  // this filter exists and why it's a named, tested function rather than an
  // inline `.filter()`.
  const bundles = bundlesOnly(compositions);

  const [refreshing, setRefreshing] = useState(false);

  // ── The selected day ────────────────────────────────────────
  const [selected, setSelected] = useState(todayKey());
  const [showJump, setShowJump] = useState(false);

  // Ticks once a minute purely so "today" gets RE-EVALUATED across a midnight
  // boundary even if the screen is left open and untouched — without this,
  // nothing would ever force a re-render to notice the day changed underneath
  // it. `now` is never read once and cached; every consumer below re-derives
  // from this each time it changes.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  // ── Day pager ────────────────────────────────────────────────
  //
  // A 3-page sliding window — [yesterday, selected, tomorrow] — rather than a
  // library pager: nothing in this repo already depends on gesture-handler or
  // reanimated, and adding either means a new dev-client build. Each page is
  // its own DayPage, keyed on its date, so paging to a new day always mounts
  // fresh (scroll position and the sticky bar both reset for free — nothing
  // to manually rewind).
  //
  // On landing (onMomentumScrollEnd), `selected` moves to whichever page the
  // swipe landed on, which shifts the window, and the effect below snaps the
  // ScrollView straight back to the centre slot — same visual day, new centre
  // index — so the next swipe always has a page in reserve on both sides.
  const pagerRef = useRef<ScrollView>(null);
  const [pagerWidth, setPagerWidth] = useState(0);
  const pageDates = useMemo(
    () => [addDays(selected, -1), selected, addDays(selected, 1)],
    [selected],
  );

  useLayoutEffect(() => {
    if (pagerWidth > 0) {
      pagerRef.current?.scrollTo({ x: pagerWidth, animated: false });
    }
  }, [selected, pagerWidth]);

  const handlePagerLayout = (e: any) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0 && w !== pagerWidth) setPagerWidth(w);
  };

  // Android's pagingEnabled ScrollView can dispatch onMomentumScrollEnd twice
  // for a single swipe — once for the fling settling, once more for the
  // snap-to-page correction that follows it — both reporting the same landed
  // offset. Without a guard, the second firing runs against the closure from
  // the FIRST firing's setSelected, advancing the day twice per swipe. This
  // ref makes only the first REAL (non-centre) firing per gesture count;
  // onScrollBeginDrag reliably precedes momentum on Android, so it's the
  // right place to reset the lock for the next swipe.
  const hasHandledRef = useRef(false);

  const handlePagerScrollBegin = () => {
    hasHandledRef.current = false;
  };

  const handlePagerScrollEnd = (e: any) => {
    if (pagerWidth === 0) return;
    if (hasHandledRef.current) return;
    const page = Math.round(e.nativeEvent.contentOffset.x / pagerWidth);
    if (page === 1) return; // bounced back to the centre — no day change, no lock consumed
    hasHandledRef.current = true;
    setSelected(addDays(selected, page - 1));
  };

  // ── Selection mode ──────────────────────────────────────────
  //
  // Long-press USED to fire an immediate delete confirm. It now enters selection
  // mode, and delete moves into the action bar — which gives multi-delete for
  // free, and a confirm that counts ("Remove 4 items?") rather than one that
  // names one thing. Long-press-to-select is also what both platforms actually
  // do; delete-on-long-press was an inherited pattern, not a defended one.
  const [selection, setSelection] = useState<Set<string> | null>(null);
  const selecting = selection !== null;

  const [sheet, setSheet] = useState<
    | null
    | "apply"
    | "save"
    | "copy" // Day/Meal/Time sheet — see CopyToSheet. One item or many; the
    // sheet itself picks its opening mode from the selection.
    | "time" // bulk retime
  >(null);
  const [busy, setBusy] = useState(false);

  const today = dateKey(now);

  const duePending = getDuePendingEntries();

  useFocusEffect(
    useCallback(() => {
      fetchEntries();
      fetchCompositions();
      fetchWorkouts();
    }, []),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([fetchEntries(), fetchCompositions(), fetchWorkouts()]);
    setRefreshing(false);
  };

  // Selection is keyed on id, and ids survive a day change — so leaving the day
  // with rows selected would let you copy Monday's food using Tuesday's screen.
  // Resolve the selection back to real entries from the WHOLE store, not from
  // the current day, so it can't silently lose rows either.
  const selectedEntries: MealEntry[] = useMemo(() => {
    if (!selection) return [];
    const all = useStore.getState().getAllEntries();
    return all.filter((e) => selection.has(e.id));
  }, [selection]);

  // The subset we can actually confirm: planned meals whose time has passed.
  // Confirming a still-future plan ("yes, I ate tomorrow's dinner") is nonsense,
  // and an already-eaten row is a no-op — so "Mark eaten" acts on these only, and
  // hides entirely when there are none.
  const overduePendingSelected = useMemo(
    () => selectedEntries.filter(isOverduePending),
    [selectedEntries],
  );
  const hasOverduePending = overduePendingSelected.length > 0;

  const exitSelection = () => {
    setSelection(null);
    setSheet(null);
  };

  const beginSelection = (entry: MealEntry) => {
    // Start WITH the long-pressed row selected. Anything else makes the gesture
    // feel like it did nothing.
    setSelection(new Set([entry.id]));
  };

  const toggle = (entry: MealEntry) => {
    setSelection((prev) => {
      if (!prev) return prev;
      const next = new Set(prev);
      if (next.has(entry.id)) next.delete(entry.id);
      else next.add(entry.id);
      // Deselecting the last row leaves selection mode. Nothing else to do here.
      return next.size === 0 ? null : next;
    });
  };

  const handlePress = (entry: MealEntry) => {
    if (selecting) {
      toggle(entry);
      return;
    }
    handleEdit(entry);
  };

  const handleEdit = (entry: MealEntry) => {
    const product = mealEntryToProduct(entry);

    // mealEntryToProduct returns null when serving_g is missing: the per-100g
    // values genuinely cannot be recovered from a snapshot with no weight, and
    // the old code silently assumed 100g — which rewrote every macro by a factor
    // of 100/actual on save. Refusing is the honest answer.
    if (!product) {
      Alert.alert(
        "Can't edit this one",
        `"${entry.name}" was saved without a serving weight, so its per-100g values can't be worked out. Remove it and add it again.`,
        [{ text: "OK" }],
      );
      return;
    }

    navigation.navigate("Product", {
      product,
      date: entry.date,
      mealType: entry.meal_type,
      editEntryId: entry.id,
      initialServingG: entry.serving_g,
      initialEatenAt: entry.eaten_at,
    });
  };

  // "Ate it" on a single overdue-planned row. Goes STRAIGHT to the store's
  // confirm action — deliberately NOT through ProductScreen, whose edit path
  // recomputes every macro from a lossy round-trip. confirmEntries writes only
  // confirmed_at, so calories can't drift.
  const handleConfirmOne = (entry: MealEntry) => {
    void confirmEntries([entry.id]);
  };

  // Bulk "Mark eaten" — confirms only the overdue-planned rows in the selection.
  // Selection is KEPT (not cleared) so you can immediately chain "Set time" to
  // correct when you actually ate. Confirm and retime are two separate steps for
  // now — see the D5 note; combine later if testing says so.
  const handleMarkEatenSelected = async () => {
    const ids = overduePendingSelected.map((e) => e.id);
    if (ids.length === 0) return;
    setBusy(true);
    await confirmEntries(ids);
    setBusy(false);
  };

  const handleSetTimeSelected = () => setSheet("time");

  const handleDeleteOne = (entry: MealEntry) => {
    Alert.alert("Remove item", `Remove "${entry.name}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => deleteEntry(entry.id),
      },
    ]);
  };

  const handleDeleteSelected = () => {
    const n = selectedEntries.length;
    Alert.alert(
      n === 1 ? "Remove item" : `Remove ${n} items`,
      n === 1
        ? `Remove "${selectedEntries[0].name}"?`
        : `Remove these ${n} items from your log?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            setBusy(true);
            const { error } = await deleteEntries(
              selectedEntries.map((e) => e.id),
            );
            setBusy(false);
            if (error) Alert.alert("Couldn't remove those", error);
            else exitSelection();
          },
        },
      ],
    );
  };

  const onJump = (event: any, picked?: Date) => {
    setShowJump(false);
    if (event?.type === "dismissed" || !picked) return;
    setSelected(dateKey(picked));
  };

  // Copy — shared mode: every selected entry lands on ONE chosen
  // {day, meal_type, time}, chosen in the sheet, not inherited from any
  // source row — see draftsForTarget in lib/entries.ts. This is the ONLY
  // path for a single item (always shared, no toggle) and is what a
  // multi-select "Same meal & time for all" routes through too.
  const onCopySharedTarget = async (target: {
    dayKey: string;
    meal_type: MealType;
    time: TimeOfDay;
  }) => {
    setSheet(null);
    if (selectedEntries.length === 0) return;

    setBusy(true);
    const { error } = await copyEntriesTo(selectedEntries, target);
    setBusy(false);

    if (error) {
      Alert.alert("Couldn't copy those", error);
      return;
    }
    exitSelection();
    setSelected(target.dayKey); // land on the day you just filled. Show, don't tell.
  };

  // Copy — each mode: every selected entry keeps its OWN wall clock and its
  // own meal section — Monday's 12:30 lunch becomes Tuesday's 12:30 LUNCH,
  // not "whatever section you picked". Only reachable from a multi-select
  // whose sections don't already agree (see sharedMealType).
  const onCopyEachTarget = async (targetDayKey: string) => {
    setSheet(null);
    if (selectedEntries.length === 0) return;

    setBusy(true);
    const { error } = await copyEntriesToDay(selectedEntries, targetDayKey);
    setBusy(false);

    if (error) {
      Alert.alert("Couldn't copy those", error);
      return;
    }
    exitSelection();
    setSelected(targetDayKey); // land on the day you just filled. Show, don't tell.
  };

  // Bulk retime: one time, applied to every selected row (each keeps its own
  // calendar day). Writes only the clock — never a macro. Selection is kept so a
  // partial failure stays on screen.
  const onSetTimePicked = async (event: any, picked?: Date) => {
    setSheet(null);
    if (event?.type === "dismissed" || !picked) return;
    const ids = selectedEntries.map((e) => e.id);
    if (ids.length === 0) return;

    setBusy(true);
    const { error } = await retimeEntries(
      ids,
      picked.getHours(),
      picked.getMinutes(),
    );
    setBusy(false);
    if (error) Alert.alert("Couldn't set the time", error);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      {showJump && (
        <DateTimePicker
          value={parseDateKey(selected)}
          mode="date"
          display="default"
          onChange={onJump}
        />
      )}

      {sheet === "time" && (
        <DateTimePicker
          value={new Date(selectedEntries[0]?.eaten_at ?? Date.now())}
          mode="time"
          is24Hour
          display="default"
          onChange={onSetTimePicked}
        />
      )}

      {/* ── Day pager ──────────────────────────────────────────────
          A 3-page sliding window, each page its own vertical scroll — see
          the comment by pageDates above for how the re-centering works. */}
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
            {pageDates.map((date) => (
              <DayPage
                key={date}
                date={date}
                today={today}
                now={now}
                width={pagerWidth}
                selecting={selecting}
                selection={selection}
                refreshing={refreshing}
                onRefresh={onRefresh}
                onPress={handlePress}
                onConfirm={handleConfirmOne}
                onLongPress={selecting ? toggle : beginSelection}
                onToggleSelectAll={(entries) => {
                  const all = entries.map((e) => e.id);
                  const allSelected = all.every((id) => selection?.has(id));
                  setSelection(allSelected ? null : new Set(all));
                }}
                duePending={duePending}
                onConfirmAllDue={() =>
                  confirmEntries(duePending.map((e) => e.id))
                }
                onConfirmDue={(id) => confirmEntries([id])}
                onSkipDue={(id) => skipEntries([id])}
                hasBundles={bundles.length > 0}
                onOpenBundles={() => setSheet("apply")}
                onOpenCalendarJump={() => setShowJump(true)}
                onReturnToToday={() => setSelected(today)}
              />
            ))}
          </ScrollView>
        )}
      </View>

      {/* ── Selection action bar ─────────────────────────── */}
      {selecting && (
        <SelectionActionBar
          count={selectedEntries.length}
          busy={busy}
          hasOverduePending={hasOverduePending}
          onMarkEaten={handleMarkEatenSelected}
          onSetTime={handleSetTimeSelected}
          onCopy={() => setSheet("copy")}
          onBundle={() => setSheet("save")}
          onDelete={handleDeleteSelected}
          onCancel={exitSelection}
        />
      )}

      {/* ── Apply a bundle ───────────────────────────────── */}
      <ApplyBundleSheet
        visible={sheet === "apply"}
        bundles={bundles}
        dayKey={selected}
        onClose={() => setSheet(null)}
        onApply={async (bundle, anchor) => {
          setBusy(true);
          const { error } = await applyCompositionToDay(bundle, selected, anchor);
          setBusy(false);
          setSheet(null);
          if (error) Alert.alert("Couldn't apply that bundle", error);
        }}
      />

      {/* ── Save a bundle ────────────────────────────────── */}
      <SaveBundleSheet
        visible={sheet === "save"}
        entries={selectedEntries}
        bundles={bundles}
        onClose={() => setSheet(null)}
        onCreate={async (name) => {
          setBusy(true);
          const { error } = await saveBundleFromEntries(name, selectedEntries);
          setBusy(false);
          setSheet(null);
          if (error) Alert.alert("Couldn't save the bundle", error);
          else exitSelection();
        }}
        onAppend={async (bundle) => {
          setBusy(true);
          const { error } = await addEntriesToBundle(bundle, selectedEntries);
          setBusy(false);
          setSheet(null);
          if (error) Alert.alert("Couldn't add to that bundle", error);
          else exitSelection();
        }}
      />

      {/* ── Copy to a chosen day/meal/time (one item, or a merged/kept-each
            multi-select) ──────────────────────────────────────── */}
      <CopyToSheet
        visible={sheet === "copy"}
        entries={selectedEntries}
        onClose={() => setSheet(null)}
        onCopyShared={onCopySharedTarget}
        onCopyEach={onCopyEachTarget}
      />
    </SafeAreaView>
  );
}

// ─── Day page ───────────────────────────────────────────────────────────────
//
// One day's worth of content — banner, ring, macros, rail, snacks — plus its
// own scroll and its own sticky condensed bar. Three of these are mounted at
// once (the pager's sliding window) but only the centred one is visible, so
// each page owning its own scroll/animation state is what makes swiping to a
// new day "just work": a page is KEYED on its date in the pager above, so a
// fresh date is a fresh mount — scroll position and the sticky bar's
// Animated.Value both start over for free, with no manual reset to write.
//
// `date` is the page's own day — never `selected`. Every read (totals,
// entries, isFuture) and every write (AddIngredient's target day) goes
// through it, so the currently-centred page is the only one that happens to
// match `selected`; the neighbours are honestly showing a different day.

function DayPage({
  date,
  today,
  now,
  width,
  selecting,
  selection,
  refreshing,
  onRefresh,
  onPress,
  onConfirm,
  onLongPress,
  onToggleSelectAll,
  duePending,
  onConfirmAllDue,
  onConfirmDue,
  onSkipDue,
  hasBundles,
  onOpenBundles,
  onOpenCalendarJump,
  onReturnToToday,
}: {
  date: string;
  today: string;
  now: Date;
  width: number;
  selecting: boolean;
  selection: Set<string> | null;
  refreshing: boolean;
  onRefresh: () => void;
  onPress: (e: MealEntry) => void;
  onConfirm: (e: MealEntry) => void;
  onLongPress: (e: MealEntry) => void;
  onToggleSelectAll: (entries: MealEntry[]) => void;
  duePending: MealEntry[];
  onConfirmAllDue: () => void;
  onConfirmDue: (id: string) => void;
  onSkipDue: (id: string) => void;
  hasBundles: boolean;
  onOpenBundles: () => void;
  onOpenCalendarJump: () => void;
  onReturnToToday: () => void;
}) {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { goals, getSplitTotalsForDate, getEntriesForDate, getWorkoutsForDate } =
    useStore();

  const isPageToday = date === today;
  const isFuture = isFutureDay(date);
  const dayLabel = formatDayLabel(date);
  const pageHeader = dayHeaderInfo(date, now);
  // The anchor already carries the weekday when off-today ("Wednesday"), so
  // this sub-line drops it there to avoid saying it twice; on today the
  // anchor just says "Today", so the weekday still earns its place here.
  const dateStr = parseDateKey(date).toLocaleDateString(
    "en-GB",
    isPageToday
      ? { weekday: "long", day: "numeric", month: "long" }
      : { day: "numeric", month: "long" },
  );

  const totals = getSplitTotalsForDate(date);
  const dayEntries = getEntriesForDate(date);
  // getWorkoutsForDate returns [] on a future day (WHOOP has no future
  // workouts), so planned days are untouched by this for free. Workouts
  // NEVER feed totals — only dayEntries does, above and everywhere below.
  const dayWorkouts = getWorkoutsForDate(date);
  const dayStream = buildDayStream(dayEntries, dayWorkouts);

  // ── Time-first add ──────────────────────────────────────────
  //
  // ONE add affordance now, not one button per section: pick WHEN, and
  // meal_type is derived from that time downstream (AddIngredientScreen,
  // via sectionForTime) rather than chosen here. Seeded to now on today; a
  // future/past page has no "now" that means anything, so it seeds midday.
  const [showAddPicker, setShowAddPicker] = useState(false);
  const [addPickerSeed, setAddPickerSeed] = useState(new Date());

  const openAddPicker = () => {
    if (isPageToday) {
      setAddPickerSeed(new Date(now));
    } else {
      const seed = parseDateKey(date);
      seed.setHours(12, 0, 0, 0);
      setAddPickerSeed(seed);
    }
    setShowAddPicker(true);
  };

  const onAddTimePicked = (event: any, picked?: Date) => {
    setShowAddPicker(false);
    if (event?.type === "dismissed" || !picked) return;
    // The page's OWN date, not today — this is what makes "plan for 19:00
    // tomorrow" land on tomorrow. sameTimeOnDay also switches OFF the
    // midnight roll-back heuristic, which would otherwise fight this.
    const eatenAt = sameTimeOnDay(
      { hours: picked.getHours(), minutes: picked.getMinutes() },
      date,
    );
    navigation.navigate("AddIngredient", { date, eatenAt });
  };

  const kcalEaten = Math.round(totals.eaten.calories);
  const kcalPlanned = Math.round(totals.planned.calories);
  const kcalTotal = Math.round(totals.total.calories);
  const over = kcalTotal > goals.calories;
  const kcalRemaining = Math.abs(goals.calories - kcalTotal);

  // ── Sticky condensed bar — driven by THIS page's own scroll only ───
  //
  // The bar should replace the header+hero stack once BOTH have scrolled out
  // — the header now lives in-flow above the hero, so the threshold is their
  // combined height, not the hero's alone. Both default absurdly large (not
  // 0) so the crossfade's input range is nonsense-high until onLayout
  // reports the real numbers — otherwise the bar would flash visible for a
  // frame at scrollY=0 before either is measured.
  const scrollY = useRef(new Animated.Value(0)).current;
  const [headerHeight, setHeaderHeight] = useState(9999);
  const [heroHeight, setHeroHeight] = useState(9999);
  const stickyThreshold = Math.max(
    headerHeight + heroHeight - STICKY_FADE_RANGE,
    0,
  );
  const stickyOpacity = scrollY.interpolate({
    inputRange: [stickyThreshold, stickyThreshold + STICKY_FADE_RANGE],
    outputRange: [0, 1],
    extrapolate: "clamp",
  });
  const stickyTranslateY = scrollY.interpolate({
    inputRange: [stickyThreshold, stickyThreshold + STICKY_FADE_RANGE],
    outputRange: [-8, 0],
    extrapolate: "clamp",
  });

  const stripSegments = [
    { color: MacroColor.protein, fraction: frac(totals.total.protein, goals.protein) },
    { color: MacroColor.carbs, fraction: frac(totals.total.carbs, goals.carbs) },
    { color: MacroColor.fat, fraction: frac(totals.total.fat, goals.fat) },
    { color: MacroColor.satFat, fraction: frac(totals.total.satFat, goals.satFat) },
    { color: MacroColor.salt, fraction: frac(totals.total.salt, goals.salt) },
    { color: MacroColor.fibre, fraction: frac(totals.total.fibre, goals.fibre) },
    { color: MacroColor.sugar, fraction: frac(totals.total.sugar, goals.sugar) },
  ];

  return (
    <View style={{ width }}>
      <Animated.ScrollView
        contentContainerStyle={[
          styles.scroll,
          selecting && { paddingBottom: 160 },
        ]}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
        scrollEventThrottle={16}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true },
        )}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors.green}
            colors={[Colors.green]}
          />
        }
      >
        {/* ── Header — scrolls away with the rest of the day's content;
              the sticky bar below replaces it once it's gone. ─────── */}
        <View
          style={styles.header}
          onLayout={(e) => setHeaderHeight(e.nativeEvent.layout.height)}
        >
          <View style={styles.headerText}>
            <Text style={styles.eyebrow}>{pageHeader.eyebrow}</Text>
            <Text style={styles.anchor}>{pageHeader.anchor}</Text>
            <View style={styles.dateRow}>
              <View
                style={[
                  styles.statusDot,
                  isPageToday ? styles.statusDotLive : styles.statusDotMuted,
                ]}
              />
              <Text style={styles.date}>{dateStr}</Text>
            </View>
          </View>

          <View style={styles.nav}>
            {!isPageToday && (
              <Pressable
                onPress={onReturnToToday}
                style={({ pressed }) => [
                  styles.returnChip,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={styles.returnChipText}>Return to today</Text>
              </Pressable>
            )}
            {hasBundles && !selecting && (
              <Pressable
                onPress={onOpenBundles}
                hitSlop={8}
                style={({ pressed }) => [
                  styles.bundleBtn,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={styles.bundleBtnText}>Bundles</Text>
              </Pressable>
            )}
            <Pressable
              onPress={onOpenCalendarJump}
              hitSlop={8}
              disabled={selecting}
              style={({ pressed }) => [
                styles.calendarBtn,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text style={styles.calendarBtnText}>📅</Text>
            </Pressable>
          </View>
        </View>

        {/* ── Confirmation banner ─────────────────────────── */}
        {isPageToday && !selecting && duePending.length > 0 && (
          <ConfirmBanner
            entries={duePending}
            onConfirmAll={onConfirmAllDue}
            onConfirm={onConfirmDue}
            onSkip={onSkipDue}
          />
        )}

        {/* ── Calorie ring card ───────────────────────────── */}
        <View
          style={styles.ringCard}
          onLayout={(e) => setHeroHeight(e.nativeEvent.layout.height)}
        >
          <CalorieRing
            consumed={kcalEaten}
            planned={kcalPlanned}
            goal={goals.calories}
            size={200}
            stroke={14}
          />

          <View style={styles.ringStatsRow}>
            <RingStat
              label="Goal"
              value={goals.calories.toLocaleString()}
              unit="kcal"
            />
            <View style={styles.ringStatDivider} />
            {/* "Eaten" on a future date is a lie. Nothing has been eaten. */}
            <RingStat
              label={isFuture ? "Planned" : "Eaten"}
              value={(isFuture ? kcalPlanned : kcalEaten).toLocaleString()}
              unit="kcal"
              highlight
            />
            <View style={styles.ringStatDivider} />
            <RingStat
              label={over ? "Over" : "Left"}
              value={Math.abs(goals.calories - kcalTotal).toLocaleString()}
              unit="kcal"
              danger={over}
            />
          </View>

          {/* Why "Left" doesn't equal Goal − Eaten. Say it, don't hide it. */}
          {!isFuture && kcalPlanned > 0 && (
            <Text style={styles.plannedNote}>
              <Text style={styles.plannedNoteStrong}>
                +{kcalPlanned.toLocaleString()} kcal
              </Text>{" "}
              planned, not yet eaten
            </Text>
          )}
        </View>

        {/* ── Macros card ─────────────────────────────────── */}
        {/* Macro bars measure against GOALS, and a plan counts toward a goal —
            dropping tomorrow's protein off tomorrow's screen makes planning
            pointless. So these use `total`, not `eaten`. The correlation is the
            one place a plan is not evidence, and it has its own gate.

            Compact 2-column grid: same MacroBar component, its existing
            `compact` prop (previously unused). Salt is alone on the last row —
            given full width rather than stranded next to empty space. */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Macronutrients</Text>
          <View style={styles.macroGrid}>
            <View style={styles.macroCol}>
              <MacroBar
                compact
                macro="protein"
                consumed={Math.round(totals.total.protein)}
                goal={goals.protein}
              />
            </View>
            <View style={styles.macroCol}>
              <MacroBar
                compact
                macro="carbs"
                consumed={Math.round(totals.total.carbs)}
                goal={goals.carbs}
              />
            </View>
            <View style={styles.macroCol}>
              <MacroBar
                compact
                macro="fat"
                consumed={Math.round(totals.total.fat)}
                goal={goals.fat}
              />
            </View>
            <View style={styles.macroCol}>
              <MacroBar
                compact
                macro="satFat"
                label="Sat fat"
                consumed={Math.round(totals.total.satFat)}
                goal={goals.satFat}
              />
            </View>
            <View style={styles.macroCol}>
              <MacroBar
                compact
                macro="fibre"
                consumed={Math.round(totals.total.fibre)}
                goal={goals.fibre}
              />
            </View>
            <View style={styles.macroCol}>
              <MacroBar
                compact
                macro="sugar"
                consumed={Math.round(totals.total.sugar)}
                goal={goals.sugar}
              />
            </View>
            {/* Salt is the one sub-gram macro: rounded to 2dp, not to a whole
                number, or a real 0.47g day would read as "0g". */}
            <View style={styles.macroColFull}>
              <MacroBar
                compact
                macro="salt"
                consumed={roundSalt(totals.total.salt)}
                goal={goals.salt}
                unit="g"
              />
            </View>
          </View>
        </View>

        {/* ── Select-all affordance ───────────────────────── */}
        {selecting && dayEntries.length > 0 && (
          <Pressable
            style={({ pressed }) => [
              styles.selectAll,
              pressed && { opacity: 0.7 },
            ]}
            onPress={() => onToggleSelectAll(dayEntries)}
          >
            <Text style={styles.selectAllText}>
              {dayEntries.every((e) => selection?.has(e.id))
                ? "Deselect all"
                : `Select all of ${dayLabel.toLowerCase()}`}
            </Text>
          </Pressable>
        )}

        {/* ── Day stream ───────────────────────────────────── */}
        {/* One time-ordered pass over the day (see lib/dayStream.ts) instead
            of four fixed sections. A band header is presentation only — it
            never reflects back into meal_type, which is why every food row
            carries its own inline tag instead of inheriting one from a
            section it no longer sits in. */}
        {dayStream.length === 0 ? (
          <Pressable style={styles.streamEmpty} onPress={openAddPicker}>
            <Text style={styles.streamEmptyText}>
              {isFuture ? "Nothing planned yet" : "Nothing logged yet"}
            </Text>
            <View style={styles.streamEmptyBtn}>
              <Text style={styles.streamEmptyBtnText}>
                {isFuture ? "＋ Plan something" : "＋ Add something"}
              </Text>
            </View>
          </Pressable>
        ) : (
          <View style={streamStyles.card}>
            {dayStream.map((item, i) => {
              if (item.kind === "band") {
                return (
                  <Text key={item.key} style={streamStyles.bandLabel}>
                    {BAND_LABELS[item.band]}
                  </Text>
                );
              }
              // Bordered under everything except the last row of its band —
              // the next band header already reads as a break, a border
              // there would just double it. Applies to both row kinds.
              const next = dayStream[i + 1];
              const isLastOfGroup = !next || next.kind === "band";

              if (item.kind === "workout") {
                return (
                  <WorkoutCard
                    key={item.key}
                    workout={item.workout}
                    bordered={!isLastOfGroup}
                  />
                );
              }

              return (
                <StreamFoodRow
                  key={item.key}
                  entry={item.entry}
                  bordered={!isLastOfGroup}
                  selection={selection}
                  onPress={onPress}
                  onConfirm={onConfirm}
                  onLongPress={onLongPress}
                />
              );
            })}
          </View>
        )}

        <View style={{ height: Spacing.xxl }} />
      </Animated.ScrollView>

      {/* ── Time-first add ───────────────────────────────── */}
      {!selecting && (
        <Pressable
          onPress={openAddPicker}
          hitSlop={6}
          style={({ pressed }) => [
            styles.fab,
            pressed && { opacity: 0.85 },
          ]}
        >
          <Text style={styles.fabText}>＋</Text>
        </Pressable>
      )}

      {showAddPicker && (
        <DateTimePicker
          value={addPickerSeed}
          mode="time"
          is24Hour
          display="default"
          onChange={onAddTimePicked}
        />
      )}

      {/* ── Sticky condensed bar ─────────────────────────── */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.stickyBar,
          {
            opacity: stickyOpacity,
            transform: [{ translateY: stickyTranslateY }],
          },
        ]}
      >
        <View style={styles.stickyIdentity}>
          <View
            style={[
              styles.statusDot,
              pageHeader.isToday ? styles.statusDotLive : styles.statusDotMuted,
            ]}
          />
          <Text style={styles.stickyAnchor}>{pageHeader.anchor}</Text>
        </View>

        <View style={styles.stickyMacroStrip}>
          {stripSegments.map(({ color, fraction }, i) => (
            <View key={i} style={styles.stickyMacroTrack}>
              <View
                style={[
                  styles.stickyMacroFill,
                  { width: `${fraction * 100}%`, backgroundColor: color },
                ]}
              />
            </View>
          ))}
        </View>

        <Text style={[styles.stickyKcal, over && styles.stickyKcalOver]}>
          {over ? "-" : ""}
          {kcalRemaining.toLocaleString()} kcal
        </Text>
      </Animated.View>
    </View>
  );
}

// ─── Selection action bar ───────────────────────────────────────────────────
//
// Two rows. The top row is STATE — "Mark eaten" (only when the selection holds a
// meal that was planned and whose time has passed) and "Set time". The bottom
// row is ORGANISE — copy, bundle, remove, unchanged from D4. Keeping "Mark
// eaten" conditional stops the bar hitting five buttons in the common case of
// selecting already-logged food to copy or bundle.

function SelectionActionBar({
  count,
  busy,
  hasOverduePending,
  onMarkEaten,
  onSetTime,
  onCopy,
  onBundle,
  onDelete,
  onCancel,
}: {
  count: number;
  busy: boolean;
  hasOverduePending: boolean;
  onMarkEaten: () => void;
  onSetTime: () => void;
  onCopy: () => void;
  onBundle: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  return (
    <View style={barStyles.bar}>
      <View style={barStyles.headerRow}>
        <Text style={barStyles.count}>
          {count === 1 ? "1 item selected" : `${count} items selected`}
        </Text>
        <Pressable onPress={onCancel} hitSlop={10} disabled={busy}>
          <Text style={barStyles.cancel}>Done</Text>
        </Pressable>
      </View>

      {busy ? (
        <View style={barStyles.busy}>
          <ActivityIndicator color={Colors.green} />
        </View>
      ) : (
        <View style={barStyles.rows}>
          {/* State row: confirm + retime */}
          <View style={barStyles.actions}>
            {hasOverduePending && (
              <Pressable
                style={({ pressed }) => [
                  barStyles.actionPrimary,
                  pressed && { opacity: 0.85 },
                ]}
                onPress={onMarkEaten}
              >
                <Text style={barStyles.actionPrimaryText}>Mark eaten</Text>
              </Pressable>
            )}
            <Pressable
              style={({ pressed }) => [
                barStyles.action,
                pressed && { opacity: 0.75 },
              ]}
              onPress={onSetTime}
            >
              <Text style={barStyles.actionText}>Set time</Text>
            </Pressable>
          </View>

          {/* Organise row: copy / bundle / remove */}
          <View style={barStyles.actions}>
            <Pressable
              style={({ pressed }) => [
                barStyles.action,
                pressed && { opacity: 0.75 },
              ]}
              onPress={onCopy}
            >
              <Text style={barStyles.actionText}>Copy to…</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                barStyles.action,
                pressed && { opacity: 0.75 },
              ]}
              onPress={onBundle}
            >
              <Text style={barStyles.actionText}>Save bundle</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                barStyles.actionDanger,
                pressed && { opacity: 0.75 },
              ]}
              onPress={onDelete}
            >
              <Text style={barStyles.actionDangerText}>Remove</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

const barStyles = StyleSheet.create({
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: Colors.surface,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.lg,
    gap: Spacing.sm,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  count: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.text,
  },
  cancel: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.green,
  },
  busy: {
    paddingVertical: Spacing.md,
    alignItems: "center",
  },
  rows: {
    gap: 6,
  },
  actions: {
    flexDirection: "row",
    gap: 6,
  },
  action: {
    flex: 1,
    backgroundColor: Colors.greenSoft,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: `${Colors.green}40`,
    paddingVertical: 10,
    paddingHorizontal: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  actionText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.green,
    textAlign: "center",
  },
  // The primary state action — filled, so "Mark eaten" reads as the emphasised
  // thing to do when there's a planned meal waiting on an answer.
  actionPrimary: {
    flex: 1,
    backgroundColor: Colors.green,
    borderRadius: Radius.pill,
    paddingVertical: 10,
    paddingHorizontal: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  actionPrimaryText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.bg,
    textAlign: "center",
  },
  actionDanger: {
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  actionDangerText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.danger,
  },
});

// ─── Apply-a-bundle sheet ───────────────────────────────────────────────────
//
// ⚠ THE LOGGED/PLANNED PILLS ARE NOT DECORATION.
//
// A bundle item at 07:30. It is 19:00. Apply the bundle to TODAY and that item
// lands in the PAST — so the DB trigger derives planned = false, and it enters
// the WHOOP correlation as a meal you ATE. Silently. Through the front door of
// this feature.
//
// You cannot fix that with a `planned` argument; the trigger owns that column,
// correctly. You fix it by SHOWING, before the user commits, that 2 of their 5
// items are about to be recorded as eaten. The language matches ProductScreen's
// existing time chips exactly, because it is the same distinction.

function ApplyBundleSheet({
  visible,
  bundles,
  dayKey,
  onClose,
  onApply,
}: {
  visible: boolean;
  bundles: MealCompositionWithItems[];
  dayKey: string;
  onClose: () => void;
  onApply: (bundle: MealCompositionWithItems, anchor: TimeOfDay) => void;
}) {
  const { renameComposition, removeComposition, removeCompositionItem } =
    useStore();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  // ── Apply-time picker ───────────────────────────────────────
  //
  // Tapping Add doesn't apply immediately — it opens a native time picker,
  // defaulted to the bundle's own saved earliest item time (so "apply at the
  // usual time" is one confirmation, not a full time entry). The picked time
  // becomes the anchor every item shifts against; see anchorTimesOfDay in
  // lib/time.ts and draftsFromComposition in lib/compositions.ts for the
  // offset math and why it stays DST-safe / same-day.
  const [pickingTimeFor, setPickingTimeFor] =
    useState<MealCompositionWithItems | null>(null);
  const [pickerSeed, setPickerSeed] = useState(new Date());

  const openTimePicker = (bundle: MealCompositionWithItems) => {
    // The `bundles` filter in TodayScreen (kind === 'bundle') is what
    // actually keeps a batch out of this sheet — this null-filter is a
    // second, redundant line of defence for the picker's SEED value only:
    // if a batch ever slipped past that filter, it gets skipped here rather
    // than crashing. Was, briefly, the ONLY defence, before the batch-in-
    // Bundles-sheet crash made clear that "shouldn't happen" needs an actual
    // filter upstream, not just a null-safe read down here.
    const bundleTimes = bundle.items
      .map((i) => i.eaten_time)
      .filter((t): t is string => t != null)
      .map(parseTimeOfDay);
    const earliest = earliestTimeOfDay(bundleTimes) ?? {
      hours: DEFAULT_HOUR.breakfast,
      minutes: 0,
    };
    const seed = new Date();
    seed.setHours(earliest.hours, earliest.minutes, 0, 0);
    setPickerSeed(seed);
    setPickingTimeFor(bundle);
  };

  const dayLabel = formatDayLabel(dayKey);

  const commitRename = async (bundleId: string) => {
    const name = draftName.trim();
    setRenaming(null);
    if (!name) return;
    const { error } = await renameComposition(bundleId, name);
    if (error) Alert.alert("Couldn't rename that", error);
  };

  const confirmDeleteBundle = (bundle: MealCompositionWithItems) => {
    Alert.alert("Delete bundle", `Delete "${bundle.name}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const { error } = await removeComposition(bundle.id);
          if (error) Alert.alert("Couldn't delete that", error);
        },
      },
    ]);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={sheetStyles.backdrop} onPress={onClose} />
      <View style={sheetStyles.sheet}>
        <View style={sheetStyles.grabber} />
        <Text style={sheetStyles.title}>
          Add a bundle to {dayLabel.toLowerCase()}
        </Text>

        <ScrollView style={{ maxHeight: 460 }}>
          {bundles.length === 0 && (
            <Text style={sheetStyles.empty}>
              No bundles yet. Long-press a few items on any day and save them as
              one.
            </Text>
          )}

          {bundles.map((bundle) => {
            const preview = previewComposition(bundle, dayKey);
            const kcal = Math.round(
              bundle.items.reduce((s, i) => s + i.calories, 0),
            );
            const isOpen = expanded === bundle.id;

            return (
              <View key={bundle.id} style={sheetStyles.bundle}>
                <View style={sheetStyles.bundleHead}>
                  <Pressable
                    style={{ flex: 1 }}
                    onPress={() => setExpanded(isOpen ? null : bundle.id)}
                    onLongPress={() => {
                      setRenaming(bundle.id);
                      setDraftName(bundle.name);
                    }}
                  >
                    {renaming === bundle.id ? (
                      <TextInput
                        style={sheetStyles.renameInput}
                        value={draftName}
                        onChangeText={setDraftName}
                        autoFocus
                        selectTextOnFocus
                        onBlur={() => commitRename(bundle.id)}
                        onSubmitEditing={() => commitRename(bundle.id)}
                        returnKeyType="done"
                      />
                    ) : (
                      <Text style={sheetStyles.bundleName}>{bundle.name}</Text>
                    )}
                    <Text style={sheetStyles.bundleMeta}>
                      {bundle.items.length}{" "}
                      {bundle.items.length === 1 ? "item" : "items"} · {kcal}{" "}
                      kcal {isOpen ? "▴" : "▾"}
                    </Text>
                  </Pressable>

                  <Pressable
                    style={({ pressed }) => [
                      sheetStyles.applyBtn,
                      pressed && { opacity: 0.8 },
                    ]}
                    onPress={() => openTimePicker(bundle)}
                  >
                    <Text style={sheetStyles.applyBtnText}>Add</Text>
                  </Pressable>
                </View>

                {isOpen && (
                  <View style={sheetStyles.items}>
                    {preview.map(({ item, planned }) => (
                      <View key={item.id} style={sheetStyles.item}>
                        <View style={{ flex: 1 }}>
                          <Text style={sheetStyles.itemName} numberOfLines={1}>
                            {item.name}
                          </Text>
                          <Text style={sheetStyles.itemMeta}>
                            {/* This sheet only ever shows bundle items, whose
                                eaten_time/meal_type are guaranteed non-null by
                                previewComposition's own bundleItemTime guard
                                (it would have thrown before this array ever
                                existed) — the "—" fallback is belt-and-braces
                                display safety, not an expected case. */}
                            {item.eaten_time?.slice(0, 5) ?? "—"} ·{" "}
                            {item.meal_type ? MEAL_LABELS[item.meal_type] : "—"}{" "}
                            · {Math.round(item.calories)} kcal
                          </Text>
                        </View>

                        <View
                          style={[
                            sheetStyles.pill,
                            planned
                              ? sheetStyles.pillPlanned
                              : sheetStyles.pillLogged,
                          ]}
                        >
                          <Text
                            style={[
                              sheetStyles.pillText,
                              planned
                                ? sheetStyles.pillTextPlanned
                                : sheetStyles.pillTextLogged,
                            ]}
                          >
                            {planned ? "Planned" : "Logged"}
                          </Text>
                        </View>

                        <Pressable
                          hitSlop={8}
                          onPress={async () => {
                            const { error } = await removeCompositionItem(
                              bundle.id,
                              item.id,
                            );
                            if (error)
                              Alert.alert("Couldn't remove that", error);
                          }}
                        >
                          <Text style={sheetStyles.remove}>✕</Text>
                        </Pressable>
                      </View>
                    ))}

                    {preview.some((p) => !p.planned) && (
                      <Text style={sheetStyles.note}>
                        Times already past today will be saved as{" "}
                        <Text style={sheetStyles.noteStrong}>eaten</Text>, not
                        planned.
                      </Text>
                    )}

                    <Pressable
                      style={sheetStyles.deleteBundle}
                      onPress={() => confirmDeleteBundle(bundle)}
                    >
                      <Text style={sheetStyles.deleteBundleText}>
                        Delete this bundle
                      </Text>
                    </Pressable>
                  </View>
                )}
              </View>
            );
          })}
          <View style={{ height: Spacing.lg }} />
        </ScrollView>

        <Pressable style={sheetStyles.close} onPress={onClose}>
          <Text style={sheetStyles.closeText}>Close</Text>
        </Pressable>
      </View>

      {pickingTimeFor && (
        <DateTimePicker
          value={pickerSeed}
          mode="time"
          is24Hour
          display="default"
          onChange={(event: any, picked?: Date) => {
            const bundle = pickingTimeFor;
            setPickingTimeFor(null);
            if (event?.type === "dismissed" || !picked || !bundle) return;
            onApply(bundle, {
              hours: picked.getHours(),
              minutes: picked.getMinutes(),
            });
          }}
        />
      )}
    </Modal>
  );
}

// ─── Save-a-bundle sheet ────────────────────────────────────────────────────

function SaveBundleSheet({
  visible,
  entries,
  bundles,
  onClose,
  onCreate,
  onAppend,
}: {
  visible: boolean;
  entries: MealEntry[];
  bundles: MealCompositionWithItems[];
  onClose: () => void;
  onCreate: (name: string) => void;
  onAppend: (bundle: MealCompositionWithItems) => void;
}) {
  const [name, setName] = useState("");
  const n = entries.length;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={sheetStyles.backdrop} onPress={onClose} />
      <View style={sheetStyles.sheet}>
        <View style={sheetStyles.grabber} />
        <Text style={sheetStyles.title}>
          Save {n === 1 ? "this" : `these ${n}`} as a bundle
        </Text>

        <TextInput
          style={sheetStyles.nameInput}
          value={name}
          onChangeText={setName}
          placeholder="Sunday chilli, My breakfast…"
          placeholderTextColor={Colors.textMuted}
          returnKeyType="done"
          onSubmitEditing={() => name.trim() && onCreate(name)}
        />

        <Pressable
          style={({ pressed }) => [
            sheetStyles.primary,
            !name.trim() && sheetStyles.primaryDisabled,
            pressed && name.trim() && { opacity: 0.85 },
          ]}
          disabled={!name.trim()}
          onPress={() => onCreate(name)}
        >
          <Text
            style={[
              sheetStyles.primaryText,
              !name.trim() && sheetStyles.primaryTextDisabled,
            ]}
          >
            Save as a new bundle
          </Text>
        </Pressable>

        {/* Adding to an existing bundle is what makes a bundle EDITOR
            unnecessary: you add food from the day where the food already is. */}
        {bundles.length > 0 && (
          <>
            <Text style={sheetStyles.orLabel}>or add to an existing one</Text>
            <ScrollView style={{ maxHeight: 220 }}>
              {bundles.map((b) => (
                <Pressable
                  key={b.id}
                  style={({ pressed }) => [
                    sheetStyles.appendRow,
                    pressed && { opacity: 0.7 },
                  ]}
                  onPress={() => onAppend(b)}
                >
                  <Text style={sheetStyles.appendName} numberOfLines={1}>
                    {b.name}
                  </Text>
                  <Text style={sheetStyles.appendMeta}>
                    {b.items.length} → {b.items.length + n}
                  </Text>
                </Pressable>
              ))}
              <View style={{ height: Spacing.md }} />
            </ScrollView>
          </>
        )}

        <Pressable style={sheetStyles.close} onPress={onClose}>
          <Text style={sheetStyles.closeText}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

// ─── Copy-to-a-slot sheet (one item, or a multi-select) ──────────────────
//
// Day / Meal / Time, all overridable — the whole point of D5. D6 extends it
// to a multi-select: the sheet now has TWO modes.
//
//   SHARED — every entry lands on ONE chosen {day, meal_type, time}. Meal
//            and Time pickers are visible. Routes through copyEntriesTo /
//            draftsForTarget.
//   EACH   — every entry keeps its OWN meal_type and wall clock; only the
//            day moves. Meal and Time pickers are hidden. Routes through
//            copyEntriesToDay / draftsFromDay.
//
// A single item is ALWAYS shared mode with no toggle — that's "behaves
// exactly as today". The toggle only appears for a multi-select
// (entries.length > 1); which mode WINS by default is a separate question
// from whether the toggle shows — see the opening-mode effect below, and
// don't collapse the two checks back into one "length > 1" gate, which is
// the exact regression that shipped and got caught: it forced single items
// down the EACH branch and silently dropped their Meal/Time pickers.
//
// The Logged/Planned pill is computed from THIS SHEET'S OWN live state on
// every render — never from a source entry's original eaten_at. Move a
// picker into the future and the pill must flip before you commit, the same
// reason ApplyBundleSheet's pills exist: silently recording a plan as
// "eaten" is a WHOOP-correlation bug, not a display nit. In EACH mode the
// pill is built from draftsFromDay + willBePlanned — the SAME builder the
// actual insert goes through — so the preview can't drift from what lands
// (see the DST-switch test in entries.test.ts).
function CopyToSheet({
  visible,
  entries,
  onClose,
  onCopyShared,
  onCopyEach,
}: {
  visible: boolean;
  entries: MealEntry[];
  onClose: () => void;
  onCopyShared: (target: {
    dayKey: string;
    meal_type: MealType;
    time: TimeOfDay;
  }) => void;
  onCopyEach: (dayKey: string) => void;
}) {
  const [mode, setMode] = useState<"shared" | "each">("shared");
  const [dayKey, setDayKey] = useState(todayKey());
  const [mealType, setMealType] = useState<MealType>("breakfast");
  const [time, setTime] = useState<TimeOfDay>({ hours: 8, minutes: 0 });
  const [picking, setPicking] = useState<"date" | "time" | null>(null);

  const showToggle = entries.length > 1;

  // Reseed every time the sheet OPENS on a (possibly new) selection — not on
  // every render, or moving a picker would keep snapping back. Keyed on the
  // selection's ids as well as `visible`: the sheet stays mounted between
  // opens (only its Modal `visible` prop toggles), so re-opening on the SAME
  // set after a Cancel must still reset, not resume the cancelled edit.
  const idsKey = entries.map((e) => e.id).join(",");
  useEffect(() => {
    if (!visible || entries.length === 0) return;

    const shared = sharedMealType(entries);

    if (shared !== null) {
      setMode("shared");
      const earliest = entries.reduce((min, e) =>
        minutesSinceLocalMidnight(e.eaten_at) <
        minutesSinceLocalMidnight(min.eaten_at)
          ? e
          : min,
      );
      setDayKey(dateKey(new Date(earliest.eaten_at)));
      setMealType(shared);
      setTime(localHM(earliest.eaten_at));
    } else {
      setMode("each");
      setDayKey(dateKey(new Date(entries[0].eaten_at)));
    }
  }, [visible, idsKey]);

  if (entries.length === 0) return null;

  const prospectiveEatenAt = sameTimeOnDay(time, dayKey);
  const sharedPlanned = willBePlanned(prospectiveEatenAt);

  // EACH-mode pill: built from the exact drafts copyEntriesToDay will insert
  // — recomputed from `entries`/`dayKey` on every render, so it can't go
  // stale when the Day picker changes.
  const eachDrafts = mode === "each" ? draftsFromDay(entries, dayKey) : [];
  const eachPlannedCount = eachDrafts.filter((d) =>
    willBePlanned(d.eaten_at),
  ).length;
  const eachLoggedCount = eachDrafts.length - eachPlannedCount;

  const timeSeed = new Date();
  timeSeed.setHours(time.hours, time.minutes, 0, 0);

  const title =
    entries.length === 1 ? `Copy "${entries[0].name}"` : `Copy ${entries.length} items`;

  const eachSummary =
    eachLoggedCount > 0 && eachPlannedCount > 0
      ? `${eachLoggedCount} logged · ${eachPlannedCount} planned`
      : eachPlannedCount > 0
        ? `${eachPlannedCount} planned`
        : `${eachLoggedCount} logged`;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={sheetStyles.backdrop} onPress={onClose} />
      <View style={sheetStyles.sheet}>
        <View style={sheetStyles.grabber} />
        <Text style={sheetStyles.title} numberOfLines={1}>
          {title}
        </Text>

        {showToggle && (
          <View style={copyStyles.segmented}>
            <Pressable
              style={[
                copyStyles.segment,
                mode === "each" && copyStyles.segmentActive,
              ]}
              onPress={() => setMode("each")}
            >
              <Text
                style={[
                  copyStyles.segmentText,
                  mode === "each" && copyStyles.segmentTextActive,
                ]}
              >
                Keep each item's meal & time
              </Text>
            </Pressable>
            <Pressable
              style={[
                copyStyles.segment,
                mode === "shared" && copyStyles.segmentActive,
              ]}
              onPress={() => setMode("shared")}
            >
              <Text
                style={[
                  copyStyles.segmentText,
                  mode === "shared" && copyStyles.segmentTextActive,
                ]}
              >
                Same meal & time for all
              </Text>
            </Pressable>
          </View>
        )}

        <Pressable
          style={copyStyles.row}
          onPress={() => setPicking("date")}
        >
          <Text style={copyStyles.rowLabel}>Day</Text>
          <Text style={copyStyles.rowValue}>{formatDayLabel(dayKey)}</Text>
        </Pressable>

        {mode === "shared" && (
          <>
            <Text style={copyStyles.rowLabel}>Meal</Text>
            <View style={copyStyles.segmented}>
              {MEAL_TYPES.map((mt) => (
                <Pressable
                  key={mt}
                  style={[
                    copyStyles.segment,
                    mealType === mt && copyStyles.segmentActive,
                  ]}
                  onPress={() => setMealType(mt)}
                >
                  <Text
                    style={[
                      copyStyles.segmentText,
                      mealType === mt && copyStyles.segmentTextActive,
                    ]}
                  >
                    {MEAL_LABELS[mt]}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Pressable
              style={copyStyles.row}
              onPress={() => setPicking("time")}
            >
              <Text style={copyStyles.rowLabel}>Time</Text>
              <Text style={copyStyles.rowValue}>{formatTimeOfDay(time)}</Text>
            </Pressable>

            <View
              style={[
                sheetStyles.pill,
                sharedPlanned ? sheetStyles.pillPlanned : sheetStyles.pillLogged,
                copyStyles.pill,
              ]}
            >
              <Text
                style={[
                  sheetStyles.pillText,
                  sharedPlanned
                    ? sheetStyles.pillTextPlanned
                    : sheetStyles.pillTextLogged,
                ]}
              >
                {sharedPlanned
                  ? "Will be saved as Planned"
                  : "Will be saved as Logged"}
              </Text>
            </View>
          </>
        )}

        {mode === "each" && (
          <View
            style={[
              sheetStyles.pill,
              eachPlannedCount > 0
                ? sheetStyles.pillPlanned
                : sheetStyles.pillLogged,
              copyStyles.pill,
            ]}
          >
            <Text
              style={[
                sheetStyles.pillText,
                eachPlannedCount > 0
                  ? sheetStyles.pillTextPlanned
                  : sheetStyles.pillTextLogged,
              ]}
            >
              {eachSummary}
            </Text>
          </View>
        )}

        <Pressable
          style={({ pressed }) => [
            sheetStyles.primary,
            pressed && { opacity: 0.85 },
          ]}
          onPress={() =>
            mode === "shared"
              ? onCopyShared({ dayKey, meal_type: mealType, time })
              : onCopyEach(dayKey)
          }
        >
          <Text style={sheetStyles.primaryText}>Copy</Text>
        </Pressable>

        <Pressable style={sheetStyles.close} onPress={onClose}>
          <Text style={sheetStyles.closeText}>Cancel</Text>
        </Pressable>
      </View>

      {picking === "date" && (
        <DateTimePicker
          value={parseDateKey(dayKey)}
          mode="date"
          display="default"
          onChange={(event: any, picked?: Date) => {
            setPicking(null);
            if (event?.type === "dismissed" || !picked) return;
            setDayKey(dateKey(picked));
          }}
        />
      )}

      {picking === "time" && mode === "shared" && (
        <DateTimePicker
          value={timeSeed}
          mode="time"
          is24Hour
          display="default"
          onChange={(event: any, picked?: Date) => {
            setPicking(null);
            if (event?.type === "dismissed" || !picked) return;
            setTime({ hours: picked.getHours(), minutes: picked.getMinutes() });
          }}
        />
      )}
    </Modal>
  );
}

const copyStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: Colors.surface,
    borderRadius: Radius.control,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
  },
  rowLabel: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.semibold,
    fontFamily: Fonts.sans.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  rowValue: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.text,
  },
  segmented: {
    flexDirection: "row",
    gap: 6,
  },
  segment: {
    flex: 1,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentActive: {
    backgroundColor: Colors.greenSoft,
    borderColor: `${Colors.green}60`,
  },
  segmentText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.textMuted,
  },
  segmentTextActive: {
    color: Colors.green,
  },
  pill: {
    alignSelf: "center",
    marginTop: Spacing.xs,
  },
});

const sheetStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  sheet: {
    backgroundColor: Colors.bg,
    borderTopLeftRadius: Radius.card,
    borderTopRightRadius: Radius.card,
    borderTopWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.lg,
    gap: Spacing.sm,
  },
  grabber: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    marginBottom: Spacing.sm,
  },
  title: {
    fontSize: Typography.md,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.text,
    letterSpacing: -0.3,
    marginBottom: Spacing.xs,
  },
  empty: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
    fontFamily: Fonts.sans.medium,
    lineHeight: Typography.sm * 1.5,
    paddingVertical: Spacing.md,
  },

  bundle: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.control,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: Spacing.sm,
    overflow: "hidden",
  },
  bundleHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    padding: Spacing.md,
  },
  bundleName: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.text,
    letterSpacing: -0.2,
  },
  bundleMeta: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
    fontFamily: Fonts.sans.medium,
    marginTop: 2,
  },
  renameInput: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.text,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.control,
    borderWidth: 1,
    borderColor: `${Colors.green}50`,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
  },
  applyBtn: {
    backgroundColor: Colors.green,
    borderRadius: Radius.pill,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  applyBtnText: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.bg,
  },

  items: {
    borderTopWidth: 1,
    borderTopColor: Colors.borderSub,
    backgroundColor: Colors.surface2,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    gap: Spacing.sm,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
  },
  itemName: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    fontFamily: Fonts.sans.semibold,
    color: Colors.text,
  },
  itemMeta: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
    fontFamily: Fonts.sans.medium,
    marginTop: 2,
  },
  pill: {
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  pillPlanned: {
    backgroundColor: `${Colors.blue}12`,
    borderColor: `${Colors.blue}40`,
  },
  pillLogged: {
    backgroundColor: Colors.greenSoft,
    borderColor: `${Colors.green}40`,
  },
  pillText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
  },
  pillTextPlanned: { color: Colors.blue },
  pillTextLogged: { color: Colors.green },
  remove: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    paddingHorizontal: 2,
  },
  note: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
    fontFamily: Fonts.sans.medium,
    lineHeight: Typography.xs * 1.5,
  },
  noteStrong: {
    color: Colors.green,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
  },
  deleteBundle: {
    paddingVertical: Spacing.sm,
    alignItems: "center",
  },
  deleteBundleText: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    fontFamily: Fonts.sans.semibold,
    color: Colors.danger,
  },

  nameInput: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.control,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    fontFamily: Fonts.sans.semibold,
    color: Colors.text,
  },
  primary: {
    backgroundColor: Colors.green,
    borderRadius: Radius.pill,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryDisabled: {
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  primaryText: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.bg,
  },
  primaryTextDisabled: {
    color: Colors.textMuted,
  },
  orLabel: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.semibold,
    fontFamily: Fonts.sans.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: Spacing.sm,
  },
  appendRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: Colors.surface,
    borderRadius: Radius.control,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    marginTop: 6,
    gap: Spacing.sm,
  },
  appendName: {
    flex: 1,
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    fontFamily: Fonts.sans.semibold,
    color: Colors.text,
  },
  appendMeta: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    fontFamily: Fonts.mono.bold,
    color: Colors.green,
    fontVariant: ["tabular-nums"],
  },

  close: {
    paddingVertical: Spacing.md,
    alignItems: "center",
  },
  closeText: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    fontFamily: Fonts.sans.semibold,
    color: Colors.textSub,
  },
});

// ─── Confirmation banner ────────────────────────────────────────────────────
//
// ONE banner, batched, never a per-meal nag. Meal prep is five containers of
// chilli; being asked five separate times is worse than not being asked.
//
// Nothing auto-expires. A user who ignores the app for a day would silently lose
// meals they genuinely ate — under-reporting instead of over-reporting, which is
// the same bias wearing a different hat. Pending meals wait.
//
// NB (D5): this banner is the NEXT-DAY net — it only ever asks about days that
// are already over (getDuePendingEntries). Confirming a meal on the SAME day it
// was planned now happens inline on the row ("Ate it") or in the selection bar
// ("Mark eaten"), so a meal you planned this morning and ate no longer has to
// wait until midnight to count.

function ConfirmBanner({
  entries,
  onConfirmAll,
  onConfirm,
  onSkip,
}: {
  entries: MealEntry[];
  onConfirmAll: () => Promise<void> | void;
  onConfirm: (id: string) => Promise<void> | void;
  onSkip: (id: string) => Promise<void> | void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);

  // "from yesterday" when they're all from one day; otherwise don't pretend.
  const when = useMemo(() => {
    const days = Array.from(new Set(entries.map((e) => e.date)));
    return days.length === 1
      ? formatDayLabel(days[0]).toLowerCase()
      : "the last few days";
  }, [entries]);

  const n = entries.length;

  const handleAll = async () => {
    setBusy(true);
    await onConfirmAll();
    setBusy(false);
  };

  return (
    <View style={bannerStyles.banner}>
      <Text style={bannerStyles.title}>
        {n === 1
          ? `1 planned meal from ${when} — did you eat it?`
          : `${n} planned meals from ${when} — did you eat them?`}
      </Text>

      <View style={bannerStyles.actions}>
        <Pressable
          style={({ pressed }) => [
            bannerStyles.primary,
            pressed && { opacity: 0.85 },
          ]}
          onPress={handleAll}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator size="small" color={Colors.bg} />
          ) : (
            <Text style={bannerStyles.primaryText}>
              {n === 1 ? "Yes, I did" : "All of them"}
            </Text>
          )}
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            bannerStyles.secondary,
            pressed && { opacity: 0.7 },
          ]}
          onPress={() => setExpanded((v) => !v)}
          disabled={busy}
        >
          <Text style={bannerStyles.secondaryText}>
            {expanded ? "Close" : "Review"}
          </Text>
        </Pressable>
      </View>

      {expanded && (
        <View style={bannerStyles.list}>
          {entries.map((e) => (
            <View key={e.id} style={bannerStyles.item}>
              <View style={bannerStyles.itemBody}>
                <Text style={bannerStyles.itemName} numberOfLines={1}>
                  {e.name}
                </Text>
                <Text style={bannerStyles.itemMeta}>
                  {formatDayLabel(e.date)} · {formatTime(e.eaten_at)} ·{" "}
                  {Math.round(e.calories)} kcal
                </Text>
              </View>
              <Pressable
                style={({ pressed }) => [
                  bannerStyles.ate,
                  pressed && { opacity: 0.7 },
                ]}
                onPress={() => onConfirm(e.id)}
              >
                <Text style={bannerStyles.ateText}>Ate it</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  bannerStyles.didnt,
                  pressed && { opacity: 0.7 },
                ]}
                onPress={() => onSkip(e.id)}
              >
                <Text style={bannerStyles.didntText}>Didn't</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const bannerStyles = StyleSheet.create({
  banner: {
    backgroundColor: `${Colors.amber}12`,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: `${Colors.amber}40`,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  title: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    fontFamily: Fonts.sans.semibold,
    color: Colors.text,
    lineHeight: Typography.sm * 1.4,
    marginBottom: Spacing.sm,
  },
  actions: {
    flexDirection: "row",
    gap: Spacing.sm,
  },
  primary: {
    flex: 1,
    backgroundColor: Colors.amber,
    borderRadius: Radius.pill,
    paddingVertical: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.bg,
  },
  secondary: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 9,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: `${Colors.amber}50`,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryText: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.amber,
  },
  list: {
    marginTop: Spacing.md,
    gap: Spacing.sm,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    backgroundColor: Colors.surface,
    borderRadius: Radius.control,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm,
  },
  itemBody: {
    flex: 1,
  },
  itemName: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    fontFamily: Fonts.sans.semibold,
    color: Colors.text,
  },
  itemMeta: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    marginTop: 2,
    fontWeight: Typography.medium,
    fontFamily: Fonts.sans.medium,
  },
  ate: {
    backgroundColor: Colors.greenSoft,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: `${Colors.green}40`,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  ateText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.green,
  },
  didnt: {
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  didntText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.textMuted,
  },
});

// ─── Ring stat ──────────────────────────────────────────────────────────────

function RingStat({
  label,
  value,
  unit,
  highlight,
  danger,
}: {
  label: string;
  value: string;
  unit: string;
  highlight?: boolean;
  danger?: boolean;
}) {
  const valueColor = danger
    ? Colors.coral
    : highlight
      ? Colors.green
      : Colors.text;

  return (
    <View style={statStyles.stat}>
      <Text style={statStyles.label}>{label}</Text>
      <Text style={[statStyles.value, { color: valueColor }]}>{value}</Text>
      <Text style={statStyles.unit}>{unit}</Text>
    </View>
  );
}

const statStyles = StyleSheet.create({
  stat: {
    flex: 1,
    alignItems: "center",
    gap: 1,
  },
  label: {
    fontSize: Typography.xs,
    fontWeight: Typography.medium,
    fontFamily: Fonts.sans.medium,
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  value: {
    fontSize: Typography.lg,
    fontWeight: Typography.bold,
    fontFamily: Fonts.mono.bold,
    letterSpacing: -0.5,
    color: Colors.text,
  },
  unit: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
    fontFamily: Fonts.sans.medium,
  },
});

// ─── Stream food row ────────────────────────────────────────────────────────
//
// The row internals from the old per-section MealSection, unchanged in what
// they DO (time, P/C/F, pending dim, overdue "Ate it" chip, selection
// checkbox, long-press-to-select, tap-to-edit) — the only addition is the
// inline meal-type tag, since a row no longer sits inside a card that named
// its section for it. `bordered` replaces "am I not the last row in my
// section" with "am I not the last row in my BAND", computed by the caller
// from dayStream's own order.

function StreamFoodRow({
  entry,
  bordered,
  selection,
  onPress,
  onConfirm,
  onLongPress,
}: {
  entry: MealEntry;
  bordered: boolean;
  selection: Set<string> | null;
  onPress: (e: MealEntry) => void;
  onConfirm: (e: MealEntry) => void;
  onLongPress: (e: MealEntry) => void;
}) {
  const selecting = selection !== null;
  const pending = isPending(entry);
  // Only ask "Ate it?" once the planned time has actually passed. A future
  // plan (tonight's dinner, seen this afternoon) stays a quiet dimmed row.
  const canConfirmInline = !selecting && isOverduePending(entry);
  const picked = selection?.has(entry.id) ?? false;
  const time = formatTime(entry.eaten_at);

  return (
    <Pressable
      onPress={() => onPress(entry)}
      onLongPress={() => onLongPress(entry)}
      style={({ pressed }) => [
        streamStyles.row,
        bordered && streamStyles.rowBorder,
        pending && streamStyles.rowPending,
        picked && streamStyles.rowPicked,
        pressed && { backgroundColor: Colors.surface2 },
      ]}
    >
      {selecting && (
        <View style={[streamStyles.check, picked && streamStyles.checkOn]}>
          {picked && <Text style={streamStyles.checkMark}>✓</Text>}
        </View>
      )}

      <View style={streamStyles.rowBody}>
        <View style={streamStyles.rowTop}>
          <Text style={streamStyles.rowName} numberOfLines={1}>
            {pending ? "🕐 " : ""}
            {entry.name}
            {entry.brand ? (
              <Text style={streamStyles.rowBrand}> · {entry.brand}</Text>
            ) : null}
          </Text>
          <View style={streamStyles.mealTag}>
            <Text style={streamStyles.mealTagText}>
              {MEAL_LABELS[entry.meal_type]}
            </Text>
          </View>
        </View>
        <Text style={streamStyles.rowMacros}>
          {time ? <Text style={streamStyles.rowTime}>{time} · </Text> : null}
          {servingLabel(entry.serving_g)}
          {"  "}
          <Text style={{ color: Colors.blue }}>
            P {entry.protein.toFixed(1)}
          </Text>
          {"  "}
          <Text style={{ color: Colors.amber }}>
            C {entry.carbs.toFixed(1)}
          </Text>
          {"  "}
          <Text style={{ color: Colors.coral }}>
            F {entry.fat.toFixed(1)}
          </Text>
        </Text>
      </View>

      {/* Inline confirm for an overdue plan. Nested Pressable: the tap is
          handled here and does NOT fall through to the row's edit press. */}
      {canConfirmInline && (
        <Pressable
          onPress={() => onConfirm(entry)}
          hitSlop={6}
          style={({ pressed }) => [
            streamStyles.ateInline,
            pressed && { opacity: 0.7 },
          ]}
        >
          <Text style={streamStyles.ateInlineText}>Ate it</Text>
        </Pressable>
      )}

      <Text
        style={[streamStyles.rowCals, pending && streamStyles.rowCalsPending]}
      >
        {Math.round(entry.calories)}
      </Text>
    </Pressable>
  );
}

// ─── Workout card ───────────────────────────────────────────────────────────
//
// Read-only, cyan (Colors.whoop). Deliberately NOT a Pressable: no tap-to-
// edit, no long-press-to-select, no checkbox — a workout isn't a MealEntry,
// it's never counted by select-all (which only ever walks dayEntries' ids),
// and there is nothing here to edit or delete. energyKilojoule IS rendered,
// as a plain descriptive metric of the session (kcal, alongside strain/
// distance/duration) — but it stays inside this card, never in a daily
// total and never adjacent to the intake ring. Netting burned against eaten
// is still gated by the deferred gross-to-net add-back formula; this is
// display only.

function WorkoutCard({
  workout,
  bordered,
}: {
  workout: Workout;
  bordered: boolean;
}) {
  const durationMin = Math.round(
    (new Date(workout.workoutEnd).getTime() -
      new Date(workout.workoutStart).getTime()) /
      60000,
  );
  const hours = Math.floor(durationMin / 60);
  const mins = durationMin % 60;
  const durationLabel = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  const distanceKm =
    workout.distanceMeter != null ? (workout.distanceMeter / 1000).toFixed(2) : null;

  const kcal = kjToKcal(workout.energyKilojoule);

  return (
    <View style={[workoutStyles.row, bordered && streamStyles.rowBorder]}>
      <View style={workoutStyles.accent} />

      <View style={workoutStyles.body}>
        <View style={workoutStyles.top}>
          <Text style={workoutStyles.sport} numberOfLines={1}>
            {workout.sportName ?? "Workout"}
          </Text>
          {/* Source mark — where a future Garmin/Apple badge lives, keyed
              off the same ingestSource column. */}
          <View style={workoutStyles.sourceTag}>
            <Text style={workoutStyles.sourceTagText}>
              {workout.ingestSource.toUpperCase()}
            </Text>
          </View>
        </View>
        <Text style={workoutStyles.meta}>
          {formatTime(workout.workoutStart)} · {durationLabel}
          {distanceKm ? ` · ${distanceKm} km` : ""}
          {kcal != null && (
            <Text style={workoutStyles.kcal}> · {kcal} kcal</Text>
          )}
        </Text>
      </View>

      {workout.strain != null && (
        <Text style={workoutStyles.strain}>{workout.strain.toFixed(1)}</Text>
      )}
    </View>
  );
}

const workoutStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: Spacing.md,
    paddingVertical: 11,
    backgroundColor: `${Colors.whoop}0C`,
  },
  accent: {
    width: 3,
    alignSelf: "stretch",
    borderRadius: 2,
    backgroundColor: Colors.whoop,
    marginRight: Spacing.sm,
  },
  body: {
    flex: 1,
    marginRight: Spacing.sm,
  },
  top: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing.sm,
  },
  sport: {
    flex: 1,
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    fontFamily: Fonts.sans.semibold,
    color: Colors.text,
    letterSpacing: -0.1,
  },
  sourceTag: {
    flexShrink: 0,
    backgroundColor: `${Colors.whoop}18`,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: `${Colors.whoop}40`,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  sourceTagText: {
    fontSize: 10,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.whoop,
    letterSpacing: 0.3,
  },
  meta: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    marginTop: 3,
    fontWeight: Typography.medium,
    fontFamily: Fonts.mono.medium,
  },
  kcal: {
    fontWeight: Typography.medium,
    fontFamily: Fonts.mono.medium,
    color: Colors.whoop,
  },
  strain: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    fontFamily: Fonts.mono.bold,
    color: Colors.whoop,
    minWidth: 32,
    textAlign: "right",
  },
});

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  scroll: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
  },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: Spacing.md,
  },
  headerText: {
    flex: 1,
  },
  eyebrow: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
    fontFamily: Fonts.sans.medium,
    marginBottom: 2,
  },
  anchor: {
    fontSize: Typography.xl,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.text,
    letterSpacing: -0.5,
  },
  dateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 5,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusDotLive: {
    backgroundColor: Colors.green,
  },
  statusDotMuted: {
    backgroundColor: Colors.textMuted,
  },
  date: {
    fontSize: Typography.sm,
    color: Colors.textSub,
    fontWeight: Typography.medium,
    fontFamily: Fonts.mono.medium,
  },

  nav: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  calendarBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.surface,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  calendarBtnText: {
    fontSize: 16,
  },
  bundleBtn: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    height: 36,
    justifyContent: "center",
  },
  bundleBtnText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.textSub,
  },
  returnChip: {
    backgroundColor: Colors.greenSoft,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: `${Colors.green}40`,
    paddingHorizontal: 12,
    height: 36,
    justifyContent: "center",
  },
  returnChipText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.green,
  },

  pager: {
    flex: 1,
  },

  stickyBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    backgroundColor: Colors.surface2,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderSub,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
  },
  stickyIdentity: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  stickyAnchor: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.text,
  },
  stickyMacroStrip: {
    flex: 1,
    flexDirection: "row",
    gap: 2,
  },
  stickyMacroTrack: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.surface2,
    overflow: "hidden",
  },
  stickyMacroFill: {
    height: "100%",
    borderRadius: 2,
  },
  stickyKcal: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    fontFamily: Fonts.mono.bold,
    color: Colors.text,
    fontVariant: ["tabular-nums"],
  },
  stickyKcalOver: {
    color: Colors.coral,
  },

  selectAll: {
    alignSelf: "flex-start",
    backgroundColor: Colors.surface,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: Spacing.md,
  },
  selectAllText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.textSub,
  },

  ringCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    marginBottom: Spacing.md,
    alignItems: "center",
    gap: Spacing.md,
  },
  ringStatsRow: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    paddingHorizontal: Spacing.sm,
  },
  ringStatDivider: {
    width: 1,
    height: 32,
    backgroundColor: Colors.border,
  },
  plannedNote: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
    fontFamily: Fonts.sans.medium,
    marginTop: -Spacing.sm,
  },
  plannedNoteStrong: {
    color: Colors.textSub,
    fontWeight: Typography.bold,
    fontFamily: Fonts.mono.bold,
  },

  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  cardTitle: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    fontFamily: Fonts.sans.semibold,
    color: Colors.textSub,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: Spacing.md,
  },
  macroGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing.md,
  },
  macroCol: {
    flexBasis: "47%",
    flexGrow: 1,
  },
  macroColFull: {
    flexBasis: "100%",
  },

  // Day-level empty state — one per day, not one per (now-gone) section.
  streamEmpty: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    borderStyle: "dashed",
    paddingVertical: Spacing.xl,
    alignItems: "center",
    gap: Spacing.md,
    marginBottom: Spacing.md,
  },
  streamEmptyText: {
    fontSize: Typography.sm,
    color: Colors.textSub,
    fontWeight: Typography.medium,
    fontFamily: Fonts.sans.medium,
  },
  streamEmptyBtn: {
    backgroundColor: Colors.greenSoft,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: `${Colors.green}40`,
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
  },
  streamEmptyBtnText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.green,
  },

  // Time-first add — one floating affordance per page, replacing the old
  // one-button-per-section rail. Fixed to the page, not the scroll content.
  fab: {
    position: "absolute",
    right: Spacing.md,
    bottom: Spacing.lg,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.green,
    alignItems: "center",
    justifyContent: "center",
    ...Shadow.md,
  },
  fabText: {
    fontSize: 28,
    fontWeight: Typography.bold,
    color: Colors.bg,
    marginTop: -2,
  },
});

const streamStyles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: Spacing.md,
    overflow: "hidden",
  },

  // Band header — presentation only, reuses the rail's old time-label
  // typography rather than a card of its own.
  bandLabel: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    backgroundColor: Colors.surface2,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    paddingBottom: 6,
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: Spacing.md,
    paddingVertical: 11,
  },
  rowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderSub,
  },
  // Dimmed, not greyed out: it still counts toward your goals, it just hasn't
  // happened yet. The row is real; the eating is hypothetical.
  rowPending: {
    opacity: 0.62,
  },
  rowPicked: {
    backgroundColor: Colors.greenSoft,
  },
  check: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: Colors.border,
    marginRight: Spacing.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  checkOn: {
    backgroundColor: Colors.green,
    borderColor: Colors.green,
  },
  checkMark: {
    fontSize: 12,
    lineHeight: 14,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.bg,
  },
  rowBody: {
    flex: 1,
    marginRight: Spacing.sm,
  },
  rowTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing.sm,
  },
  rowName: {
    flex: 1,
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    fontFamily: Fonts.sans.semibold,
    color: Colors.text,
    letterSpacing: -0.1,
  },
  rowBrand: {
    fontWeight: Typography.regular,
    fontFamily: Fonts.sans.regular,
    color: Colors.textMuted,
  },
  // Inline section tag — a row no longer sits inside a card that named its
  // section for it, so each row names its own.
  mealTag: {
    flexShrink: 0,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  mealTagText: {
    fontSize: 10,
    fontWeight: Typography.semibold,
    fontFamily: Fonts.sans.semibold,
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  rowMacros: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    marginTop: 3,
    fontWeight: Typography.medium,
    fontFamily: Fonts.mono.medium,
  },
  rowTime: {
    color: Colors.textSub,
    fontWeight: Typography.semibold,
    fontFamily: Fonts.mono.semibold,
    fontVariant: ["tabular-nums"],
  },
  // Inline "Ate it" — matches the banner's confirm chip (greenSoft, green
  // border/text). Sits between the macros and the calorie figure on an overdue
  // planned row only.
  ateInline: {
    backgroundColor: Colors.greenSoft,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: `${Colors.green}40`,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginRight: Spacing.sm,
  },
  ateInlineText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.green,
  },
  rowCals: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    fontFamily: Fonts.mono.bold,
    color: Colors.text,
    minWidth: 32,
    textAlign: "right",
  },
  rowCalsPending: {
    color: Colors.textSub,
  },
});
