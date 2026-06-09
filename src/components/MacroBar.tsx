/**
 * MacroBar
 *
 * Animated progress bar for a single macro nutrient.
 * Animates fill width on mount. Shows label, consumed/goal, and a unit.
 *
 * Usage:
 *   <MacroBar macro="protein" consumed={142} goal={180} unit="g" />
 */

import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import {
  Colors,
  MacroColor,
  MacroColorSoft,
  Spacing,
  Radius,
  Typography,
} from "../theme";

type Props = {
  macro: string; // key into MacroColor — 'protein' | 'carbs' | 'fat' | etc.
  label?: string; // display name override, defaults to capitalised macro
  consumed: number;
  goal: number;
  unit?: string; // 'g' | 'mg' | 'kcal'
  compact?: boolean; // smaller variant for dense lists
};

export function MacroBar({
  macro,
  label,
  consumed,
  goal,
  unit = "g",
  compact = false,
}: Props) {
  const color = MacroColor[macro] ?? Colors.green;
  const trackColor = MacroColorSoft[macro] ?? `${Colors.green}18`;
  const progress = goal > 0 ? Math.min(consumed / goal, 1) : 0;
  const isOver = consumed > goal;
  const displayLabel = label ?? macro.charAt(0).toUpperCase() + macro.slice(1);

  const animWidth = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(animWidth, {
      toValue: progress,
      duration: 800,
      delay: 200,
      useNativeDriver: false,
    }).start();
  }, [progress]);

  const barHeight = compact ? 5 : 7;

  return (
    <View style={[styles.container, compact && styles.containerCompact]}>
      {/* Row: label + value */}
      <View style={styles.labelRow}>
        <View style={styles.labelLeft}>
          <View style={[styles.dot, { backgroundColor: color }]} />
          <Text style={[styles.label, compact && styles.labelCompact]}>
            {displayLabel}
          </Text>
        </View>
        <Text style={[styles.value, compact && styles.valueCompact]}>
          <Text
            style={[
              styles.valueHighlight,
              { color: isOver ? Colors.coral : Colors.text },
            ]}
          >
            {consumed}
          </Text>
          <Text style={styles.valueMuted}>
            {" / "}
            {goal}
            {unit}
          </Text>
        </Text>
      </View>

      {/* Track + fill */}
      <View
        style={[
          styles.track,
          { height: barHeight, backgroundColor: trackColor },
        ]}
      >
        <Animated.View
          style={[
            styles.fill,
            {
              height: barHeight,
              backgroundColor: isOver ? Colors.coral : color,
              width: animWidth.interpolate({
                inputRange: [0, 1],
                outputRange: ["0%", "100%"],
              }),
              // Softer right-edge radius when not complete
              borderTopRightRadius: progress < 1 ? 2 : Radius.full,
              borderBottomRightRadius: progress < 1 ? 2 : Radius.full,
            },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.xs,
  },
  containerCompact: {
    gap: 3,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  labelLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  label: {
    fontSize: Typography.sm,
    fontWeight: Typography.medium,
    color: Colors.textSub,
  },
  labelCompact: {
    fontSize: Typography.xs,
  },
  value: {
    fontSize: Typography.sm,
  },
  valueCompact: {
    fontSize: Typography.xs,
  },
  valueHighlight: {
    fontWeight: Typography.semibold,
  },
  valueMuted: {
    color: Colors.textMuted,
    fontWeight: Typography.regular,
  },
  track: {
    borderRadius: Radius.full,
    overflow: "hidden",
  },
  fill: {
    borderTopLeftRadius: Radius.full,
    borderBottomLeftRadius: Radius.full,
  },
});
