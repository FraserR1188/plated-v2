// ============================================================
// src/components/DevReceiptEntry.tsx — TEMPORARY, DEV BUILDS ONLY
//
// Opens ReceiptScan and shows the last scan's draft, so receipt commit 5a can
// be device-tested before its real entry (Data → Spending, commit 6) and
// its destination (the review screen, commit 5b) exist.
//
// IT CANNOT SHIP:
//   • SettingsScreen renders it only as `{__DEV__ && <DevReceiptEntry />}`.
//     Release and preview builds compile __DEV__ to false, so the branch is
//     dead code the minifier removes; and this component returns null on
//     its own when !__DEV__, as a second lock.
//   • receiptDevEntry.test.ts fails if it's rendered anywhere except under
//     __DEV__ in SettingsScreen — and fails outright once any non-dev
//     navigate("ReceiptScan") exists (commit 6's Spending entry), until this
//     file and its one use are deleted.
// ============================================================

import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useStore } from "../store/useStore";
import { formatPence } from "../lib/money";
import { Colors, Spacing, Radius, Typography, withDefaultFont } from "../theme/tokens";
import { RootStackParamList } from "../types";

export function DevReceiptEntry() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const draft = useStore((s) => s.receiptDraft);
  if (!__DEV__) return null;

  const scanned = draft && draft.lines.length > 0 ? draft : null;
  const flagged = scanned ? scanned.lines.filter((l) => l.possibleSeamDuplicate).length : 0;

  return (
    <View style={styles.box}>
      <Text style={styles.tag}>DEV ONLY · receipt 5a</Text>
      <Pressable
        style={({ pressed }) => [styles.btn, pressed && { opacity: 0.75 }]}
        onPress={() => navigation.navigate("ReceiptScan")}
        accessibilityRole="button"
      >
        <Text style={styles.btnText}>Scan a receipt</Text>
      </Pressable>
      {scanned && (
        <Text style={styles.summary}>
          Last scan: {scanned.parts.length} part{scanned.parts.length === 1 ? "" : "s"},{" "}
          {scanned.lines.length} lines, {flagged} flagged · total{" "}
          {scanned.header.printedTotalPence == null
            ? "—"
            : formatPence(scanned.header.printedTotalPence, scanned.header.currency)}{" "}
          · {scanned.header.purchasedOn}
          {scanned.header.purchasedOnEstimated ? " (estimated)" : ""}
          {scanned.header.store ? ` · ${scanned.header.store}` : ""}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create(
  withDefaultFont({
    box: {
      marginHorizontal: Spacing.md,
      marginTop: Spacing.md,
      padding: Spacing.md,
      gap: Spacing.sm,
      borderRadius: Radius.card,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: Colors.warning,
    },
    tag: { fontSize: Typography.xs, fontWeight: Typography.bold, color: Colors.warning },
    btn: {
      backgroundColor: Colors.surface,
      borderRadius: Radius.pill,
      borderWidth: 1,
      borderColor: Colors.border,
      paddingVertical: 10,
      alignItems: "center",
    },
    btnText: { fontSize: Typography.sm, fontWeight: Typography.semibold, color: Colors.text },
    summary: { fontSize: Typography.sm, color: Colors.textSub },
  }),
);
