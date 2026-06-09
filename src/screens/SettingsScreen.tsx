import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
  Pressable,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useStore } from "../store/useStore";
import { exportCSV, last30Days } from "../lib/csv";
import { Colors, Spacing, Radius, Typography, MacroColor } from "../theme";

// Map each goal field to its macro colour for the input accent
const GOAL_FIELDS: {
  key: "calories" | "protein" | "carbs" | "fat" | "salt" | "fibre" | "sugar";
  label: string;
  unit: string;
  color: string;
}[] = [
  { key: "calories", label: "Calories", unit: "kcal", color: Colors.green },
  { key: "protein", label: "Protein", unit: "g", color: MacroColor.protein },
  { key: "carbs", label: "Carbs", unit: "g", color: MacroColor.carbs },
  { key: "fat", label: "Fat", unit: "g", color: MacroColor.fat },
  { key: "salt", label: "Salt", unit: "g", color: MacroColor.salt },
  { key: "fibre", label: "Fibre", unit: "g", color: MacroColor.fibre },
  { key: "sugar", label: "Sugar", unit: "g", color: MacroColor.sugar },
];

const WHOOP_STEPS = [
  "Export from plated using the button above.",
  "In Whoop: Profile → My Data → Export.",
  "Open both CSVs in Google Sheets — join on the date column.",
  "Use VLOOKUP to match recovery score, HRV, and strain against your daily nutrition.",
];

