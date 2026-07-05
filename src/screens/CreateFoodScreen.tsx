// ============================================================
// src/screens/CreateFoodScreen.tsx — add a food OFF doesn't know
//
// Reached from:
//   • ScannerScreen "Add it manually" (barcode pre-filled)
//   • AddIngredientScreen "Can't find it? Add your own" (phase 1b,
//     initialName pre-filled)
//
// On save: inserts into custom_foods, then replaces itself with
// ProductScreen so the user logs the food in the same flow.
// ============================================================

import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Pressable,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { createCustomFood, customFoodToProduct } from "../lib/foodLookup";
import { Colors, Spacing, Radius, Typography, MacroColor } from "../theme";
import { RootStackParamList, MEAL_LABELS } from "../types";

type Nav = NativeStackNavigationProp<RootStackParamList, "CreateFood">;
type Route = RouteProp<RootStackParamList, "CreateFood">;

// ─── Macro input definitions ─────────────────────────────────

type MacroKey =
  | "cal"
  | "protein"
  | "carbs"
  | "fat"
  | "salt"
  | "fibre"
  | "sugar";

const MACRO_FIELDS: {
  key: MacroKey;
  label: string;
  unit: string;
  color: string;
}[] = [
  { key: "cal", label: "Calories", unit: "kcal", color: Colors.green },
  { key: "protein", label: "Protein", unit: "g", color: MacroColor.protein },
  { key: "carbs", label: "Carbs", unit: "g", color: MacroColor.carbs },
  { key: "fat", label: "Fat", unit: "g", color: MacroColor.fat },
  { key: "salt", label: "Salt", unit: "g", color: MacroColor.salt },
  { key: "fibre", label: "Fibre", unit: "g", color: MacroColor.fibre },
  { key: "sugar", label: "Sugar", unit: "g", color: MacroColor.sugar },
];

const num = (s: string): number => {
  const v = parseFloat(s.replace(",", "."));
  return Number.isFinite(v) && v >= 0 ? v : 0;
};

