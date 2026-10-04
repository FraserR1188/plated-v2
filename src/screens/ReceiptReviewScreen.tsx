// ============================================================
// src/screens/ReceiptReviewScreen.tsx — check, correct and save a receipt
// (receipt-scanner findings §3, §6; commit 5b)
//
// ONE component, two modes (route param):
//   • create — opened by ReceiptScan after a successful scan, with the
//     scanned draft already in the store. Part tags, seam flags with
//     one-tap Remove, and the long-receipt notice on 2+ parts.
//   • edit — opened on a saved receipt; loads it with openReceiptForEdit.
//     Save updates it; Delete removes it.
//
// LIVE TEXT (PL-005/006; CopyConfirm's pattern): every value is held as the
// text on screen, and Save parses exactly that — no commit on blur, so Save
// straight after typing saves what was typed. The item count and reconcile
// banner read the same text (lib/receiptReview.ts).
//
// KEEP INPUT ON FAILURE: the fields are seeded from the store's draft and
// reseeded ONLY when the draft object changes (the edit-mode load). The
// store leaves the draft as the same object on every failed save or delete
// (useStore.saveReceiptReview), so a failure never touches what's typed.
//
// NEVER A SILENT GBP: an unread currency shows unset, and Save refuses until
// one is chosen.
//
// Leaving clears the draft (unmount). Leaving a fresh scan, or an edit with
// changes, asks first: the scan cost one of the hour's AI scans.
// ============================================================

import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  Pressable,
  Alert,
  ScrollView,
  Platform,
} from "react-native";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useStore } from "../store/useStore";
import { KeyboardScreen } from "../components/KeyboardScreen";
import { DateTimeField } from "../components/DateTimeField";
import {
  fieldsFromDraft,
  updateLine,
  addLine,
  removeLine,
  setPurchasedOn,
  setCurrency,
  parseReview,
  reviewSummary,
  itemCountLabel,
  reconcileBanner,
  type ReviewFields,
  type ReviewLine,
  type BannerTone,
} from "../lib/receiptReview";
import { LONG_RECEIPT_NOTICE, showLongReceiptNotice } from "../lib/receiptCapture";
import { formatPence } from "../lib/money";
import type { ReceiptDraft } from "../lib/receipts";
import { dateKey, formatDayLabel, parseDateKey } from "../lib/time";
import { Colors, Spacing, Radius, Typography, withDefaultFont } from "../theme/tokens";
import { RootStackParamList } from "../types";

type Nav = NativeStackNavigationProp<RootStackParamList, "ReceiptReview">;
type Route = RouteProp<RootStackParamList, "ReceiptReview">;
type Params = RootStackParamList["ReceiptReview"];

const CURRENCIES = [
  { code: "GBP", label: "£ GBP" },
  { code: "EUR", label: "€ EUR" },
];

// Android's numeric keyboard has "-" and "."; iOS's decimal pad has no minus,
// and a discount needs one.
const AMOUNT_KEYBOARD = Platform.OS === "ios" ? "numbers-and-punctuation" : "numeric";

/** The draft this route is for: a create draft, or this receipt's edit draft. */
function draftFits(draft: ReceiptDraft, params: Params): boolean {
  return params.mode === "create"
    ? draft.mode.kind === "create"
    : draft.mode.kind === "edit" && draft.mode.receiptId === params.receiptId;
}

