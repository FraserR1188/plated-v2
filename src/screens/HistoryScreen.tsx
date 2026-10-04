import React, { useState } from "react";
import { View, Text, ScrollView, StyleSheet, Pressable } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import { useStore } from "../store/useStore";
import { BottomTabParamList } from "../types";
import { dailyAverages, KnownAverage } from "../lib/historyAverages";
import { dateKey, addDays } from "../lib/time";
import { RangeControl } from "../components/RangeControl";
import {
  Colors,
  Spacing,
  Radius,
  Typography,
  MacroColor,
  Fonts,
  withDefaultFont,
} from "../theme/tokens";

type Range = "7d" | "30d";

const RANGES: { value: Range; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

// Today and History are sibling tabs under the same Tab.Navigator (see
// AppNavigator.tsx) — navigating "to Today" is a same-navigator tab switch,
// not a push onto RootStackParamList, so this is typed off BottomTabParamList
// rather than the NativeStackNavigationProp every push-modal screen uses.
type Nav = BottomTabNavigationProp<BottomTabParamList>;

/**
 * The Data tab's History segment, rendered by DataScreen only (it was once a
 * tab of its own). DataScreen owns the safe-area inset and the screen title,
 * so this draws neither: a second inset pushed the list down by the status
 * bar, and a "History" heading under the segmented control was the same
 * word twice.
 */
export function HistoryScreen() {
  const { goals, getDaySummaryForDate, setViewedDate } = useStore();
  const navigation = useNavigation<Nav>();
  const [range, setRange] = useState<Range>("7d");
  const days = range === "7d" ? 7 : 30;

  // Build day array newest → oldest, in local calendar days (dateKey and
  // addDays, never a hand-built or UTC key).
  const todayKey = dateKey();
  const dayArray = Array.from({ length: days }, (_, i) => addDays(todayKey, -i));

  // Headline figures (calories/macros/count/"logged") are EATEN only — what
  // actually happened that day. Previously this filtered `entries` by date
  // alone, with no regard for planned/skipped/confirmed, so an unconfirmed
  // plan (or even a skipped one) inflated every number below it: the
  // average, "N of 7 logged" and adherence % all derive from `dayData`, so
  // that one unfiltered filter was inflating four surfaces at once. See
  // getDaySummaryForDate in useStore.ts / getDaySummary in lib/entries.ts.
  const summaries = dayArray.map((date) => ({
    date,
    summary: getDaySummaryForDate(date),
  }));

  // The small four are deliberately NOT carried here: the day rows show only
  // P/C/F, and the averages come from the buckets themselves (PL-058), where
  // an unknown stays null instead of being coalesced to a 0 nobody measured.
  const dayData = summaries.map(({ date, summary }) => {
    const eaten = summary.eaten;
    return {
      date,
      calories: eaten.calories,
      protein: eaten.protein,
      carbs: eaten.carbs,
      fat: eaten.fat,
      count: eaten.count,
      // Surfaced separately, never folded into the headline figures above —
      // same "+X kcal planned, not yet eaten" register as TodayScreen's ring.
      pendingCalories: summary.pending.calories,
      pendingCount: summary.pending.count,
    };
  });

  const logged = dayData.filter((d) => d.count > 0);
  // PL-058: one shared rule with Trends — a day where a small-four value is
  // unknown on every row is left out of that average, not counted as 0.
  const avg = dailyAverages(summaries.map(({ summary }) => summary.eaten));

  const fmtDate = (ds: string) => {
    const d = new Date(ds + "T12:00:00");
    if (ds === todayKey) return "Today";
    if (ds === addDays(todayKey, -1)) return "Yesterday";
    return d.toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  };

  // Adherence: days where calories were within ±10% of goal
  const adherent = logged.filter(
    (d) =>
      d.calories >= goals.calories * 0.9 && d.calories <= goals.calories * 1.1,
  ).length;
  const adherencePct = logged.length
    ? Math.round((adherent / logged.length) * 100)
    : 0;

  return (
    <View style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Header ─────────────────────────────────────── */}
        <View style={styles.header}>
          {/* The Data tab's shared range control, top right */}
          <RangeControl options={RANGES} value={range} onChange={setRange} />
        </View>

        {/* ── Average stats card ──────────────────────────── */}
        {avg ? (
          <View style={styles.avgCard}>
            <View style={styles.avgHeader}>
              <View>
                <Text style={styles.avgTitle}>Daily average</Text>
                <Text style={styles.avgSub}>
                  {logged.length} of {days} days logged
                </Text>
              </View>
              <View style={styles.adherenceBadge}>
                <Text style={styles.adherencePct}>{adherencePct}%</Text>
                <Text style={styles.adherenceLabel}>on goal</Text>
              </View>
            </View>

            {/* Primary macro row */}
            <View style={styles.avgDivider} />
            <View style={styles.avgRow}>
              <AvgStat
                label="Calories"
                value={`${avg.calories}`}
                unit="kcal"
                color={Colors.green}
                large
              />
              <View style={styles.avgStatDivider} />
              <AvgStat
                label="Protein"
                value={`${avg.protein}`}
                unit="g"
                color={MacroColor.protein}
              />
              <AvgStat
                label="Carbs"
                value={`${avg.carbs}`}
                unit="g"
                color={MacroColor.carbs}
              />
              <AvgStat
                label="Fat"
                value={`${avg.fat}`}
                unit="g"
                color={MacroColor.fat}
              />
            </View>

            {/* Secondary macro row */}
            <View style={styles.avgSecondaryRow}>
              <SecondaryAvgStat
                label="Sat fat"
                average={avg.satFat}
                color={MacroColor.satFat}
              />
              <SecondaryAvgStat
                label="Salt"
                average={avg.salt}
                color={MacroColor.salt}
              />
              <SecondaryAvgStat
                label="Fibre"
                average={avg.fibre}
                color={MacroColor.fibre}
              />
              <SecondaryAvgStat
                label="Sugar"
                average={avg.sugar}
                color={MacroColor.sugar}
              />
            </View>
          </View>
        ) : (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyEmoji}>📊</Text>
            <Text style={styles.emptyTitle}>No data yet</Text>
            <Text style={styles.emptySubtitle}>
              Start logging meals on the Today tab and your history will appear
              here.
            </Text>
          </View>
        )}

        {/* ── Day rows ─────────────────────────────────────── */}
        <Text style={styles.sectionLabel}>Daily breakdown</Text>

        {dayData.map((day) => {
          const pct =
            goals.calories > 0 ? Math.min(day.calories / goals.calories, 1) : 0;
          const over = day.calories > goals.calories;
          const isEmpty = day.count === 0;
          const hasPending = day.pendingCount > 0;

          return (
            <Pressable
              key={day.date}
              onPress={() => {
                // Store, not a route param — BottomTabParamList.Today stays
                // `undefined`. Today is a tab, not a pushed screen: it stays
                // mounted across tab switches, so a param handed to it once
                // would go stale the next time you arrived here without a
                // fresh navigate call. Setting store state first means
                // TodayScreen (already mounted, subscribed to the store) has
                // re-rendered onto the right day before the tab switch even
                // finishes — see the viewedDate doc comment in useStore.ts.
                setViewedDate(day.date);
                navigation.navigate("Today");
              }}
              // Not dimmed when there's nothing eaten but something pending —
              // "0 eaten, 3 planned" is a day worth reading clearly, not one
              // to fade into the empty-day styling.
              style={({ pressed }) => [
                styles.dayRow,
                isEmpty && !hasPending && styles.dayRowEmpty,
                pressed && styles.dayRowPressed,
              ]}
            >
              <View style={styles.dayTop}>
                <Text style={[styles.dayName, isEmpty && styles.dayNameEmpty]}>
                  {fmtDate(day.date)}
                </Text>
                <Text
                  style={[
                    styles.dayCals,
                    over && styles.dayCalsOver,
                    isEmpty && styles.dayCalsEmpty,
                  ]}
                >
                  {isEmpty ? "Not logged" : `${Math.round(day.calories)} kcal`}
                </Text>
              </View>

              {!isEmpty && (
                <>
                  {/* Calorie progress bar */}
                  <View style={styles.barTrack}>
                    <View
                      style={[
                        styles.barFill,
                        {
                          width: `${pct * 100}%` as any,
                          backgroundColor: over ? Colors.coral : Colors.green,
                        },
                      ]}
                    />
                    {/* Goal marker line */}
                    <View style={styles.goalMarker} />
                  </View>

                  {/* Macro chips */}
                  <View style={styles.chipRow}>
                    <MacroChip
                      label="P"
                      value={`${day.protein.toFixed(1)}g`}
                      color={MacroColor.protein}
                    />
                    <MacroChip
                      label="C"
                      value={`${day.carbs.toFixed(1)}g`}
                      color={MacroColor.carbs}
                    />
                    <MacroChip
                      label="F"
                      value={`${day.fat.toFixed(1)}g`}
                      color={MacroColor.fat}
                    />
                    <View style={styles.chipSpacer} />
                    <Text style={styles.itemCount}>
                      {day.count} item{day.count !== 1 ? "s" : ""}
                    </Text>
                  </View>
                </>
              )}

              {hasPending && (
                <Text style={styles.pendingNote}>
                  <Text style={styles.pendingNoteStrong}>
                    +{Math.round(day.pendingCalories)} kcal
                  </Text>{" "}
                  planned, not yet eaten · {day.pendingCount} item
                  {day.pendingCount !== 1 ? "s" : ""}
                </Text>
              )}
            </Pressable>
          );
        })}

        <View style={{ height: Spacing.xxl }} />
      </ScrollView>
    </View>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function AvgStat({
  label,
  value,
  unit,
  color,
  large,
}: {
  label: string;
  value: string;
  unit: string;
  color: string;
  large?: boolean;
}) {
  return (
    <View style={avgStyles.stat}>
      <Text style={[avgStyles.value, { color }, large && avgStyles.valueLarge]}>
        {value}
      </Text>
      <Text style={[avgStyles.unit, large && { color }]}>{unit}</Text>
      <Text style={avgStyles.label}>{label}</Text>
    </View>
  );
}

/**
 * PL-058: a small-four average can be unknown (no logged day had a value) or
 * partial (some days were left out). Both are said out loud — "—" and
 * "n of N days" — rather than shown as a confident number.
 */
function SecondaryAvgStat({
  label,
  average,
  color,
}: {
  label: string;
  average: KnownAverage;
  color: string;
}) {
  const partial =
    average.value != null && average.knownDays < average.loggedDays;
  return (
    <View style={avgStyles.secondary}>
      <View style={[avgStyles.secondaryDot, { backgroundColor: color }]} />
      <Text style={avgStyles.secondaryLabel}>{label}</Text>
      <View style={avgStyles.secondaryValueCol}>
        <Text
          style={[
            avgStyles.secondaryValue,
            { color: average.value == null ? Colors.textMuted : color },
          ]}
        >
          {average.value == null ? "—" : `${average.value}g`}
        </Text>
        {partial && (
          <Text style={avgStyles.secondaryNote}>
            {average.knownDays} of {average.loggedDays} days
          </Text>
        )}
      </View>
    </View>
  );
}

function MacroChip({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <View style={[chipStyles.chip, { backgroundColor: `${color}15` }]}>
      <Text style={[chipStyles.label, { color }]}>{label}</Text>
      <Text style={[chipStyles.value, { color }]}>{value}</Text>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create(
  withDefaultFont({
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
    justifyContent: "flex-end",
    marginBottom: Spacing.md,
  },

  // Average card
  avgCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  avgHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: Spacing.md,
  },
  avgTitle: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.text,
    letterSpacing: -0.2,
  },
  avgSub: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    marginTop: 2,
    fontWeight: Typography.medium,
  },
  adherenceBadge: {
    alignItems: "center",
    backgroundColor: Colors.greenSoft,
    borderRadius: Radius.control,
    borderWidth: 1,
    borderColor: `${Colors.green}30`,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 5,
    minWidth: 56,
  },
  adherencePct: {
    fontSize: Typography.md,
    fontWeight: Typography.bold,
    fontFamily: Fonts.mono.bold,
    color: Colors.green,
    letterSpacing: -0.5,
  },
  adherenceLabel: {
    fontSize: 9,
    fontWeight: Typography.semibold,
    color: Colors.green,
    opacity: 0.8,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  avgDivider: {
    height: 1,
    backgroundColor: Colors.border,
    marginBottom: Spacing.md,
  },
  avgRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: Spacing.sm,
  },
  avgStatDivider: {
    width: 1,
    height: 36,
    backgroundColor: Colors.border,
    marginHorizontal: 4,
  },
  avgSecondaryRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingTop: Spacing.sm,
    gap: Spacing.sm,
  },

  // Empty card
  emptyCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.xl,
    alignItems: "center",
    marginBottom: Spacing.md,
    gap: Spacing.sm,
  },
  emptyEmoji: { fontSize: 36 },
  emptyTitle: {
    fontSize: Typography.md,
    fontWeight: Typography.semibold,
    color: Colors.text,
  },
  emptySubtitle: {
    fontSize: Typography.sm,
    color: Colors.textSub,
    textAlign: "center",
    lineHeight: Typography.sm * 1.6,
    maxWidth: 260,
  },

  // Section label
  sectionLabel: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.7,
    marginBottom: Spacing.sm,
  },

  // Day rows
  dayRow: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.control,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  dayRowEmpty: {
    opacity: 0.45,
  },
  dayRowPressed: {
    opacity: 0.7,
  },
  dayTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  dayName: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    color: Colors.text,
    letterSpacing: -0.1,
  },
  dayNameEmpty: {
    color: Colors.textSub,
  },
  dayCals: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    fontFamily: Fonts.mono.bold,
    color: Colors.text,
  },
  dayCalsOver: {
    color: Colors.coral,
  },
  dayCalsEmpty: {
    fontSize: Typography.xs,
    fontWeight: Typography.medium,
    color: Colors.textMuted,
  },
  barTrack: {
    height: 5,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.pill,
    overflow: "hidden",
    marginBottom: 8,
    position: "relative",
  },
  barFill: {
    height: 5,
    borderRadius: Radius.pill,
  },
  goalMarker: {
    position: "absolute",
    right: 0,
    top: -1,
    width: 1,
    height: 7,
    backgroundColor: Colors.border,
  },
  chipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  chipSpacer: { flex: 1 },
  itemCount: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
  },
  // Same register as TodayScreen's plannedNote — a plan is never folded into
  // the headline figures above, only ever noted alongside them.
  pendingNote: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
    marginTop: 6,
  },
  pendingNoteStrong: {
    color: Colors.textSub,
    fontWeight: Typography.bold,
    fontFamily: Fonts.mono.bold,
  },
  }),
);

