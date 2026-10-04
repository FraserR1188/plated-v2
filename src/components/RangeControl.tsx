// ============================================================
// src/components/RangeControl.tsx — the Data tab's one range control
// (receipt-scanner findings §2, commit 7)
//
// History (7/30 days), Trends (7/14 days) and Spending (this week / this
// month) each pass their own options, and all three look the same. Before
// this, History had a green pill and Trends a grey one, so switching
// segments changed the control's look as well as its options. Placement
// stays with the caller, at the top right under the segmented control.
// ============================================================

import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Colors, Radius, Spacing, Typography, withDefaultFont } from "../theme/tokens";

export interface RangeOption<T extends string | number> {
  value: T;
  label: string;
}

interface Props<T extends string | number> {
  options: RangeOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

export function RangeControl<T extends string | number>({ options, value, onChange }: Props<T>) {
  return (
    <View style={styles.track}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            onPress={() => onChange(o.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            style={[styles.btn, on && styles.btnOn]}
          >
            <Text style={[styles.text, on && styles.textOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create(
  withDefaultFont({
    track: {
      flexDirection: "row",
      backgroundColor: Colors.surface,
      borderRadius: Radius.pill,
      padding: 3,
    },
    btn: {
      paddingVertical: 6,
      paddingHorizontal: Spacing.sm,
      borderRadius: Radius.pill,
    },
    btnOn: { backgroundColor: Colors.surface2 },
    text: {
      fontSize: Typography.xs,
      fontWeight: Typography.semibold,
      color: Colors.textDim,
    },
    textOn: { color: Colors.text },
  }),
);
