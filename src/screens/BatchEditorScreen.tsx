// ============================================================
// src/screens/BatchEditorScreen.tsx
// ============================================================
// Create AND edit, one screen — compositionId omitted means create, present
// means edit (same pattern as ProductScreen's editEntryId).
//
// The ingredient list, name, and yield/portion fields all render straight
// off useStore's `batchDraft` slice rather than local component state.
// BatchIngredientPickerScreen adds to that same slice directly
// (addBatchIngredient/addBatchIngredients) and pops — there is no callback
// handed through navigation params anymore. See useStore.ts's BatchDraft
// comment for why: a function in a nav param broke React Navigation's
// "Non-serializable values" contract and couldn't survive state restore.
//
// DRAFT LIFECYCLE — read before touching either effect below.
//   - Edit mode hydrates the draft from the existing composition ONCE, at
//     mount (see the effect below `existing`). Deliberately not re-run when
//     `existing` changes: useFocusEffect's fetchCompositions() refetches on
//     every refocus, including the refocus FROM BatchIngredientPicker — if
//     hydration re-ran then, it would silently discard whatever the user
//     just picked mid-edit.
//   - Create mode resets the draft at mount as a belt-and-braces guard
//     against a stale draft surviving from an abandoned previous session.
//   - Every genuine exit (header back, hardware back, gesture, or Save's
//     navigation.goBack()) resets the draft via a `beforeRemove` listener —
//     NOT a blur/useFocusEffect cleanup, which would also fire when merely
//     navigating to BatchIngredientPicker and clear the draft mid-build.
//
// YIELD-ON-EDIT: the moment the ingredient set changes (add / remove /
// quantity edit — NOT renaming the batch or the portion label), the yield
// and portion fields are CLEARED, not left holding a stale number and not
// silently recomputed from the new ingredient weights. This now happens
// INSIDE the store's batch-draft actions (addBatchIngredient(s),
// removeBatchIngredient, updateBatchIngredientQuantity), not here. A
// tappable "use the raw ingredient weight" suggestion appears once
// ingredients exist, but filling it in is a deliberate tap — never
// automatic. Save is disabled while either field is empty or invalid, so
// there is no path to saving a batch whose yield doesn't reflect its
// current ingredients.
//
// IMMUTABILITY: saving here (create or edit) never touches meal_entries —
// see compositions.ts's updateBatch for why an edit is safe by construction,
// not by care taken here.
// ============================================================

import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Alert,
  ActivityIndicator,
} from "react-native";
import { useFocusEffect, useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useStore, BatchDraftIngredient } from "../store/useStore";
import { BatchIngredientInput } from "../lib/compositions";
import {
  Colors,
  Spacing,
  Radius,
  Typography,
  Fonts,
  withDefaultFont,
} from "../theme/tokens";
import { FoodProduct, MealCompositionItem, RootStackParamList } from "../types";

type Nav = NativeStackNavigationProp<RootStackParamList, "BatchEditor">;
type Route = RouteProp<RootStackParamList, "BatchEditor">;

/**
 * Reconstruct an approximate FoodProduct (per-100g rates) from an already-
 * saved batch item's ABSOLUTE macros, so an existing ingredient's quantity
 * can be edited the same way a freshly-picked one can.
 *
 * ⚠ LOSSY, same shape and same caveat as foodLookup.mealEntryToProduct: the
 * round-trip (rate → absolute at save → rate again on next edit) does not
 * commute exactly, because of rounding at each step. Accepted here for the
 * same reason it's accepted there — the alternative is refusing to let an
 * existing ingredient's quantity be edited at all — but unlike that screen,
 * the user directly SEES and can correct the reconstructed numbers (via the
 * quantity/macros they're actively editing) before anything saves, so the
 * failure mode is "slightly off, visibly," not "silently wrong."
 */