export function ReceiptReviewScreen() {
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Route>();
  const insets = useSafeAreaInsets();

  const draft = useStore((s) => s.receiptDraft);
  const saveReceiptReview = useStore((s) => s.saveReceiptReview);
  const deleteReviewedReceipt = useStore((s) => s.deleteReviewedReceipt);
  const openReceiptForEdit = useStore((s) => s.openReceiptForEdit);
  const clearReceiptDraft = useStore((s) => s.clearReceiptDraft);

  const [fields, setFields] = useState<ReviewFields | null>(null);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [loading, setLoading] = useState(params.mode === "edit");
  const [pickingDate, setPickingDate] = useState(false);
  // Problems are marked only once Save has been tried, then follow edits live.
  const [triedSave, setTriedSave] = useState(false);

  const seededFrom = useRef<ReceiptDraft | null>(null);
  const seededFields = useRef<ReviewFields | null>(null);
  // Set when the screen closes itself (saved, deleted, gone): no "discard?".
  const closing = useRef(false);
  const busyRef = useRef(false);

  // Seed from the draft, and reseed ONLY when the draft object changes. A
  // failed save leaves the same object in the store, so this never fires
  // and every input stays (the keep-input contract).
  useEffect(() => {
    if (!draft || draft === seededFrom.current || !draftFits(draft, params)) return;
    seededFrom.current = draft;
    const f = fieldsFromDraft(draft);
    seededFields.current = f;
    setFields(f);
    setTriedSave(false);
  }, [draft, params]);

  const close = () => {
    closing.current = true;
    navigation.goBack();
  };

  const sayGone = () =>
    Alert.alert(
      "This receipt no longer exists",
      "It may have been deleted on another device.",
      [{ text: "OK", onPress: close }],
      { cancelable: false },
    );

  // Edit mode: load the receipt.
  useEffect(() => {
    if (params.mode !== "edit") return;
    let live = true;
    openReceiptForEdit(params.receiptId).then((result) => {
      if (!live) return;
      setLoading(false);
      if (result === "gone") sayGone();
      if (result === "failed") {
        Alert.alert("Couldn't open that receipt", "Check your connection and try again.", [
          { text: "OK", onPress: close },
        ]);
      }
    });
    return () => {
      live = false;
    };
    // Once, for this route's receipt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every way out clears the draft — it holds photos and a person's shopping.
  useEffect(() => () => clearReceiptDraft(), [clearReceiptDraft]);

  // Back, hardware back or swipe: a fresh scan (or an edit with changes)
  // asks before it's thrown away. Nothing leaves mid-save.
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  useEffect(() => {
    const unsubscribe = navigation.addListener("beforeRemove", (e) => {
      if (closing.current) return;
      if (busyRef.current) {
        e.preventDefault();
        return;
      }
      const f = fieldsRef.current;
      const unsaved = params.mode === "create" ? f != null : f != null && f !== seededFields.current;
      if (!unsaved) return;
      e.preventDefault();
      Alert.alert(
        params.mode === "create" ? "Discard this receipt?" : "Discard your changes?",
        params.mode === "create" ? "The scan won't be saved." : "The receipt stays as it was saved.",
        [
          { text: "Keep editing", style: "cancel" },
          {
            text: "Discard",
            style: "destructive",
            onPress: () => {
              closing.current = true;
              navigation.dispatch(e.data.action);
            },
          },
        ],
      );
    });
    return unsubscribe;
  }, [navigation, params.mode]);

  const run = async (kind: "save" | "delete", work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(kind);
    try {
      await work();
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const onSave = () =>
    run("save", async () => {
      if (!fields) return;
      // Exactly what's on screen right now — no blur needed.
      const out = await saveReceiptReview(fields);
      switch (out.kind) {
        case "saved":
        case "no_draft":
          close();
          return;
        case "invalid":
          setTriedSave(true);
          Alert.alert("Can't save yet", out.message);
          return;
        case "gone":
          sayGone();
          return;
        case "failed":
          // Nothing is cleared: the draft is untouched, so every input stays.
          Alert.alert("Couldn't save", "Check your connection and try again. Everything you've entered is still here.");
          return;
      }
    });

  const onDelete = () =>
    Alert.alert("Delete this receipt?", "Its lines go with it. This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          run("delete", async () => {
            const out = await deleteReviewedReceipt();
            if (out.kind === "deleted" || out.kind === "no_draft") close();
            else if (out.kind === "gone") sayGone();
            else Alert.alert("Couldn't delete", "Check your connection and try again.");
          }),
      },
    ]);

  const header = (
    <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
      <Pressable
        onPress={() => navigation.goBack()}
        style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Back"
        disabled={busy != null}
      >
        <Text style={styles.backArrow}>‹</Text>
      </Pressable>
      <Text style={styles.headerTitle}>{params.mode === "create" ? "Review receipt" : "Edit receipt"}</Text>
      <View style={{ width: 36 }} />
    </View>
  );

  if (loading || !fields || !draft) {
    return (
      <SafeAreaView style={styles.safe} edges={["bottom"]}>
        {header}
        <View style={styles.center}>
          <ActivityIndicator color={Colors.textSub} />
        </View>
      </SafeAreaView>
    );
  }

  const isCreate = params.mode === "create";
  const multiPart = isCreate && draft.parts.length > 1;
  const summary = reviewSummary(fields);
  const banner = reconcileBanner(summary.reconcile);
  const parsed = triedSave ? parseReview(fields) : null;
  const problems = parsed && !parsed.ok ? parsed.problems : null;
  const edit = (f: ReviewFields) => setFields(f);

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      {header}
      <KeyboardScreen>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {showLongReceiptNotice(draft) && (
            <View style={styles.notice}>
              <Text style={styles.noticeText}>{LONG_RECEIPT_NOTICE}</Text>
            </View>
          )}

          <Text style={styles.label}>Store</Text>
          <TextInput
            style={styles.input}
            value={fields.store}
            onChangeText={(store) => edit({ ...fields, store })}
            placeholder="Not read"
            placeholderTextColor={Colors.textDim}
            autoCorrect={false}
          />

          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Date</Text>
              <Pressable
                style={({ pressed }) => [styles.chip, pressed && { opacity: 0.75 }]}
                onPress={() => setPickingDate(true)}
                accessibilityRole="button"
                accessibilityLabel="Change the date"
              >
                <Text style={styles.chipText}>{formatDayLabel(fields.purchasedOn)}</Text>
                {fields.purchasedOnEstimated && <Text style={styles.chipHint}>not on receipt · tap to set</Text>}
              </Pressable>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Total</Text>
              <TextInput
                style={[styles.input, problems?.total && styles.inputBad]}
                value={fields.totalText}
                onChangeText={(totalText) => edit({ ...fields, totalText })}
                placeholder="Unknown"
                placeholderTextColor={Colors.textDim}
                keyboardType={AMOUNT_KEYBOARD}
              />
            </View>
          </View>

          <Text style={[styles.label, (problems?.currency || fields.currency == null) && styles.labelWarn]}>
            {fields.currency == null ? "Currency not read: choose one" : "Currency"}
          </Text>
          <View style={[styles.currencyRow, problems?.currency && styles.currencyRowBad]}>
            {[
              ...CURRENCIES,
              // A saved receipt in another currency still shows it.
              ...(fields.currency && !CURRENCIES.some((c) => c.code === fields.currency)
                ? [{ code: fields.currency, label: fields.currency }]
                : []),
            ].map((c) => {
              const on = fields.currency === c.code;
              return (
                <Pressable
                  key={c.code}
                  style={[styles.currencyChip, on && styles.currencyChipOn]}
                  onPress={() => edit(setCurrency(fields, c.code))}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                >
                  <Text style={[styles.currencyText, on && styles.currencyTextOn]}>{c.label}</Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.summary}>
            <Text style={styles.count}>{itemCountLabel(summary.counts)}</Text>
            <View style={[styles.banner, bannerStyle(banner.tone)]}>
              <Text style={[styles.bannerText, { color: bannerColor(banner.tone) }]}>{banner.text}</Text>
            </View>
            {isCreate && summary.flaggedCount > 0 && (
              <Text style={styles.flagHint}>
                {summary.flaggedCount === 1 ? "1 line" : `${summary.flaggedCount} lines`} may be repeated where
                the photos overlap. Check against the receipt, and remove any that aren't real.
              </Text>
            )}
          </View>

          {fields.lines.map((line) => (
            <LineRow
              key={line.key}
              line={line}
              currency={fields.currency}
              showPart={multiPart}
              showFlag={isCreate && line.possibleSeamDuplicate}
              problem={problems?.lines[line.key]}
              onChange={(patch) => setFields((f) => (f ? updateLine(f, line.key, patch) : f))}
              onRemove={() => setFields((f) => (f ? removeLine(f, line.key) : f))}
            />
          ))}

          <Pressable
            style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.75 }]}
            onPress={() => edit(addLine(fields))}
            accessibilityRole="button"
          >
            <Text style={styles.addText}>+ Add line</Text>
          </Pressable>

          {!isCreate && (
            <Pressable
              style={({ pressed }) => [styles.deleteBtn, pressed && { opacity: 0.75 }]}
              onPress={onDelete}
              disabled={busy != null}
              accessibilityRole="button"
            >
              {busy === "delete" ? (
                <ActivityIndicator size="small" color={Colors.danger} />
              ) : (
                <Text style={styles.deleteText}>Delete receipt</Text>
              )}
            </Pressable>
          )}
        </ScrollView>

        <View style={styles.footer}>
          <Pressable
            style={({ pressed }) => [styles.primaryBtn, busy != null && styles.primaryBtnDisabled, pressed && { opacity: 0.88 }]}
            onPress={onSave}
            disabled={busy != null}
            accessibilityRole="button"
          >
            {busy === "save" ? (
              <ActivityIndicator size="small" color={Colors.bg} />
            ) : (
              <Text style={styles.primaryBtnText}>{isCreate ? "Save receipt" : "Save changes"}</Text>
            )}
          </Pressable>
        </View>
      </KeyboardScreen>

      <DateTimeField
        visible={pickingDate}
        value={parseDateKey(fields.purchasedOn)}
        mode="date"
        onConfirm={(picked) => {
          setPickingDate(false);
          setFields((f) => (f ? setPurchasedOn(f, dateKey(picked)) : f));
        }}
        onCancel={() => setPickingDate(false)}
      />
    </SafeAreaView>
  );
}

