import React, { useState, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Image,
} from "react-native";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { searchFood } from "../lib/openfoodfacts";
import { useStore } from "../store/useStore";
import { Colors, Spacing, Radius, Typography, MacroColor } from "../theme";
import {
  FoodProduct,
  RootStackParamList,
  SavedIngredient,
  MEAL_LABELS,
} from "../types";

type Nav = NativeStackNavigationProp<RootStackParamList, "AddIngredient">;
type Route = RouteProp<RootStackParamList, "AddIngredient">;
type Tab = "search" | "library";

export function AddIngredientScreen() {
  const navigation = useNavigation<Nav>();
  const { date, mealType } = useRoute<Route>().params;
  const { savedIngredients, addEntry } = useStore();
  const insets = useSafeAreaInsets();

  const [tab, setTab] = useState<Tab>("search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoodProduct[]>([]);
  const [searching, setSearching] = useState(false);

  // Manual entry fields
  const [name, setName] = useState("");
  const [cals, setCals] = useState("");
  const [prot, setProt] = useState("");
  const [carbs, setCarbs] = useState("");
  const [fat, setFat] = useState("");
  const [satFat, setSatFat] = useState("");
  const [salt, setSalt] = useState("");
  const [fibre, setFibre] = useState("");
  const [sugar, setSugar] = useState("");
  const [saving, setSaving] = useState(false);

  const timer = useRef<ReturnType<typeof setTimeout>>();

  const handleSearch = (text: string) => {
    setQuery(text);
    clearTimeout(timer.current);
    if (text.trim().length < 2) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(async () => {
      setSearching(true);
      try {
        setResults(await searchFood(text.trim()));
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 600);
  };

  const handleSelectProduct = (product: FoodProduct) =>
    navigation.navigate("Product", { product, date, mealType });

  const handleLibrarySelect = (saved: SavedIngredient) => {
    const product: FoodProduct = {
      name: saved.name,
      brand: saved.brand ?? "",
      cal_per100: saved.cal_per100,
      protein_per100: saved.protein_per100,
      carbs_per100: saved.carbs_per100,
      fat_per100: saved.fat_per100,
      sat_fat_per100: saved.sat_fat_per100 ?? 0,
      salt_per100: saved.salt_per100,
      fibre_per100: saved.fibre_per100,
      sugar_per100: saved.sugar_per100,
      barcode: saved.barcode,
      off_id: saved.off_id,
    };
    navigation.navigate("Product", { product, date, mealType });
  };

  const handleManualAdd = async () => {
    if (!name.trim() || !cals) return;
    setSaving(true);
    await addEntry({
      date,
      meal_type: mealType,
      name: name.trim(),
      brand: "",
      serving_g: 100,
      calories: parseFloat(cals) || 0,
      protein: parseFloat(prot) || 0,
      carbs: parseFloat(carbs) || 0,
      fat: parseFloat(fat) || 0,
      sat_fat: parseFloat(satFat) || 0,
      salt: parseFloat(salt) || 0,
      fibre: parseFloat(fibre) || 0,
      sugar: parseFloat(sugar) || 0,
      source: "manual",
      eaten_at: new Date().toISOString(),
    });
    setSaving(false);
    navigation.goBack();
  };

  const mealLabel = MEAL_LABELS[mealType];
  const canAdd = name.trim().length > 0 && cals.length > 0;

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* ── Header ──────────────────────────────────── */}
        {/* ↓ paddingTop now uses insets.top so header clears the status bar */}
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
            <Text style={styles.headerTitle}>Add ingredient</Text>
            <View style={styles.mealPill}>
              <Text style={styles.mealPillText}>{mealLabel}</Text>
            </View>
          </View>

          <Pressable
            style={({ pressed }) => [
              styles.scanBtn,
              pressed && { opacity: 0.75 },
            ]}
            onPress={() => navigation.navigate("Scanner", { date, mealType })}
          >
            <Text style={styles.scanIcon}>⌗</Text>
            <Text style={styles.scanLabel}>Scan</Text>
          </Pressable>
        </View>

        {/* ── Tab switcher ────────────────────────────── */}
        <View style={styles.tabBar}>
          {(["search", "library"] as Tab[]).map((t) => (
            <Pressable
              key={t}
              style={[styles.tabBtn, tab === t && styles.tabBtnActive]}
              onPress={() => setTab(t)}
            >
              <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
                {t === "search"
                  ? "Search"
                  : `My Library${savedIngredients.length > 0 ? ` (${savedIngredients.length})` : ""}`}
              </Text>
            </Pressable>
          ))}
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.scroll}
        >
          {/* ── Search tab ──────────────────────────────── */}
          {tab === "search" && (
            <>
              <View style={styles.searchBox}>
                <Text style={styles.searchIcon}>⌕</Text>
                <TextInput
                  style={styles.searchInput}
                  value={query}
                  onChangeText={handleSearch}
                  placeholder="Search food or brand…"
                  placeholderTextColor={Colors.textMuted}
                  autoFocus
                  returnKeyType="search"
                />
                {searching ? (
                  <ActivityIndicator size="small" color={Colors.green} />
                ) : (
                  query.length > 0 && (
                    <Pressable
                      onPress={() => {
                        setQuery("");
                        setResults([]);
                      }}
                      hitSlop={8}
                    >
                      <Text style={styles.clearBtn}>✕</Text>
                    </Pressable>
                  )
                )}
              </View>

              {results.length > 0 && (
                <View style={styles.resultsList}>
                  {results.map((p, i) => (
                    <Pressable
                      key={i}
                      style={({ pressed }) => [
                        styles.resultRow,
                        i < results.length - 1 && styles.resultBorder,
                        pressed && { backgroundColor: Colors.surface2 },
                      ]}
                      onPress={() => handleSelectProduct(p)}
                    >
                      <RowThumb uri={p.image_thumb_url} />
                      <View style={styles.resultBody}>
                        <Text style={styles.resultName} numberOfLines={1}>
                          {p.name}
                        </Text>
                        {p.brand ? (
                          <Text style={styles.resultBrand}>{p.brand}</Text>
                        ) : null}
                        <View style={styles.macroRow}>
                          <MacroPill
                            value={`${p.cal_per100}`}
                            unit="kcal"
                            color={Colors.green}
                          />
                          <MacroPill
                            value={`${p.protein_per100}`}
                            label="P"
                            unit="g"
                            color={MacroColor.protein}
                          />
                          <MacroPill
                            value={`${p.carbs_per100}`}
                            label="C"
                            unit="g"
                            color={MacroColor.carbs}
                          />
                          <MacroPill
                            value={`${p.fat_per100}`}
                            label="F"
                            unit="g"
                            color={MacroColor.fat}
                          />
                          <Text style={styles.per100}>/ 100g</Text>
                        </View>
                      </View>
                      <Text style={styles.chevron}>›</Text>
                    </Pressable>
                  ))}
                </View>
              )}

              {!searching && query.length >= 2 && results.length === 0 && (
                <View style={styles.noResults}>
                  <Text style={styles.noResultsText}>
                    No results for "{query}"
                  </Text>
                  <Text style={styles.noResultsSub}>
                    Try a different spelling or add it manually below
                  </Text>
                </View>
              )}

              <View style={styles.dividerRow}>
                <View style={styles.divLine} />
                <Text style={styles.divLabel}>or add manually</Text>
                <View style={styles.divLine} />
              </View>

              <View style={styles.form}>
                <FormField
                  label="Ingredient name"
                  value={name}
                  onChange={setName}
                  placeholder="e.g. Chicken breast"
                />
                <FormField
                  label="Calories"
                  value={cals}
                  onChange={setCals}
                  placeholder="0"
                  unit="kcal"
                  numeric
                  accent={Colors.green}
                />
                <View style={styles.twoCol}>
                  <FormField
                    label="Protein"
                    value={prot}
                    onChange={setProt}
                    placeholder="0"
                    unit="g"
                    numeric
                    accent={MacroColor.protein}
                    half
                  />
                  <FormField
                    label="Carbs"
                    value={carbs}
                    onChange={setCarbs}
                    placeholder="0"
                    unit="g"
                    numeric
                    accent={MacroColor.carbs}
                    half
                  />
                </View>
                <View style={styles.twoCol}>
                  <FormField
                    label="Fat"
                    value={fat}
                    onChange={setFat}
                    placeholder="0"
                    unit="g"
                    numeric
                    accent={MacroColor.fat}
                    half
                  />
                  <FormField
                    label="Sat fat"
                    value={satFat}
                    onChange={setSatFat}
                    placeholder="0"
                    unit="g"
                    numeric
                    accent={MacroColor.satFat}
                    half
                  />
                </View>
                <View style={styles.twoCol}>
                  <FormField
                    label="Salt"
                    value={salt}
                    onChange={setSalt}
                    placeholder="0"
                    unit="g"
                    numeric
                    accent={MacroColor.salt}
                    half
                  />
                  <FormField
                    label="Fibre"
                    value={fibre}
                    onChange={setFibre}
                    placeholder="0"
                    unit="g"
                    numeric
                    accent={MacroColor.fibre}
                    half
                  />
                </View>
                <View style={styles.twoCol}>
                  <FormField
                    label="Sugar"
                    value={sugar}
                    onChange={setSugar}
                    placeholder="0"
                    unit="g"
                    numeric
                    accent={MacroColor.sugar}
                    half
                  />
                  <View style={{ flex: 1 }} />
                </View>

                <Pressable
                  style={({ pressed }) => [
                    styles.addBtn,
                    !canAdd && styles.addBtnDisabled,
                    pressed && canAdd && { opacity: 0.85 },
                  ]}
                  onPress={handleManualAdd}
                  disabled={!canAdd || saving}
                >
                  {saving ? (
                    <ActivityIndicator color={Colors.bg} />
                  ) : (
                    <Text
                      style={[
                        styles.addBtnText,
                        !canAdd && styles.addBtnTextDisabled,
                      ]}
                    >
                      Add to {mealLabel}
                    </Text>
                  )}
                </Pressable>
              </View>
            </>
          )}

          {/* ── Library tab ─────────────────────────────── */}
          {tab === "library" &&
            (savedIngredients.length === 0 ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyEmoji}>📚</Text>
                <Text style={styles.emptyTitle}>Library is empty</Text>
                <Text style={styles.emptySub}>
                  Ingredients you search or scan will be saved here for quick
                  re-use.
                </Text>
              </View>
            ) : (
              <View style={styles.resultsList}>
                {savedIngredients.map((item, i) => (
                  <Pressable
                    key={item.id}
                    style={({ pressed }) => [
                      styles.resultRow,
                      i < savedIngredients.length - 1 && styles.resultBorder,
                      pressed && { backgroundColor: Colors.surface2 },
                    ]}
                    onPress={() => handleLibrarySelect(item)}
                  >
                    <View style={styles.resultBody}>
                      <Text style={styles.resultName}>{item.name}</Text>
                      {item.brand ? (
                        <Text style={styles.resultBrand}>{item.brand}</Text>
                      ) : null}
                      <View style={styles.macroRow}>
                        <MacroPill
                          value={`${Math.round(item.cal_per100)}`}
                          unit="kcal"
                          color={Colors.green}
                        />
                        <MacroPill
                          value={`${item.protein_per100}`}
                          label="P"
                          unit="g"
                          color={MacroColor.protein}
                        />
                        <MacroPill
                          value={`${item.carbs_per100}`}
                          label="C"
                          unit="g"
                          color={MacroColor.carbs}
                        />
                        <MacroPill
                          value={`${item.fat_per100}`}
                          label="F"
                          unit="g"
                          color={MacroColor.fat}
                        />
                        <Text style={styles.per100}>· {item.use_count}×</Text>
                      </View>
                    </View>
                    <Text style={styles.chevron}>›</Text>
                  </Pressable>
                ))}
              </View>
            ))}

          <View style={{ height: Spacing.xxl }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── RowThumb ────────────────────────────────────────────────────────────────

// Small search-result thumbnail. Uses the ~100px OFF thumb to keep the list
// light. Falls back to a themed placeholder tile when there's no image, or if
// the image URL fails to load (OFF images occasionally 404).
function RowThumb({ uri }: { uri?: string }) {
  const [errored, setErrored] = useState(false);
  const showImage = !!uri && !errored;

  return (
    <View style={styles.rowThumb}>
      {showImage ? (
        <Image
          source={{ uri }}
          style={styles.rowThumbImage}
          resizeMode="cover"
          onError={() => setErrored(true)}
        />
      ) : (
        <Text style={styles.rowThumbPlaceholder}>🍽️</Text>
      )}
    </View>
  );
}

// ─── MacroPill ───────────────────────────────────────────────────────────────

function MacroPill({
  value,
  label,
  unit,
  color,
}: {
  value: string;
  label?: string;
  unit: string;
  color: string;
}) {
  return (
    <View style={[pillStyles.pill, { backgroundColor: `${color}18` }]}>
      {label && <Text style={[pillStyles.label, { color }]}>{label} </Text>}
      <Text style={[pillStyles.value, { color }]}>{value}</Text>
      <Text style={[pillStyles.unit, { color }]}>{unit}</Text>
    </View>
  );
}

const pillStyles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "baseline",
    borderRadius: Radius.full,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  label: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    letterSpacing: 0.2,
  },
  value: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
  },
  unit: {
    fontSize: 9,
    fontWeight: Typography.medium,
    marginLeft: 1,
  },
});

