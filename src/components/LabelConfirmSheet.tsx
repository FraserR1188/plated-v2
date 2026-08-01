// ============================================================
// src/components/LabelConfirmSheet.tsx
//
// "Is this what you've plated?" — the confirmation step between the
// vision call and the macro grid.
//
// WHY A MODAL, NOT A SCREEN:
// A pushed screen would mean serialising the in-progress form through
// navigation params and plumbing results back on the way out, plus a
// navigator entry and headerShown: false. A modal rendered inside
// CreateFoodScreen keeps the half-filled form alive in state and touches
// no navigator config.
//
// WHAT GETS APPLIED:
// The macro grid is per-100g, so per-100g is ALWAYS what gets written.
// The Per 100g / Per serving toggle is a VERIFICATION AID — it lets the
// user check the model read the right column of a two-column label. It
// does not change the outcome. The button says so explicitly.
// ============================================================

import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  MACRO_KEYS,
  scaleTo100g,
  type ExtractSuccess,
  type MacroKey,
  type MacroSet,
  type Reading,
} from "../lib/labelExtraction";
import {
  Colors,
  Spacing,
  Radius,
  Typography,
  MacroColor,
  Fonts,
  withDefaultFont,
} from "../theme/tokens";

// Amber, for "the model wasn't sure". Not in the macro palette on
// purpose — it must not be mistaken for a macro colour. Colors.warning
// is deliberately a different shade from MacroColor.carbs for exactly
// this reason (see tokens.ts).
const WARN = Colors.warning;

const MACRO_META: Record<
  MacroKey,
  { label: string; unit: string; color: string }
> = {
  cal: { label: "Calories", unit: "kcal", color: Colors.green },
  protein: { label: "Protein", unit: "g", color: MacroColor.protein },
  carbs: { label: "Carbs", unit: "g", color: MacroColor.carbs },
  fat: { label: "Fat", unit: "g", color: MacroColor.fat },
  satFat: { label: "Sat fat", unit: "g", color: MacroColor.satFat },
  salt: { label: "Salt", unit: "g", color: MacroColor.salt },
  fibre: { label: "Fibre", unit: "g", color: MacroColor.fibre },
  sugar: { label: "Sugar", unit: "g", color: MacroColor.sugar },
};

export type LabelConfirmApply = {
  per100g: MacroSet;
  servingG: number | null;
  servingLabel: string | null;
  productName: string | null;
};

type Props = {
  visible: boolean;
  loading: boolean;
  /** User-facing message from the Edge Function. */
  error: string | null;
  result: ExtractSuccess | null;
  onApply: (payload: LabelConfirmApply) => void;
  onDismiss: () => void;
  onRetry: () => void;
};