function LineRow({
  line,
  currency,
  showPart,
  showFlag,
  problem,
  onChange,
  onRemove,
}: {
  line: ReviewLine;
  currency: string | null;
  showPart: boolean;
  showFlag: boolean;
  problem: "text" | "amount" | undefined;
  onChange: (patch: Partial<Pick<ReviewLine, "rawText" | "totalText">>) => void;
  onRemove: () => void;
}) {
  const unit =
    line.unitPricePence != null && line.qty != null
      ? line.qtyUnit === "kg"
        ? `${line.qty} kg @ ${formatPence(line.unitPricePence, currency ?? "")}/kg`
        : `${line.qty} × ${formatPence(line.unitPricePence, currency ?? "")}`
      : null;
  return (
    <View style={[styles.line, showFlag && styles.lineFlagged]}>
      {(showPart || showFlag || unit) && (
        <View style={styles.lineMeta}>
          {showPart && line.part != null && <Text style={styles.partTag}>Part {line.part}</Text>}
          {unit && <Text style={styles.unitText}>{unit}</Text>}
          {showFlag && (
            <>
              <Text style={styles.flagTag}>Possible repeat</Text>
              <Pressable onPress={onRemove} hitSlop={8} accessibilityRole="button" accessibilityLabel="Remove this possible repeat">
                <Text style={styles.flagRemove}>Remove</Text>
              </Pressable>
            </>
          )}
        </View>
      )}
      <View style={styles.lineInputs}>
        <TextInput
          style={[styles.input, styles.lineText, problem === "text" && styles.inputBad]}
          value={line.rawText}
          onChangeText={(rawText) => onChange({ rawText })}
          placeholder="Item"
          placeholderTextColor={Colors.textDim}
          autoCorrect={false}
        />
        <TextInput
          style={[styles.input, styles.lineAmount, problem === "amount" && styles.inputBad]}
          value={line.totalText}
          onChangeText={(totalText) => onChange({ totalText })}
          placeholder="—"
          placeholderTextColor={Colors.textDim}
          keyboardType={AMOUNT_KEYBOARD}
          textAlign="right"
        />
        <Pressable
          style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
          onPress={onRemove}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Remove line"
        >
          <Text style={styles.iconText}>✕</Text>
        </Pressable>
      </View>
    </View>
  );
}

