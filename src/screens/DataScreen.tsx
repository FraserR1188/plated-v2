// ============================================================
// The Data tab — History, Trends and Grocery spending, behind an in-screen
// segmented control. Renamed from the History tab in Part 4; Spending
// added by the receipt scanner (commit 6).
//
// NO NESTED NAVIGATOR, deliberately. The segments are views, not
// destinations: a navigator would give each its own
// history stack, back behaviour and focus events, none of which this needs,
// and it would add a dependency to a runtime fingerprint that has to stay
// OTA-compatible.
//
// It OPENS ON HISTORY, every time. The segment is deliberately not
// remembered: History is the thing people come here for, and a tab that
// opens somewhere different depending on what you did last week is a tab
// you have to read before you can use. The nutrient selection inside
// Trends IS remembered -- that is a preference about content, not about
// where you are.
// ============================================================

import React, { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { HistoryScreen } from "./HistoryScreen";
import { TrendsPanel } from "../components/TrendsPanel";
import { SpendingPanel } from "../components/SpendingPanel";
import { SegmentedControl } from "../components/SegmentedControl";
import {
  Colors,
  Spacing,
  Typography,
  withDefaultFont,
} from "../theme/tokens";

type Segment = "history" | "trends" | "spending";

const SEGMENTS = [
  { value: "history" as const, label: "History" },
  { value: "trends" as const, label: "Trends" },
  // "Spending", not "Grocery spending": the control is capped at 220 dp.
  // The panel's own title says "Grocery spending" (findings decision 1).
  { value: "spending" as const, label: "Spending" },
];

export function DataScreen() {
  const [segment, setSegment] = useState<Segment>("history");

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Data</Text>
      </View>
      <View style={styles.controlRow}>
        <SegmentedControl
          options={SEGMENTS}
          value={segment}
          onChange={setSegment}
          accessibilityLabel="History, Trends or Spending"
        />
      </View>

      {segment === "history" ? (
        <HistoryScreen />
      ) : segment === "trends" ? (
        <TrendsPanel />
      ) : (
        <SpendingPanel />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create(
  withDefaultFont({
    safe: {
      flex: 1,
      backgroundColor: Colors.bg,
    },
    header: {
      paddingHorizontal: Spacing.md,
      paddingTop: Spacing.md,
      paddingBottom: Spacing.sm,
    },
    title: {
      fontSize: Typography.xl,
      fontWeight: Typography.bold,
      color: Colors.text,
      letterSpacing: -0.5,
    },
    // Its own full-width row under the title (2026-10-04): three labels in
    // a 220 dp cap beside the title were cramped.
    controlRow: {
      paddingHorizontal: Spacing.md,
      paddingBottom: Spacing.sm,
    },
  }),
);
