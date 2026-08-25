// ============================================================
// src/components/ScanButton.tsx
// ============================================================
// Chrome only — icon, label, pressed opacity, loading spinner. `onPress`
// is deliberately caller-supplied rather than baked in here: the two
// current callers (AddIngredientScreen, BatchIngredientPickerScreen) each
// navigate on a DIFFERENT branch of the Scanner route's param union — one
// passes { date, mealType, eatenAt } to log a scanned product directly,
// the other passes an { onScanned } callback into a quantity-confirm step
// that feeds a batch draft instead. Don't "helpfully" unify those into one
// navigation call inside this component: the two outcomes are genuinely
// different, and the union's mutual exclusion (onScanned?: undefined vs.
// date?: undefined) is what stops a caller supplying both and getting
// ambiguous behaviour. See the Scanner entry in types/index.ts.
// ============================================================

import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native";
import { Colors, Radius, Spacing, Typography, withDefaultFont } from "../theme/tokens";

export function ScanButton({
  icon,
  label,
  onPress,
  loading = false,
  disabled = false,
  accessibilityLabel,
}: {
  icon: string;
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  accessibilityLabel: string;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.scanBtn, pressed && { opacity: 0.75 }]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      {loading ? (
        <ActivityIndicator size="small" color={Colors.textSub} />
      ) : (
        <>
          <Text style={styles.scanIcon}>{icon}</Text>
          <Text style={styles.scanLabel}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create(
  withDefaultFont({
    scanBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: Colors.surface,
      borderRadius: Radius.pill,
      borderWidth: 1,
      borderColor: Colors.border,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 7,
    },
    scanIcon: {
      fontSize: 14,
      color: Colors.textSub,
    },
    scanLabel: {
      fontSize: Typography.xs,
      fontWeight: Typography.semibold,
      color: Colors.textSub,
    },
  }),
);
