import React, { useCallback, useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
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
import { previewBundle } from "../lib/bundles";
import {
  formatTime,
  formatDayLabel,
  isFutureDay,
  parseDateKey,
  dateKey,
  addDays,
} from "../lib/time";
import { Colors, Spacing, Radius, Typography } from "../theme";
import {
  RootStackParamList,
  MealEntry,
  MealBundleWithItems,
  MealType,
  MEAL_TYPES,
  MEAL_LABELS,
  MEAL_ICONS,
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

/** Salt is sub-gram, so Math.round() would collapse it to 0 — and the raw float
 *  sum shows a "0.4660000000000001" tail. Floored to 2dp: trims the noise, keeps
 *  small values visible (0.04 stays 0.04, not "0.0"), and the +1e-9 nudge stops
 *  a value like 0.47 slipping to 0.46 on FP error. Swap Math.floor→Math.round if
 *  you'd rather round to nearest. */
const roundSalt = (g: number): number => Math.floor(g * 100 + 1e-9) / 100;

export function TodayScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const {
    goals,
    bundles,
    getSplitTotalsForDate,
    getEntriesForMeal,
    getEntriesForDate,
    getDuePendingEntries,
    confirmEntries,
    skipEntries,
    retimeEntries,
    deleteEntry,
    deleteEntries,
    copyEntriesToDay,
    saveBundleFromEntries,
    addEntriesToBundle,
    applyBundleToDay,
    fetchEntries,
    fetchBundles,
  } = useStore();

  const [refreshing, setRefreshing] = useState(false);

  // ── The selected day ────────────────────────────────────────
  const [selected, setSelected] = useState(todayKey());
  const [showJump, setShowJump] = useState(false);

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
    null | "apply" | "save" | "copy" | "time" // copy = date picker; time = bulk retime
  >(null);
  const [busy, setBusy] = useState(false);

  const today = todayKey();
  const isToday = selected === today;
  const isFuture = isFutureDay(selected);

  const totals = getSplitTotalsForDate(selected);
  const duePending = getDuePendingEntries();

  useFocusEffect(
    useCallback(() => {
      fetchEntries();
      fetchBundles();
    }, []),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([fetchEntries(), fetchBundles()]);
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

  // Copy-a-day: pick the target day, then copy. Each row keeps its own wall
  // clock and its own meal section — Monday's 12:30 lunch becomes Tuesday's
  // 12:30 LUNCH, not "whatever section you picked".
  const onCopyDayPicked = async (event: any, picked?: Date) => {
    setSheet(null);
    if (event?.type === "dismissed" || !picked) return;

    setBusy(true);
    const { error } = await copyEntriesToDay(selectedEntries, dateKey(picked));
    setBusy(false);

    if (error) {
      Alert.alert("Couldn't copy those", error);
      return;
    }
    const target = dateKey(picked);
    exitSelection();
    setSelected(target); // land on the day you just filled. Show, don't tell.
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

  // Greeting only makes sense on the day you're actually living through.
  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  const dayLabel = formatDayLabel(selected);
  const dateStr = parseDateKey(selected).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  const kcalEaten = Math.round(totals.eaten.calories);
  const kcalPlanned = Math.round(totals.planned.calories);
  const kcalTotal = Math.round(totals.total.calories);
  const over = kcalTotal > goals.calories;

  const dayEntries = getEntriesForDate(selected);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          selecting && { paddingBottom: 160 },
        ]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors.green}
            colors={[Colors.green]}
          />
        }
      >
        {/* ── Header ─────────────────────────────────────── */}
        <View style={styles.header}>
          <Pressable
            onPress={() => setShowJump(true)}
            style={({ pressed }) => [
              styles.headerText,
              pressed && { opacity: 0.7 },
            ]}
            disabled={selecting}
          >
            <Text style={styles.greeting}>{isToday ? greeting : dayLabel}</Text>
            <Text style={styles.date}>
              {dateStr} <Text style={styles.dateCaret}>▾</Text>
            </Text>
          </Pressable>

          <View style={styles.nav}>
            {bundles.length > 0 && !selecting && (
              <Pressable
                onPress={() => setSheet("apply")}
                hitSlop={8}
                style={({ pressed }) => [
                  styles.bundleBtn,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={styles.bundleBtnText}>Bundles</Text>
              </Pressable>
            )}
            <NavBtn
              label="‹"
              onPress={() => setSelected(addDays(selected, -1))}
            />
            <NavBtn
              label="›"
              onPress={() => setSelected(addDays(selected, 1))}
            />
          </View>
        </View>

        {!isToday && (
          <Pressable
            style={({ pressed }) => [
              styles.backToToday,
              pressed && { opacity: 0.7 },
            ]}
            onPress={() => setSelected(today)}
          >
            <Text style={styles.backToTodayText}>Back to today</Text>
          </Pressable>
        )}

        {showJump && (
          <DateTimePicker
            value={parseDateKey(selected)}
            mode="date"
            display="default"
            onChange={onJump}
          />
        )}

        {sheet === "copy" && (
          <DateTimePicker
            value={parseDateKey(selected)}
            mode="date"
            display="default"
            onChange={onCopyDayPicked}
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

        {/* ── Confirmation banner ─────────────────────────── */}
        {isToday && !selecting && duePending.length > 0 && (
          <ConfirmBanner
            entries={duePending}
            onConfirmAll={() => confirmEntries(duePending.map((e) => e.id))}
            onConfirm={(id) => confirmEntries([id])}
            onSkip={(id) => skipEntries([id])}
          />
        )}

        {/* ── Calorie ring card ───────────────────────────── */}
        <View style={styles.ringCard}>
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
            one place a plan is not evidence, and it has its own gate. */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Macronutrients</Text>
          <View style={styles.macroList}>
            <MacroBar
              macro="protein"
              consumed={Math.round(totals.total.protein)}
              goal={goals.protein}
            />
            <MacroBar
              macro="carbs"
              consumed={Math.round(totals.total.carbs)}
              goal={goals.carbs}
            />
            <MacroBar
              macro="fat"
              consumed={Math.round(totals.total.fat)}
              goal={goals.fat}
            />
            <MacroBar
              macro="satFat"
              label="Sat fat"
              consumed={Math.round(totals.total.satFat)}
              goal={goals.satFat}
            />
            <MacroBar
              macro="fibre"
              consumed={Math.round(totals.total.fibre)}
              goal={goals.fibre}
            />
            <MacroBar
              macro="sugar"
              consumed={Math.round(totals.total.sugar)}
              goal={goals.sugar}
            />
            {/* Salt is the one sub-gram macro: rounded to 2dp, not to a whole
                number, or a real 0.47g day would read as "0g". */}
            <MacroBar
              macro="salt"
              consumed={roundSalt(totals.total.salt)}
              goal={goals.salt}
              unit="g"
            />
          </View>
        </View>

        {/* ── Select-all affordance ───────────────────────── */}
        {selecting && dayEntries.length > 0 && (
          <Pressable
            style={({ pressed }) => [
              styles.selectAll,
              pressed && { opacity: 0.7 },
            ]}
            onPress={() => {
              const all = dayEntries.map((e) => e.id);
              const allSelected = all.every((id) => selection?.has(id));
              setSelection(allSelected ? null : new Set(all));
            }}
          >
            <Text style={styles.selectAllText}>
              {dayEntries.every((e) => selection?.has(e.id))
                ? "Deselect all"
                : `Select all of ${dayLabel.toLowerCase()}`}
            </Text>
          </Pressable>
        )}

        {/* ── Meal sections ───────────────────────────────── */}
        {MEAL_TYPES.map((mealType) => (
          <MealSection
            key={mealType}
            mealType={mealType}
            entries={getEntriesForMeal(selected, mealType)}
            isFuture={isFuture}
            selection={selection}
            onAdd={() =>
              // The SELECTED date, not today. This is the whole feature.
              navigation.navigate("AddIngredient", { date: selected, mealType })
            }
            onPress={handlePress}
            onConfirm={handleConfirmOne}
            onLongPress={selecting ? toggle : beginSelection}
          />
        ))}

        <View style={{ height: Spacing.xxl }} />
      </ScrollView>

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
        onApply={async (bundle) => {
          setBusy(true);
          const { error } = await applyBundleToDay(bundle, selected);
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
    </SafeAreaView>
  );
}

// ─── Date nav ───────────────────────────────────────────────────────────────

function NavBtn({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      style={({ pressed }) => [styles.navBtn, pressed && { opacity: 0.6 }]}
    >
      <Text style={styles.navBtnText}>{label}</Text>
    </Pressable>
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
    color: Colors.text,
  },
  cancel: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
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
    borderRadius: Radius.full,
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
    color: Colors.green,
    textAlign: "center",
  },
  // The primary state action — filled, so "Mark eaten" reads as the emphasised
  // thing to do when there's a planned meal waiting on an answer.
  actionPrimary: {
    flex: 1,
    backgroundColor: Colors.green,
    borderRadius: Radius.full,
    paddingVertical: 10,
    paddingHorizontal: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  actionPrimaryText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    color: Colors.bg,
    textAlign: "center",
  },
  actionDanger: {
    borderRadius: Radius.full,
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
  bundles: MealBundleWithItems[];
  dayKey: string;
  onClose: () => void;
  onApply: (bundle: MealBundleWithItems) => void;
}) {
  const { renameBundle, removeBundle, removeBundleItem } = useStore();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const dayLabel = formatDayLabel(dayKey);

  const commitRename = async (bundleId: string) => {
    const name = draftName.trim();
    setRenaming(null);
    if (!name) return;
    const { error } = await renameBundle(bundleId, name);
    if (error) Alert.alert("Couldn't rename that", error);
  };

  const confirmDeleteBundle = (bundle: MealBundleWithItems) => {
    Alert.alert("Delete bundle", `Delete "${bundle.name}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const { error } = await removeBundle(bundle.id);
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
            const preview = previewBundle(bundle, dayKey);
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
                    onPress={() => onApply(bundle)}
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
                            {item.eaten_time.slice(0, 5)} ·{" "}
                            {MEAL_LABELS[item.meal_type]} ·{" "}
                            {Math.round(item.calories)} kcal
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
                            const { error } = await removeBundleItem(
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
  bundles: MealBundleWithItems[];
  onClose: () => void;
  onCreate: (name: string) => void;
  onAppend: (bundle: MealBundleWithItems) => void;
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

const sheetStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  sheet: {
    backgroundColor: Colors.bg,
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
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
    color: Colors.text,
    letterSpacing: -0.3,
    marginBottom: Spacing.xs,
  },
  empty: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
    lineHeight: Typography.sm * 1.5,
    paddingVertical: Spacing.md,
  },

  bundle: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
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
    color: Colors.text,
    letterSpacing: -0.2,
  },
  bundleMeta: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
    marginTop: 2,
  },
  renameInput: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.text,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: `${Colors.green}50`,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
  },
  applyBtn: {
    backgroundColor: Colors.green,
    borderRadius: Radius.full,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  applyBtnText: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
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
    color: Colors.text,
  },
  itemMeta: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
    marginTop: 2,
  },
  pill: {
    borderRadius: Radius.full,
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
  },
  pillTextPlanned: { color: Colors.blue },
  pillTextLogged: { color: Colors.green },
  remove: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
    fontWeight: Typography.bold,
    paddingHorizontal: 2,
  },
  note: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
    lineHeight: Typography.xs * 1.5,
  },
  noteStrong: {
    color: Colors.green,
    fontWeight: Typography.bold,
  },
  deleteBundle: {
    paddingVertical: Spacing.sm,
    alignItems: "center",
  },
  deleteBundleText: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.danger,
  },

  nameInput: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.text,
  },
  primary: {
    backgroundColor: Colors.green,
    borderRadius: Radius.full,
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
    color: Colors.bg,
  },
  primaryTextDisabled: {
    color: Colors.textMuted,
  },
  orLabel: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: Spacing.sm,
  },
  appendRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
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
    color: Colors.text,
  },
  appendMeta: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
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
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: `${Colors.amber}40`,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  title: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
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
    borderRadius: Radius.full,
    paddingVertical: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    color: Colors.bg,
  },
  secondary: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 9,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: `${Colors.amber}50`,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryText: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
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
    borderRadius: Radius.md,
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
    color: Colors.text,
  },
  itemMeta: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    marginTop: 2,
    fontWeight: Typography.medium,
  },
  ate: {
    backgroundColor: Colors.greenSoft,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: `${Colors.green}40`,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  ateText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    color: Colors.green,
  },
  didnt: {
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  didntText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
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
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  value: {
    fontSize: Typography.lg,
    fontWeight: Typography.bold,
    letterSpacing: -0.5,
    color: Colors.text,
  },
  unit: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
  },
});

// ─── Meal section ───────────────────────────────────────────────────────────

function MealSection({
  mealType,
  entries,
  isFuture,
  selection,
  onAdd,
  onPress,
  onConfirm,
  onLongPress,
}: {
  mealType: MealType;
  entries: MealEntry[];
  isFuture: boolean;
  selection: Set<string> | null;
  onAdd: () => void;
  onPress: (e: MealEntry) => void;
  onConfirm: (e: MealEntry) => void;
  onLongPress: (e: MealEntry) => void;
}) {
  const selecting = selection !== null;

  const calories = entries.reduce((s, e) => s + e.calories, 0);
  const protein = entries.reduce((s, e) => s + e.protein, 0);
  const carbs = entries.reduce((s, e) => s + e.carbs, 0);
  const fat = entries.reduce((s, e) => s + e.fat, 0);

  return (
    <View style={mealStyles.section}>
      <View style={mealStyles.header}>
        <View style={mealStyles.headerLeft}>
          <View style={mealStyles.iconWrap}>
            <Text style={mealStyles.icon}>{MEAL_ICONS[mealType]}</Text>
          </View>
          <Text style={mealStyles.title}>{MEAL_LABELS[mealType]}</Text>
        </View>
        <View style={mealStyles.headerRight}>
          {entries.length > 0 && (
            <Text style={mealStyles.calories}>{Math.round(calories)} kcal</Text>
          )}
          {!selecting && (
            <Pressable
              onPress={onAdd}
              style={({ pressed }) => [
                mealStyles.addBtn,
                pressed && { opacity: 0.6 },
              ]}
              hitSlop={8}
            >
              <Text style={mealStyles.addBtnText}>
                {isFuture ? "＋ Plan" : "＋ Add"}
              </Text>
            </Pressable>
          )}
        </View>
      </View>

      {entries.map((entry, i) => {
        const pending = isPending(entry);
        // Only ask "Ate it?" once the planned time has actually passed. A future
        // plan (tonight's dinner, seen this afternoon) stays a quiet dimmed row.
        const canConfirmInline = !selecting && isOverduePending(entry);
        const picked = selection?.has(entry.id) ?? false;
        const time = formatTime(entry.eaten_at);
        return (
          <Pressable
            key={entry.id}
            onPress={() => onPress(entry)}
            onLongPress={() => onLongPress(entry)}
            style={({ pressed }) => [
              mealStyles.row,
              i < entries.length - 1 && mealStyles.rowBorder,
              pending && mealStyles.rowPending,
              picked && mealStyles.rowPicked,
              pressed && { backgroundColor: Colors.surface2 },
            ]}
          >
            {selecting && (
              <View style={[mealStyles.check, picked && mealStyles.checkOn]}>
                {picked && <Text style={mealStyles.checkMark}>✓</Text>}
              </View>
            )}

            <View style={mealStyles.rowBody}>
              <Text style={mealStyles.rowName} numberOfLines={1}>
                {pending ? "🕐 " : ""}
                {entry.name}
                {entry.brand ? (
                  <Text style={mealStyles.rowBrand}> · {entry.brand}</Text>
                ) : null}
              </Text>
              <Text style={mealStyles.rowMacros}>
                {time ? (
                  <Text style={mealStyles.rowTime}>{time} · </Text>
                ) : null}
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
                  mealStyles.ateInline,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={mealStyles.ateInlineText}>Ate it</Text>
              </Pressable>
            )}

            <Text
              style={[mealStyles.rowCals, pending && mealStyles.rowCalsPending]}
            >
              {Math.round(entry.calories)}
            </Text>
          </Pressable>
        );
      })}

      {entries.length === 0 && !selecting && (
        <Pressable onPress={onAdd} style={mealStyles.empty}>
          <Text style={mealStyles.emptyText}>
            Tap to {isFuture ? "plan" : "log"}{" "}
            {MEAL_LABELS[mealType].toLowerCase()}
          </Text>
        </Pressable>
      )}

      {entries.length > 0 && (
        <View style={mealStyles.footer}>
          <Text style={mealStyles.footerText}>
            <Text style={{ color: Colors.blue }}>P {protein.toFixed(1)}g</Text>
            {"   "}
            <Text style={{ color: Colors.amber }}>C {carbs.toFixed(1)}g</Text>
            {"   "}
            <Text style={{ color: Colors.coral }}>F {fat.toFixed(1)}g</Text>
          </Text>
        </View>
      )}
    </View>
  );
}

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
  greeting: {
    fontSize: Typography.xl,
    fontWeight: Typography.bold,
    color: Colors.text,
    letterSpacing: -0.5,
  },
  date: {
    fontSize: Typography.sm,
    color: Colors.textSub,
    marginTop: 3,
    fontWeight: Typography.medium,
  },
  dateCaret: {
    color: Colors.textMuted,
  },

  nav: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  navBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.surface,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  navBtnText: {
    fontSize: 20,
    lineHeight: 24,
    marginTop: -2,
    color: Colors.textSub,
    fontWeight: Typography.bold,
  },
  bundleBtn: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    height: 36,
    justifyContent: "center",
  },
  bundleBtnText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    color: Colors.textSub,
  },

  backToToday: {
    alignSelf: "flex-start",
    backgroundColor: Colors.greenSoft,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: `${Colors.green}40`,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginBottom: Spacing.md,
    marginTop: -Spacing.xs,
  },
  backToTodayText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    color: Colors.green,
  },

  selectAll: {
    alignSelf: "flex-start",
    backgroundColor: Colors.surface,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: Spacing.md,
  },
  selectAllText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    color: Colors.textSub,
  },

  ringCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.md,
    marginBottom: Spacing.md,
    alignItems: "center",
    gap: Spacing.lg,
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
    marginTop: -Spacing.sm,
  },
  plannedNoteStrong: {
    color: Colors.textSub,
    fontWeight: Typography.bold,
  },

  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  cardTitle: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    color: Colors.textSub,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: Spacing.md,
  },
  macroList: {
    gap: Spacing.md,
  },
});

const mealStyles = StyleSheet.create({
  section: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: Spacing.md,
    overflow: "hidden",
  },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: Spacing.md,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: Radius.sm,
    backgroundColor: Colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  icon: { fontSize: 16 },
  title: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.text,
    letterSpacing: -0.2,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
  },
  calories: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    color: Colors.textSub,
  },
  addBtn: {
    backgroundColor: Colors.greenSoft,
    borderRadius: Radius.full,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: `${Colors.green}40`,
  },
  addBtnText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    color: Colors.green,
    letterSpacing: 0.2,
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
    color: Colors.bg,
  },
  rowBody: {
    flex: 1,
    marginRight: Spacing.sm,
  },
  rowName: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    color: Colors.text,
    letterSpacing: -0.1,
  },
  rowBrand: {
    fontWeight: Typography.regular,
    color: Colors.textMuted,
  },
  rowMacros: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    marginTop: 3,
    fontWeight: Typography.medium,
  },
  rowTime: {
    color: Colors.textSub,
    fontWeight: Typography.semibold,
    fontVariant: ["tabular-nums"],
  },
  // Inline "Ate it" — matches the banner's confirm chip (greenSoft, green
  // border/text). Sits between the macros and the calorie figure on an overdue
  // planned row only.
  ateInline: {
    backgroundColor: Colors.greenSoft,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: `${Colors.green}40`,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginRight: Spacing.sm,
  },
  ateInlineText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    color: Colors.green,
  },
  rowCals: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    color: Colors.text,
    minWidth: 32,
    textAlign: "right",
  },
  rowCalsPending: {
    color: Colors.textSub,
  },

  empty: {
    paddingVertical: Spacing.lg,
    alignItems: "center",
  },
  emptyText: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
  },

  footer: {
    borderTopWidth: 1,
    borderTopColor: Colors.borderSub,
    paddingHorizontal: Spacing.md,
    paddingVertical: 9,
    backgroundColor: Colors.surface2,
  },
  footerText: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
  },
});
