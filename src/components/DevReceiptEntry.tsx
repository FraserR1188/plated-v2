// ============================================================
// src/components/DevReceiptEntry.tsx — TEMPORARY, DEV BUILDS ONLY
//
// Opens ReceiptScan, and reopens the newest saved receipt in ReceiptReview's
// edit mode, so receipt commits 5a and 5b can be device-tested before their
// real entries (Data → Spending's scan button and receipt rows, commit 6)
// exist.
//
// IT CANNOT SHIP:
//   • SettingsScreen renders it only as `{__DEV__ && <DevReceiptEntry />}`.
//     Release and preview builds compile __DEV__ to false, so the branch is
//     dead code the minifier removes; and this component returns null on
//     its own when !__DEV__, as a second lock.
//   • receiptDevEntry.test.ts fails if it's rendered anywhere except under
//     __DEV__ in SettingsScreen — and fails outright once any non-dev
//     navigate("ReceiptScan") or navigate("ReceiptReview") exists (commit
//     6's Spending entries), until this file and its one use are deleted.
// ============================================================

import React, { useCallback, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useStore } from "../store/useStore";
import { fetchReceipts, type ReceiptListRow } from "../lib/receipts";
import { formatPence } from "../lib/money";
import { Colors, Spacing, Radius, Typography, withDefaultFont } from "../theme/tokens";
import { RootStackParamList } from "../types";

export function DevReceiptEntry() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const userId = useStore((s) => s.userId);
  const [newest, setNewest] = useState<ReceiptListRow | null>(null);

  // The newest saved receipt, refreshed on every return to Settings, so a
  // save, edit or delete in review shows here at once.
  useFocusEffect(
    useCallback(() => {
      if (!__DEV__ || !userId) return;
      let live = true;
      fetchReceipts(userId)
        .then((rows) => live && setNewest(rows[0] ?? null))
        .catch(() => live && setNewest(null));
      return () => {
        live = false;
      };
    }, [userId]),
  );

  if (!__DEV__) return null;

  return (
    <View style={styles.box}>
      <Text style={styles.tag}>DEV ONLY · receipt 5a/5b</Text>
      <Pressable
        style={({ pressed }) => [styles.btn, pressed && { opacity: 0.75 }]}
        onPress={() => navigation.navigate("ReceiptScan")}
        accessibilityRole="button"
      >
        <Text style={styles.btnText}>Scan a receipt</Text>
      </Pressable>
      {newest ? (
        <>
          <Pressable
            style={({ pressed }) => [styles.btn, pressed && { opacity: 0.75 }]}
            onPress={() => navigation.navigate("ReceiptReview", { mode: "edit", receiptId: newest.id })}
            accessibilityRole="button"
          >
            <Text style={styles.btnText}>Edit the newest saved receipt</Text>
          </Pressable>
          <Text style={styles.summary}>
            Newest saved: {newest.purchased_on}
            {newest.purchased_on_estimated ? " (estimated)" : ""} · {newest.store ?? "no store"} · total{" "}
            {newest.printed_total_pence == null ? "—" : formatPence(newest.printed_total_pence, newest.currency)} ·{" "}
            {newest.lines.length} lines
          </Text>
        </>
      ) : (
        <Text style={styles.summary}>No saved receipts yet.</Text>
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