function productFromItem(item: MealCompositionItem): FoodProduct | null {
  if (item.serving_g == null || item.serving_g <= 0) return null;
  const g = item.serving_g;
  const rate = (v: number, dp: number) => +((v / g) * 100).toFixed(dp);
  const rateOptional = (v: number | null, dp: number): number | undefined =>
    v == null ? undefined : rate(v, dp);

  return {
    name: item.name,
    brand: item.brand ?? "",
    cal_per100: Math.round(rate(item.calories, 0)),
    protein_per100: rate(item.protein, 1),
    carbs_per100: rate(item.carbs, 1),
    fat_per100: rate(item.fat, 1),
    sat_fat_per100: rateOptional(item.sat_fat, 1),
    salt_per100: rateOptional(item.salt, 2),
    fibre_per100: rateOptional(item.fibre, 1),
    sugar_per100: rateOptional(item.sugar, 1),
    barcode: item.barcode ?? undefined,
    off_id: item.off_id ?? undefined,
    image_url: item.image_url ?? undefined,
    image_path: item.image_path ?? undefined,
    custom_food_id: item.custom_food_id ?? undefined,
  };
}

function IngredientRow({
  ingredient,
  onQuantityChange,
  onRemove,
}: {
  ingredient: BatchDraftIngredient;
  onQuantityChange: (g: number) => void;
  onRemove: () => void;
}) {
  const [qtyText, setQtyText] = useState(String(ingredient.quantityG));

  const commit = () => {
    const g = parseFloat(qtyText.replace(",", "."));
    if (Number.isFinite(g) && g > 0) {
      onQuantityChange(g);
    } else {
      setQtyText(String(ingredient.quantityG)); // revert — don't accept garbage
    }
  };

  return (
    <View style={styles.ingredientRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.ingredientName} numberOfLines={1}>
          {ingredient.product.name}
        </Text>
        {ingredient.product.brand ? (
          <Text style={styles.ingredientBrand} numberOfLines={1}>
            {ingredient.product.brand}
          </Text>
        ) : null}
      </View>
      <TextInput
        style={styles.ingredientQtyInput}
        value={qtyText}
        onChangeText={setQtyText}
        onBlur={commit}
        onSubmitEditing={commit}
        keyboardType="decimal-pad"
        returnKeyType="done"
      />
      <Text style={styles.ingredientQtyUnit}>g</Text>
      <Pressable onPress={onRemove} hitSlop={10}>
        <Text style={styles.removeIcon}>✕</Text>
      </Pressable>
    </View>
  );
}