const bannerColor = (tone: BannerTone) =>
  tone === "ok" ? Colors.green : tone === "warn" ? Colors.warning : Colors.textSub;
const bannerStyle = (tone: BannerTone) => ({
  borderColor: tone === "ok" ? Colors.green : tone === "warn" ? Colors.warning : Colors.border,
});

const styles = StyleSheet.create(
  withDefaultFont({
    safe: { flex: 1, backgroundColor: Colors.bg },
    center: { flex: 1, alignItems: "center", justifyContent: "center" },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: Spacing.md,
      paddingBottom: Spacing.sm,
    },
    backBtn: {
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: Colors.surface,
      borderRadius: Radius.pill,
      borderWidth: 1,
      borderColor: Colors.border,
    },
    backArrow: { fontSize: 22, color: Colors.textSub, lineHeight: 26, marginTop: -2 },
    headerTitle: { fontSize: Typography.base, fontWeight: Typography.bold, color: Colors.text },

    body: { paddingHorizontal: Spacing.md, paddingBottom: Spacing.lg, gap: Spacing.sm },
    notice: {
      borderWidth: 1,
      borderColor: Colors.warning,
      borderRadius: Radius.card,
      padding: Spacing.md,
    },
    noticeText: { fontSize: Typography.sm, color: Colors.text, lineHeight: Typography.sm * Typography.normal },

    label: { fontSize: Typography.xs, fontWeight: Typography.semibold, color: Colors.textSub, marginTop: Spacing.xs },
    labelWarn: { color: Colors.warning },
    row: { flexDirection: "row", gap: Spacing.md },
    input: {
      backgroundColor: Colors.surface,
      borderRadius: Radius.control,
      borderWidth: 1,
      borderColor: Colors.border,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 8,
      fontSize: Typography.base,
      color: Colors.text,
    },
    inputBad: { borderColor: Colors.danger },

    chip: {
      backgroundColor: Colors.surface,
      borderRadius: Radius.control,
      borderWidth: 1,
      borderColor: Colors.border,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 8,
    },
    chipText: { fontSize: Typography.base, color: Colors.text },
    chipHint: { fontSize: Typography.xs, color: Colors.warning },

    currencyRow: { flexDirection: "row", gap: Spacing.sm, borderRadius: Radius.control, borderWidth: 1, borderColor: "transparent" },
    currencyRowBad: { borderColor: Colors.danger },
    currencyChip: {
      paddingHorizontal: Spacing.md,
      paddingVertical: 8,
      borderRadius: Radius.pill,
      borderWidth: 1,
      borderColor: Colors.border,
      backgroundColor: Colors.surface,
    },
    currencyChipOn: { backgroundColor: Colors.green, borderColor: Colors.green },
    currencyText: { fontSize: Typography.sm, fontWeight: Typography.semibold, color: Colors.text },
    currencyTextOn: { color: Colors.bg },

    summary: { gap: Spacing.sm, marginVertical: Spacing.sm },
    count: { fontSize: Typography.md, fontWeight: Typography.bold, color: Colors.text },
    banner: { borderWidth: 1, borderRadius: Radius.control, padding: Spacing.sm },
    bannerText: { fontSize: Typography.sm, fontWeight: Typography.semibold },
    flagHint: { fontSize: Typography.sm, color: Colors.warning },

    line: {
      backgroundColor: Colors.surface,
      borderRadius: Radius.control,
      borderWidth: 1,
      borderColor: Colors.border,
      padding: Spacing.xs,
      gap: Spacing.xs,
    },
    lineFlagged: { borderColor: Colors.warning },
    lineMeta: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, paddingHorizontal: Spacing.xs },
    partTag: { fontSize: Typography.xs, color: Colors.textMuted },
    unitText: { fontSize: Typography.xs, color: Colors.textMuted },
    flagTag: { fontSize: Typography.xs, fontWeight: Typography.bold, color: Colors.warning },
    flagRemove: { fontSize: Typography.xs, fontWeight: Typography.bold, color: Colors.text, textDecorationLine: "underline" },
    lineInputs: { flexDirection: "row", alignItems: "center", gap: Spacing.xs },
    lineText: { flex: 1, backgroundColor: Colors.surface2 },
    lineAmount: { width: 84, backgroundColor: Colors.surface2 },
    iconBtn: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: Radius.pill,
      borderWidth: 1,
      borderColor: Colors.border,
    },
    iconText: { fontSize: Typography.sm, color: Colors.textSub },

    addBtn: {
      borderRadius: Radius.control,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: Colors.border,
      paddingVertical: 10,
      alignItems: "center",
    },
    addText: { fontSize: Typography.sm, fontWeight: Typography.semibold, color: Colors.textSub },
    deleteBtn: {
      marginTop: Spacing.lg,
      borderRadius: Radius.pill,
      borderWidth: 1,
      borderColor: Colors.danger,
      paddingVertical: 11,
      alignItems: "center",
    },
    deleteText: { fontSize: Typography.sm, fontWeight: Typography.bold, color: Colors.danger },

    footer: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm, paddingBottom: Spacing.md },
    primaryBtn: {
      backgroundColor: Colors.green,
      borderRadius: Radius.pill,
      paddingVertical: 13,
      alignItems: "center",
      justifyContent: "center",
    },
    primaryBtnDisabled: { opacity: 0.5 },
    primaryBtnText: { fontSize: Typography.base, fontWeight: Typography.bold, color: Colors.bg },
  }),
);
