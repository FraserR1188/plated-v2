/**
 * CalorieRing
 *
 * SVG-based circular progress ring. Two arcs:
 *
 *   ghost (translucent)  — the PLAN: everything you intend to eat today
 *   solid                — what you have ACTUALLY eaten
 *
 * The ghost sits underneath and extends past the solid fill, so you can see at
 * a glance whether Sunday's meal prep actually hits your protein — which is the
 * only place the eaten/planned split becomes legible rather than theoretical.
 *
 * On a FUTURE day, `consumed` is 0 by definition. A solid arc at zero with a
 * ghost at 2,400 reads as "you have eaten nothing today" — technically true and
 * completely useless. So on a future day the plan IS the arc: solid, but dimmed.
 *
 * Props:
 *   consumed  — kcal actually eaten (logged + confirmed)
 *   planned   — kcal planned but not yet confirmed. Optional; 0 = old behaviour.
 *   goal      — daily calorie target
 *   size      — outer diameter in dp (default 220)
 *   stroke    — ring thickness in dp (default 16)
 */

import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Stop } from "react-native-svg";
import { Colors, Typography, Spacing, Fonts } from "../theme/tokens";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

type Props = {
  consumed: number;
  planned?: number;
  goal: number;
  size?: number;
  stroke?: number;
};

export function CalorieRing({
  consumed,
  planned = 0,
  goal,
  size = 220,
  stroke = 14,
}: Props) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  const total = consumed + planned;

  // A plan counts toward the goal — dropping tomorrow's dinner off tomorrow's
  // screen would make planning pointless. So "over" and "remaining" both key on
  // the total, which is also what TodayScreen's "Left" stat uses. If these two
  // disagreed, the card would be arguing with itself.
  const isOver = total > goal;
  const remaining = Math.max(goal - total, 0);

  // Nothing eaten, but something planned → you're looking at a future day.
  const isPlanOnly = consumed === 0 && planned > 0;

  const eatenProgress = goal > 0 ? Math.min(consumed / goal, 1) : 0;
  const totalProgress = goal > 0 ? Math.min(total / goal, 1) : 0;

  const eatenAnim = useRef(new Animated.Value(0)).current;
  const totalAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // ⚠ toValue MUST be 1, not the progress fraction.
    //
    // The old code animated 0 → progress against an interpolator calibrated for
    // 0 → 1, so the arc came to rest at progress SQUARED. A 50% day drew a 25%
    // arc; an 80% day drew 64%. It only ever looked right at 100%, because
    // 1² = 1 — which is why nobody caught it.
    Animated.parallel([
      Animated.timing(totalAnim, {
        toValue: 1,
        duration: 900,
        delay: 150,
        useNativeDriver: false, // SVG props can't use the native driver
      }),
      Animated.timing(eatenAnim, {
        toValue: 1,
        duration: 900,
        delay: 250, // the solid fill lands just after the ghost it sits inside
        useNativeDriver: false,
      }),
    ]).start();
  }, [eatenProgress, totalProgress]);

  const dashoffsetFor = (anim: Animated.Value, progress: number) =>
    anim.interpolate({
      inputRange: [0, 1],
      outputRange: [circumference, circumference * (1 - progress)],
    });

  const arcColor = isOver ? Colors.coral : Colors.green;

  return (
    <View style={styles.container}>
      <Svg width={size} height={size}>
        <Defs>
          <LinearGradient id="arcGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <Stop offset="0%" stopColor={arcColor} stopOpacity="0.7" />
            <Stop offset="100%" stopColor={arcColor} stopOpacity="1" />
          </LinearGradient>
        </Defs>

        {/* Track */}
        <Circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={Colors.surface2}
          strokeWidth={stroke}
        />

        {/* The PLAN. Drawn first, so the solid fill sits on top of it and the
            ghost only shows where the plan runs ahead of what you've eaten.
            On a future day this is the only arc, so it carries full weight. */}
        {planned > 0 && (
          <AnimatedCircle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={arcColor}
            strokeOpacity={isPlanOnly ? 0.55 : 0.3}
            strokeWidth={stroke}
            strokeDasharray={circumference}
            strokeDashoffset={dashoffsetFor(totalAnim, totalProgress)}
            strokeLinecap="round"
            rotation="-90"
            origin={`${center}, ${center}`}
          />
        )}

        {/* What you actually ate. */}
        {consumed > 0 && (
          <AnimatedCircle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="url(#arcGrad)"
            strokeWidth={stroke}
            strokeDasharray={circumference}
            strokeDashoffset={dashoffsetFor(eatenAnim, eatenProgress)}
            strokeLinecap="round"
            rotation="-90"
            origin={`${center}, ${center}`}
          />
        )}
      </Svg>

      {/* Centre label */}
      <View style={[styles.centre, { width: size, height: size }]}>
        <Text
          style={[
            styles.heroNumber,
            isOver && styles.heroOver,
            isPlanOnly && styles.heroPlanned,
          ]}
        >
          {(isPlanOnly ? planned : consumed).toLocaleString()}
        </Text>

        <Text style={styles.heroLabel}>
          {isPlanOnly ? "kcal planned" : isOver ? "over goal" : "kcal eaten"}
        </Text>

        <View style={styles.remainingRow}>
          <View style={[styles.remainingDot, { backgroundColor: arcColor }]} />
          <Text style={styles.remainingText}>
            <Text style={{ fontFamily: Fonts.mono.medium }}>
              {(isOver ? total - goal : remaining).toLocaleString()}
            </Text>
            {isOver ? " over" : " remaining"}
          </Text>
        </View>

        {/* Only when there's a real split to explain. On a future day the hero
            number IS the plan, so repeating it here would be noise. */}
        {planned > 0 && !isPlanOnly && (
          <Text style={styles.plannedNote}>
            <Text style={{ fontFamily: Fonts.mono.semibold }}>
              +{planned.toLocaleString()}
            </Text>{" "}
            planned
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
  },
  centre: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
  },
  heroNumber: {
    fontSize: Typography.hero,
    fontWeight: Typography.bold,
    fontFamily: Fonts.mono.bold,
    color: Colors.text,
    letterSpacing: -2,
    lineHeight: Typography.hero * 1.0,
  },
  heroOver: {
    color: Colors.coral,
  },
  heroPlanned: {
    color: Colors.textSub,
  },
  heroLabel: {
    fontSize: Typography.sm,
    fontWeight: Typography.medium,
    fontFamily: Fonts.sans.medium,
    color: Colors.textSub,
    marginTop: 2,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  remainingRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: Spacing.sm,
    gap: 5,
  },
  remainingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  remainingText: {
    fontSize: Typography.xs,
    fontWeight: Typography.medium,
    fontFamily: Fonts.sans.medium,
    color: Colors.textMuted,
  },
  plannedNote: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    fontFamily: Fonts.sans.semibold,
    color: Colors.textMuted,
    marginTop: 3,
    opacity: 0.8,
  },
});
