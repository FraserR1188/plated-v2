/**
 * CalorieRing
 *
 * SVG-based circular progress ring. The filled arc animates on mount
 * using React Native's Animated API so there's no extra dependency.
 *
 * Props:
 *   consumed  — calories eaten today
 *   goal      — daily calorie target
 *   size      — outer diameter in dp (default 220)
 *   stroke    — ring thickness in dp (default 16)
 */

import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Stop } from "react-native-svg";
import { Colors, Typography, Spacing } from "../theme";

// Wrap the SVG Circle so Animated.createAnimatedComponent works
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

type Props = {
  consumed: number;
  goal: number;
  size?: number;
  stroke?: number;
};

export function CalorieRing({
  consumed,
  goal,
  size = 220,
  stroke = 14,
}: Props) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.min(consumed / goal, 1); // clamp to 1
  const remaining = Math.max(goal - consumed, 0);
  const isOver = consumed > goal;

  // Animate strokeDashoffset from circumference → (1-progress)*circumference
  const animValue = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(animValue, {
      toValue: progress,
      duration: 900,
      delay: 150,
      useNativeDriver: false, // SVG props can't use native driver
    }).start();
  }, [progress]);

  const strokeDashoffset = animValue.interpolate({
    inputRange: [0, 1],
    outputRange: [circumference, circumference * (1 - progress)],
  });

  const arcColor = isOver ? Colors.coral : Colors.green;
  const center = size / 2;

  return (
    <View style={styles.container}>
      <Svg width={size} height={size}>
        <Defs>
          <LinearGradient id="arcGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <Stop
              offset="0%"
              stopColor={isOver ? Colors.coral : Colors.green}
              stopOpacity="0.7"
            />
            <Stop
              offset="100%"
              stopColor={isOver ? Colors.coral : Colors.green}
              stopOpacity="1"
            />
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

        {/* Progress arc */}
        <AnimatedCircle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="url(#arcGrad)"
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          // Start arc at the top (12 o'clock)
          rotation="-90"
          origin={`${center}, ${center}`}
        />
      </Svg>

      {/* Centre label */}
      <View style={[styles.centre, { width: size, height: size }]}>
        <Text style={[styles.heroNumber, isOver && styles.heroOver]}>
          {consumed.toLocaleString()}
        </Text>
        <Text style={styles.heroLabel}>
          {isOver ? "over goal" : "kcal eaten"}
        </Text>
        <View style={styles.remainingRow}>
          <View
            style={[
              styles.remainingDot,
              { backgroundColor: isOver ? Colors.coral : Colors.green },
            ]}
          />
          <Text style={styles.remainingText}>
            {isOver
              ? `${(consumed - goal).toLocaleString()} over`
              : `${remaining.toLocaleString()} remaining`}
          </Text>
        </View>
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
    color: Colors.text,
    letterSpacing: -2,
    lineHeight: Typography.hero * 1.0,
  },
  heroOver: {
    color: Colors.coral,
  },
  heroLabel: {
    fontSize: Typography.sm,
    fontWeight: Typography.medium,
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
    color: Colors.textMuted,
  },
});
