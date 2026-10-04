// ============================================================
// src/components/SpendingPanel.tsx — the Data tab's third segment,
// "Grocery spending" (receipt-scanner findings §2, commit 6)
//
// The receipt flow's real entry: "Scan a receipt" opens ReceiptScan, and a
// receipt row opens ReceiptReview in edit mode.
//
// THE RULES live in lib/spending.ts (spendingOverview), not here:
//   • totals per currency, never added across currencies;
//   • a receipt with no readable amount is listed, never counted as £0;
//   • the period is a local-calendar week (Mon–Sun) or month to date.
//
// Every receipt is read through the PL-050 pager (fetchReceipts), refreshed
// on focus, so a save, edit or delete in review shows on return.
// ============================================================

import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator, Alert } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useStore } from "../store/useStore";
import { fetchReceipts, type ReceiptListRow } from "../lib/receipts";
import { spendingOverview, weekRange, monthRange, UNKNOWN_STORE, type ReceiptAmount } from "../lib/spending";
import { formatPence } from "../lib/money";
import { exportSpendingCSV } from "../lib/csv";
import { dateKey, formatDayLabel } from "../lib/time";
import { Colors, Spacing, Radius, Typography, withDefaultFont } from "../theme/tokens";
import { RootStackParamList } from "../types";
import { RangeControl } from "./RangeControl";

type Period = "week" | "month";
const PERIODS: { value: Period; label: string }[] = [
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
];

const amountText = (amount: ReceiptAmount, currency: string) =>
  amount == null ? "—" : formatPence(amount.pence, currency);

