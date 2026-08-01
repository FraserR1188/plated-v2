// ============================================================
// src/screens/ConnectedUserLogScreen.tsx
// ============================================================
// Shows a connected user's log for a given date.
// Viewer can copy individual ingredients, full meal sections,
// or the entire day into their own log.
//
// ⚠ todayKey() below is the VIEWER's own local "today" — the target day for
// a copy — and must not be confused with `date` from route params, which is
// the FRIEND's log date being viewed (see the `route.params` destructure
// further down). Two different days, same screen.
// ============================================================

import React, {
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
} from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Alert,
  SectionList,
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
import { getEntriesForUser, followUser, unfollowUser } from "../lib/social";
import { sectionForTime } from "../lib/time";
import { todayKey } from "../store/useStore";
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
    salt_per100: parseFloat(((entry.salt ?? 0) * factor).toFixed(2)),
    fibre_per100: parseFloat(((entry.fibre ?? 0) * factor).toFixed(1)),
    sugar_per100: parseFloat(((entry.sugar ?? 0) * factor).toFixed(1)),
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

// ─── Day summary bar ─────────────────────────────────────────

function DaySummary({ entries }: { entries: MealEntry[] }) {
  const totals = sumEntries(entries);
  return (
    <View style={styles.daySummary}>
      <Text style={styles.daySummaryCalories}>
        {Math.round(totals.calories)}
      </Text>
      <Text style={styles.daySummaryLabel}>kcal today</Text>
      <View style={styles.daySummaryMacros}>
        {[
          {
            label: "protein",
            value: totals.protein,
            color: MacroColor.protein,
          },
          { label: "carbs", value: totals.carbs, color: MacroColor.carbs },
          { label: "fat", value: totals.fat, color: MacroColor.fat },
        ].map((m) => (
          <View key={m.label} style={styles.macroChip}>
            <View style={[styles.macroChipDot, { backgroundColor: m.color }]} />
            <Text style={styles.macroChipText}>{m.value.toFixed(1)}g</Text>
            <Text style={styles.macroChipLabel}> {m.label}</Text>
          </View>
        ))}
      </View>
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
  return (
    <View style={styles.ingredientRow}>
      <View style={styles.ingredientMeta}>
        <Text style={styles.ingredientName} numberOfLines={1}>
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
  onCopySection: (
    entries: MealEntry[],
    mealType: MealType,
    label: string,
  ) => void;
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
            onPress={() => onCopySection(entries, mealType, label)}
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

// ─── Main screen ─────────────────────────────────────────────

export function ConnectedUserLogScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const { profile, date } = route.params;

  const [entries, setEntries] = useState<MealEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const displayName = profile.display_name ?? profile.username;

  // ── Set header title ──────────────────────────────────────

  useLayoutEffect(() => {
    navigation.setOptions({
      title: `${displayName}'s log`,
      headerBackTitle: "Friends",
    });
  }, [navigation, displayName]);

  // ── Load entries ──────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getEntriesForUser(profile.user_id, date)
      .then((data) => {
        if (!cancelled) setEntries(data);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load their log. Try again.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [profile.user_id, date]);

  // ── Group entries by meal ─────────────────────────────────

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

  // ── Copy: single ingredient ───────────────────────────────
  // Opens ProductScreen pre-filled so the viewer can adjust serving size

  const handleCopyIngredient = useCallback(
    (entry: MealEntry) => {
      const product = entryToProduct(entry);
      // ⚠ NOT entry.meal_type. That was inheriting the FRIEND's section as
      // this copy's target — exactly the bug class CLAUDE.md's architecture
      // invariants call out ("never inherit date or section from a source
      // entry"). ProductScreen has no meal-type control (checked — the old
      // comment here claiming "user can change on Product screen" was false),
      // so whatever is passed here is final. This screen lands the copy at
      // eaten_at = now (ProductScreen seeds "now" for date: todayKey()), so
      // sectionForTime(now) is the correct default: a fresh section derived
      // from THIS copy's own time, not borrowed from the source.
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
    (sectionEntries: MealEntry[], mealType: MealType, label: string) => {
      const payload: CopyPayload = {
        scope: "meal_section",
        entries: sectionEntries,
        sourceName: `${displayName}'s ${label}`,
        targetMeal: mealType,
      };
      navigation.navigate("CopyConfirm", { payload, date: todayKey() });
    },
    [navigation, displayName],
  );

  // ── Copy: full day ────────────────────────────────────────

  const handleCopyFullDay = useCallback(() => {
    if (entries.length === 0) return;

    const payload: CopyPayload = {
      scope: "full_day",
      entries,
      sourceName: `${displayName}'s full day`,
      targetMeal: null,
    };
    navigation.navigate("CopyConfirm", { payload, date: todayKey() });
  }, [navigation, entries, displayName]);

  // ── Render ────────────────────────────────────────────────

  if (loading) {
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
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Day summary */}
        {entries.length > 0 && <DaySummary entries={entries} />}

        {/* Copy full day CTA */}
        {entries.length > 0 && (
          <TouchableOpacity
            onPress={handleCopyFullDay}
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
              onCopyIngredient={handleCopyIngredient}
              onCopySection={handleCopySection}
            />
          ))}
        </View>

        {entries.length === 0 && (
          <View style={styles.centred}>
            <Text style={styles.emptyIcon}>🍽️</Text>
            <Text style={styles.emptyText}>
              {displayName} hasn't logged anything today yet.
            </Text>
          </View>
        )}
      </ScrollView>
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
