// ============================================================
// The Data tab — History and Trends, behind an in-screen segmented
// control. Renamed from the History tab in Part 4.
//
// NO NESTED NAVIGATOR, deliberately. The two segments are two views of the
// same data, not two destinations: a navigator would give each its own
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
import { SegmentedControl } from "../components/SegmentedControl";
import {
  Colors,
  Spacing,
  Typography,
  withDefaultFont,
} from "../theme/tokens";

type Segment = "history" | "trends";

const SEGMENTS = [
  { value: "history" as const, label: "History" },
  { value: "trends" as const, label: "Trends" },
];

export function DataScreen() {
  const [segment, setSegment] = useState<Segment>("history");

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Data</Text>
        <View style={styles.controlWrap}>
          <SegmentedControl
            options={SEGMENTS}
            value={segment}
            onChange={setSegment}
            accessibilityLabel="History or Trends"
          />
        </View>
      </View>

      {segment === "history" ? <HistoryScreen embedded /> : <TrendsPanel />}
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
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: Spacing.sm,
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
    // Capped rather than flex:1 so the control keeps its shape beside the
    // title at 360dp, and doesn't stretch across a tablet width.
    controlWrap: {
      flexShrink: 1,
      maxWidth: 220,
      minWidth: 160,
    },
  }),
);
