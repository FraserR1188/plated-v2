// ============================================================
// src/screens/ReceiptScanScreen.tsx — photograph a till receipt in 1–3 parts
// (receipt-scanner findings §4, commit 5a)
//
// A root-stack modal. It follows RecipeScanScreen's preview-before-scan
// shape, extended to an ordered list: each part is checked (full screen) and
// put in order before one scan is spent on all of them.
//
//   • Parts live in the store's receiptDraft, never in route params: three
//     photos of base64 are far too big for navigation state (findings §7).
//   • The order on screen is the order sent (lib/receiptCapture.ts).
//   • A failed scan keeps every part on screen (the PL-003 rule applied to
//     capture), so a retry never means re-photographing.
//   • Leaving the screen any other way (back, hardware back, swipe) clears
//     the draft: a stale set of photos must not greet the next scan. Only a
//     successful scan keeps it, and hands over to ReceiptReview (5b).
// ============================================================

import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  Image,
  Pressable,
  Alert,
  ScrollView,
  Modal,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useStore } from "../store/useStore";
import { captureImage, pickImage } from "../lib/imageCapture";
import {
  addPart,
  canAddPart,
  movePart,
  removePart,
  scanParts,
  draftFromScan,
  type ReceiptPart,
} from "../lib/receiptCapture";
import { MAX_RECEIPT_PARTS } from "../lib/receiptScan";
import { dateKey } from "../lib/time";
import { Colors, Overlay, Spacing, Radius, Typography, withDefaultFont } from "../theme/tokens";
import { RootStackParamList } from "../types";

type Nav = NativeStackNavigationProp<RootStackParamList, "ReceiptScan">;

const NO_PARTS: ReceiptPart[] = [];

