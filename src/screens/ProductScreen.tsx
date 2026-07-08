import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Pressable,
  Alert,
  Image,
} from "react-native";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import DateTimePicker from "@react-native-community/datetimepicker";
import { useStore } from "../store/useStore";
import { formatTime, resolveEatenAt } from "../lib/time";
import { Colors, Spacing, Radius, Typography, MacroColor } from "../theme";
import { RootStackParamList, MEAL_LABELS } from "../types";

type Nav = NativeStackNavigationProp<RootStackParamList, "Product">;
type Route = RouteProp<RootStackParamList, "Product">;

const DEFAULT_PRESETS = [50, 75, 100, 150, 200];

// Product identity thumbnail. Shows the OFF (or, later, custom-food) image
// when present; falls back to a themed placeholder tile when there's no image
// OR when the image URL fails to load (OFF images occasionally 404).
function ProductThumb({ uri }: { uri?: string }) {
  const [errored, setErrored] = useState(false);
  const showImage = !!uri && !errored;

  return (
    <View style={styles.thumb}>
      {showImage ? (
        <Image
          source={{ uri }}
          style={styles.thumbImage}
          resizeMode="cover"
          onError={() => setErrored(true)}
        />
      ) : (
        <Text style={styles.thumbPlaceholder}>🍽️</Text>
      )}
    </View>
  );
}

