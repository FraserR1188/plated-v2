import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Alert,
  RefreshControl,
  Pressable,
} from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SafeAreaView } from "react-native-safe-area-context";
import { CalorieRing } from "../components/CalorieRing";
import { MacroBar } from "../components/MacroBar";
import { useStore, todayKey } from "../store/useStore";
import { mealEntryToProduct } from "../lib/foodLookup";
import { formatTime } from "../lib/time";
import { Colors, Spacing, Radius, Typography } from "../theme";
import {
  RootStackParamList,
  MealEntry,
  MealType,
  MEAL_TYPES,
  MEAL_LABELS,
  MEAL_ICONS,
} from "../types";

export function TodayScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const {
    goals,
    getTotalsForDate,
    getEntriesForMeal,
    deleteEntry,
    fetchEntries,
  } = useStore();
  const [refreshing, setRefreshing] = useState(false);
  const today = todayKey();
  const totals = getTotalsForDate(today);

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

  // Tap a logged item → edit its serving size / time on ProductScreen
  const handleEdit = (entry: MealEntry) => {
    navigation.navigate("Product", {
      product: mealEntryToProduct(entry),
      date: entry.date,
      mealType: entry.meal_type,
      editEntryId: entry.id,
      initialServingG: entry.serving_g,
      initialEatenAt: entry.eaten_at ?? entry.logged_at,
    });
  };

  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const dateStr = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  return (
    // top + left + right only — tab bar handles bottom inset
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
        <View style={styles.header}>
          <View>
            <Text style={styles.greeting}>{greeting}</Text>
            <Text style={styles.date}>{dateStr}</Text>
          </View>
          {/* Streak / badge — placeholder for future feature */}
          <View style={styles.streakBadge}>
            <Text style={styles.streakEmoji}>🔥</Text>
            <Text style={styles.streakText}>4</Text>
          </View>
        </View>

        {/* ── Calorie ring card ───────────────────────────── */}
        <View style={styles.ringCard}>
          <CalorieRing
            consumed={Math.round(totals.calories)}
            goal={goals.calories}
            size={200}
            stroke={14}
          />

          {/* Three stats below the ring */}
          <View style={styles.ringStatsRow}>
            <RingStat
              label="Goal"
              value={goals.calories.toLocaleString()}
              unit="kcal"
            />
            <View style={styles.ringStatDivider} />
            <RingStat
              label="Eaten"
              value={Math.round(totals.calories).toLocaleString()}
              unit="kcal"
              highlight
            />
            <View style={styles.ringStatDivider} />
            <RingStat
              label={totals.calories > goals.calories ? "Over" : "Left"}
              value={Math.abs(
                goals.calories - Math.round(totals.calories),
              ).toLocaleString()}
              unit="kcal"
              danger={totals.calories > goals.calories}
            />
          </View>
        </View>

        {/* ── Macros card ─────────────────────────────────── */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Macronutrients</Text>
          <View style={styles.macroList}>
            <MacroBar
              macro="protein"
              consumed={Math.round(totals.protein)}
              goal={goals.protein}
            />
            <MacroBar
              macro="carbs"
              consumed={Math.round(totals.carbs)}
              goal={goals.carbs}
            />
            <MacroBar
              macro="fat"
              consumed={Math.round(totals.fat)}
              goal={goals.fat}
            />
            <MacroBar
              macro="satFat"
              label="Sat fat"
              consumed={Math.round(totals.satFat)}
              goal={goals.satFat}
            />
            <MacroBar
              macro="fibre"
              consumed={Math.round(totals.fibre)}
              goal={goals.fibre}
            />
            <MacroBar
              macro="sugar"
              consumed={Math.round(totals.sugar)}
              goal={goals.sugar}
            />
            <MacroBar
              macro="salt"
              consumed={totals.salt}
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
            entries={getEntriesForMeal(today, mealType)}
            onAdd={() =>
              navigation.navigate("AddIngredient", { date: today, mealType })
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
  onAdd,
  onEdit,
  onDelete,
}: {
  mealType: MealType;
  entries: MealEntry[];
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
      {/* Header row */}
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
            <Text style={mealStyles.addBtnText}>＋ Add</Text>
          </Pressable>
        </View>
      </View>

      {/* Ingredient rows — tap to edit, long-press to remove */}
      {entries.map((entry, i) => {
        const time = formatTime(entry.eaten_at ?? entry.logged_at);
        return (
          <Pressable
            key={entry.id}
            onPress={() => onEdit(entry)}
            onLongPress={() => onDelete(entry)}
            style={({ pressed }) => [
              mealStyles.row,
              i < entries.length - 1 && mealStyles.rowBorder,
              pressed && { backgroundColor: Colors.surface2 },
            ]}
          >
            <View style={mealStyles.rowBody}>
              <Text style={mealStyles.rowName} numberOfLines={1}>
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
            <Text style={mealStyles.rowCals}>{Math.round(entry.calories)}</Text>
          </Pressable>
        );
      })}

      {/* Empty state */}
      {entries.length === 0 && (
        <Pressable onPress={onAdd} style={mealStyles.empty}>
          <Text style={mealStyles.emptyText}>
            Tap to log {MEAL_LABELS[mealType].toLowerCase()}
          </Text>
        </Pressable>
      )}

      {/* Macro summary footer — only when items exist */}
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

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: Spacing.lg,
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
  streakBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Colors.surface,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  streakEmoji: { fontSize: 14 },
  streakText: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    color: Colors.text,
  },

  // Ring card
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

  // Macros card
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

  // Header
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

  // Ingredient rows
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

  // Empty state
  empty: {
    paddingVertical: Spacing.lg,
    alignItems: "center",
  },
  emptyText: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
  },

  // Footer
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