export function SpendingPanel() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const userId = useStore((s) => s.userId);
  const [period, setPeriod] = useState<Period>("week");
  const [receipts, setReceipts] = useState<ReceiptListRow[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [exporting, setExporting] = useState(false);

  useFocusEffect(
    useCallback(() => {
      if (!userId) return;
      let live = true;
      fetchReceipts(userId)
        .then((rows) => {
          if (!live) return;
          setReceipts(rows);
          setLoadFailed(false);
        })
        .catch(() => live && setLoadFailed(true));
      return () => {
        live = false;
      };
    }, [userId]),
  );

  // Today is read per render, so the period rolls over at local midnight.
  const today = dateKey();
  const overview = useMemo(
    () => (receipts ? spendingOverview(receipts, period === "week" ? weekRange(today) : monthRange(today)) : null),
    [receipts, period, today],
  );

  const scan = () => navigation.navigate("ReceiptScan");

  const onExport = async () => {
    if (!userId || exporting) return;
    setExporting(true);
    try {
      await exportSpendingCSV(userId);
    } catch {
      Alert.alert("Export failed", "Check your connection and try again.");
    } finally {
      setExporting(false);
    }
  };

  const header = (
    <View style={styles.headRow}>
      <Text style={styles.title}>Grocery spending</Text>
      <Pressable
        style={({ pressed }) => [styles.scanBtn, pressed && { opacity: 0.8 }]}
        onPress={scan}
        accessibilityRole="button"
      >
        <Text style={styles.scanText}>Scan a receipt</Text>
      </Pressable>
    </View>
  );

  if (receipts == null) {
    return (
      <View style={styles.scroll}>
        {header}
        {loadFailed ? (
          <Text style={styles.muted}>Couldn't load your receipts. Check your connection and come back to this tab.</Text>
        ) : (
          <ActivityIndicator style={{ marginTop: Spacing.lg }} color={Colors.textSub} />
        )}
      </View>
    );
  }

  if (receipts.length === 0) {
    return (
      <View style={styles.scroll}>
        {header}
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No receipts yet</Text>
          <Text style={styles.muted}>
            Photograph a till receipt to see what you spend on groceries, by week, month and store.
          </Text>
          <Pressable
            style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.88 }]}
            onPress={scan}
            accessibilityRole="button"
          >
            <Text style={styles.primaryBtnText}>Scan a receipt</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const o = overview!;
  const periodWord = period === "week" ? "this week" : "this month";

  return (
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      {header}

      <View style={styles.rangeRow}>
        <RangeControl options={PERIODS} value={period} onChange={setPeriod} />
      </View>

      <View style={styles.card}>
        {o.headline ? (
          <>
            <Text style={styles.headline}>{formatPence(o.headline.pence, o.headline.currency)}</Text>
            <Text style={styles.cardSub}>
              {o.headline.receipts} {o.headline.receipts === 1 ? "receipt" : "receipts"} {periodWord}
            </Text>
            {o.otherCurrencies.map((c) => (
              <Text key={c.currency} style={styles.otherCurrency}>
                + {formatPence(c.pence, c.currency)} · {c.receipts} {c.receipts === 1 ? "receipt" : "receipts"}
              </Text>
            ))}
          </>
        ) : (
          <Text style={styles.cardSub}>No receipts with a total {periodWord}</Text>
        )}
        {o.unknown.length > 0 && (
          <View style={styles.unknownBox}>
            <Text style={styles.unknownTitle}>
              {o.unknown.length === 1 ? "1 receipt has" : `${o.unknown.length} receipts have`} no readable total, so{" "}
              {o.unknown.length === 1 ? "it isn't" : "they aren't"} counted:
            </Text>
            {o.unknown.map((r) => (
              <Text key={r.id} style={styles.unknownLine}>
                {formatDayLabel(r.purchased_on)} · {r.store ?? UNKNOWN_STORE}
              </Text>
            ))}
          </View>
        )}
      </View>

      {o.byStore.length > 0 && (
        <>
          <Text style={styles.section}>By store</Text>
          <View style={styles.card}>
            {o.byStore.map((s) => (
              <View key={`${s.currency}:${s.store}`} style={styles.storeRow}>
                <Text style={styles.storeName} numberOfLines={1}>
                  {s.store}
                </Text>
                <Text style={styles.storeCount}>{s.receipts}</Text>
                <Text style={styles.storeTotal}>{formatPence(s.pence, s.currency)}</Text>
              </View>
            ))}
          </View>
        </>
      )}

      <Text style={styles.section}>Receipts</Text>
      <View style={styles.card}>
        {o.rows.map((row) => (
          <Pressable
            key={row.id}
            style={({ pressed }) => [styles.receiptRow, pressed && { opacity: 0.7 }]}
            onPress={() => navigation.navigate("ReceiptReview", { mode: "edit", receiptId: row.id })}
            accessibilityRole="button"
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.receiptStore} numberOfLines={1}>
                {row.receipt.store ?? UNKNOWN_STORE}
              </Text>
              <Text style={styles.receiptDate}>
                {formatDayLabel(row.receipt.purchased_on)}
                {row.receipt.purchased_on_estimated ? " · date estimated" : ""}
              </Text>
            </View>
            {row.mismatch && <Text style={styles.badge}>Doesn't add up</Text>}
            <Text style={styles.receiptTotal}>{amountText(row.amount, row.receipt.currency)}</Text>
          </Pressable>
        ))}
      </View>

      <Pressable
        style={({ pressed }) => [styles.exportBtn, pressed && { opacity: 0.8 }]}
        onPress={onExport}
        disabled={exporting}
        accessibilityRole="button"
      >
        {exporting ? (
          <ActivityIndicator size="small" color={Colors.textSub} />
        ) : (
          <Text style={styles.exportText}>Export spending (CSV)</Text>
        )}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create(
  withDefaultFont({
    scroll: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm, paddingBottom: Spacing.lg, gap: Spacing.sm },
    headRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: Spacing.sm },
    title: { fontSize: Typography.md, fontWeight: Typography.bold, color: Colors.text },
    scanBtn: {
      backgroundColor: Colors.green,
      borderRadius: Radius.pill,
      paddingVertical: 7,
      paddingHorizontal: Spacing.md,
    },
    scanText: { fontSize: Typography.sm, fontWeight: Typography.bold, color: Colors.bg },

    rangeRow: { flexDirection: "row", justifyContent: "flex-end" },

    card: {
      backgroundColor: Colors.surface,
      borderRadius: Radius.card,
      borderWidth: 1,
      borderColor: Colors.border,
      padding: Spacing.md,
      gap: Spacing.xs,
    },
    headline: { fontSize: Typography.xxl, fontWeight: Typography.bold, color: Colors.text },
    cardSub: { fontSize: Typography.sm, color: Colors.textSub },
    otherCurrency: { fontSize: Typography.base, fontWeight: Typography.semibold, color: Colors.text },
    unknownBox: { marginTop: Spacing.sm, gap: 2 },
    unknownTitle: { fontSize: Typography.sm, color: Colors.warning },
    unknownLine: { fontSize: Typography.sm, color: Colors.textSub },

    section: { fontSize: Typography.sm, fontWeight: Typography.bold, color: Colors.textSub, marginTop: Spacing.sm },
    storeRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, paddingVertical: 4 },
    storeName: { flex: 1, fontSize: Typography.base, color: Colors.text },
    storeCount: { fontSize: Typography.sm, color: Colors.textMuted, minWidth: 20, textAlign: "right" },
    storeTotal: { fontSize: Typography.base, fontWeight: Typography.semibold, color: Colors.text, minWidth: 80, textAlign: "right" },

    receiptRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, paddingVertical: 6 },
    receiptStore: { fontSize: Typography.base, color: Colors.text },
    receiptDate: { fontSize: Typography.xs, color: Colors.textMuted },
    badge: {
      fontSize: Typography.xs,
      fontWeight: Typography.bold,
      color: Colors.warning,
      borderWidth: 1,
      borderColor: Colors.warning,
      borderRadius: Radius.pill,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    receiptTotal: { fontSize: Typography.base, fontWeight: Typography.semibold, color: Colors.text, minWidth: 72, textAlign: "right" },

    exportBtn: {
      marginTop: Spacing.md,
      borderRadius: Radius.pill,
      borderWidth: 1,
      borderColor: Colors.border,
      paddingVertical: 11,
      alignItems: "center",
    },
    exportText: { fontSize: Typography.sm, fontWeight: Typography.semibold, color: Colors.text },

    empty: { alignItems: "center", gap: Spacing.sm, marginTop: Spacing.xl, paddingHorizontal: Spacing.md },
    emptyTitle: { fontSize: Typography.md, fontWeight: Typography.bold, color: Colors.text },
    muted: { fontSize: Typography.sm, color: Colors.textSub, textAlign: "center" },
    primaryBtn: {
      marginTop: Spacing.sm,
      backgroundColor: Colors.green,
      borderRadius: Radius.pill,
      paddingVertical: 12,
      paddingHorizontal: Spacing.xl,
    },
    primaryBtnText: { fontSize: Typography.base, fontWeight: Typography.bold, color: Colors.bg },
  }),
);
