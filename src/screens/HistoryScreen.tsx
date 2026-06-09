import React, { useState } from "react";
import { View, Text, ScrollView, StyleSheet, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useStore } from "../store/useStore";
import { Colors, Spacing, Radius, Typography, MacroColor } from "../theme";

type Range = "7d" | "30d";

export function HistoryScreen() {
  const { entries, goals } = useStore();
  const [range, setRange] = useState<Range>("7d");
  const days = range === "7d" ? 7 : 30;

  // Build day array newest → oldest
  const dayArray = Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - i);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });

  const dayData = dayArray.map((date) => {
    const de = entries.filter((e) => e.date === date);
    return {
      date,
      calories: de.reduce((s, e) => s + e.calories, 0),
      protein: de.reduce((s, e) => s + e.protein, 0),
      carbs: de.reduce((s, e) => s + e.carbs, 0),
      fat: de.reduce((s, e) => s + e.fat, 0),
      salt: de.reduce((s, e) => s + e.salt, 0),
      fibre: de.reduce((s, e) => s + e.fibre, 0),
      sugar: de.reduce((s, e) => s + e.sugar, 0),
      count: de.length,
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

          return (
            <View
              key={day.date}
              style={[styles.dayRow, isEmpty && styles.dayRowEmpty]}
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
            </View>
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
  heading: {
    fontSize: Typography.xl,
    fontWeight: Typography.bold,
    color: Colors.text,
    letterSpacing: -0.5,
  },
  rangePicker: {
    flexDirection: "row",
    backgroundColor: Colors.surface,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 3,
  },
  rangeBtn: {
    paddingVertical: 6,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.full,
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
    borderRadius: Radius.lg,
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
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: `${Colors.green}30`,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 5,
    minWidth: 56,
  },
  adherencePct: {
    fontSize: Typography.md,
    fontWeight: Typography.bold,
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
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingTop: Spacing.sm,
    gap: Spacing.sm,
  },

  // Empty card
  emptyCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
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
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  dayRowEmpty: {
    opacity: 0.45,
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
    borderRadius: Radius.full,
    overflow: "hidden",
    marginBottom: 8,
    position: "relative",
  },
  barFill: {
    height: 5,
    borderRadius: Radius.full,
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
});

const avgStyles = StyleSheet.create({
  stat: {
    flex: 1,
    alignItems: "center",
    gap: 1,
  },
  value: {
    fontSize: Typography.md,
    fontWeight: Typography.bold,
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
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.sm,
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
  },
});

const chipStyles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    borderRadius: Radius.sm,
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
  },
});
