// ============================================================
// src/screens/BundleApplyReviewScreen.tsx
//
// Apply-time quantity adjustment (Phase 1). Sits between ApplyBundleSheet's
// time picker and the actual insert: the anchor step is unchanged (Add →
// pick a time), but instead of applying immediately, that now routes here.
//
// Reads/writes useStore's `compositionApplyDraft` slice exclusively — no
// navigation params (see the RootStackParamList comment on this route) and
// no local component copy of the drafts. Per-row grams TEXT is local state
// (same pattern as BatchEditorScreen's IngredientRow): only a successfully
// parsed, positive number is committed back to the store, on blur/submit.
// This is deliberate, not an oversight — it's what lets the user type
// "1" then "10" then "10." without the field fighting them mid-edit, and
// it's exactly IngredientRow's own commit-or-revert shape.
//
// An item whose original serving_g is NULL or <=0 has no denominator to
// scale from — scaleEntryDraftGrams refuses by returning the draft
// unchanged, and this screen mirrors that at the UI layer: the grams field
// is disabled with an inline note, never a guessed default weight, and the
// item is never hidden.
// ============================================================

import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  ActivityIndicator,
  StyleSheet,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";

import {
  useStore,
  CompositionApplyDraftItem,
  compositionApplyItemChanged,
} from "../store/useStore";
import { scaleEntryDraftGrams } from "../lib/compositions";
import { formatTime } from "../lib/time";
import {
  Colors,
  Spacing,
  Typography,
  Radius,
  Fonts,
  withDefaultFont,
} from "../theme/tokens";
import { EntryDraft, MEAL_LABELS, RootStackParamList } from "../types";

type Nav = NativeStackNavigationProp<RootStackParamList, "BundleApplyReview">;

/** The item's scaled EntryDraft, resolved fresh from originalDraft +
 *  currentGramsG every render — nothing scaled is ever stored mid-edit. */
function scaledDraftOf(item: CompositionApplyDraftItem): EntryDraft {
  return scaleEntryDraftGrams(
    item.originalDraft,
    item.originalDraft.serving_g,
    item.currentGramsG ?? item.originalDraft.serving_g ?? 0,
  );
}

function ReviewRow({
  item,
  onCommitGrams,
}: {
  item: CompositionApplyDraftItem;
  onCommitGrams: (grams: number) => void;
}) {
  const rescalable =
    item.originalDraft.serving_g != null && item.originalDraft.serving_g > 0;

  const [gramsText, setGramsText] = useState(
    item.currentGramsG != null ? String(item.currentGramsG) : "",
  );

  const scaled = scaledDraftOf(item);

  const commit = () => {
    const g = parseFloat(gramsText.replace(",", "."));
    if (Number.isFinite(g) && g > 0) {
      onCommitGrams(g);
    } else {
      // Revert — don't accept garbage, don't silently zero the item.
      setGramsText(item.currentGramsG != null ? String(item.currentGramsG) : "");
    }
  };

  return (
    <View style={styles.row}>
      <View style={styles.rowMeta}>
        <Text style={styles.rowName} numberOfLines={1}>
          {scaled.name}
        </Text>
        <Text style={styles.rowSub}>
          {formatTime(scaled.eaten_at)} ·{" "}
          {MEAL_LABELS[scaled.meal_type]}
        </Text>
        {!rescalable && (
          <Text style={styles.rowNote}>
            No saved quantity for this item — applies unchanged.
          </Text>
        )}
      </View>

      <View style={styles.rowQty}>
        <TextInput
          style={[styles.gramsInput, !rescalable && styles.gramsInputDisabled]}
          value={rescalable ? gramsText : "—"}
          onChangeText={setGramsText}
          onBlur={commit}
          onSubmitEditing={commit}
          editable={rescalable}
          keyboardType="decimal-pad"
          returnKeyType="done"
          selectTextOnFocus
        />
        <Text style={styles.gramsUnit}>g</Text>
      </View>

      <Text style={styles.rowKcal}>{Math.round(scaled.calories)} kcal</Text>
    </View>
  );
}