const avgStyles = StyleSheet.create(
  withDefaultFont({
    stat: {
      flex: 1,
      alignItems: "center",
      gap: 1,
    },
    value: {
      fontSize: Typography.md,
      fontWeight: Typography.bold,
      fontFamily: Fonts.mono.bold,
      letterSpacing: -0.5,
    },
    valueLarge: {
      fontSize: Typography.lg,
    },
    unit: {
      fontSize: Typography.xs,
      color: Colors.textMuted,
      fontWeight: Typography.medium,
    },
    label: {
      fontSize: Typography.xs,
      color: Colors.textMuted,
      fontWeight: Typography.medium,
      marginTop: 1,
    },
    secondary: {
      flexBasis: "47%",
      flexGrow: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      backgroundColor: Colors.surface2,
      borderRadius: Radius.control,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 6,
    },
    secondaryDot: {
      width: 5,
      height: 5,
      borderRadius: 3,
    },
    secondaryLabel: {
      fontSize: Typography.xs,
      color: Colors.textMuted,
      fontWeight: Typography.medium,
      flex: 1,
    },
    secondaryValue: {
      fontSize: Typography.xs,
      fontWeight: Typography.bold,
      fontFamily: Fonts.mono.bold,
    },
    secondaryValueCol: {
      alignItems: "flex-end",
    },
    secondaryNote: {
      fontSize: 10,
      color: Colors.textMuted,
      fontWeight: Typography.medium,
    },
  }),
);

const chipStyles = StyleSheet.create(
  withDefaultFont({
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      borderRadius: Radius.control,
      paddingHorizontal: 7,
      paddingVertical: 3,
    },
    label: {
      fontSize: Typography.xs,
      fontWeight: Typography.bold,
      letterSpacing: 0.2,
    },
    value: {
      fontSize: Typography.xs,
      fontWeight: Typography.semibold,
      fontFamily: Fonts.mono.semibold,
    },
  }),
);