// ─── FormField ───────────────────────────────────────────────────────────────

function FormField({
  label,
  value,
  onChange,
  placeholder,
  unit,
  numeric,
  accent,
  half,
}: {
  label: string;
  value: string;
  onChange: (t: string) => void;
  placeholder: string;
  unit?: string;
  numeric?: boolean;
  accent?: string;
  half?: boolean;
}) {
  return (
    <View style={[fieldStyles.wrap, half && fieldStyles.half]}>
      <Text style={fieldStyles.label}>{label}</Text>
      <View
        style={[fieldStyles.inputRow, accent && { borderColor: `${accent}30` }]}
      >
        <TextInput
          style={fieldStyles.input}
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={Colors.textMuted}
          keyboardType={numeric ? "decimal-pad" : "default"}
        />
        {unit && (
          <Text style={[fieldStyles.unit, accent && { color: accent }]}>
            {unit}
          </Text>
        )}
      </View>
    </View>
  );
}

const fieldStyles = StyleSheet.create({
  wrap: {
    marginBottom: Spacing.sm,
  },
  half: {
    flex: 1,
  },
  label: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 5,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface2,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 8,
  },
  input: {
    flex: 1,
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.text,
  },
  unit: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.textMuted,
    marginLeft: 4,
  },
});

// ─── Main styles ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  scroll: {
    paddingHorizontal: Spacing.md,
  },

  // Header — paddingTop is applied inline via insets, so only horizontal/bottom here
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.sm, // ← was paddingVertical; top is now dynamic
    gap: Spacing.sm,
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
    alignItems: "flex-start",
    gap: 3,
  },
  headerTitle: {
    fontSize: Typography.md,
    fontWeight: Typography.bold,
    color: Colors.text,
    letterSpacing: -0.3,
  },
  mealPill: {
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
  scanBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Colors.surface,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 7,
  },
  scanIcon: {
    fontSize: 14,
    color: Colors.textSub,
  },
  scanLabel: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.textSub,
  },

  // Tab bar
  tabBar: {
    flexDirection: "row",
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 3,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: Radius.full,
    alignItems: "center",
  },
  tabBtnActive: {
    backgroundColor: Colors.green,
  },
  tabText: {
    fontSize: Typography.sm,
    fontWeight: Typography.medium,
    color: Colors.textSub,
  },
  tabTextActive: {
    color: Colors.bg,
    fontWeight: Typography.bold,
  },

  // Search box
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
    marginBottom: Spacing.md,
    gap: Spacing.sm,
  },
  searchIcon: {
    fontSize: 18,
    color: Colors.textMuted,
  },
  searchInput: {
    flex: 1,
    fontSize: Typography.base,
    color: Colors.text,
    paddingVertical: 13,
  },
  clearBtn: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
    paddingLeft: 4,
  },

  // Results list
  resultsList: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: Spacing.md,
    overflow: "hidden",
  },
  resultRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: Spacing.md,
  },
  resultBorder: {
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderSub,
  },
  resultBody: {
    flex: 1,
    marginRight: Spacing.sm,
  },
  resultName: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    color: Colors.text,
    letterSpacing: -0.1,
    marginBottom: 2,
  },
  resultBrand: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
    marginBottom: 5,
  },
  macroRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 4,
  },
  per100: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
  },
  chevron: {
    fontSize: Typography.lg,
    color: Colors.textDim,
  },

  // Row thumbnail (search results)
  rowThumb: {
    width: 44,
    height: 44,
    borderRadius: Radius.sm,
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    marginRight: Spacing.sm,
  },
  rowThumbImage: {
    width: "100%",
    height: "100%",
  },
  rowThumbPlaceholder: {
    fontSize: 18,
    opacity: 0.3,
  },

  // No results
  noResults: {
    alignItems: "center",
    paddingVertical: Spacing.lg,
    gap: 4,
  },
  noResultsText: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    color: Colors.textSub,
  },
  noResultsSub: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    textAlign: "center",
  },

  // Divider
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    marginVertical: Spacing.md,
  },
  divLine: {
    flex: 1,
    height: 1,
    backgroundColor: Colors.border,
  },
  divLabel: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
  },

  // Form
  form: {
    gap: 0,
  },
  twoCol: {
    flexDirection: "row",
    gap: Spacing.sm,
  },

  // Add button
  addBtn: {
    backgroundColor: Colors.green,
    borderRadius: Radius.full,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: Spacing.sm,
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
  },
  addBtnTextDisabled: {
    color: Colors.textMuted,
  },

  // Empty state
  emptyState: {
    alignItems: "center",
    paddingVertical: Spacing.xxl,
    gap: Spacing.sm,
  },
  emptyEmoji: {
    fontSize: 40,
    marginBottom: Spacing.xs,
  },
  emptyTitle: {
    fontSize: Typography.md,
    fontWeight: Typography.semibold,
    color: Colors.text,
  },
  emptySub: {
    fontSize: Typography.sm,
    color: Colors.textSub,
    textAlign: "center",
    lineHeight: 20,
    maxWidth: 260,
  },
});
