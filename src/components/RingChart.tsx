import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View, Text, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { Colors, Typography } from '../theme';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

interface Props { value: number; goal: number; size?: number; stroke?: number; }

export function RingChart({ value, goal, size = 160, stroke = 12 }: Props) {
  const radius      = (size - stroke * 2) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct         = Math.min(value / goal, 1);
  const over        = value > goal;
  const color       = over ? Colors.danger : Colors.green;
  const progress    = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: pct, duration: 800,
      easing: Easing.out(Easing.cubic), useNativeDriver: false,
    }).start();
  }, [pct]);

  const offset = progress.interpolate({ inputRange: [0, 1], outputRange: [circumference, 0] });
  const cx = size / 2, cy = size / 2;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
        <Circle cx={cx} cy={cy} r={radius} fill="none" stroke={Colors.surface2} strokeWidth={stroke} />
        <AnimatedCircle cx={cx} cy={cy} r={radius} fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset} />
      </Svg>
      <View style={{ alignItems: 'center' }}>
        <Text style={[styles.value, { color }]}>{Math.round(value)}</Text>
        <Text style={styles.unit}>kcal</Text>
        <Text style={styles.sub}>{over ? `${Math.round(value - goal)} over` : `${Math.round(goal - value)} left`}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  value: { fontSize: Typography.xl, fontWeight: Typography.bold, lineHeight: Typography.xl + 4 },
  unit:  { fontSize: Typography.sm, color: Colors.textMuted, fontWeight: Typography.medium },
  sub:   { fontSize: Typography.xs, color: Colors.textDim, marginTop: 2 },
});
