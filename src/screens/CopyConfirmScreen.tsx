// ============================================================
// src/screens/CopyConfirmScreen.tsx
// ============================================================
// Shown before bulk-copying a meal section or a full day.
// Gives the viewer a summary of what will be copied and a
// single confirm button to execute the bulk insert.
// ============================================================

import React, { useState, useLayoutEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";

import {
  Colors,
  Spacing,
  Typography,
  Radius,
  Fonts,
  withDefaultFont,
} from "../theme/tokens";
import { copyEntriesToMyLog } from "../lib/social";
import { sharedMealType } from "../lib/entries";
import { dateKey, sectionForTime, TimeOfDay } from "../lib/time";
import { CopyTargetPicker } from "../components/CopyTargetPicker";
import { MealEntry, MealType, RootStackParamList } from "../types";

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Route = RouteProp<RootStackParamList, "CopyConfirm">;

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

export function CopyConfirmScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const { payload } = route.params;

  const [confirming, setConfirming] = useState(false);

  // ── Copy target: Day/Time/Meal, defaulting to NOW ──────────
  //
  // "Steal this meal idea," not "mirror their day": seeded from a `now`
  // captured ONCE on mount, never from the day being browsed in the friend's
  // log and never from the source entries' own eaten_at. Day/time/meal all
  // derive from that one `now` so they can't disagree across a midnight or
  // noon boundary — same reasoning as TodayScreen's CopyToSheet.
  //
  // `mode` is not user-toggleable here (unlike TodayScreen's multi-select
  // sheet): a meal_section payload's entries always share one meal_type by
  // construction of ConnectedUserLogScreen's grouping (verified — there is no
  // producer that mixes them), and full_day always means "preserve each
  // entry's own section." scope alone determines it.
  const [now] = useState(() => new Date());
  const [dayKey, setDayKey] = useState(() => dateKey(now));
  const [time, setTime] = useState<TimeOfDay>(() => ({
    hours: now.getHours(),
    minutes: now.getMinutes(),
  }));
  const [mealType, setMealType] = useState<MealType>(
    () => sharedMealType(payload.entries) ?? sectionForTime(now.toISOString()),
  );
  const mode: "shared" | "each" =
    payload.scope === "full_day" ? "each" : "shared";

  const totals = sumEntries(payload.entries);
  const itemCount = payload.entries.length;

  useLayoutEffect(() => {
    navigation.setOptions({
      title: "Confirm copy",
      headerBackTitle: "Back",
    });
  }, [navigation]);

  const handleConfirm = async () => {
    setConfirming(true);
    try {
      await copyEntriesToMyLog(payload, {
        dayKey,
        // "each" mode (full_day) preserves each entry's OWN wall clock —
        // null tells draftsFromFeedEntry to resolve it per entry, exactly
        // like meal_type below. Only "shared" mode (meal_section) applies
        // one chosen time to every entry.
        time: mode === "shared" ? time : null,
        meal_type: mode === "shared" ? mealType : null,
      });
      // Go back two screens to Today tab — or just pop to Today
      navigation.popToTop();
      // Small toast-style feedback (native Alert as fallback — replace
      // with a toast library like react-native-toast-message if preferred)
      Alert.alert(
        "Copied!",
        `${itemCount} item${itemCount !== 1 ? "s" : ""} added to your log.`,
        [{ text: "OK" }],
      );
    } catch {
      Alert.alert("Error", "Could not copy entries. Please try again.");
      setConfirming(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["bottom"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero summary */}
        <View style={styles.hero}>
          <Text style={styles.heroTitle}>Copy to your log?</Text>
          <Text style={styles.heroSource}>{payload.sourceName}</Text>

          <View style={styles.statsRow}>
            <View style={styles.statCell}>
              <Text style={styles.statValue}>
                {Math.round(totals.calories)}
              </Text>
              <Text style={styles.statLabel}>kcal</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statCell}>
              <Text style={styles.statValue}>{totals.protein.toFixed(1)}g</Text>
              <Text style={styles.statLabel}>protein</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statCell}>
              <Text style={styles.statValue}>{totals.carbs.toFixed(1)}g</Text>
              <Text style={styles.statLabel}>carbs</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statCell}>
              <Text style={styles.statValue}>{totals.fat.toFixed(1)}g</Text>
              <Text style={styles.statLabel}>fat</Text>
            </View>
          </View>

          {mode === "each" && (
            <View style={styles.destinationRow}>
              <Text style={styles.destinationText}>
                → each item copied to its own section
              </Text>
            </View>
          )}
        </View>

        {/* Copy target: Day always editable; Meal + Time editable only in
            "shared" mode (a single meal_section) — full_day preserves each
            entry's own section, so there is nothing for Meal to override. */}
        <View style={styles.targetCard}>
          <CopyTargetPicker
            dayKey={dayKey}
            onDayKeyChange={setDayKey}
            time={time}
            onTimeChange={setTime}
            mealType={mealType}
            onMealTypeChange={setMealType}
            mode={mode}
          />
        </View>

        {/* Entry breakdown */}
        <Text style={styles.sectionLabel}>
          {itemCount} item{itemCount !== 1 ? "s" : ""}
        </Text>
        <View style={styles.card}>
          {payload.entries.map((entry, i) => (
            <View
              key={entry.id}
              style={[
                styles.entryRow,
                i < payload.entries.length - 1 && styles.entryRowBorder,
              ]}
            >
              <View style={styles.entryMeta}>
                <Text style={styles.entryName} numberOfLines={1}>
                  {entry.name}
                </Text>
                <Text style={styles.entrySub}>
                  {entry.serving_g}g · {entry.meal_type}
                </Text>
              </View>
              <Text style={styles.entryCalories}>
                {Math.round(entry.calories)} kcal
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>

      {/* Sticky confirm button */}
      <View style={styles.footer}>
        <TouchableOpacity
          onPress={handleConfirm}
          disabled={confirming}
          activeOpacity={0.85}
          style={[styles.confirmBtn, confirming && styles.confirmBtnDisabled]}
        >
          {confirming ? (
            <ActivityIndicator color={Colors.bg} />
          ) : (
            <Text style={styles.confirmBtnText}>
              Add {itemCount} item{itemCount !== 1 ? "s" : ""} to my log
            </Text>
          )}
        </TouchableOpacity>
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
  scroll: {
    paddingBottom: Spacing.xxl,
  },

  // Hero
  hero: {
    margin: Spacing.md,
    padding: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: Spacing.sm,
  },
  heroTitle: {
    fontSize: Typography.lg,
    fontWeight: Typography.bold,
    color: Colors.text,
  },
  heroSource: {
    fontSize: Typography.base,
    color: Colors.textMuted,
  },

  // Stats row
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    marginTop: Spacing.sm,
    paddingTop: Spacing.sm,
    borderTopWidth: 1,
    borderTopColor: Colors.borderSub,
  },
  statCell: {
    alignItems: "center",
    gap: 2,
  },
  statValue: {
    fontSize: Typography.md,
    fontWeight: Typography.bold,
    fontFamily: Fonts.mono.bold,
    color: Colors.text,
  },
  statLabel: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
  },
  statDivider: {
    width: 1,
    height: 28,
    backgroundColor: Colors.borderSub,
  },

  // Destination indicator
  destinationRow: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.control,
    padding: Spacing.sm,
  },
  destinationText: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
    textAlign: "center",
  },

  // Copy target (Day/Meal/Time)
  targetCard: {
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.md,
    gap: Spacing.sm,
  },

  // Section label
  sectionLabel: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.textMuted,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.xs,
  },

  // Entry card
  card: {
    marginHorizontal: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  entryRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  entryRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderSub,
  },
  entryMeta: {
    flex: 1,
  },
  entryName: {
    fontSize: Typography.base,
    fontWeight: Typography.medium,
    color: Colors.text,
  },
  entrySub: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
    marginTop: 2,
  },
  entryCalories: {
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    fontFamily: Fonts.mono.semibold,
    color: Colors.textSub,
    marginLeft: Spacing.sm,
  },

  // Footer
  footer: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.md,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    backgroundColor: Colors.bg,
  },
  confirmBtn: {
    backgroundColor: Colors.green,
    borderRadius: Radius.control,
    padding: Spacing.md,
    alignItems: "center",
  },
  confirmBtnDisabled: {
    opacity: 0.6,
  },
  confirmBtnText: {
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.bg,
  },
  }),
);
