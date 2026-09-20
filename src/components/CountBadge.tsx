// ============================================================
// src/components/CountBadge.tsx — the small red unread count.
//
// Extracted from TabBar so the Settings TAB and the Friends ROW inside
// Settings render the same badge from the same store value, rather than
// two lookalikes that drift in size or cap. Pure presentation: the count
// is passed in.
//
// Absent or 0 renders NOTHING — never a "0". A badge that says zero is
// worse than no badge: it reads as a notification.
// ============================================================

import React from "react";
import { View, Text, StyleSheet, type ViewStyle } from "react-native";
import { Colors, Typography, Fonts, Overlay } from "../theme/tokens";

type Props = {
  count?: number;
  /** Position it against whatever it badges — the tab icon overlays, the row sits inline. */
  style?: ViewStyle;
};

export function CountBadge({ count, style }: Props) {
  if (!count || count <= 0) return null;

  return (
    <View style={[styles.badge, style]}>
      <Text style={styles.badgeText} numberOfLines={1}>
        {count > 9 ? "9+" : count}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    minWidth: 15,
    height: 15,
    borderRadius: 8,
    paddingHorizontal: 3,
    backgroundColor: Colors.danger,
    borderWidth: 1,
    borderColor: Colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    fontSize: 9,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Overlay.white,
  },
});