export function SettingsScreen() {
  const {
    goals,
    saveGoals,
    getAllEntries,
    savedIngredients,
    deleteIngredient,
  } = useStore();

  // One state entry per field, keyed by GOAL_FIELDS
  const [values, setValues] = useState<Record<string, string>>({
    calories: String(goals.calories),
    protein: String(goals.protein),
    carbs: String(goals.carbs),
    fat: String(goals.fat),
    salt: String(goals.salt),
    fibre: String(goals.fibre),
    sugar: String(goals.sugar),
  });
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleChange = (key: string, val: string) => {
    setValues((prev) => ({ ...prev, [key]: val }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    await saveGoals({
      calories: parseInt(values.calories) || 2000,
      protein: parseInt(values.protein) || 150,
      carbs: parseInt(values.carbs) || 200,
      fat: parseInt(values.fat) || 65,
      salt: parseFloat(values.salt) || 6,
      fibre: parseInt(values.fibre) || 30,
      sugar: parseInt(values.sugar) || 30,
    });
    setSaving(false);
    setSaved(true);
  };

  const handleExport = async () => {
    const entries = last30Days(getAllEntries());
    if (entries.length === 0) {
      Alert.alert("No data", "No entries in the last 30 days.");
      return;
    }
    setExporting(true);
    try {
      await exportCSV(entries);
    } catch (e: any) {
      Alert.alert("Export failed", e.message);
    } finally {
      setExporting(false);
    }
  };

  const handleDeleteIngredient = (id: string, name: string) => {
    Alert.alert(
      "Remove from library",
      `Remove "${name}" from your saved ingredients?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => deleteIngredient(id),
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Header ─────────────────────────────────── */}
        <Text style={styles.heading}>Settings</Text>

        {/* ── Daily goals ────────────────────────────── */}
        <SectionLabel title="Daily goals" />
        <View style={styles.card}>
          {GOAL_FIELDS.map((field, i) => (
            <View
              key={field.key}
              style={[
                styles.goalRow,
                i < GOAL_FIELDS.length - 1 && styles.goalBorder,
              ]}
            >
              {/* Colour dot + label */}
              <View style={styles.goalLeft}>
                <View
                  style={[styles.goalDot, { backgroundColor: field.color }]}
                />
                <Text style={styles.goalLabel}>{field.label}</Text>
              </View>

              {/* Input + unit */}
              <View style={styles.goalRight}>
                <TextInput
                  style={[
                    styles.goalInput,
                    { borderColor: `${field.color}30` },
                  ]}
                  value={values[field.key]}
                  onChangeText={(v) => handleChange(field.key, v)}
                  keyboardType="decimal-pad"
                  selectTextOnFocus
                  placeholderTextColor={Colors.textMuted}
                />
                <Text style={styles.goalUnit}>{field.unit}</Text>
              </View>
            </View>
          ))}

          {/* Save button */}
          <Pressable
            style={({ pressed }) => [
              styles.saveBtn,
              saved && styles.saveBtnSaved,
              pressed && { opacity: 0.85 },
            ]}
            onPress={handleSave}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator color={Colors.bg} />
            ) : (
              <Text style={styles.saveBtnText}>
                {saved ? "✓  Goals saved" : "Save goals"}
              </Text>
            )}
          </Pressable>
        </View>

        {/* ── CSV Export ─────────────────────────────── */}
        <SectionLabel title="Export data" />
        <View style={styles.card}>
          <Text style={styles.exportInfo}>
            Export the last 30 days as a CSV to cross-reference with your Whoop
            data in Google Sheets.
          </Text>

          {/* Column preview */}
          <View style={styles.colsBox}>
            <Text style={styles.colsLabel}>Included columns</Text>
            <Text style={styles.colsText}>
              date · time · meal · ingredient · brand · serving · calories ·
              protein · carbs · fat · salt · fibre · sugar · source
            </Text>
          </View>

          {exporting ? (
            <View style={styles.exportLoading}>
              <ActivityIndicator color={Colors.green} size="small" />
              <Text style={styles.exportLoadingText}>Preparing file…</Text>
            </View>
          ) : (
            <Pressable
              style={({ pressed }) => [
                styles.exportBtn,
                pressed && { opacity: 0.85 },
              ]}
              onPress={handleExport}
            >
              <Text style={styles.exportBtnText}>Export last 30 days</Text>
            </Pressable>
          )}
        </View>

        {/* ── Whoop cross-reference ───────────────────── */}
        <SectionLabel title="Whoop cross-reference" />
        <View style={styles.card}>
          <Text style={styles.whoopIntro}>
            Once Whoop integration launches, this will be automatic. For now:
          </Text>
          {WHOOP_STEPS.map((step, i) => (
            <View
              key={i}
              style={[
                styles.step,
                i < WHOOP_STEPS.length - 1 && styles.stepBorder,
              ]}
            >
              <View style={styles.stepNum}>
                <Text style={styles.stepNumText}>{i + 1}</Text>
              </View>
              <Text style={styles.stepText}>{step}</Text>
            </View>
          ))}
        </View>

        {/* ── Saved ingredients ──────────────────────── */}
        <SectionLabel
          title="Saved ingredients"
          count={savedIngredients.length}
        />

        {savedIngredients.length === 0 ? (
          <View style={styles.emptyLibCard}>
            <Text style={styles.emptyLibText}>
              Ingredients you log frequently will appear here for quick re-use.
            </Text>
          </View>
        ) : (
          <View style={styles.card}>
            {savedIngredients.map((item, i) => (
              <Pressable
                key={item.id}
                style={({ pressed }) => [
                  styles.libRow,
                  i < savedIngredients.length - 1 && styles.goalBorder,
                  pressed && { backgroundColor: Colors.surface2 },
                ]}
                onLongPress={() => handleDeleteIngredient(item.id, item.name)}
              >
                <View style={styles.libBody}>
                  <Text style={styles.libName} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={styles.libSub}>
                    {item.brand ? `${item.brand} · ` : ""}
                    {item.cal_per100} kcal/100g · used {item.use_count}×
                  </Text>
                </View>
                <Text style={styles.libChevron}>›</Text>
              </Pressable>
            ))}
            <Text style={styles.libHint}>
              Long-press to remove from library
            </Text>
          </View>
        )}

        <View style={{ height: Spacing.xxl }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Section label ───────────────────────────────────────────────────────────

function SectionLabel({ title, count }: { title: string; count?: number }) {
  return (
    <View style={sectionStyles.row}>
      <Text style={sectionStyles.label}>{title}</Text>
      {count !== undefined && (
        <View style={sectionStyles.badge}>
          <Text style={sectionStyles.badgeText}>{count}</Text>
        </View>
      )}
    </View>
  );
}

const sectionStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
    marginTop: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  label: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.7,
  },
  badge: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.full,
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  badgeText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    color: Colors.textSub,
  },
});

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  scroll: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
  },
  heading: {
    fontSize: Typography.xl,
    fontWeight: Typography.bold,
    color: Colors.text,
    letterSpacing: -0.5,
    marginBottom: Spacing.lg,
  },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },

  // Goal rows
  goalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 11,
  },
  goalBorder: {
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderSub,
  },
  goalLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
  },
  goalDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  goalLabel: {
    fontSize: Typography.base,
    fontWeight: Typography.medium,
    color: Colors.text,
  },
  goalRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
  },
  goalInput: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.sm,
    borderWidth: 1,
    paddingHorizontal: Spacing.md,
    paddingVertical: 7,
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.text,
    minWidth: 76,
    textAlign: "center",
  },
  goalUnit: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
    width: 32,
  },

  // Save button
  saveBtn: {
    backgroundColor: Colors.green,
    borderRadius: Radius.full,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: Spacing.md,
  },
  saveBtnSaved: {
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: `${Colors.green}40`,
  },
  saveBtnText: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.bg,
  },

  // Export
  exportInfo: {
    fontSize: Typography.sm,
    color: Colors.textSub,
    lineHeight: 20,
    marginBottom: Spacing.md,
  },
  colsBox: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.sm,
    padding: Spacing.sm,
    marginBottom: Spacing.md,
    gap: 4,
  },
  colsLabel: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  colsText: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontStyle: "italic",
    lineHeight: 17,
  },
  exportLoading: {
    flexDirection: "row",
    gap: Spacing.sm,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: Spacing.md,
  },
  exportLoadingText: {
    fontSize: Typography.sm,
    color: Colors.textSub,
  },
  exportBtn: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: 13,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    gap: Spacing.sm,
  },
  exportBtnText: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.text,
  },

  // Whoop steps
  whoopIntro: {
    fontSize: Typography.sm,
    color: Colors.textSub,
    marginBottom: Spacing.md,
    lineHeight: 19,
  },
  step: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing.sm,
    paddingVertical: 10,
  },
  stepBorder: {
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderSub,
  },
  stepNum: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: Colors.greenDim,
    borderWidth: 1,
    borderColor: `${Colors.green}50`,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    marginTop: 1,
  },
  stepNumText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    color: Colors.green,
  },
  stepText: {
    flex: 1,
    fontSize: Typography.sm,
    color: Colors.textSub,
    lineHeight: 20,
  },

  // Ingredient library
  emptyLibCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
    alignItems: "center",
    marginBottom: Spacing.md,
  },
  emptyLibText: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
    textAlign: "center",
    lineHeight: 20,
  },
  libRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 11,
    borderRadius: Radius.sm,
    marginHorizontal: -4,
    paddingHorizontal: 4,
  },
  libBody: {
    flex: 1,
  },
  libName: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    color: Colors.text,
    letterSpacing: -0.1,
  },
  libSub: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    marginTop: 2,
    fontWeight: Typography.medium,
  },
  libChevron: {
    fontSize: 18,
    color: Colors.textDim,
    marginLeft: Spacing.sm,
  },
  libHint: {
    fontSize: Typography.xs,
    color: Colors.textDim,
    marginTop: Spacing.sm,
    textAlign: "center",
    fontWeight: Typography.medium,
  },
});