export function CreateFoodScreen() {
  const navigation = useNavigation<Nav>();
  const { date, mealType, barcode, initialName } = useRoute<Route>().params;
  const insets = useSafeAreaInsets();

  const [name, setName] = useState(initialName ?? "");
  const [brand, setBrand] = useState("");
  const [code, setCode] = useState(barcode ?? "");
  const [macros, setMacros] = useState<Record<MacroKey, string>>({
    cal: "",
    protein: "",
    carbs: "",
    fat: "",
    salt: "",
    fibre: "",
    sugar: "",
  });
  const [servingG, setServingG] = useState("");
  const [servingLabel, setServingLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const setMacro = (key: MacroKey, value: string) =>
    setMacros((m) => ({ ...m, [key]: value }));

  // Name + calories are the minimum for a useful entry.
  const canSave = useMemo(
    () => name.trim().length > 0 && macros.cal.trim().length > 0 && !saving,
    [name, macros.cal, saving],
  );

  const mealLabel = MEAL_LABELS[mealType];

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError("");

    const sg = num(servingG);
    const { food, error: err } = await createCustomFood({
      name: name.trim(),
      brand: brand.trim() ? brand.trim() : null,
      barcode: code.trim() ? code.trim() : null,
      cal_per100: Math.round(num(macros.cal)),
      protein_per100: num(macros.protein),
      carbs_per100: num(macros.carbs),
      fat_per100: num(macros.fat),
      salt_per100: num(macros.salt),
      fibre_per100: num(macros.fibre),
      sugar_per100: num(macros.sugar),
      serving_g: sg > 0 ? sg : null,
      serving_label: servingLabel.trim() ? servingLabel.trim() : null,
    });

    setSaving(false);

    if (!food) {
      setError(err ?? "Couldn't save — please try again.");
      return;
    }

    // Straight into the normal logging flow with the new food.
    navigation.replace("Product", {
      product: customFoodToProduct(food),
      date,
      mealType,
    });
  };

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          {/* ── Header ──────────────────────────────────── */}
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
            <View style={styles.headerCentre}>
              <Text style={styles.headerTitle}>Create a food</Text>
              <View style={styles.mealPill}>
                <Text style={styles.mealPillText}>{mealLabel}</Text>
              </View>
            </View>
          </View>

          {code ? (
            <Text style={styles.introText}>
              This barcode isn't in the food database yet. Add the details from
              the label and it'll scan instantly next time.
            </Text>
          ) : null}

          {/* ── Identity card ───────────────────────────── */}
          <View style={styles.card}>
            <Text style={styles.cardSectionLabel}>Product</Text>

            <Text style={styles.fieldLabel}>Name *</Text>
            <TextInput
              style={styles.textField}
              value={name}
              onChangeText={setName}
              placeholder="e.g. Crunchy Oat Cereal"
              placeholderTextColor={Colors.textMuted}
              autoCapitalize="words"
              returnKeyType="next"
            />

            <Text style={styles.fieldLabel}>Brand</Text>
            <TextInput
              style={styles.textField}
              value={brand}
              onChangeText={setBrand}
              placeholder="Optional"
              placeholderTextColor={Colors.textMuted}
              autoCapitalize="words"
              returnKeyType="next"
            />

            <Text style={styles.fieldLabel}>Barcode</Text>
            <TextInput
              style={[styles.textField, styles.barcodeField]}
              value={code}
              onChangeText={setCode}
              placeholder="Optional"
              placeholderTextColor={Colors.textMuted}
              keyboardType="number-pad"
            />
          </View>

          {/* ── Nutrition card ──────────────────────────── */}
          <View style={styles.card}>
            <Text style={styles.cardSectionLabel}>Nutrition per 100g</Text>
            <Text style={styles.nutritionHint}>
              Copy these from the nutrition table on the packaging.
            </Text>

            <View style={styles.macroGrid}>
              {MACRO_FIELDS.map((m) => (
                <View
                  key={m.key}
                  style={[
                    styles.macroInputCell,
                    { backgroundColor: `${m.color}12` },
                  ]}
                >
                  <View style={styles.macroInputRow}>
                    <TextInput
                      style={[styles.macroInput, { color: m.color }]}
                      value={macros[m.key]}
                      onChangeText={(v) => setMacro(m.key, v)}
                      placeholder="0"
                      placeholderTextColor={`${m.color}55`}
                      keyboardType="decimal-pad"
                      selectTextOnFocus
                      maxLength={6}
                    />
                    <Text style={styles.macroUnit}>{m.unit}</Text>
                  </View>
                  <Text style={styles.macroCellLabel}>
                    {m.label}
                    {m.key === "cal" ? " *" : ""}
                  </Text>
                </View>
              ))}
            </View>
          </View>

          {/* ── Serving size card (optional) ─────────────── */}
          <View style={styles.card}>
            <Text style={styles.cardSectionLabel}>
              Typical serving (optional)
            </Text>
            <View style={styles.servingRow}>
              <TextInput
                style={[styles.textField, styles.servingInput]}
                value={servingG}
                onChangeText={setServingG}
                placeholder="45"
                placeholderTextColor={Colors.textMuted}
                keyboardType="decimal-pad"
                maxLength={6}
              />
              <Text style={styles.servingUnit}>g</Text>
              <TextInput
                style={[styles.textField, styles.servingLabelInput]}
                value={servingLabel}
                onChangeText={setServingLabel}
                placeholder='e.g. "1 bowl"'
                placeholderTextColor={Colors.textMuted}
              />
            </View>
          </View>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <View style={{ height: 100 }} />
        </ScrollView>

        {/* ── Sticky save button ───────────────────────── */}
        <View style={styles.fab}>
          <Pressable
            style={({ pressed }) => [
              styles.saveBtn,
              !canSave && styles.saveBtnDisabled,
              pressed && canSave && { opacity: 0.88 },
            ]}
            onPress={handleSave}
            disabled={!canSave}
          >
            {saving ? (
              <ActivityIndicator color={Colors.bg} />
            ) : (
              <Text
                style={[
                  styles.saveBtnText,
                  !canSave && styles.saveBtnTextDisabled,
                ]}
              >
                Save & add to {mealLabel}
              </Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Styles ──────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  scroll: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },

  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.surface,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  backArrow: {
    fontSize: 22,
    color: Colors.textSub,
    lineHeight: 26,
    marginTop: -2,
  },
  headerCentre: { flex: 1, gap: 3 },
  headerTitle: {
    fontSize: Typography.md,
    fontWeight: Typography.bold,
    color: Colors.text,
    letterSpacing: -0.3,
  },
  mealPill: {
    alignSelf: "flex-start",
    backgroundColor: Colors.greenSoft,
    borderRadius: Radius.full,
    paddingHorizontal: 9,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: `${Colors.green}35`,
  },
  mealPillText: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.green,
  },

  introText: {
    fontSize: Typography.sm,
    color: Colors.textSub,
    lineHeight: 20,
    marginBottom: Spacing.md,
  },

  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  cardSectionLabel: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: Spacing.sm,
  },

  fieldLabel: {
    fontSize: Typography.xs,
    fontWeight: Typography.medium,
    color: Colors.textSub,
    marginBottom: 6,
    marginTop: Spacing.xs,
  },
  textField: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    fontSize: Typography.base,
    fontWeight: Typography.medium,
    color: Colors.text,
    marginBottom: Spacing.xs,
  },
  barcodeField: {
    letterSpacing: 1.5,
    fontVariant: ["tabular-nums"],
  },

  nutritionHint: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    marginBottom: Spacing.sm,
    marginTop: -4,
  },
  macroGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  macroInputCell: {
    borderRadius: Radius.sm,
    paddingVertical: Spacing.sm,
    paddingHorizontal: 6,
    alignItems: "center",
    minWidth: "22%",
    flex: 1,
  },
  macroInputRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 2,
  },
  macroInput: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    letterSpacing: -0.2,
    minWidth: 34,
    textAlign: "center",
    padding: 0,
  },
  macroUnit: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.regular,
  },
  macroCellLabel: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    marginTop: 2,
    fontWeight: Typography.medium,
  },

  servingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
  },
  servingInput: {
    width: 80,
    textAlign: "center",
    marginBottom: 0,
  },
  servingUnit: {
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.textSub,
  },
  servingLabelInput: { flex: 1, marginBottom: 0 },

  errorText: {
    fontSize: Typography.sm,
    color: "#FF6B6B",
    textAlign: "center",
    marginBottom: Spacing.sm,
    fontWeight: Typography.medium,
  },

  fab: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.lg,
    backgroundColor: Colors.bg,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  saveBtn: {
    backgroundColor: Colors.green,
    borderRadius: Radius.full,
    paddingVertical: 16,
    alignItems: "center",
  },
  saveBtnDisabled: {
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  saveBtnText: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.bg,
    letterSpacing: 0.1,
  },
  saveBtnTextDisabled: { color: Colors.textMuted },
});
