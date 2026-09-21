// ============================================================
// The Trends segment of the Data tab: a nutrient picker, a 7/14-day
// toggle, and one small-multiple chart per selected nutrient.
//
// The aggregation is lib/trends.ts and nothing is computed here. The
// selection and range are remembered per user in AsyncStorage
// (lib/trendsPrefs.ts) and cleared by the store's reset() on sign-out.
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  LayoutChangeEvent,
} from "react-native";
import { useStore } from "../store/useStore";
import {
  DEFAULT_NUTRIENTS,
  MAX_SELECTED,
  RANGE_DAYS,
  TREND_NUTRIENTS,
  TrendNutrient,
  TrendRange,
  buildTrendSeries,
  capMessageFor,
  toggleNutrient,
} from "../lib/trends";
import { readTrendsPrefs, writeTrendsPrefs } from "../lib/trendsPrefs";
import { TrendChart } from "./TrendChart";
import {
  Colors,
  Radius,
  Spacing,
  Typography,
  withDefaultFont,
} from "../theme/tokens";

export function TrendsPanel() {
  const entries = useStore((s) => s.entries);
  const goals = useStore((s) => s.goals);
  const goalsState = useStore((s) => s.goalsState);
  const userId = useStore((s) => s.userId);

  const [nutrients, setNutrients] = useState<TrendNutrient[]>(DEFAULT_NUTRIENTS);
  const [range, setRange] = useState<TrendRange>(7);
  const [width, setWidth] = useState(0);
  const [capMessage, setCapMessage] = useState<string | null>(null);

  // The message clears itself: it answers a tap, and an explanation that
  // outlives the thing it explains becomes furniture.
  const capTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!capMessage) return;
    capTimer.current = setTimeout(() => setCapMessage(null), 2600);
    return () => {
      if (capTimer.current) clearTimeout(capTimer.current);
    };
  }, [capMessage]);

  // Seed from the remembered preference, once per user. A failed or absent
  // read leaves the defaults in place, which is always a valid answer.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void (async () => {
      const prefs = await readTrendsPrefs(userId);
      if (cancelled || !prefs) return;
      setNutrients(prefs.nutrients);
      setRange(prefs.range);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const persist = (next: { nutrients?: TrendNutrient[]; range?: TrendRange }) => {
    if (!userId) return;
    void writeTrendsPrefs(userId, {
      nutrients: next.nutrients ?? nutrients,
      range: next.range ?? range,
    });
  };

  const onToggle = (nutrient: TrendNutrient) => {
    const next = toggleNutrient(nutrients, nutrient);
    // toggleNutrient returns the SAME array when it refuses — either the cap
    // was hit or this is the last one standing. Identity is the signal.
    if (next === nutrients) {
      // Tapping a fourth chip used to do nothing at all, which reads as a
      // broken button rather than as a rule. Say so, briefly. The wording
      // and the choice between the two refusals live in lib/trends.ts,
      // where they are tested against toggleNutrient itself.
      setCapMessage(capMessageFor(nutrients, nutrient));
      return;
    }
    setCapMessage(null);
    setNutrients(next);
    persist({ nutrients: next });
  };

  const onRange = (next: TrendRange) => {
    setRange(next);
    persist({ range: next });
  };

  // `now` is captured once per render rather than read inside the loop, so
  // every chart in one frame agrees about which day is today.
  const series = useMemo(
    () =>
      buildTrendSeries({
        entries,
        nutrients,
        range,
        now: new Date(),
        goals,
        goalsState,
      }),
    [entries, nutrients, range, goals, goalsState],
  );

  const onLayout = (e: LayoutChangeEvent) =>
    setWidth(e.nativeEvent.layout.width);

  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      showsVerticalScrollIndicator={false}
    >
      {/* ── Range toggle ─────────────────────────────────── */}
      <View style={styles.rangeRow}>
        <View style={styles.rangePicker}>
          {RANGE_DAYS.map((r) => (
            <Pressable
              key={r}
              onPress={() => onRange(r)}
              accessibilityRole="button"
              accessibilityState={{ selected: range === r }}
              style={[styles.rangeBtn, range === r && styles.rangeBtnOn]}
            >
              <Text
                style={[styles.rangeText, range === r && styles.rangeTextOn]}
              >
                {r} days
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* ── Nutrient picker ──────────────────────────────── */}
      <View style={styles.pickerHead}>
        <Text style={styles.pickerHint}>{`Pick up to ${MAX_SELECTED}`}</Text>
        <Text style={styles.pickerCount}>
          {`${nutrients.length}/${MAX_SELECTED}`}
        </Text>
      </View>
      <View style={styles.chips}>
        {TREND_NUTRIENTS.map((n) => {
          const on = nutrients.includes(n.key);
          return (
            <Pressable
              key={n.key}
              onPress={() => onToggle(n.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={[styles.chip, on && styles.chipOn]}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>
                {n.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {capMessage && (
        <Text style={styles.capHint} accessibilityLiveRegion="polite">
          {capMessage}
        </Text>
      )}

      {/* ── The small multiples ──────────────────────────── */}
      <View onLayout={onLayout} style={styles.charts}>
        {width > 0 &&
          series.map((s) => (
            <TrendChart
              key={s.nutrient}
              series={s}
              range={range}
              width={width}
            />
          ))}
      </View>

      {goalsState !== "loaded" && (
        <Text style={styles.goalNote}>
          {goalsState === "loading"
            ? "Loading your targets…"
            : "Target lines are hidden until your targets load."}
        </Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create(
  withDefaultFont({
    scroll: {
      paddingHorizontal: Spacing.md,
      paddingTop: Spacing.sm,
      paddingBottom: Spacing.lg,
    },
    rangeRow: {
      flexDirection: "row",
      justifyContent: "flex-end",
      marginBottom: Spacing.sm,
    },
    rangePicker: {
      flexDirection: "row",
      backgroundColor: Colors.surface,
      borderRadius: Radius.pill,
      padding: 3,
    },
    rangeBtn: {
      paddingVertical: 6,
      paddingHorizontal: Spacing.sm,
      borderRadius: Radius.pill,
    },
    rangeBtnOn: {
      backgroundColor: Colors.surface2,
    },
    rangeText: {
      fontSize: Typography.xs,
      fontWeight: Typography.semibold,
      color: Colors.textDim,
    },
    rangeTextOn: {
      color: Colors.text,
    },
    pickerHead: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 6,
    },
    pickerHint: {
      fontSize: Typography.xs,
      color: Colors.textDim,
    },
    pickerCount: {
      fontSize: Typography.xs,
      color: Colors.textDim,
    },
    chips: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
      marginBottom: Spacing.sm,
    },
    chip: {
      paddingVertical: 6,
      paddingHorizontal: Spacing.sm,
      borderRadius: Radius.pill,
      borderWidth: 1,
      borderColor: Colors.border,
      backgroundColor: Colors.surface,
    },
    chipOn: {
      backgroundColor: Colors.surface2,
      borderColor: Colors.textDim,
    },
    chipText: {
      fontSize: Typography.xs,
      fontWeight: Typography.semibold,
      color: Colors.textDim,
    },
    chipTextOn: {
      color: Colors.text,
    },
    capHint: {
      fontSize: Typography.xs,
      color: Colors.textDim,
      marginBottom: Spacing.sm,
    },
    charts: {
      width: "100%",
    },
    goalNote: {
      fontSize: Typography.xs,
      color: Colors.textDim,
      marginTop: Spacing.xs,
    },
  }),
);
