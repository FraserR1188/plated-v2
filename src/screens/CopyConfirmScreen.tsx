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

import { Colors, Spacing, Typography, Radius } from "../theme";
import { copyEntriesToMyLog } from "../lib/social";
import { MealEntry, RootStackParamList } from "../types";

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
      await copyEntriesToMyLog(payload);
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

          {payload.targetMeal && (
            <View style={styles.destinationRow}>
              <Text style={styles.destinationText}>
                → copied to{" "}
                <Text style={styles.destinationMeal}>
                  {payload.targetMeal.charAt(0).toUpperCase() +
                    payload.targetMeal.slice(1)}
                </Text>{" "}
                in today's log
              </Text>
            </View>
          )}
          {!payload.targetMeal && (
            <View style={styles.destinationRow}>
              <Text style={styles.destinationText}>
                → each meal copied to the same section in today's log
              </Text>
            </View>
          )}
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

const styles = StyleSheet.create({
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
    borderRadius: Radius.lg,
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
    borderRadius: Radius.sm,
    padding: Spacing.sm,
  },
  destinationText: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
    textAlign: "center",
  },
  destinationMeal: {
    color: Colors.text,
    fontWeight: Typography.semibold,
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
    borderRadius: Radius.lg,
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
    borderRadius: Radius.md,
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
});