export function BatchEditorScreen() {
  const navigation = useNavigation<Nav>();
  const { compositionId } = useRoute<Route>().params;
  const isEditing = !!compositionId;
  const insets = useSafeAreaInsets();

  const {
    compositions,
    fetchCompositions,
    saveBatch,
    saveBatchEdits,
    removeComposition,
    batchDraft,
    setBatchDraftName,
    setBatchDraftPortionLabel,
    setBatchDraftTotalYieldG,
    setBatchDraftPortionSizeG,
    setBatchDraftIngredients,
    removeBatchIngredient,
    updateBatchIngredientQuantity,
    resetBatchDraft,
  } = useStore();

  const existing = isEditing
    ? compositions.find((c) => c.id === compositionId)
    : undefined;

  const [saving, setSaving] = useState(false);

  // Hydrate (edit) or reset (create) the draft ONCE at mount — see the
  // file-level DRAFT LIFECYCLE comment for why this must not re-run on
  // every `existing` change.
  useEffect(() => {
    if (existing) {
      setBatchDraftName(existing.name);
      setBatchDraftPortionLabel(existing.portion_label ?? "");
      setBatchDraftTotalYieldG(existing.yield_g != null ? String(existing.yield_g) : "");
      setBatchDraftPortionSizeG(existing.portion_g != null ? String(existing.portion_g) : "");
      setBatchDraftIngredients(
        existing.items.flatMap((item) => {
          const product = productFromItem(item);
          if (!product) {
            console.warn(
              `BatchEditor: skipping item ${item.id} — no usable serving_g to reconstruct from.`,
            );
            return [];
          }
          return [{ key: item.id, product, quantityG: item.serving_g! }];
        }),
      );
    } else {
      // Belt-and-braces: the draft SHOULD already be empty (the
      // beforeRemove listener below clears it on every exit), but a stale
      // draft surviving here would silently reopen a half-finished batch
      // from a previous session as if it were a fresh one.
      resetBatchDraft();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset on every genuine exit — NOT on blur, which also fires when
  // navigating to BatchIngredientPicker and would wipe the draft mid-build.
  // beforeRemove fires only when this screen is actually leaving the stack
  // (back button, hardware back, gesture, or Save's navigation.goBack()).
  useEffect(() => {
    const unsubscribe = navigation.addListener("beforeRemove", () => {
      resetBatchDraft();
    });
    return unsubscribe;
  }, [navigation, resetBatchDraft]);

  // Refetch on focus so an edit made elsewhere (or a slow initial load) isn't
  // silently stale — harmless if it's already fresh.
  useFocusEffect(
    useCallback(() => {
      fetchCompositions();
    }, []),
  );

  const rawSumG = batchDraft.ingredients.reduce((s, i) => s + i.quantityG, 0);
  const needsYieldConfirm =
    batchDraft.ingredients.length > 0 &&
    (batchDraft.totalYieldG.trim() === "" || batchDraft.portionSizeG.trim() === "");

  const yieldGNum = parseFloat(batchDraft.totalYieldG.replace(",", "."));
  const portionGNum = parseFloat(batchDraft.portionSizeG.replace(",", "."));
  const yieldValid = Number.isFinite(yieldGNum) && yieldGNum > 0;
  const portionValid = Number.isFinite(portionGNum) && portionGNum > 0;
  const portionFitsYield = !yieldValid || !portionValid || portionGNum <= yieldGNum;

  const canSave =
    batchDraft.name.trim().length > 0 &&
    batchDraft.ingredients.length > 0 &&
    yieldValid &&
    portionValid &&
    portionGNum <= yieldGNum;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);

    const ingredientInputs: BatchIngredientInput[] = batchDraft.ingredients.map((i) => ({
      product: i.product,
      quantityG: i.quantityG,
    }));

    const { error } = isEditing
      ? await saveBatchEdits(compositionId!, {
          name: batchDraft.name,
          yieldG: yieldGNum,
          portionG: portionGNum,
          portionLabel: batchDraft.portionLabel.trim() ? batchDraft.portionLabel.trim() : null,
          ingredients: ingredientInputs,
        })
      : await saveBatch({
          name: batchDraft.name,
          yieldG: yieldGNum,
          portionG: portionGNum,
          portionLabel: batchDraft.portionLabel.trim() ? batchDraft.portionLabel.trim() : null,
          ingredients: ingredientInputs,
        });

    setSaving(false);
    if (error) {
      Alert.alert("Couldn't save", error);
    } else {
      navigation.goBack();
    }
  };

  const handleDelete = () => {
    if (!compositionId) return;
    Alert.alert(
      "Delete batch",
      `Delete "${existing?.name ?? "this batch"}"? This can't be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            const { error } = await removeComposition(compositionId);
            if (error) {
              Alert.alert("Couldn't delete that", error);
              return;
            }
            navigation.goBack();
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <Pressable
            onPress={() => navigation.goBack()}
            style={({ pressed }) => [
              styles.backBtn,
              pressed && { opacity: 0.6 },
            ]}
            hitSlop={12}
          >
            <Text style={styles.backArrow}>‹</Text>
          </Pressable>
          <Text style={styles.headerTitle}>
            {isEditing ? "Edit batch" : "New batch"}
          </Text>
          <Pressable
            onPress={handleSave}
            disabled={!canSave || saving}
            style={({ pressed }) => [
              styles.saveBtn,
              (!canSave || saving) && styles.saveBtnDisabled,
              pressed && canSave && { opacity: 0.85 },
            ]}
          >
            {saving ? (
              <ActivityIndicator size="small" color={Colors.bg} />
            ) : (
              <Text style={styles.saveBtnText}>Save</Text>
            )}
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* ── Name ─────────────────────────────────── */}
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Name</Text>
            <TextInput
              style={styles.nameInput}
              value={batchDraft.name}
              onChangeText={setBatchDraftName}
              placeholder="Sunday pancakes, chilli, soup…"
              placeholderTextColor={Colors.textMuted}
              returnKeyType="done"
            />
          </View>

          {/* ── Ingredients ──────────────────────────── */}
          <View style={styles.card}>
            <Text style={styles.cardLabel}>
              Ingredients {batchDraft.ingredients.length > 0 ? `(${batchDraft.ingredients.length})` : ""}
            </Text>

            {batchDraft.ingredients.length === 0 ? (
              <Text style={styles.emptyIngredients}>
                Add what went into the pot — search or pick from your library.
              </Text>
            ) : (
              batchDraft.ingredients.map((ing) => (
                <IngredientRow
                  key={ing.key}
                  ingredient={ing}
                  onQuantityChange={(g) => updateBatchIngredientQuantity(ing.key, g)}
                  onRemove={() => removeBatchIngredient(ing.key)}
                />
              ))
            )}

            <Pressable
              style={({ pressed }) => [
                styles.addIngredientRow,
                pressed && { backgroundColor: Colors.surface2 },
              ]}
              onPress={() => navigation.navigate("BatchIngredientPicker")}
            >
              <Text style={styles.addIngredientIcon}>＋</Text>
              <Text style={styles.addIngredientText}>Add ingredient</Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [
                styles.addIngredientRow,
                pressed && { backgroundColor: Colors.surface2 },
              ]}
              onPress={() => navigation.navigate("RecipeScan")}
            >
              <Text style={styles.addIngredientIcon}>🪄</Text>
              <Text style={styles.addIngredientText}>Scan Recipe</Text>
            </Pressable>
          </View>

          {/* ── Yield & portion ──────────────────────── */}
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Yield &amp; portion</Text>

            {needsYieldConfirm && (
              <View style={styles.confirmBanner}>
                <Text style={styles.confirmBannerText}>
                  Ingredients changed — weigh the cooked result and confirm the
                  yield below.
                </Text>
                {rawSumG > 0 && (
                  <Pressable
                    onPress={() => setBatchDraftTotalYieldG(String(Math.round(rawSumG)))}
                    style={({ pressed }) => [
                      styles.suggestionChip,
                      pressed && { opacity: 0.8 },
                    ]}
                  >
                    <Text style={styles.suggestionChipText}>
                      Ingredients weigh ~{Math.round(rawSumG)}g raw — tap to use
                      as a starting point
                    </Text>
                  </Pressable>
                )}
              </View>
            )}

            <View style={styles.fieldRow}>
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Total yield</Text>
                <View style={styles.numberInputRow}>
                  <TextInput
                    style={styles.numberInput}
                    value={batchDraft.totalYieldG}
                    onChangeText={setBatchDraftTotalYieldG}
                    keyboardType="decimal-pad"
                    placeholder="e.g. 900"
                    placeholderTextColor={Colors.textMuted}
                  />
                  <Text style={styles.numberUnit}>g</Text>
                </View>
              </View>
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Portion size</Text>
                <View style={styles.numberInputRow}>
                  <TextInput
                    style={styles.numberInput}
                    value={batchDraft.portionSizeG}
                    onChangeText={setBatchDraftPortionSizeG}
                    keyboardType="decimal-pad"
                    placeholder="e.g. 150"
                    placeholderTextColor={Colors.textMuted}
                  />
                  <Text style={styles.numberUnit}>g</Text>
                </View>
              </View>
            </View>

            {!portionFitsYield && (
              <Text style={styles.errorText}>
                Portion size can't be more than the total yield.
              </Text>
            )}

            <Text style={styles.cardLabel}>Portion label (optional)</Text>
            <TextInput
              style={styles.nameInput}
              value={batchDraft.portionLabel}
              onChangeText={setBatchDraftPortionLabel}
              placeholder="1 pancake, 1 bowl…"
              placeholderTextColor={Colors.textMuted}
              returnKeyType="done"
            />
          </View>

          {isEditing && (
            <Pressable
              style={({ pressed }) => [
                styles.deleteRow,
                pressed && { opacity: 0.7 },
              ]}
              onPress={handleDelete}
            >
              <Text style={styles.deleteText}>Delete this batch</Text>
            </Pressable>
          )}

          <View style={{ height: Spacing.xxl }} />
        </ScrollView>
      </KeyboardAvoidingView>
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
    backArrow: {
      fontSize: 22,
      color: Colors.textSub,
      lineHeight: 26,
      marginTop: -2,
    },
    headerTitle: {
      fontSize: Typography.base,
      fontWeight: Typography.bold,
      color: Colors.text,
    },
    saveBtn: {
      backgroundColor: Colors.green,
      borderRadius: Radius.pill,
      paddingHorizontal: Spacing.md,
      paddingVertical: 8,
      minWidth: 64,
      alignItems: "center",
    },
    saveBtnDisabled: { backgroundColor: Colors.surface2 },
    saveBtnText: {
      fontSize: Typography.sm,
      fontWeight: Typography.bold,
      color: Colors.bg,
    },

    scroll: { paddingHorizontal: Spacing.md },

    card: {
      backgroundColor: Colors.surface,
      borderRadius: Radius.card,
      borderWidth: 1,
      borderColor: Colors.border,
      padding: Spacing.md,
      marginBottom: Spacing.md,
      gap: Spacing.sm,
    },
    cardLabel: {
      fontSize: Typography.xs,
      fontWeight: Typography.bold,
      color: Colors.textMuted,
      letterSpacing: 0.5,
      textTransform: "uppercase",
    },
    nameInput: {
      fontSize: Typography.base,
      color: Colors.text,
      paddingVertical: 6,
    },

    emptyIngredients: {
      fontSize: Typography.sm,
      color: Colors.textSub,
      lineHeight: 20,
    },
    ingredientRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.sm,
      paddingVertical: 6,
      borderBottomWidth: 1,
      borderBottomColor: Colors.borderSub,
    },
    ingredientName: {
      fontSize: Typography.sm,
      fontWeight: Typography.medium,
      color: Colors.text,
    },
    ingredientBrand: {
      fontSize: Typography.xs,
      color: Colors.textMuted,
    },
    ingredientQtyInput: {
      fontSize: Typography.sm,
      fontFamily: Fonts.mono.medium,
      color: Colors.text,
      minWidth: 44,
      textAlign: "right",
      backgroundColor: Colors.surface2,
      borderRadius: Radius.control,
      paddingHorizontal: 8,
      paddingVertical: 6,
    },
    ingredientQtyUnit: {
      fontSize: Typography.xs,
      color: Colors.textMuted,
    },
    removeIcon: {
      fontSize: Typography.sm,
      color: Colors.textDim,
      paddingHorizontal: 4,
    },

    addIngredientRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
      paddingVertical: Spacing.sm,
    },
    addIngredientIcon: {
      fontSize: Typography.base,
      color: Colors.green,
      fontWeight: Typography.bold,
    },
    addIngredientText: {
      fontSize: Typography.sm,
      fontWeight: Typography.semibold,
      color: Colors.green,
    },

    confirmBanner: {
      backgroundColor: `${Colors.warning}18`,
      borderRadius: Radius.control,
      borderWidth: 1,
      borderColor: `${Colors.warning}40`,
      padding: Spacing.sm,
      gap: Spacing.xs,
    },
    confirmBannerText: {
      fontSize: Typography.xs,
      color: Colors.text,
      lineHeight: 17,
    },
    suggestionChip: {
      alignSelf: "flex-start",
      backgroundColor: Colors.surface2,
      borderRadius: Radius.pill,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 6,
    },
    suggestionChipText: {
      fontSize: Typography.xs,
      fontWeight: Typography.semibold,
      color: Colors.green,
    },

    fieldRow: {
      flexDirection: "row",
      gap: Spacing.sm,
    },
    field: { flex: 1, gap: 4 },
    fieldLabel: {
      fontSize: Typography.xs,
      color: Colors.textMuted,
      fontWeight: Typography.medium,
    },
    numberInputRow: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: Colors.surface2,
      borderRadius: Radius.control,
      paddingHorizontal: Spacing.sm,
    },
    numberInput: {
      flex: 1,
      fontSize: Typography.base,
      fontFamily: Fonts.mono.semibold,
      color: Colors.text,
      paddingVertical: 10,
    },
    numberUnit: {
      fontSize: Typography.sm,
      color: Colors.textMuted,
    },
    errorText: {
      fontSize: Typography.xs,
      color: Colors.danger,
      fontWeight: Typography.medium,
    },

    deleteRow: {
      alignItems: "center",
      paddingVertical: Spacing.md,
    },
    deleteText: {
      fontSize: Typography.sm,
      fontWeight: Typography.semibold,
      color: Colors.danger,
    },
  }),
);
