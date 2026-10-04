// ============================================================
// src/components/SpendingChart.tsx — the Spending segment's bar chart
// (commit 8b): a bar per day this week, per week this month, per week over
// the last 13 weeks.
//
// Drawn with plain Views: no chart dependency, nothing native, so the
// runtime fingerprint stays the same and this ships by OTA.
//
// The buckets come from lib/spending.ts (spendingBuckets): one currency per
// chart, never mixed, and a receipt with no readable total is marked "?" on
// its bar rather than drawn as £0.
// ============================================================

import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { formatPence } from "../lib/money";
import type { SpendBucket } from "../lib/spending";
import { Colors, Radius, Spacing, Typography, withDefaultFont } from "../theme/tokens";

const CHART_HEIGHT = 110;

interface Props {
  buckets: SpendBucket[];
  currency: string;
  /** Currencies left out of this chart, named in a footnote. */
  otherCurrencies: string[];
}

export function SpendingChart({ buckets, currency, otherCurrencies }: Props) {
  const max = Math.max(0, ...buckets.map((b) => b.pence));
  // 13 weekly bars can't each carry a date: label every 4th.
  const labelEvery = buckets.length > 7 ? 4 : 1;
  const anyUnknown = buckets.some((b) => b.unknown > 0);

  return (
    <View style={styles.wrap}>
      <Text style={styles.max}>{max > 0 ? `Highest ${formatPence(max, currency)}` : "Nothing spent yet"}</Text>
      <View style={styles.bars}>
        {buckets.map((b) => (
          <View key={b.start} style={styles.col}>
            {b.unknown > 0 && <Text style={styles.unknown}>?</Text>}
            <View
              style={[
                styles.bar,
                { height: max > 0 ? Math.max(b.pence > 0 ? 2 : 0, (b.pence / max) * CHART_HEIGHT) : 0 },
              ]}
            />
          </View>
        ))}
      </View>
      <View style={styles.labels}>
        {buckets.map((b, i) => (
          <Text key={b.start} style={styles.label} numberOfLines={1}>
            {i % labelEvery === 0 ? b.label : ""}
          </Text>
        ))}
      </View>
      {anyUnknown && <Text style={styles.note}>? a receipt with no readable total, not counted</Text>}
      {otherCurrencies.length > 0 && (
        <Text style={styles.note}>Only {currency} receipts are charted; {otherCurrencies.join(", ")} shown above.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create(
  withDefaultFont({
    wrap: { gap: Spacing.xs },
    max: { fontSize: Typography.xs, color: Colors.textMuted },
    bars: { flexDirection: "row", alignItems: "flex-end", height: CHART_HEIGHT + 14, gap: 3 },
    col: { flex: 1, alignItems: "center", justifyContent: "flex-end" },
    bar: { width: "100%", backgroundColor: Colors.green, borderTopLeftRadius: Radius.control / 2, borderTopRightRadius: Radius.control / 2 },
    unknown: { fontSize: Typography.xs, fontWeight: Typography.bold, color: Colors.warning },
    labels: { flexDirection: "row", gap: 3 },
    label: { flex: 1, fontSize: 10, color: Colors.textMuted, textAlign: "left" },
    note: { fontSize: Typography.xs, color: Colors.textMuted },
  }),
);
