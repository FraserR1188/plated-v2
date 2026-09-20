// ============================================================
// src/components/WhoopScoresPanel.tsx — recovery, sleep and strain in a
// fixed-width column beside the calorie ring.
//
// THE COLUMN IS ALWAYS THE SAME WIDTH, and that is the whole layout
// contract. It renders for a connected user on every page, including a
// future date where all three values are "–", because the alternative is
// the ring sliding sideways as you swipe between days. A dash that holds
// its place is better than a number that moves the page.
//
// "–" covers every "we don't know": a NULL value, a pending or unscorable
// score, a state WHOOP invents later, no row for the day, an undated
// cycle, a future date, and a failed read. The panel has one thing to
// render for all of them on purpose — see getWhoopScoresForDate, which
// collapses them there rather than here.
//
// NO STRAIN CAPTION YET. The timestamp the design asked for
// (`source_updated_at`) is a whole-FRAME signal — greatest(cycle,
// recovery, sleep) — so it can carry the sleep scoring time under a
// strain number, measured at 1.2% of production rows and up to 17.6 hours
// out. Decision (Robbie, 2026-09-20): ship the panel without the caption,
// then add `strain_updated_at` to the view in PR 6 and wire it. The
// formatter already exists and is tested in src/lib/whoopScores.ts.
// ============================================================

import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { WhoopScores } from "../lib/whoopScores";
import { Colors, Spacing, Typography, Fonts } from "../theme/tokens";

/** 82dp at 360dp width, per the design. Fixed, never content-derived:
 *  a column that sized itself to "100" vs "–" would move the ring. */
export const WHOOP_PANEL_WIDTH = 82;

/** The one thing shown for every kind of "we don't know". An en dash,
 *  not a hyphen — it reads as a placeholder rather than a minus sign. */
const DASH = "–";

function Score({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit?: string;
}) {
  return (
    <View style={styles.score}>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.valueRow}>
        <Text
          style={styles.value}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.8}
        >
          {value}
        </Text>
        {/* The unit is dropped alongside a dash: "– %" reads as a broken
            number rather than an absent one. */}
        {unit && value !== DASH && <Text style={styles.unit}>{unit}</Text>}
      </View>
    </View>
  );
}

export function WhoopScoresPanel({ scores }: { scores: WhoopScores }) {
  const pct = (v: number | null) => (v == null ? DASH : String(v));
  // Strain is 0-21 to one decimal place, so toFixed(1) rather than the
  // integer percentages above — 12 and 12.3 are different readings.
  const strain = scores.strain == null ? DASH : scores.strain.toFixed(1);

  return (
    <View style={styles.column}>
      {/* Text, not a logo: WHOOP's brand assets have their own licensing,
          and a word mark we drew ourselves would be worse than either. */}
      <Text style={styles.brand}>WHOOP</Text>
      <Score label="Recovery" value={pct(scores.recovery)} unit="%" />
      <Score label="Sleep" value={pct(scores.sleep)} unit="%" />
      <Score label="Strain" value={strain} />
    </View>
  );
}

const styles = StyleSheet.create({
  column: {
    width: WHOOP_PANEL_WIDTH,
    alignItems: "center",
    gap: Spacing.sm,
  },
  brand: {
    fontSize: Typography.xs,
    fontFamily: Fonts.sans.medium,
    color: Colors.textMuted,
    letterSpacing: 1.2,
  },
  score: {
    alignItems: "center",
    width: "100%",
  },
  label: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
  },
  valueRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 2,
  },
  value: {
    fontSize: Typography.lg,
    fontFamily: Fonts.mono.semibold,
    color: Colors.text,
  },
  unit: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
  },
});
