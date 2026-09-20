// ============================================================
// src/screens/CopyConfirmScreen.tsx
// ============================================================
// The one review step for copying a friend's food into your own log — a
// single ingredient, a meal section, or a full day. Gives the viewer a
// summary of what will be copied, where it lands, and a single confirm
// button; the insert goes through draftsFromFeedEntry → applyEntries.
//
// A single-ingredient copy also gets a grams field (the ReviewRow pattern
// from BundleApplyReviewScreen): the portion rescales the friend's stored
// absolutes by ratio (draftsForCopy → scaleEntryDraftGrams), never through a
// per-100g rebuild. An entry with no saved weight can't be rescaled — the
// field is disabled with an inline note and the entry copies unchanged, with
// serving_g NULL, exactly as a section copy of the same row would.
//
// Every total on this screen is computed from draftsForCopy — the same
// function the confirm button inserts through — so what's shown is what's
// written.
// ============================================================

import React, { useState, useLayoutEffect } from "react";
import {
  View,
  Text,
  TextInput,
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
import {
  copyEntriesToMyLog,
  draftsForCopy,
  initialCopyMealType,
} from "../lib/social";
import { dateKey, TimeOfDay } from "../lib/time";
import { goToCopiedDay } from "../lib/copyDestination";
import { parseGrams } from "../lib/macros";
import { useStore } from "../store/useStore";
import { CopyTargetPicker } from "../components/CopyTargetPicker";
import { KeyboardScreen } from "../components/KeyboardScreen";
import { EntryDraft, MealType, RootStackParamList } from "../types";

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Route = RouteProp<RootStackParamList, "CopyConfirm">;

function sumDrafts(drafts: EntryDraft[]) {
  return drafts.reduce(
    (acc, d) => ({
      calories: acc.calories + d.calories,
      protein: acc.protein + d.protein,
      carbs: acc.carbs + d.carbs,
      fat: acc.fat + d.fat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
}

export function CopyConfirmScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const setViewedDate = useStore((s) => s.setViewedDate);
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
  // A DEFAULT, not an inheritance: see initialCopyMealType for why a
  // single-ingredient copy seeds from now rather than the friend's section.
  const [mealType, setMealType] = useState<MealType>(() =>
    initialCopyMealType(payload, now),
  );
  const mode: "shared" | "each" =
    payload.scope === "full_day" ? "each" : "shared";

  // ── Portion (single-ingredient copy only) ──────────────────
  //
  // Starts at the friend's own serving_g, i.e. an exact copy. `lastGrams` is
  // the last text that parsed to a real weight; the preview AND the insert
  // both use the live text when it parses, else lastGrams — so there is no
  // window where the box, the preview and the write disagree (a tap on
  // Confirm before the field blurs still writes what's shown). An unparseable
  // entry reverts on blur, same as ReviewRow.
  const isIngredient = payload.scope === "ingredient";
  const source = payload.entries[0];
  const rescalable =
    isIngredient && source?.serving_g != null && source.serving_g > 0;
  const [gramsText, setGramsText] = useState(() =>
    rescalable ? String(source.serving_g) : "",
  );
  const [lastGrams, setLastGrams] = useState<number | null>(() =>
    rescalable ? source.serving_g : null,
  );
  const targetGrams = rescalable ? (parseGrams(gramsText) ?? lastGrams) : null;

  const onGramsChange = (text: string) => {
    setGramsText(text);
    const g = parseGrams(text);
    if (g != null) setLastGrams(g);
  };
  const onGramsBlur = () => {
    if (parseGrams(gramsText) == null && lastGrams != null) {
      setGramsText(String(lastGrams));
    }
  };

  const target = {
    dayKey,
    // "each" mode (full_day) preserves each entry's OWN wall clock — null
    // tells draftsFromFeedEntry to resolve it per entry, exactly like
    // meal_type below. "shared" mode (ingredient, meal_section) applies one
    // chosen time to every entry.
    time: mode === "shared" ? time : null,
    meal_type: mode === "shared" ? mealType : null,
  };
  const drafts = draftsForCopy(payload, target, targetGrams);

  const totals = sumDrafts(drafts);
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
      // Same payload, target and targetGrams the preview was built from.
      await copyEntriesToMyLog(payload, target, targetGrams);

      // Land on Today, showing the day the copy went to, and unwind the
      // whole Friends flow on the way — see src/lib/copyDestination.ts for
      // why this is popTo rather than navigate. No success Alert: the
      // copied food is now on screen, which is the same way TodayScreen's
      // own copy flows report themselves. Failures still alert, below.
      goToCopiedDay(navigation, setViewedDate, dayKey);
    } catch {
      Alert.alert("Error", "Could not copy entries. Please try again.");
      setConfirming(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["bottom"]}>
      <KeyboardScreen>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
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
              "shared" mode (a single ingredient or a meal_section) — full_day
              preserves each entry's own section, so there is nothing for Meal
              to override. */}
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
            {isIngredient ? (
              // Single ingredient: the portion is editable. Same shape and
              // accept/revert rule as BundleApplyReviewScreen's ReviewRow;
              // the kcal shown is drafts[0] — the row that will be inserted.
              <View style={styles.entryRow}>
                <View style={styles.entryMeta}>
                  <Text style={styles.entryName} numberOfLines={1}>
                    {source.name}
                  </Text>
                  {!rescalable && (
                    <Text style={styles.entryNote}>
                      No saved weight for this item — copies unchanged.
                    </Text>
                  )}
                </View>
                <View style={styles.gramsQty}>
                  <TextInput
                    style={[
                      styles.gramsInput,
                      !rescalable && styles.gramsInputDisabled,
                    ]}
                    value={rescalable ? gramsText : "—"}
                    onChangeText={onGramsChange}
                    onBlur={onGramsBlur}
                    onSubmitEditing={onGramsBlur}
                    editable={rescalable}
                    keyboardType="decimal-pad"
                    returnKeyType="done"
                    selectTextOnFocus
                  />
                  <Text style={styles.gramsUnit}>g</Text>
                </View>
                <Text style={styles.entryCalories}>
                  {Math.round(drafts[0].calories)} kcal
                </Text>
              </View>
            ) : (
              payload.entries.map((entry, i) => (
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
              ))
            )}
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
      </KeyboardScreen>
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
  // Grams field — same values as BundleApplyReviewScreen's ReviewRow.
  entryNote: {
    fontSize: Typography.xs,
    color: Colors.warning,
    marginTop: 2,
  },
  gramsQty: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginLeft: Spacing.sm,
  },
  gramsInput: {
    width: 56,
    textAlign: "right",
    fontSize: Typography.base,
    fontFamily: Fonts.mono.regular,
    color: Colors.text,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.control,
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  gramsInputDisabled: {
    color: Colors.textMuted,
    borderColor: Colors.borderSub,
  },
  gramsUnit: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
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
