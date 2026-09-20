// ============================================================
// src/screens/InsightsScreen.tsx — the centre tab, as a stub.
//
// DELIBERATELY STATIC. No store reads, no queries, no day counter: what
// counts as a "tracked day" is decided by the readiness query, which
// doesn't exist yet, and a number rendered here before then would either
// disagree with it or quietly invent its own definition. The copy says
// "about a month" for the same reason — it sets an expectation without
// claiming a count this screen cannot yet source.
//
// When that query lands, this screen gains the real progress and the
// unlocked state; nothing else about the tab needs to change.
// ============================================================

import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  Colors,
  Spacing,
  Typography,
  Radius,
  withDefaultFont,
} from "../theme/tokens";

export function InsightsScreen() {
  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.centre}>
        <View style={styles.badge}>
          <Text style={styles.badgeGlyph}>◈</Text>
        </View>
        <Text style={styles.title}>Insights unlock after 31 days of tracking</Text>
        <Text style={styles.body}>
          We need about a month of your meals to find patterns worth showing
          you.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create(
  withDefaultFont({
    safe: {
      flex: 1,
      backgroundColor: Colors.bg,
    },
    centre: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: Spacing.lg,
      gap: Spacing.sm,
    },
    badge: {
      width: 56,
      height: 56,
      borderRadius: Radius.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: Colors.surface,
      borderWidth: 1,
      borderColor: Colors.border,
      marginBottom: Spacing.sm,
    },
    badgeGlyph: {
      fontSize: 24,
      color: Colors.green,
    },
    title: {
      fontSize: Typography.md,
      fontWeight: Typography.bold,
      color: Colors.text,
      textAlign: "center",
      letterSpacing: -0.3,
    },
    body: {
      fontSize: Typography.sm,
      color: Colors.textSub,
      textAlign: "center",
      lineHeight: 20,
      maxWidth: 300,
    },
  }),
);
