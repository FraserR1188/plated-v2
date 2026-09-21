// ============================================================
// A two-or-more-way segmented control, in-screen state only.
//
// Deliberately NOT a nested navigator. The Data tab switches between two
// views of the same data; a navigator would give each its own history
// stack, its own back behaviour and its own focus events, none of which
// this needs, and it would add a dependency to a fingerprint that has to
// stay OTA-compatible.
// ============================================================

import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Colors, Radius, Spacing, Typography, withDefaultFont } from "../theme/tokens";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Announced to screen readers as the group's purpose. */
  accessibilityLabel?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: Props<T>) {
  return (
    <View
      style={styles.track}
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            // `selected` is what a screen reader announces; without it the
            // two segments are indistinguishable to anyone not looking at
            // the background colour.
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            style={[styles.segment, selected && styles.segmentOn]}
          >
            <Text
              style={[styles.label, selected && styles.labelOn]}
              // The control must not reflow into two lines at the largest
              // system font; it shrinks instead, down to a readable floor.
              numberOfLines={1}
              minimumFontScale={0.85}
              adjustsFontSizeToFit
            >
              {option.label}
            </Text>
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
      borderWidth: 1,
      borderColor: Colors.border,
    },
    segment: {
      flex: 1,
      paddingVertical: Spacing.xs,
      paddingHorizontal: Spacing.sm,
      borderRadius: Radius.pill,
      alignItems: "center",
      justifyContent: "center",
      // The padding alone gets close to a comfortable touch target; this
      // guarantees it at the smallest font scale too.
      minHeight: 36,
    },
    segmentOn: {
      backgroundColor: Colors.surface2,
    },
    label: {
      fontSize: Typography.sm,
      fontWeight: Typography.semibold,
      color: Colors.textDim,
    },
    labelOn: {
      color: Colors.text,
    },
  }),
);
