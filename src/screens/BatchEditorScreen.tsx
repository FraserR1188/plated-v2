// ============================================================
// src/screens/BatchEditorScreen.tsx
// ============================================================
// Create AND edit, one screen — compositionId omitted means create, present
// means edit (same pattern as ProductScreen's editEntryId).
//
// YIELD-ON-EDIT: the moment the ingredient set changes (add / remove /
// quantity edit — NOT renaming the batch or the portion label), the yield
// and portion fields are CLEARED, not left holding a stale number and not
// silently recomputed from the new ingredient weights. A tappable "use the
// raw ingredient weight" suggestion appears once ingredients exist, but
// filling it in is a deliberate tap — never automatic. Save is disabled
// while either field is empty or invalid, so there is no path to saving a
// batch whose yield doesn't reflect its current ingredients.
//
// IMMUTABILITY: saving here (create or edit) never touches meal_entries —
// see compositions.ts's updateBatch for why an edit is safe by construction,
// not by care taken here.
// ============================================================

import React, { useCallback, useState } from "react";
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
import { useStore } from "../store/useStore";
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

interface DraftIngredient {
  key: string;
  product: FoodProduct;
  quantityG: number;
}

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
  ingredient: DraftIngredient;
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

  const { compositions, fetchCompositions, saveBatch, saveBatchEdits, removeComposition } =
    useStore();

  const existing = isEditing
    ? compositions.find((c) => c.id === compositionId)
    : undefined;

  const [name, setName] = useState(existing?.name ?? "");
  const [portionLabel, setPortionLabel] = useState(existing?.portion_label ?? "");
  const [yieldG, setYieldG] = useState(
    existing?.yield_g != null ? String(existing.yield_g) : "",
  );
  const [portionG, setPortionG] = useState(
    existing?.portion_g != null ? String(existing.portion_g) : "",
  );
  const [ingredients, setIngredients] = useState<DraftIngredient[]>(() => {
    if (!existing) return [];
    return existing.items.flatMap((item) => {
      const product = productFromItem(item);
      if (!product) {
        console.warn(
          `BatchEditor: skipping item ${item.id} — no usable serving_g to reconstruct from.`,
        );
        return [];
      }
      return [{ key: item.id, product, quantityG: item.serving_g! }];
    });
  });
  const [saving, setSaving] = useState(false);

  // Refetch on focus so an edit made elsewhere (or a slow initial load) isn't
  // silently stale — harmless if it's already fresh.
  useFocusEffect(
    useCallback(() => {
      fetchCompositions();
    }, []),
  );

  const clearYieldOnIngredientChange = () => {
    setYieldG("");
    setPortionG("");
  };

  const addIngredient = (product: FoodProduct, quantityG: number) => {
    setIngredients((prev) => [
      ...prev,
      { key: `${Date.now()}-${Math.random()}`, product, quantityG },
    ]);
    clearYieldOnIngredientChange();
  };

  const removeIngredient = (key: string) => {
    setIngredients((prev) => prev.filter((i) => i.key !== key));
    clearYieldOnIngredientChange();
  };

  const updateIngredientQuantity = (key: string, quantityG: number) => {
    setIngredients((prev) =>
      prev.map((i) => (i.key === key ? { ...i, quantityG } : i)),
    );
    clearYieldOnIngredientChange();
  };

  const rawSumG = ingredients.reduce((s, i) => s + i.quantityG, 0);
  const needsYieldConfirm =
    ingredients.length > 0 && (yieldG.trim() === "" || portionG.trim() === "");

  const yieldGNum = parseFloat(yieldG.replace(",", "."));
  const portionGNum = parseFloat(portionG.replace(",", "."));
  const yieldValid = Number.isFinite(yieldGNum) && yieldGNum > 0;
  const portionValid = Number.isFinite(portionGNum) && portionGNum > 0;
  const portionFitsYield = !yieldValid || !portionValid || portionGNum <= yieldGNum;

  const canSave =
    name.trim().length > 0 &&
    ingredients.length > 0 &&
    yieldValid &&
    portionValid &&
    portionGNum <= yieldGNum;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);

    const ingredientInputs: BatchIngredientInput[] = ingredients.map((i) => ({
      product: i.product,
      quantityG: i.quantityG,
    }));

    const { error } = isEditing
      ? await saveBatchEdits(compositionId!, {
          name,
          yieldG: yieldGNum,
          portionG: portionGNum,
          portionLabel: portionLabel.trim() ? portionLabel.trim() : null,
          ingredients: ingredientInputs,
        })
      : await saveBatch({
          name,
          yieldG: yieldGNum,
          portionG: portionGNum,
          portionLabel: portionLabel.trim() ? portionLabel.trim() : null,
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
              value={name}
              onChangeText={setName}
              placeholder="Sunday pancakes, chilli, soup…"
              placeholderTextColor={Colors.textMuted}
              returnKeyType="done"
            />
          </View>

          {/* ── Ingredients ──────────────────────────── */}
          <View style={styles.card}>
            <Text style={styles.cardLabel}>
              Ingredients {ingredients.length > 0 ? `(${ingredients.length})` : ""}
            </Text>

            {ingredients.length === 0 ? (
              <Text style={styles.emptyIngredients}>
                Add what went into the pot — search or pick from your library.
              </Text>
            ) : (
              ingredients.map((ing) => (
                <IngredientRow
                  key={ing.key}
                  ingredient={ing}
                  onQuantityChange={(g) => updateIngredientQuantity(ing.key, g)}
                  onRemove={() => removeIngredient(ing.key)}
                />
              ))
            )}

            <Pressable
              style={({ pressed }) => [
                styles.addIngredientRow,
                pressed && { backgroundColor: Colors.surface2 },
              ]}
              onPress={() =>
                navigation.navigate("BatchIngredientPicker", {
                  onPick: addIngredient,
                })
              }
            >
              <Text style={styles.addIngredientIcon}>＋</Text>
              <Text style={styles.addIngredientText}>Add ingredient</Text>
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
                    onPress={() => setYieldG(String(Math.round(rawSumG)))}
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
                    value={yieldG}
                    onChangeText={setYieldG}
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
                    value={portionG}
                    onChangeText={setPortionG}
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
              value={portionLabel}
              onChangeText={setPortionLabel}
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
