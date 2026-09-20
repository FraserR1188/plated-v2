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
// THE STRAIN CAPTION reads `strain_updated_at` — the cycle's own
// timestamp, added to the view in PR 6 — and never `source_updated_at`,
// which is greatest(cycle, recovery, sleep) and would put the SLEEP
// scoring time under a strain number.
//
// It renders only when there IS a strain value. A caption under a dash
// would claim the dash is fresh, which is nonsense, and the caption is
// absent for Health-Connect-only days (no cycle, so no calculation time)
// and for future days (nothing calculated yet).
// ============================================================

import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { WhoopScores, formatStrainCaption } from "../lib/whoopScores";
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
  // Null whenever there is no strain to caption, no timestamp, or the
  // timestamp doesn't parse — the formatter owns all three.
  const caption = formatStrainCaption(scores.asOf);

  return (
    <View style={styles.column}>
      {/* Text, not a logo: WHOOP's brand assets have their own licensing,
          and a word mark we drew ourselves would be worse than either. */}
      <Text style={styles.brand}>WHOOP</Text>
      <Score label="Recovery" value={pct(scores.recovery)} unit="%" />
      <Score label="Sleep" value={pct(scores.sleep)} unit="%" />
      <Score label="Strain" value={strain} />
      {caption && (
        <Text style={styles.caption} numberOfLines={1} adjustsFontSizeToFit>
          {caption}
        </Text>
      )}
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
  caption: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    textAlign: "center",
  },
});