export function BundleApplyReviewScreen() {
  const navigation = useNavigation<Nav>();
  const {
    compositionApplyDraft,
    setCompositionApplyItemGrams,
    resetCompositionApplyDraft,
    applyCompositionDraft,
    saveCompositionApplyQuantities,
  } = useStore();

  const [applying, setApplying] = useState(false);

  // Phase 2: "Also update this bundle." Off by default, local-only (like
  // BatchEditorScreen's qtyText) — this is a one-shot choice for THIS
  // confirm, not draft state anything else reads.
  const [alsoUpdateBundle, setAlsoUpdateBundle] = useState(false);

  // Nothing to review — e.g. this screen reached without startCompositionApplyDraft
  // having run first. Bail rather than render against null.
  useEffect(() => {
    if (!compositionApplyDraft) navigation.goBack();
  }, [compositionApplyDraft, navigation]);

  // Reset on every genuine exit (back, gesture, or Confirm's own popToTop) —
  // same beforeRemove pattern as BatchEditorScreen's draft. applyCompositionDraft
  // deliberately does NOT clear the slice itself; this is the only place that does,
  // so a successful confirm can't race this screen's own "no draft" guard above.
  useEffect(() => {
    const unsubscribe = navigation.addListener("beforeRemove", () => {
      resetCompositionApplyDraft();
    });
    return unsubscribe;
  }, [navigation, resetCompositionApplyDraft]);

  if (!compositionApplyDraft) return null;

  const scaledDrafts = compositionApplyDraft.items.map(scaledDraftOf);
  const itemCount = scaledDrafts.length;

  // Totals sum the EDITED drafts, not the bundle's saved items — this is
  // what makes the hero numbers agree with what's about to be inserted.
  const totals = scaledDrafts.reduce(
    (acc, d) => ({
      calories: acc.calories + d.calories,
      protein: acc.protein + d.protein,
      carbs: acc.carbs + d.carbs,
      fat: acc.fat + d.fat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );

  // Save-back is bundle-only (see CompositionApplyDraft.compositionKind)
  // and only meaningful when at least one item actually changed — an
  // unrescalable item never counts, same predicate the store action itself
  // filters on, so the toggle can never promise a write that would end up
  // doing nothing.
  const isBundle = compositionApplyDraft.compositionKind === "bundle";
  const anyChanged = compositionApplyDraft.items.some(compositionApplyItemChanged);
  const canOfferSaveBack = isBundle && anyChanged;

  const handleConfirm = async () => {
    setApplying(true);

    // Apply runs FIRST, always — it's what makes today a logged day, and it
    // must neither wait on nor be undone by the (optional, secondary)
    // save-back below. If it fails, stop here exactly as Phase 1 did: the
    // draft survives for a retry, and nothing was logged or saved.
    const { error: applyError } = await applyCompositionDraft();
    if (applyError) {
      setApplying(false);
      Alert.alert("Couldn't apply that bundle", applyError);
      return;
    }

    // The apply already succeeded — the meal IS logged from here on,
    // regardless of what happens below. Save-back is a separate,
    // best-effort operation: its failure gets its own distinct message,
    // never one that could be misread as "nothing happened."
    if (canOfferSaveBack && alsoUpdateBundle) {
      const { error: saveError } = await saveCompositionApplyQuantities();
      setApplying(false);
      if (saveError) {
        Alert.alert("Logged, but the bundle wasn't updated", saveError);
        navigation.popToTop();
        return;
      }
      navigation.popToTop();
      return;
    }

    setApplying(false);
    navigation.popToTop();
  };

  return (
    <SafeAreaView style={styles.root} edges={["bottom"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.hero}>
          <Text style={styles.heroTitle}>Adjust & apply</Text>
          <Text style={styles.heroSource}>{compositionApplyDraft.compositionName}</Text>

          <View style={styles.statsRow}>
            <View style={styles.statCell}>
              <Text style={styles.statValue}>{Math.round(totals.calories)}</Text>
              <Text style={styles.statLabel}>kcal</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statCell}>
              <Text style={styles.statValue}>{totals.protein.toFixed(1)}g</Text>
              <Text style={styles.statLabel}>protein</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statCell}>
              <Text style={styles.statValue}>{totals.carbs.toFixed(1)}g</Text>
              <Text style={styles.statLabel}>carbs</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statCell}>
              <Text style={styles.statValue}>{totals.fat.toFixed(1)}g</Text>
              <Text style={styles.statLabel}>fat</Text>
            </View>
          </View>
        </View>

        <Text style={styles.sectionLabel}>
          {itemCount} item{itemCount !== 1 ? "s" : ""}
        </Text>
        <View style={styles.card}>
          {compositionApplyDraft.items.map((item, i) => (
            <View
              key={item.itemId}
              style={
                i < compositionApplyDraft.items.length - 1
                  ? styles.rowBorder
                  : undefined
              }
            >
              <ReviewRow
                item={item}
                onCommitGrams={(g) => setCompositionApplyItemGrams(item.itemId, g)}
              />
            </View>
          ))}
        </View>
      </ScrollView>

      <View style={styles.footer}>
        {/* Phase 2 — secondary to Confirm: smaller, muted, no button chrome,
            and never rendered at all for a batch (canOfferSaveBack is false
            whenever compositionKind !== 'bundle', regardless of anyChanged). */}
        {isBundle && (
          <Pressable
            style={styles.saveBackRow}
            disabled={!anyChanged}
            onPress={() => setAlsoUpdateBundle((v) => !v)}
            hitSlop={8}
          >
            <View
              style={[
                styles.checkbox,
                alsoUpdateBundle && anyChanged && styles.checkboxChecked,
                !anyChanged && styles.checkboxDisabled,
              ]}
            >
              {alsoUpdateBundle && anyChanged && (
                <Text style={styles.checkboxMark}>✓</Text>
              )}
            </View>
            <Text
              style={[
                styles.saveBackLabel,
                !anyChanged && styles.saveBackLabelDisabled,
              ]}
            >
              {anyChanged
                ? "Also update this bundle"
                : "Also update this bundle — change a quantity above first"}
            </Text>
          </Pressable>
        )}

        <Pressable
          onPress={handleConfirm}
          disabled={applying}
          style={[styles.confirmBtn, applying && styles.confirmBtnDisabled]}
        >
          {applying ? (
            <ActivityIndicator color={Colors.bg} />
          ) : (
            <Text style={styles.confirmBtnText}>
              Add {itemCount} item{itemCount !== 1 ? "s" : ""} to my log
            </Text>
          )}
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

// ─── Styles — modelled on CopyConfirmScreen's hero/card/footer treatment ───

const styles = StyleSheet.create(
  withDefaultFont({
    root: {
      flex: 1,
      backgroundColor: Colors.bg,
    },
    scroll: {
      paddingBottom: Spacing.xxl,
    },

    hero: {
      margin: Spacing.md,
      padding: Spacing.md,
      backgroundColor: Colors.surface,
      borderRadius: Radius.card,
      borderWidth: 1,
      borderColor: Colors.border,
      gap: Spacing.sm,
    },
    heroTitle: {
      fontSize: Typography.lg,
      fontWeight: Typography.bold,
      color: Colors.text,
    },
    heroSource: {
      fontSize: Typography.base,
      color: Colors.textMuted,
    },

    statsRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-around",
      marginTop: Spacing.sm,
      paddingTop: Spacing.sm,
      borderTopWidth: 1,
      borderTopColor: Colors.borderSub,
    },
    statCell: {
      alignItems: "center",
      gap: 2,
    },
    statValue: {
      fontSize: Typography.md,
      fontWeight: Typography.bold,
      fontFamily: Fonts.mono.bold,
      color: Colors.text,
    },
    statLabel: {
      fontSize: Typography.xs,
      color: Colors.textMuted,
    },
    statDivider: {
      width: 1,
      height: 28,
      backgroundColor: Colors.borderSub,
    },

    sectionLabel: {
      fontSize: Typography.xs,
      fontWeight: Typography.semibold,
      color: Colors.textMuted,
      letterSpacing: 0.8,
      textTransform: "uppercase",
      paddingHorizontal: Spacing.md,
      paddingBottom: Spacing.xs,
    },

    card: {
      marginHorizontal: Spacing.md,
      backgroundColor: Colors.surface,
      borderRadius: Radius.card,
      borderWidth: 1,
      borderColor: Colors.border,
      overflow: "hidden",
    },
    rowBorder: {
      borderBottomWidth: 1,
      borderBottomColor: Colors.borderSub,
    },

    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: Spacing.md,
      paddingVertical: Spacing.sm,
      gap: Spacing.sm,
    },
    rowMeta: {
      flex: 1,
    },
    rowName: {
      fontSize: Typography.base,
      fontWeight: Typography.medium,
      color: Colors.text,
    },
    rowSub: {
      fontSize: Typography.sm,
      color: Colors.textMuted,
      marginTop: 2,
    },
    rowNote: {
      fontSize: Typography.xs,
      color: Colors.warning,
      marginTop: 2,
    },

    rowQty: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    gramsInput: {
      width: 56,
      textAlign: "right",
      fontSize: Typography.base,
      fontFamily: Fonts.mono.regular,
      color: Colors.text,
      borderWidth: 1,
      borderColor: Colors.border,
      borderRadius: Radius.control,
      paddingVertical: 4,
      paddingHorizontal: 6,
    },
    gramsInputDisabled: {
      color: Colors.textMuted,
      borderColor: Colors.borderSub,
    },
    gramsUnit: {
      fontSize: Typography.sm,
      color: Colors.textMuted,
    },

    rowKcal: {
      fontSize: Typography.base,
      fontWeight: Typography.semibold,
      fontFamily: Fonts.mono.semibold,
      color: Colors.textSub,
      minWidth: 64,
      textAlign: "right",
    },

    footer: {
      paddingHorizontal: Spacing.md,
      paddingTop: Spacing.sm,
      paddingBottom: Spacing.md,
      borderTopWidth: 1,
      borderTopColor: Colors.border,
      backgroundColor: Colors.bg,
    },
    confirmBtn: {
      backgroundColor: Colors.green,
      borderRadius: Radius.control,
      padding: Spacing.md,
      alignItems: "center",
    },
    confirmBtnDisabled: {
      opacity: 0.6,
    },
    confirmBtnText: {
      fontSize: Typography.base,
      fontWeight: Typography.semibold,
      color: Colors.bg,
    },

    // Phase 2 — deliberately no button chrome (no background, no border-
    // radius fill): a checkbox row, not a second button, so it reads as
    // subordinate to confirmBtn above it rather than a competing action.
    saveBackRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingVertical: Spacing.sm,
    },
    checkbox: {
      width: 18,
      height: 18,
      borderRadius: 4,
      borderWidth: 1,
      borderColor: Colors.border,
      alignItems: "center",
      justifyContent: "center",
    },
    checkboxChecked: {
      backgroundColor: Colors.green,
      borderColor: Colors.green,
    },
    checkboxDisabled: {
      borderColor: Colors.borderSub,
    },
    checkboxMark: {
      fontSize: 12,
      fontWeight: Typography.bold,
      color: Colors.bg,
    },
    saveBackLabel: {
      fontSize: Typography.sm,
      color: Colors.textMuted,
      flex: 1,
    },
    saveBackLabelDisabled: {
      color: Colors.textMuted,
      opacity: 0.6,
    },
  }),
);
