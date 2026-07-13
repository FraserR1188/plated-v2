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
} from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SafeAreaView } from "react-native-safe-area-context";
import DateTimePicker from "@react-native-community/datetimepicker";
import { CalorieRing } from "../components/CalorieRing";
import { MacroBar } from "../components/MacroBar";
import { useStore, todayKey } from "../store/useStore";
import { mealEntryToProduct } from "../lib/foodLookup";
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
  MealType,
  MEAL_TYPES,
  MEAL_LABELS,
  MEAL_ICONS,
} from "../types";

/** Awaiting an answer. Mirrors the store's predicate; kept local for row styling. */
const isPending = (e: MealEntry) =>
  e.planned && !e.confirmed_at && !e.skipped_at;

export function TodayScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const {
    goals,
    getSplitTotalsForDate,
    getEntriesForMeal,
    getDuePendingEntries,
    confirmEntries,
    skipEntries,
    deleteEntry,
    fetchEntries,
  } = useStore();

  const [refreshing, setRefreshing] = useState(false);

  // ── The selected day ────────────────────────────────────────
  //
  // This was `const today = todayKey()` — a hardcoded constant, which is why
  // there was no way to reach any other day. It costs nothing to make it state:
  // fetchEntries() already pulls EVERY row and the selectors filter client-side,
  // so walking through days is pure useState. No new query, no loading spinner.
  const [selected, setSelected] = useState(todayKey());
  const [showJump, setShowJump] = useState(false);

  const today = todayKey();
  const isToday = selected === today;
  const isFuture = isFutureDay(selected);

  const totals = getSplitTotalsForDate(selected);

  // The banner only ever appears on the REAL today, and only about days that
  // are OVER. A lunch you planned for 13:00 today is not something the app
  // should interrogate you about at 14:00 — it waits and joins tomorrow's batch.
  const duePending = getDuePendingEntries();

  useFocusEffect(
    useCallback(() => {
      fetchEntries();
    }, []),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchEntries();
    setRefreshing(false);
  };

  const handleDelete = (entry: MealEntry) => {
    Alert.alert("Remove item", `Remove "${entry.name}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => deleteEntry(entry.id),
      },
    ]);
  };

  const handleEdit = (entry: MealEntry) => {
    navigation.navigate("Product", {
      product: mealEntryToProduct(entry),
      date: entry.date,
      mealType: entry.meal_type,
      editEntryId: entry.id,
      initialServingG: entry.serving_g,
      initialEatenAt: entry.eaten_at,
    });
  };

  const onJump = (event: any, picked?: Date) => {
    setShowJump(false);
    if (event?.type === "dismissed" || !picked) return;
    setSelected(dateKey(picked));
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

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
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
        {/* The streak badge that used to live here was a hardcoded `🔥 4` — a
            literal, rendering as a real number to a real user, lying for weeks.
            Deleted. It comes back when something actually computes it. */}
        <View style={styles.header}>
          <Pressable
            onPress={() => setShowJump(true)}
            style={({ pressed }) => [
              styles.headerText,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={styles.greeting}>{isToday ? greeting : dayLabel}</Text>
            <Text style={styles.date}>
              {dateStr} <Text style={styles.dateCaret}>▾</Text>
            </Text>
          </Pressable>

          <View style={styles.nav}>
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

        {/* ── Confirmation banner ─────────────────────────── */}
        {isToday && duePending.length > 0 && (
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
            <MacroBar
              macro="salt"
              consumed={totals.total.salt}
              goal={goals.salt}
              unit="g"
            />
          </View>
        </View>

        {/* ── Meal sections ───────────────────────────────── */}
        {MEAL_TYPES.map((mealType) => (
          <MealSection
            key={mealType}
            mealType={mealType}
            entries={getEntriesForMeal(selected, mealType)}
            isFuture={isFuture}
            onAdd={() =>
              // The SELECTED date, not today. This is the whole feature.
              navigation.navigate("AddIngredient", { date: selected, mealType })
            }
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        ))}

        <View style={{ height: Spacing.xxl }} />
      </ScrollView>
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

// ─── Confirmation banner ────────────────────────────────────────────────────
//
// ONE banner, batched, never a per-meal nag. Meal prep is five containers of
// chilli; being asked five separate times is worse than not being asked.
//
// Nothing auto-expires. A user who ignores the app for a day would silently lose
// meals they genuinely ate — under-reporting instead of over-reporting, which is
// the same bias wearing a different hat. Pending meals wait.

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
  onAdd,
  onEdit,
  onDelete,
}: {
  mealType: MealType;
  entries: MealEntry[];
  isFuture: boolean;
  onAdd: () => void;
  onEdit: (e: MealEntry) => void;
  onDelete: (e: MealEntry) => void;
}) {
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
        </View>
      </View>

      {entries.map((entry, i) => {
        const pending = isPending(entry);
        const time = formatTime(entry.eaten_at);
        return (
          <Pressable
            key={entry.id}
            onPress={() => onEdit(entry)}
            onLongPress={() => onDelete(entry)}
            style={({ pressed }) => [
              mealStyles.row,
              i < entries.length - 1 && mealStyles.rowBorder,
              pending && mealStyles.rowPending,
              pressed && { backgroundColor: Colors.surface2 },
            ]}
          >
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
                {Math.round(entry.serving_g)}g{"  "}
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
            <Text
              style={[mealStyles.rowCals, pending && mealStyles.rowCalsPending]}
            >
              {Math.round(entry.calories)}
            </Text>
          </Pressable>
        );
      })}

      {entries.length === 0 && (
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
