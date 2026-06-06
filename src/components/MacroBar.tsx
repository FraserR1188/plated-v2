import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, Easing, StyleSheet } from 'react-native';
import { Colors, Typography, Spacing, Radius, MacroColor } from '../theme';

interface Props { label: string; value: number; goal: number; unit?: string; }

export function MacroBar({ label, value, goal, unit = 'g' }: Props) {
  const pct     = Math.min(value / goal, 1);
  const over    = value > goal;
  const color   = over ? Colors.danger : (MacroColor[label.toLowerCase()] ?? Colors.green);
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: pct, duration: 700,
      easing: Easing.out(Easing.cubic), useNativeDriver: false,
    }).start();
  }, [pct]);

  const width = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Text style={styles.label}>{label}</Text>
        <Text style={[styles.nums, over && { color: Colors.danger }]}>
          {value < 10 ? value.toFixed(1) : Math.round(value)}
          <Text style={styles.goal}> / {goal}{unit}</Text>
        </Text>
      </View>
      <View style={styles.track}>
        <Animated.View style={[styles.fill, { width, backgroundColor: color }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap:  { marginBottom: 10 },
  row:   { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  label: { fontSize: Typography.sm, fontWeight: Typography.semibold, color: Colors.text },
  nums:  { fontSize: Typography.sm, fontWeight: Typography.semibold, color: Colors.text },
  goal:  { fontWeight: Typography.regular, color: Colors.textMuted },
  track: { height: 6, borderRadius: Radius.full, backgroundColor: Colors.surface2, overflow: 'hidden' },
  fill:  { height: 6, borderRadius: Radius.full },
});
