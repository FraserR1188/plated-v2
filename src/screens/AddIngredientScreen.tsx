// ============================================================
// src/screens/AddIngredientScreen.tsx
// Session B: OFF product thumbnails on search rows.
// Session B (cleanup): the inline manual-add form is GONE. It wrote
// one-shot rows straight to meal_entries — foods you couldn't re-use,
// re-scan, set a serving size for, or photograph. Every hand-created
// food now goes through CreateFoodScreen and becomes a real
// custom_foods row. One path, one behaviour.
// ============================================================

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
  Alert,
} from "react-native";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { searchFood } from "../lib/openfoodfacts";
import { useStore } from "../store/useStore";
import { captureAndScanMealPhoto } from "../lib/mealPhotoCapture";
import {
  Colors,
  Spacing,
  Radius,
  Typography,
  MacroColor,
  Fonts,
  withDefaultFont,
} from "../theme/tokens";
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
  const { savedIngredients } = useStore();
  const insets = useSafeAreaInsets();

  const [tab, setTab] = useState<Tab>("search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoodProduct[]>([]);
  const [searching, setSearching] = useState(false);
  const [scanningMeal, setScanningMeal] = useState(false);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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

  // Photo of a PLATE, not a barcode or a label — a different button from
  // "Scan" above. Nothing reaches meal_entries until the user confirms on
  // ProductScreen — captureAndScanMealPhoto only builds an editable draft.
  // (Capture/prepare/scan pipeline lives in lib/mealPhotoCapture.ts, shared
  // with BatchIngredientPickerScreen, which reuses the SAME lookup but
  // never routes the result through this screen's Product-logging path.)
  const handleScanMeal = async () => {
    setScanningMeal(true);
    try {
      const result = await captureAndScanMealPhoto();
      switch (result.status) {
        case "cancelled":
          return;
        case "permission_denied":
          Alert.alert(
            "Camera access needed",
            "Allow camera access to scan a meal photo.",
          );
          return;
        case "prep_failed":
          Alert.alert("Couldn't process that photo", "Try taking it again.");
          return;
        case "scan_failed":
          Alert.alert("Couldn't identify that meal", result.message);
          return;
        case "ok":
          navigation.navigate("Product", {
            product: result.product,
            date,
            mealType,
          });
          return;
      }
    } finally {
      setScanningMeal(false);
    }
  };

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
      barcode: saved.barcode ?? undefined,
      off_id: saved.off_id ?? undefined,
    };
    navigation.navigate("Product", { product, date, mealType });
  };

  // Hand-created foods now go through CreateFoodScreen, which gives them a
  // custom_foods row: re-usable, scannable, serving sizes, and a photo.
  //
  // NOTE: `navigate`, not `replace` (Scanner uses replace because backing out
  // to a dead scanner would be wrong). From here, backing out of CreateFood
  // should return you to your search results with the query still typed.
  const handleCreateFood = () =>
    navigation.navigate("CreateFood", {
      date,
      mealType,
      // Pre-fill the name from whatever they searched for — the "phase 1b"
      // path CreateFoodScreen's initialName param was always waiting for.
      initialName: query.trim() ? query.trim() : undefined,
    });

  const mealLabel = MEAL_LABELS[mealType];
  const showNoResults =
    !searching && query.trim().length >= 2 && results.length === 0;

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
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
            <Text style={styles.headerTitle}>Add ingredient</Text>
            <View style={styles.mealPill}>
              <Text style={styles.mealPillText}>{mealLabel}</Text>
            </View>
          </View>

          <View style={styles.headerActions}>
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

            <Pressable
              style={({ pressed }) => [
                styles.scanBtn,
                pressed && { opacity: 0.75 },
              ]}
              onPress={handleScanMeal}
              disabled={scanningMeal}
            >
              {scanningMeal ? (
                <ActivityIndicator size="small" color={Colors.textSub} />
              ) : (
                <>
                  <Text style={styles.scanIcon}>📷</Text>
                  <Text style={styles.scanLabel}>Scan meal</Text>
                </>
              )}
            </Pressable>
          </View>
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

              {/* ── Not found → create it ─────────────────── */}
              {/* Mirrors the Scanner's not_found treatment: name the thing
                  that's missing, then offer the productive path. */}
              {showNoResults && (
                <View style={styles.notFoundCard}>
                  <Text style={styles.notFoundEmoji}>🍽️</Text>
                  <Text style={styles.notFoundTitle}>
                    No results for "{query.trim()}"
                  </Text>
                  <Text style={styles.notFoundText}>
                    It isn't in the food database yet. Add it once and it's
                    yours to re-use, scan and log any time.
                  </Text>
                  <Pressable
                    style={({ pressed }) => [
                      styles.primaryBtn,
                      pressed && { opacity: 0.88 },
                    ]}
                    onPress={handleCreateFood}
                  >
                    <Text style={styles.primaryBtnText} numberOfLines={1}>
                      Create "{query.trim()}"
                    </Text>
                  </Pressable>
                </View>
              )}

              {/* ── Always-available create affordance ────── */}
              {/* Without this, creating a food from scratch would mean typing
                  a nonsense query just to summon the empty state. */}
              {!showNoResults && (
                <Pressable
                  style={({ pressed }) => [
                    styles.createRow,
                    pressed && { backgroundColor: Colors.surface2 },
                  ]}
                  onPress={handleCreateFood}
                >
                  <View style={styles.createIconTile}>
                    <Text style={styles.createIcon}>＋</Text>
                  </View>
                  <View style={styles.createBody}>
                    <Text style={styles.createTitle}>
                      Can't find it? Create a food
                    </Text>
                    <Text style={styles.createSub}>
                      Add the nutrition from the label — with a photo
                    </Text>
                  </View>
                  <Text style={styles.chevron}>›</Text>
                </Pressable>
              )}
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

