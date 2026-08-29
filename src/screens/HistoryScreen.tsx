import React, { useState } from "react";
import { View, Text, ScrollView, StyleSheet, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import { useStore } from "../store/useStore";
import { BottomTabParamList } from "../types";
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

// Today and History are sibling tabs under the same Tab.Navigator (see
// AppNavigator.tsx) — navigating "to Today" is a same-navigator tab switch,
// not a push onto RootStackParamList, so this is typed off BottomTabParamList
// rather than the NativeStackNavigationProp every push-modal screen uses.
type Nav = BottomTabNavigationProp<BottomTabParamList>;

export function HistoryScreen() {
  const { goals, getDaySummaryForDate, setViewedDate } = useStore();
  const navigation = useNavigation<Nav>();
  const [range, setRange] = useState<Range>("7d");
  const days = range === "7d" ? 7 : 30;

  // Build day array newest → oldest
  const dayArray = Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - i);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });

  // Headline figures (calories/macros/count/"logged") are EATEN only — what
  // actually happened that day. Previously this filtered `entries` by date
  // alone, with no regard for planned/skipped/confirmed, so an unconfirmed
  // plan (or even a skipped one) inflated every number below it: the
  // average, "N of 7 logged" and adherence % all derive from `dayData`, so
  // that one unfiltered filter was inflating four surfaces at once. See
  // getDaySummaryForDate in useStore.ts / getDaySummary in lib/entries.ts.
  const dayData = dayArray.map((date) => {
    const summary = getDaySummaryForDate(date);
    const eaten = summary.eaten;
    return {
      date,
      calories: eaten.calories,
      protein: eaten.protein,
      carbs: eaten.carbs,
      fat: eaten.fat,
      // Nullable on the bucket (unknown vs zero — see DayBucket in
      // lib/entries.ts); coalesced to 0 here at the display boundary, same
      // as everywhere else in the app that reads a nullable macro.
      satFat: eaten.satFat ?? 0,
      salt: eaten.salt ?? 0,
      fibre: eaten.fibre ?? 0,
      sugar: eaten.sugar ?? 0,
      count: eaten.count,
      // Surfaced separately, never folded into the headline figures above —
      // same "+X kcal planned, not yet eaten" register as TodayScreen's ring.
      pendingCalories: summary.pending.calories,
      pendingCount: summary.pending.count,
    };
  });

  const logged = dayData.filter((d) => d.count > 0);
  const avg = logged.length
    ? {
        calories: Math.round(
          logged.reduce((s, d) => s + d.calories, 0) / logged.length,
        ),
        protein: +(
          logged.reduce((s, d) => s + d.protein, 0) / logged.length
        ).toFixed(1),
        carbs: +(
          logged.reduce((s, d) => s + d.carbs, 0) / logged.length
        ).toFixed(1),
        fat: +(logged.reduce((s, d) => s + d.fat, 0) / logged.length).toFixed(
          1,
        ),
        satFat: +(
          logged.reduce((s, d) => s + d.satFat, 0) / logged.length
        ).toFixed(1),
        salt: +(logged.reduce((s, d) => s + d.salt, 0) / logged.length).toFixed(
          2,
        ),
        fibre: +(
          logged.reduce((s, d) => s + d.fibre, 0) / logged.length
        ).toFixed(1),
        sugar: +(
          logged.reduce((s, d) => s + d.sugar, 0) / logged.length
        ).toFixed(1),
      }
    : null;

  const fmtDate = (ds: string) => {
    const d = new Date(ds + "T12:00:00");
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const yd = new Date(now);
    yd.setDate(yd.getDate() - 1);
    const ydStr = `${yd.getFullYear()}-${String(yd.getMonth() + 1).padStart(2, "0")}-${String(yd.getDate()).padStart(2, "0")}`;
    if (ds === todayStr) return "Today";
    if (ds === ydStr) return "Yesterday";
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
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Header ─────────────────────────────────────── */}
        <View style={styles.header}>
          <Text style={styles.heading}>History</Text>

          {/* Range picker — pill toggle */}
          <View style={styles.rangePicker}>
            {(["7d", "30d"] as Range[]).map((r) => (
              <Pressable
                key={r}
                style={[styles.rangeBtn, range === r && styles.rangeBtnOn]}
                onPress={() => setRange(r)}
              >
                <Text
                  style={[styles.rangeTxt, range === r && styles.rangeTxtOn]}
                >
                  {r === "7d" ? "7 days" : "30 days"}
                </Text>
              </Pressable>
            ))}
          </View>
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
                value={`${avg.satFat}g`}
                color={MacroColor.satFat}
              />
              <SecondaryAvgStat
                label="Salt"
                value={`${avg.salt}g`}
                color={MacroColor.salt}
              />
              <SecondaryAvgStat
                label="Fibre"
                value={`${avg.fibre}g`}
                color={MacroColor.fibre}
              />
              <SecondaryAvgStat
                label="Sugar"
                value={`${avg.sugar}g`}
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
    </SafeAreaView>
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

function SecondaryAvgStat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <View style={avgStyles.secondary}>
      <View style={[avgStyles.secondaryDot, { backgroundColor: color }]} />
      <Text style={avgStyles.secondaryLabel}>{label}</Text>
      <Text style={[avgStyles.secondaryValue, { color }]}>{value}</Text>
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
    justifyContent: "space-between",
    marginBottom: Spacing.lg,
  },
  heading: {
    fontSize: Typography.xl,
    fontWeight: Typography.bold,
    color: Colors.text,
    letterSpacing: -0.5,
  },
  rangePicker: {
    flexDirection: "row",
    backgroundColor: Colors.surface,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 3,
  },
  rangeBtn: {
    paddingVertical: 6,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.pill,
    alignItems: "center",
  },
  rangeBtnOn: {
    backgroundColor: Colors.green,
  },
  rangeTxt: {
    fontSize: Typography.xs,
    color: Colors.textSub,
    fontWeight: Typography.medium,
  },
  rangeTxtOn: {
    color: Colors.bg,
    fontWeight: Typography.bold,
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