export function ReceiptScanScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  const parts = useStore((s) => s.receiptDraft?.parts ?? NO_PARTS);
  const startReceiptCapture = useStore((s) => s.startReceiptCapture);
  const setReceiptParts = useStore((s) => s.setReceiptParts);
  const setReceiptDraft = useStore((s) => s.setReceiptDraft);
  const clearReceiptDraft = useStore((s) => s.clearReceiptDraft);

  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  // Set only by a successful scan: the unmount cleanup then keeps the draft.
  const keepDraft = useRef(false);

  // Open a fresh capture draft, unless one is already being captured. A
  // draft holding a previous scan's lines, or an edit-mode draft, is
  // replaced: this screen only ever starts a new receipt.
  useEffect(() => {
    const d = useStore.getState().receiptDraft;
    if (!d || d.mode.kind !== "create" || d.lines.length > 0) {
      startReceiptCapture(dateKey());
    }
    return () => {
      if (!keepDraft.current) clearReceiptDraft();
    };
  }, [startReceiptCapture, clearReceiptDraft]);

  // Always read the latest parts from the store, not a render's closure:
  // a capture resolves after the user may have reordered.
  const currentParts = () => useStore.getState().receiptDraft?.parts ?? NO_PARTS;

  const handleAdd = async (source: "camera" | "library") => {
    if (!canAddPart(currentParts())) return;
    setBusy(true);
    try {
      const result = source === "camera" ? await captureImage("receipt") : await pickImage("receipt");
      switch (result.status) {
        case "cancelled":
          return;
        case "permission_denied":
          Alert.alert(
            source === "camera" ? "Camera access needed" : "Photos access needed",
            source === "camera"
              ? "Enable camera access in Settings to photograph a receipt."
              : "Enable photo access in Settings to choose a receipt photo.",
          );
          return;
        case "prep_failed":
          Alert.alert("Couldn't process that photo", "Try taking it again.");
          return;
        case "ok":
          setReceiptParts(addPart(currentParts(), result.image));
          return;
      }
    } finally {
      setBusy(false);
    }
  };

  const handleScan = async () => {
    const toSend = currentParts();
    if (toSend.length === 0 || toSend.length > MAX_RECEIPT_PARTS) return;
    setBusy(true);
    try {
      const result = await scanParts(toSend);
      if (!result.ok) {
        // Every part stays on screen for a retry.
        Alert.alert("Couldn't scan that receipt", result.message);
        return;
      }
      keepDraft.current = true;
      setReceiptDraft(draftFromScan(result, toSend, dateKey()));
      // Replace, not push: back from review returns to the opener, not to
      // a capture screen whose draft review now owns.
      navigation.replace("ReceiptReview", { mode: "create" });
    } finally {
      setBusy(false);
    }
  };

  const canAdd = canAddPart(parts);

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable
          onPress={() => navigation.goBack()}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          disabled={busy}
        >
          <Text style={styles.backArrow}>‹</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Scan receipt</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Text style={styles.hint}>
          Long receipt? Photograph it in parts from the top, overlapping each by a line or two.
        </Text>

        {parts.map((part, i) => (
          // The same library photo can be added twice, so the uri alone isn't unique.
          <View key={`${i}:${part.uri}`} style={styles.partRow}>
            <Pressable
              onPress={() => setViewing(i)}
              accessibilityRole="imagebutton"
              accessibilityLabel={`View part ${i + 1} full screen`}
            >
              <Image source={{ uri: part.uri }} style={styles.thumb} resizeMode="cover" />
            </Pressable>
            <Text style={styles.partLabel}>Part {i + 1}</Text>
            <View style={styles.partActions}>
              {i > 0 && (
                <Pressable
                  style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
                  onPress={() => setReceiptParts(movePart(currentParts(), i, -1))}
                  disabled={busy}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={`Move part ${i + 1} up`}
                >
                  <Text style={styles.iconText}>↑</Text>
                </Pressable>
              )}
              {i < parts.length - 1 && (
                <Pressable
                  style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
                  onPress={() => setReceiptParts(movePart(currentParts(), i, 1))}
                  disabled={busy}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={`Move part ${i + 1} down`}
                >
                  <Text style={styles.iconText}>↓</Text>
                </Pressable>
              )}
              <Pressable
                style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
                onPress={() => setReceiptParts(removePart(currentParts(), i))}
                disabled={busy}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={`Remove part ${i + 1}`}
              >
                <Text style={styles.iconText}>✕</Text>
              </Pressable>
            </View>
          </View>
        ))}

        {canAdd ? (
          <>
            {parts.length > 0 && <Text style={styles.addLabel}>Add another part</Text>}
            <View style={styles.photoChoices}>
              <Pressable
                style={({ pressed }) => [styles.photoChoiceBtn, pressed && { opacity: 0.75 }]}
                onPress={() => handleAdd("camera")}
                disabled={busy}
              >
                <Text style={styles.photoChoiceIcon}>📷</Text>
                <Text style={styles.photoChoiceText}>Take photo</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.photoChoiceBtn, pressed && { opacity: 0.75 }]}
                onPress={() => handleAdd("library")}
                disabled={busy}
              >
                <Text style={styles.photoChoiceIcon}>🖼️</Text>
                <Text style={styles.photoChoiceText}>Choose from library</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <Text style={styles.capText}>3 parts is the most per receipt</Text>
        )}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          style={({ pressed }) => [
            styles.primaryBtn,
            (parts.length === 0 || busy) && styles.primaryBtnDisabled,
            pressed && { opacity: 0.88 },
          ]}
          onPress={handleScan}
          disabled={parts.length === 0 || busy}
          accessibilityRole="button"
        >
          {busy ? (
            <ActivityIndicator size="small" color={Colors.bg} />
          ) : (
            <Text style={styles.primaryBtnText}>
              {parts.length > 1 ? `Scan ${parts.length} parts` : "Scan receipt"}
            </Text>
          )}
        </Pressable>
      </View>

      <Modal
        visible={viewing !== null && !!parts[viewing]}
        transparent
        animationType="fade"
        onRequestClose={() => setViewing(null)}
      >
        <Pressable style={styles.viewer} onPress={() => setViewing(null)} accessibilityLabel="Close">
          {viewing !== null && parts[viewing] && (
            <>
              <Image source={{ uri: parts[viewing].uri }} style={styles.viewerImage} resizeMode="contain" />
              <Text style={styles.viewerLabel}>Part {viewing + 1} · tap to close</Text>
            </>
          )}
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create(
  withDefaultFont({
    safe: { flex: 1, backgroundColor: Colors.bg },
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

    body: { paddingHorizontal: Spacing.md, paddingBottom: Spacing.lg, gap: Spacing.md },
    hint: { fontSize: Typography.sm, color: Colors.textSub, lineHeight: Typography.sm * Typography.normal },

    partRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.md,
      backgroundColor: Colors.surface,
      borderRadius: Radius.card,
      borderWidth: 1,
      borderColor: Colors.border,
      padding: Spacing.sm,
    },
    thumb: { width: 60, height: 80, borderRadius: Radius.control, backgroundColor: Colors.surface2 },
    partLabel: { flex: 1, fontSize: Typography.base, fontWeight: Typography.semibold, color: Colors.text },
    partActions: { flexDirection: "row", gap: Spacing.xs },
    iconBtn: {
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: Radius.pill,
      borderWidth: 1,
      borderColor: Colors.border,
      backgroundColor: Colors.surface2,
    },
    iconText: { fontSize: Typography.md, color: Colors.text },

    addLabel: { fontSize: Typography.sm, fontWeight: Typography.semibold, color: Colors.textSub },
    capText: { fontSize: Typography.sm, color: Colors.textMuted, textAlign: "center" },

    photoChoices: { gap: Spacing.md },
    photoChoiceBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      backgroundColor: Colors.surface,
      borderRadius: Radius.card,
      borderWidth: 1,
      borderColor: Colors.border,
      paddingVertical: Spacing.lg,
    },
    photoChoiceIcon: { fontSize: 22 },
    photoChoiceText: { fontSize: Typography.base, fontWeight: Typography.semibold, color: Colors.text },

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

    viewer: { flex: 1, backgroundColor: Overlay.black, alignItems: "center", justifyContent: "center" },
    viewerImage: { width: "100%", height: "88%" },
    viewerLabel: { color: Overlay.white, fontSize: Typography.sm, marginTop: Spacing.sm },
  }),
);