const pillStyles = StyleSheet.create(
  withDefaultFont({
    pill: {
      flexDirection: "row",
      alignItems: "baseline",
      borderRadius: Radius.pill,
      paddingHorizontal: 7,
      paddingVertical: 3,
    },
    label: {
      fontSize: Typography.xs,
      fontWeight: Typography.bold,
      letterSpacing: 0.2,
    },
    // A macro pill's value is a number — mono, for tabular alignment.
    value: {
      fontSize: Typography.xs,
      fontWeight: Typography.semibold,
      fontFamily: Fonts.mono.semibold,
    },
    unit: {
      fontSize: 9,
      fontWeight: Typography.medium,
      marginLeft: 1,
    },
  }),
);

// ─── Main styles ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create(
  withDefaultFont({
  safe: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  scroll: {
    paddingHorizontal: Spacing.md,
  },

  // Header — paddingTop is applied inline via insets
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.sm,
    gap: Spacing.sm,
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
    borderRadius: Radius.pill,
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
  headerActions: {
    flexDirection: "row",
    gap: Spacing.xs,
  },
  scanBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Colors.surface,
    borderRadius: Radius.pill,
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
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 3,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: Radius.pill,
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
    borderRadius: Radius.control,
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
    borderRadius: Radius.card,
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
    borderRadius: Radius.control,
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

  // Not-found → create card
  notFoundCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
    alignItems: "center",
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  notFoundEmoji: {
    fontSize: 28,
    opacity: 0.5,
  },
  notFoundTitle: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.text,
    textAlign: "center",
  },
  notFoundText: {
    fontSize: Typography.sm,
    color: Colors.textSub,
    textAlign: "center",
    lineHeight: 20,
    maxWidth: 280,
  },
  primaryBtn: {
    backgroundColor: Colors.green,
    borderRadius: Radius.pill,
    paddingVertical: 13,
    paddingHorizontal: Spacing.xl,
    alignSelf: "stretch",
    alignItems: "center",
    marginTop: Spacing.xs,
  },
  primaryBtnText: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.bg,
    letterSpacing: 0.1,
  },

  // Persistent create affordance
  createRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    borderStyle: "dashed",
    padding: Spacing.md,
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  createIconTile: {
    width: 44,
    height: 44,
    borderRadius: Radius.control,
    backgroundColor: Colors.greenSoft,
    borderWidth: 1,
    borderColor: `${Colors.green}35`,
    alignItems: "center",
    justifyContent: "center",
  },
  createIcon: {
    fontSize: 20,
    color: Colors.green,
    fontWeight: Typography.bold,
    marginTop: -2,
  },
  createBody: {
    flex: 1,
    gap: 2,
  },
  createTitle: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    color: Colors.text,
  },
  createSub: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
  },

  // Empty state (library)
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
  }),
);