export function ProductScreen() {
  const navigation = useNavigation<Nav>();
  const {
    product,
    date,
    mealType,
    editEntryId,
    initialServingG,
    initialEatenAt,
  } = useRoute<Route>().params;
  const { addEntry, updateEntry, deleteEntry, saveIngredient } = useStore();
  const insets = useSafeAreaInsets();

  const isEditing = !!editEntryId;

  // ── Serving portion ─────────────────────────────────────────
  const servingPreset =
    product.serving_g && product.serving_g > 0
      ? Math.round(product.serving_g)
      : null;

  const presets = servingPreset
    ? [servingPreset, 50, 100, 150, 200].filter(
        (v, i, a) => a.indexOf(v) === i, // dedupe if serving == a preset
      )
    : DEFAULT_PRESETS;

  const [serving, setServing] = useState(
    String(initialServingG ?? servingPreset ?? 100),
  );

  // ── Eaten-at time ───────────────────────────────────────────
  // Editing → the entry's original time; new → now.
  const [eatenAt, setEatenAt] = useState<Date>(
    initialEatenAt ? new Date(initialEatenAt) : new Date(),
  );
  const [showPicker, setShowPicker] = useState(false);

  const [saving, setSaving] = useState(false);

  const g = parseFloat(serving) || 0;
  const f = g / 100;

  const satFat100 = product.sat_fat_per100 ?? 0;

  const preview = {
    calories: Math.round(product.cal_per100 * f),
    protein: +(product.protein_per100 * f).toFixed(1),
    carbs: +(product.carbs_per100 * f).toFixed(1),
    fat: +(product.fat_per100 * f).toFixed(1),
    satFat: +(satFat100 * f).toFixed(1),
    salt: +((product.salt_per100 ?? 0) * f).toFixed(2),
    fibre: +((product.fibre_per100 ?? 0) * f).toFixed(1),
    sugar: +((product.sugar_per100 ?? 0) * f).toFixed(1),
  };

  const onTimeChange = (event: any, picked?: Date) => {
    // Android fires with type 'dismissed' on cancel.
    setShowPicker(false);
    if (event?.type === "dismissed" || !picked) return;

    if (isEditing) {
      // Keep the entry's original calendar day; only swap the time.
      const base = new Date(eatenAt);
      base.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
      setEatenAt(base);
    } else {
      // New entry: resolve against today with midnight roll-back.
      setEatenAt(
        new Date(resolveEatenAt(picked.getHours(), picked.getMinutes())),
      );
    }
  };

  const handleSubmit = async () => {
    if (!g) return;
    setSaving(true);

    const macros = {
      serving_g: g,
      calories: product.cal_per100 * f,
      protein: product.protein_per100 * f,
      carbs: product.carbs_per100 * f,
      fat: product.fat_per100 * f,
      sat_fat: satFat100 * f,
      salt: (product.salt_per100 ?? 0) * f,
      fibre: (product.fibre_per100 ?? 0) * f,
      sugar: (product.sugar_per100 ?? 0) * f,
      eaten_at: eatenAt.toISOString(),
    };

    if (isEditing) {
      await updateEntry(editEntryId!, macros);
    } else {
      await saveIngredient(product);
      await addEntry({
        date,
        meal_type: mealType,
        name: product.name,
        brand: product.brand,
        ...macros,
        source:
          product.source === "custom"
            ? "custom"
            : product.barcode
              ? "barcode"
              : "search",
        barcode: product.barcode,
        off_id: product.off_id,
      });
    }

    setSaving(false);
    navigation.popToTop();
  };

  const handleDelete = () => {
    if (!editEntryId) return;
    Alert.alert(
      "Delete entry",
      `Remove "${product.name}" from ${MEAL_LABELS[mealType]}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setSaving(true);
            await deleteEntry(editEntryId);
            setSaving(false);
            navigation.popToTop();
          },
        },
      ],
    );
  };

  const mealLabel = MEAL_LABELS[mealType];
  const canSubmit = g > 0;

  const macroRows: {
    key: string;
    label: string;
    value: string;
    unit: string;
    color: string;
  }[] = [
    {
      key: "cal",
      label: "Calories",
      value: String(product.cal_per100),
      unit: "kcal",
      color: Colors.green,
    },
    {
      key: "protein",
      label: "Protein",
      value: `${product.protein_per100}`,
      unit: "g",
      color: MacroColor.protein,
    },
    {
      key: "carbs",
      label: "Carbs",
      value: `${product.carbs_per100}`,
      unit: "g",
      color: MacroColor.carbs,
    },
    {
      key: "fat",
      label: "Fat",
      value: `${product.fat_per100}`,
      unit: "g",
      color: MacroColor.fat,
    },
    {
      key: "satFat",
      label: "Sat fat",
      value: `${satFat100}`,
      unit: "g",
      color: MacroColor.satFat,
    },
    {
      key: "salt",
      label: "Salt",
      value: `${product.salt_per100}`,
      unit: "g",
      color: MacroColor.salt,
    },
    {
      key: "fibre",
      label: "Fibre",
      value: `${product.fibre_per100}`,
      unit: "g",
      color: MacroColor.fibre,
    },
    {
      key: "sugar",
      label: "Sugar",
      value: `${product.sugar_per100}`,
      unit: "g",
      color: MacroColor.sugar,
    },
  ];

  const previewRows: {
    label: string;
    value: string;
    unit: string;
    color: string;
  }[] = [
    {
      label: "Calories",
      value: String(preview.calories),
      unit: "kcal",
      color: Colors.green,
    },
    {
      label: "Protein",
      value: String(preview.protein),
      unit: "g",
      color: MacroColor.protein,
    },
    {
      label: "Carbs",
      value: String(preview.carbs),
      unit: "g",
      color: MacroColor.carbs,
    },
    {
      label: "Fat",
      value: String(preview.fat),
      unit: "g",
      color: MacroColor.fat,
    },
    {
      label: "Sat fat",
      value: String(preview.satFat),
      unit: "g",
      color: MacroColor.satFat,
    },
    {
      label: "Salt",
      value: String(preview.salt),
      unit: "g",
      color: MacroColor.salt,
    },
    {
      label: "Fibre",
      value: String(preview.fibre),
      unit: "g",
      color: MacroColor.fibre,
    },
    {
      label: "Sugar",
      value: String(preview.sugar),
      unit: "g",
      color: MacroColor.sugar,
    },
  ];

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
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
            <Text style={styles.headerTitle}>
              {isEditing ? "Edit entry" : "Add to meal"}
            </Text>
            <View style={styles.mealPill}>
              <Text style={styles.mealPillText}>{mealLabel}</Text>
            </View>
          </View>
        </View>

        {/* ── Product identity card ───────────────────── */}
        <View style={styles.productCard}>
          <View style={styles.identityRow}>
            <ProductThumb uri={product.image_url} />
            <View style={styles.identityText}>
              <Text style={styles.productName}>{product.name}</Text>
              {product.brand ? (
                <Text style={styles.productBrand}>{product.brand}</Text>
              ) : null}
            </View>
          </View>
          <View style={styles.cardDivider} />
          <Text style={styles.refLabel}>Per 100g</Text>
          <View style={styles.macroGrid}>
            {macroRows.map((m) => (
              <View
                key={m.key}
                style={[styles.macroCell, { backgroundColor: `${m.color}12` }]}
              >
                <Text style={[styles.macroCellVal, { color: m.color }]}>
                  {m.value}
                  <Text style={styles.macroCellUnit}> {m.unit}</Text>
                </Text>
                <Text style={styles.macroCellLabel}>{m.label}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* ── Serving size card ───────────────────────── */}
        <View style={styles.card}>
          <Text style={styles.cardSectionLabel}>Serving size</Text>

          {servingPreset ? (
            <Text style={styles.servingSuggestion}>
              Suggested serving:{" "}
              <Text style={styles.servingSuggestionValue}>
                {product.serving_label ?? `${servingPreset}g`}
              </Text>
            </Text>
          ) : null}

          <View style={styles.servingRow}>
            <TextInput
              style={styles.servingInput}
              value={serving}
              onChangeText={setServing}
              keyboardType="decimal-pad"
              selectTextOnFocus
            />
            <Text style={styles.servingUnit}>g</Text>
          </View>
          <View style={styles.presets}>
            {presets.map((v) => {
              const active = serving === String(v);
              const isServing = servingPreset === v;
              return (
                <Pressable
                  key={v}
                  style={({ pressed }) => [
                    styles.preset,
                    active && styles.presetActive,
                    pressed && !active && { opacity: 0.7 },
                  ]}
                  onPress={() => setServing(String(v))}
                >
                  <Text
                    style={[
                      styles.presetText,
                      active && styles.presetTextActive,
                    ]}
                  >
                    {isServing ? `★ ${v}g` : `${v}g`}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* ── Timing card ─────────────────────────────── */}
        <View style={styles.card}>
          <Text style={styles.cardSectionLabel}>When did you eat this?</Text>
          <Pressable
            style={({ pressed }) => [
              styles.timePill,
              pressed && { opacity: 0.8 },
            ]}
            onPress={() => setShowPicker(true)}
          >
            <Text style={styles.timeClock}>🕐</Text>
            <Text style={styles.timePillText}>
              Plated at{" "}
              <Text style={styles.timePillValue}>
                {formatTime(eatenAt.toISOString())}
              </Text>
            </Text>
            <Text style={styles.timeEdit}>Change</Text>
          </Pressable>

          {showPicker && (
            <DateTimePicker
              value={eatenAt}
              mode="time"
              is24Hour
              display="default"
              onChange={onTimeChange}
            />
          )}
        </View>

        {/* ── Live preview card ───────────────────────── */}
        <View style={styles.card}>
          <View style={styles.previewHeader}>
            <Text style={styles.cardSectionLabel}>Nutrition preview</Text>
            <View style={styles.previewServingBadge}>
              <Text style={styles.previewServingText}>for {g || 0}g</Text>
            </View>
          </View>
          <View style={styles.calRow}>
            <Text style={styles.calValue}>{preview.calories}</Text>
            <Text style={styles.calUnit}>kcal</Text>
          </View>
          <View style={styles.cardDivider} />
          <View style={styles.previewGrid}>
            {previewRows.slice(1).map((m) => (
              <View key={m.label} style={styles.previewCell}>
                <Text style={[styles.previewCellVal, { color: m.color }]}>
                  {m.value}
                  <Text style={styles.previewCellUnit}>{m.unit}</Text>
                </Text>
                <Text style={styles.previewCellLabel}>{m.label}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={{ height: isEditing ? 160 : 100 }} />
      </ScrollView>

      {/* ── Sticky submit button ───────────────────────── */}
      <View style={styles.fab}>
        <Pressable
          style={({ pressed }) => [
            styles.addBtn,
            !canSubmit && styles.addBtnDisabled,
            pressed && canSubmit && { opacity: 0.88 },
          ]}
          onPress={handleSubmit}
          disabled={!canSubmit || saving}
        >
          {saving ? (
            <ActivityIndicator color={Colors.bg} />
          ) : (
            <Text
              style={[
                styles.addBtnText,
                !canSubmit && styles.addBtnTextDisabled,
              ]}
            >
              {isEditing ? "Update entry" : `Add to ${mealLabel}`}
            </Text>
          )}
        </Pressable>

        {isEditing && (
          <Pressable
            style={({ pressed }) => [
              styles.deleteBtn,
              pressed && { opacity: 0.7 },
            ]}
            onPress={handleDelete}
            disabled={saving}
          >
            <Text style={styles.deleteBtnText}>Delete entry</Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  scroll: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
  },

  // Header — paddingTop applied inline via insets
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    marginBottom: Spacing.md,
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
  headerCentre: {
    flex: 1,
    gap: 3,
  },
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

  // Product card
  productCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  productName: {
    fontSize: Typography.md,
    fontWeight: Typography.bold,
    color: Colors.text,
    letterSpacing: -0.3,
    marginBottom: 3,
  },
  productBrand: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
    marginBottom: Spacing.sm,
  },
  cardDivider: {
    height: 1,
    backgroundColor: Colors.border,
    marginVertical: Spacing.sm,
  },
  refLabel: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: Spacing.sm,
  },
  identityRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
  },
  identityText: {
    flex: 1,
  },
  thumb: {
    width: 60,
    height: 60,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  thumbImage: {
    width: "100%",
    height: "100%",
  },
  thumbPlaceholder: {
    fontSize: 26,
    opacity: 0.3,
  },

  // Macro grid — 8 cells wrap into 2×4
  macroGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  macroCell: {
    borderRadius: Radius.sm,
    padding: Spacing.sm,
    alignItems: "center",
    minWidth: "22%",
    flex: 1,
  },
  macroCellVal: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    letterSpacing: -0.2,
  },
  macroCellUnit: {
    fontSize: Typography.xs,
    fontWeight: Typography.regular,
  },
  macroCellLabel: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    marginTop: 2,
    fontWeight: Typography.medium,
  },

  // Shared card
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

  // Serving
  servingSuggestion: {
    fontSize: Typography.sm,
    color: Colors.textSub,
    marginBottom: Spacing.sm,
    marginTop: -4,
    fontWeight: Typography.medium,
  },
  servingSuggestionValue: {
    color: Colors.green,
    fontWeight: Typography.semibold,
  },
  servingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  servingInput: {
    flex: 1,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    fontSize: Typography.xxl,
    fontWeight: Typography.bold,
    color: Colors.text,
    textAlign: "center",
    letterSpacing: -1,
  },
  servingUnit: {
    fontSize: Typography.xl,
    fontWeight: Typography.semibold,
    color: Colors.textSub,
    width: 28,
  },
  presets: {
    flexDirection: "row",
    gap: 6,
  },
  preset: {
    flex: 1,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.sm,
    paddingVertical: 8,
    alignItems: "center",
    borderWidth: 1,
    borderColor: Colors.borderSub,
  },
  presetActive: {
    backgroundColor: Colors.greenSoft,
    borderColor: `${Colors.green}40`,
  },
  presetText: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.textMuted,
  },
  presetTextActive: {
    color: Colors.green,
  },

  // Timing
  timePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
  },
  timeClock: {
    fontSize: 16,
  },
  timePillText: {
    flex: 1,
    fontSize: Typography.base,
    color: Colors.textSub,
    fontWeight: Typography.medium,
  },
  timePillValue: {
    color: Colors.text,
    fontWeight: Typography.bold,
    fontVariant: ["tabular-nums"],
  },
  timeEdit: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    color: Colors.green,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },

  // Preview
  previewHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: Spacing.sm,
  },
  previewServingBadge: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.full,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  previewServingText: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.textSub,
  },
  calRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 5,
    marginBottom: Spacing.sm,
  },
  calValue: {
    fontSize: Typography.hero,
    fontWeight: Typography.bold,
    color: Colors.green,
    letterSpacing: -2,
    lineHeight: Typography.hero * 1.0,
  },
  calUnit: {
    fontSize: Typography.md,
    fontWeight: Typography.semibold,
    color: Colors.green,
    opacity: 0.7,
  },
  previewGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing.sm,
    paddingTop: Spacing.xs,
  },
  previewCell: {
    alignItems: "center",
    minWidth: "22%",
    flex: 1,
  },
  previewCellVal: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    letterSpacing: -0.3,
  },
  previewCellUnit: {
    fontSize: Typography.xs,
    fontWeight: Typography.regular,
  },
  previewCellLabel: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    marginTop: 2,
    fontWeight: Typography.medium,
  },

  // FAB
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
  addBtn: {
    backgroundColor: Colors.green,
    borderRadius: Radius.full,
    paddingVertical: 16,
    alignItems: "center",
  },
  addBtnDisabled: {
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  addBtnText: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.bg,
    letterSpacing: 0.1,
  },
  addBtnTextDisabled: {
    color: Colors.textMuted,
  },
  deleteBtn: {
    borderRadius: Radius.full,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: Spacing.sm,
  },
  deleteBtnText: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    color: Colors.danger,
  },
});