export function LabelConfirmSheet({
  visible,
  loading,
  error,
  result,
  onApply,
  onDismiss,
  onRetry,
}: Props) {
  const insets = useSafeAreaInsets();

  const [basis, setBasis] = useState<"per100g" | "perServing">("per100g");
  // Only used when the label gave a per-serving column with no gram weight.
  const [weightInput, setWeightInput] = useState("");

  const enteredWeight = useMemo(() => {
    const v = parseFloat(weightInput.replace(",", "."));
    return Number.isFinite(v) && v > 0 ? v : null;
  }, [weightInput]);

  // The per-100g set we'd actually apply. Either the server gave us one,
  // or the user is supplying the missing serving weight right now.
  const applicable: MacroSet | null = useMemo(() => {
    if (!result) return null;
    if (result.per100g) return result.per100g;
    if (result.needsServingWeight && result.perServing && enteredWeight) {
      return scaleTo100g(result.perServing, enteredWeight);
    }
    return null;
  }, [result, enteredWeight]);

  // Which column is on screen right now.
  const displayed: MacroSet | null = useMemo(() => {
    if (!result) return null;
    if (basis === "perServing" && result.perServing) return result.perServing;
    return applicable;
  }, [result, basis, applicable]);

  const hasBothColumns = !!(result?.per100g && result?.perServing);

  const handleApply = () => {
    if (!result || !applicable) return;
    onApply({
      per100g: applicable,
      // If the user typed the weight, that's the serving weight.
      servingG: result.servingG ?? enteredWeight,
      servingLabel: result.servingLabel,
      productName: result.productName,
    });
  };

  const reset = () => {
    setBasis("per100g");
    setWeightInput("");
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={() => {
        reset();
        onDismiss();
      }}
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.grabber} />

          {/* ── Loading ─────────────────────────────── */}
          {loading && (
            <View style={styles.stateBox}>
              <ActivityIndicator color={Colors.green} size="large" />
              <Text style={styles.stateTitle}>Reading the label…</Text>
              <Text style={styles.stateText}>
                This usually takes a few seconds.
              </Text>
            </View>
          )}

          {/* ── Error ───────────────────────────────── */}
          {!loading && error && (
            <View style={styles.stateBox}>
              <Text style={styles.stateIcon}>🔍</Text>
              <Text style={styles.stateTitle}>Couldn't read that one</Text>
              <Text style={styles.stateText}>{error}</Text>

              <View style={styles.errorActions}>
                <Pressable
                  style={({ pressed }) => [
                    styles.secondaryBtn,
                    pressed && { opacity: 0.7 },
                  ]}
                  onPress={() => {
                    reset();
                    onDismiss();
                  }}
                >
                  <Text style={styles.secondaryBtnText}>Enter by hand</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [
                    styles.primaryBtn,
                    styles.flex1,
                    pressed && { opacity: 0.88 },
                  ]}
                  onPress={() => {
                    reset();
                    onRetry();
                  }}
                >
                  <Text style={styles.primaryBtnText}>Retake photo</Text>
                </Pressable>
              </View>
            </View>
          )}

          {/* ── Result ──────────────────────────────── */}
          {!loading && !error && result && (
            <ScrollView
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={styles.title}>Is this what you've plated?</Text>
              <Text style={styles.subtitle}>
                {result.productName
                  ? result.productName
                  : "Check these against the packet before you save."}
              </Text>

              {/* Column toggle — verification aid only. */}
              {hasBothColumns && (
                <View style={styles.toggle}>
                  <ToggleTab
                    label="Per 100g"
                    active={basis === "per100g"}
                    onPress={() => setBasis("per100g")}
                  />
                  <ToggleTab
                    label={
                      result.servingG
                        ? `Per serving (${result.servingG}g)`
                        : "Per serving"
                    }
                    active={basis === "perServing"}
                    onPress={() => setBasis("perServing")}
                  />
                </View>
              )}

              {/* The missing-weight case: label had a per-serving column
                  but never said what a serving weighs. We can't normalise
                  without it, so ask. */}
              {result.needsServingWeight && (
                <View style={styles.weightPrompt}>
                  <Text style={styles.weightPromptTitle}>
                    How much does one serving weigh?
                  </Text>
                  <Text style={styles.weightPromptText}>
                    This label only gives per-serving values
                    {result.servingLabel ? ` (${result.servingLabel})` : ""}, so
                    I need the weight to work out the per-100g figures.
                  </Text>
                  <View style={styles.weightRow}>
                    <TextInput
                      style={styles.weightInput}
                      value={weightInput}
                      onChangeText={setWeightInput}
                      placeholder="30"
                      placeholderTextColor={Colors.textMuted}
                      keyboardType="decimal-pad"
                      maxLength={6}
                      autoFocus
                    />
                    <Text style={styles.weightUnit}>g</Text>
                  </View>
                </View>
              )}

              {/* Macro grid */}
              {displayed ? (
                <View style={styles.grid}>
                  {MACRO_KEYS.map((key) => (
                    <MacroCell
                      key={key}
                      macroKey={key}
                      reading={displayed[key]}
                    />
                  ))}
                </View>
              ) : (
                <View style={styles.gridPlaceholder}>
                  <Text style={styles.stateText}>
                    Enter the serving weight above to see the per-100g values.
                  </Text>
                </View>
              )}

              {/* Serving, if the label gave us one */}
              {result.servingG != null && (
                <Text style={styles.servingNote}>
                  Serving: {result.servingG}g
                  {result.servingLabel ? ` — ${result.servingLabel}` : ""}
                </Text>
              )}

              {/* What the SERVER worked out, as opposed to read. The user
                  deserves to know when a number isn't on their packet. */}
              {result.notes.length > 0 && (
                <View style={styles.notes}>
                  {result.notes.map((n, i) => (
                    <Text key={i} style={styles.noteText}>
                      • {n}
                    </Text>
                  ))}
                </View>
              )}

              {/* Legend — only when something is actually flagged. */}
              {displayed && hasUncertainty(displayed) && (
                <Text style={styles.legend}>
                  <Text style={{ color: WARN }}>●</Text> Amber values were hard
                  to read. A dash means I couldn't find it at all.
                </Text>
              )}

              {/* Actions */}
              <View style={styles.actions}>
                <Pressable
                  style={({ pressed }) => [
                    styles.secondaryBtn,
                    pressed && { opacity: 0.7 },
                  ]}
                  onPress={() => {
                    reset();
                    onDismiss();
                  }}
                >
                  <Text style={styles.secondaryBtnText}>Discard</Text>
                </Pressable>

                <Pressable
                  style={({ pressed }) => [
                    styles.primaryBtn,
                    styles.flex1,
                    !applicable && styles.primaryBtnDisabled,
                    pressed && applicable && { opacity: 0.88 },
                  ]}
                  onPress={handleApply}
                  disabled={!applicable}
                >
                  <Text
                    style={[
                      styles.primaryBtnText,
                      !applicable && styles.primaryBtnTextDisabled,
                    ]}
                  >
                    Use per-100g values
                  </Text>
                </Pressable>
              </View>

              <Text style={styles.footnote}>
                You can edit anything after it's filled in.
              </Text>
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

// ─── Pieces ──────────────────────────────────────────────────

function hasUncertainty(set: MacroSet): boolean {
  return MACRO_KEYS.some(
    (k) => set[k].value == null || set[k].confidence === "low",
  );
}

function ToggleTab({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.toggleTab,
        active && styles.toggleTabActive,
        pressed && { opacity: 0.8 },
      ]}
    >
      <Text
        style={[styles.toggleTabText, active && styles.toggleTabTextActive]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function MacroCell({
  macroKey,
  reading,
}: {
  macroKey: MacroKey;
  reading: Reading;
}) {
  const meta = MACRO_META[macroKey];
  const missing = reading?.value == null;
  const uncertain = !missing && reading.confidence === "low";

  // Colour carries meaning here: macro colour = read cleanly, amber = the
  // model wasn't sure, muted dash = not on the label.
  const tint = missing ? Colors.textMuted : uncertain ? WARN : meta.color;

  return (
    <View style={[styles.cell, { backgroundColor: `${tint}12` }]}>
      <View style={styles.cellValueRow}>
        <Text style={[styles.cellValue, { color: tint }]} numberOfLines={1}>
          {missing ? "—" : String(reading.value)}
        </Text>
        {!missing && <Text style={styles.cellUnit}>{meta.unit}</Text>}
      </View>
      <Text style={styles.cellLabel}>{meta.label}</Text>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────

const styles = StyleSheet.create(
  withDefaultFont({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: Colors.bg,
    borderTopLeftRadius: Radius.card,
    borderTopRightRadius: Radius.card,
    borderTopWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    maxHeight: "88%",
  },
  grabber: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    marginBottom: Spacing.md,
  },

  title: {
    fontSize: Typography.lg,
    fontWeight: Typography.bold,
    color: Colors.text,
    letterSpacing: -0.4,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: Typography.sm,
    color: Colors.textSub,
    marginBottom: Spacing.md,
    lineHeight: 19,
  },

  // ── States ──
  stateBox: {
    alignItems: "center",
    paddingVertical: Spacing.xl,
    paddingHorizontal: Spacing.md,
    gap: Spacing.xs,
  },
  stateIcon: { fontSize: 34, marginBottom: 4 },
  stateTitle: {
    fontSize: Typography.md,
    fontWeight: Typography.bold,
    color: Colors.text,
    marginTop: Spacing.sm,
  },
  stateText: {
    fontSize: Typography.sm,
    color: Colors.textSub,
    textAlign: "center",
    lineHeight: 20,
  },
  errorActions: {
    flexDirection: "row",
    gap: Spacing.sm,
    marginTop: Spacing.md,
    alignSelf: "stretch",
  },

  // ── Column toggle ──
  toggle: {
    flexDirection: "row",
    backgroundColor: Colors.surface2,
    borderRadius: Radius.pill,
    padding: 3,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  toggleTab: {
    flex: 1,
    paddingVertical: 8,
    alignItems: "center",
    borderRadius: Radius.pill,
  },
  toggleTabActive: { backgroundColor: Colors.surface },
  toggleTabText: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.textMuted,
  },
  toggleTabTextActive: { color: Colors.text },

  // ── Missing-weight prompt ──
  weightPrompt: {
    backgroundColor: `${WARN}12`,
    borderRadius: Radius.control,
    borderWidth: 1,
    borderColor: `${WARN}35`,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    gap: 6,
  },
  weightPromptTitle: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    color: Colors.text,
  },
  weightPromptText: {
    fontSize: Typography.xs,
    color: Colors.textSub,
    lineHeight: 17,
  },
  weightRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    marginTop: 4,
  },
  weightInput: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.control,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    fontFamily: Fonts.mono.semibold,
    color: Colors.text,
    width: 92,
    textAlign: "center",
  },
  weightUnit: {
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.textSub,
  },

  // ── Macro grid ──
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: Spacing.sm,
  },
  gridPlaceholder: {
    paddingVertical: Spacing.lg,
    alignItems: "center",
  },
  cell: {
    borderRadius: Radius.control,
    paddingVertical: Spacing.sm,
    paddingHorizontal: 6,
    alignItems: "center",
    minWidth: "22%",
    flex: 1,
  },
  cellValueRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 2,
  },
  cellValue: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    fontFamily: Fonts.mono.bold,
    letterSpacing: -0.2,
  },
  cellUnit: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
  },
  cellLabel: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    marginTop: 2,
    fontWeight: Typography.medium,
  },

  servingNote: {
    fontSize: Typography.xs,
    color: Colors.textSub,
    marginBottom: Spacing.xs,
    fontWeight: Typography.medium,
  },

  notes: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.control,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.sm,
    marginTop: Spacing.xs,
    gap: 3,
  },
  noteText: {
    fontSize: Typography.xs,
    color: Colors.textSub,
    lineHeight: 17,
  },

  legend: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    lineHeight: 17,
    marginTop: Spacing.sm,
  },

  // ── Actions ──
  actions: {
    flexDirection: "row",
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },
  flex1: { flex: 1 },
  primaryBtn: {
    backgroundColor: Colors.green,
    borderRadius: Radius.pill,
    paddingVertical: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnDisabled: {
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  primaryBtnText: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.bg,
  },
  primaryBtnTextDisabled: { color: Colors.textMuted },
  secondaryBtn: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: 15,
    paddingHorizontal: Spacing.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryBtnText: {
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.textSub,
  },

  footnote: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    textAlign: "center",
    marginTop: Spacing.sm,
  },
  }),
);
