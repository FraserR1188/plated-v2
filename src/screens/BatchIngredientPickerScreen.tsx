// ============================================================
// src/screens/BatchIngredientPickerScreen.tsx
// ============================================================
// Search a food, say how much of it went into the batch, hand it back to
// whoever opened this screen (route.params.onPick — see the type's comment
// in types/index.ts for why a callback and not a store slice).
//
// DELIBERATE SCOPE CUT for this pass: OFF search + My Library only — no
// barcode scan, no AI meal photo, no inline "create a custom food". Those
// all target a specific {date, mealType} entry, which a batch ingredient
// doesn't have. A custom food you've used at least once already shows up in
// My Library (ProductScreen upserts saved_ingredients on every save, custom
// or not) — a brand-new one not yet used anywhere isn't reachable from here
// yet. If that turns out to matter, it's an additive change, not a rework.
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
  Alert,
} from "react-native";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { searchFood } from "../lib/openfoodfacts";
import { useStore } from "../store/useStore";
import {
  Colors,
  Spacing,
  Radius,
  Typography,
  MacroColor,
  Fonts,
  withDefaultFont,
} from "../theme/tokens";
import { FoodProduct, RootStackParamList, SavedIngredient } from "../types";

type Nav = NativeStackNavigationProp<RootStackParamList, "BatchIngredientPicker">;
type Route = RouteProp<RootStackParamList, "BatchIngredientPicker">;
type Tab = "search" | "library";

function savedToProduct(saved: SavedIngredient): FoodProduct {
  return {
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
}

export function BatchIngredientPickerScreen() {
  const navigation = useNavigation<Nav>();
  const { onPick } = useRoute<Route>().params;
  const { savedIngredients } = useStore();
  const insets = useSafeAreaInsets();

  const [tab, setTab] = useState<Tab>("search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoodProduct[]>([]);
  const [searching, setSearching] = useState(false);

  // The quantity step. null = still browsing; set = showing "how much?" for
  // this product.
  const [picking, setPicking] = useState<FoodProduct | null>(null);
  const [quantity, setQuantity] = useState("100");

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

  const startPicking = (product: FoodProduct) => {
    setQuantity(product.serving_g != null ? String(product.serving_g) : "100");
    setPicking(product);
  };

  const confirmQuantity = () => {
    const g = parseFloat(quantity.replace(",", "."));
    if (!picking || !Number.isFinite(g) || g <= 0) {
      Alert.alert("Enter a quantity", "How many grams went into the batch?");
      return;
    }
    onPick(picking, g);
    navigation.goBack();
  };

  const showNoResults =
    !searching && query.trim().length >= 2 && results.length === 0;

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <Pressable
            onPress={() =>
              picking ? setPicking(null) : navigation.goBack()
            }
            style={({ pressed }) => [
              styles.backBtn,
              pressed && { opacity: 0.6 },
            ]}
            hitSlop={12}
          >
            <Text style={styles.backArrow}>‹</Text>
          </Pressable>
          <Text style={styles.headerTitle}>
            {picking ? "How much?" : "Add ingredient"}
          </Text>
          <View style={{ width: 36 }} />
        </View>

        {picking ? (
          <View style={styles.quantityBody}>
            <Text style={styles.quantityName} numberOfLines={2}>
              {picking.name}
            </Text>
            {picking.brand ? (
              <Text style={styles.quantityBrand}>{picking.brand}</Text>
            ) : null}

            <View style={styles.quantityInputRow}>
              <TextInput
                style={styles.quantityInput}
                value={quantity}
                onChangeText={setQuantity}
                keyboardType="decimal-pad"
                autoFocus
                selectTextOnFocus
              />
              <Text style={styles.quantityUnit}>g went into the batch</Text>
            </View>

            <Pressable
              style={({ pressed }) => [
                styles.primaryBtn,
                pressed && { opacity: 0.88 },
              ]}
              onPress={confirmQuantity}
            >
              <Text style={styles.primaryBtnText}>Add to batch</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.tabBar}>
              {(["search", "library"] as Tab[]).map((t) => (
                <Pressable
                  key={t}
                  style={[styles.tabBtn, tab === t && styles.tabBtnActive]}
                  onPress={() => setTab(t)}
                >
                  <Text
                    style={[styles.tabText, tab === t && styles.tabTextActive]}
                  >
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
                    {searching && (
                      <ActivityIndicator size="small" color={Colors.green} />
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
                          onPress={() => startPicking(p)}
                        >
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
                              <Text style={styles.per100}>/ 100g</Text>
                            </View>
                          </View>
                          <Text style={styles.chevron}>›</Text>
                        </Pressable>
                      ))}
                    </View>
                  )}

                  {showNoResults && (
                    <Text style={styles.emptyText}>
                      No results for "{query.trim()}". Create it as a food
                      from Today first, then it'll show up here.
                    </Text>
                  )}
                </>
              )}

              {tab === "library" &&
                (savedIngredients.length === 0 ? (
                  <Text style={styles.emptyText}>
                    Foods you search or scan will be saved here for quick
                    re-use.
                  </Text>
                ) : (
                  <View style={styles.resultsList}>
                    {savedIngredients.map((item, i) => (
                      <Pressable
                        key={item.id}
                        style={({ pressed }) => [
                          styles.resultRow,
                          i < savedIngredients.length - 1 &&
                            styles.resultBorder,
                          pressed && { backgroundColor: Colors.surface2 },
                        ]}
                        onPress={() => startPicking(savedToProduct(item))}
                      >
                        <View style={styles.resultBody}>
                          <Text style={styles.resultName}>{item.name}</Text>
                          {item.brand ? (
                            <Text style={styles.resultBrand}>
                              {item.brand}
                            </Text>
                          ) : null}
                          <View style={styles.macroRow}>
                            <MacroPill
                              value={`${Math.round(item.cal_per100)}`}
                              unit="kcal"
                              color={Colors.green}
                            />
                            <Text style={styles.per100}>/ 100g</Text>
                          </View>
                        </View>
                        <Text style={styles.chevron}>›</Text>
                      </Pressable>
                    ))}
                  </View>
                ))}

              <View style={{ height: Spacing.xxl }} />
            </ScrollView>
          </>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

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
    tabBtnActive: { backgroundColor: Colors.green },
    tabText: {
      fontSize: Typography.sm,
      fontWeight: Typography.medium,
      color: Colors.textSub,
    },
    tabTextActive: { color: Colors.bg, fontWeight: Typography.bold },

    scroll: { paddingHorizontal: Spacing.md },

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
    searchIcon: { fontSize: 18, color: Colors.textMuted },
    searchInput: {
      flex: 1,
      fontSize: Typography.base,
      color: Colors.text,
      paddingVertical: 13,
    },

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
    resultBody: { flex: 1, marginRight: Spacing.sm },
    resultName: {
      fontSize: Typography.sm,
      fontWeight: Typography.semibold,
      color: Colors.text,
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
    chevron: { fontSize: Typography.lg, color: Colors.textDim },

    emptyText: {
      fontSize: Typography.sm,
      color: Colors.textSub,
      textAlign: "center",
      lineHeight: 20,
      paddingVertical: Spacing.xl,
      paddingHorizontal: Spacing.md,
    },

    // Quantity step
    quantityBody: {
      paddingHorizontal: Spacing.md,
      paddingTop: Spacing.md,
      gap: Spacing.sm,
    },
    quantityName: {
      fontSize: Typography.md,
      fontWeight: Typography.bold,
      color: Colors.text,
    },
    quantityBrand: {
      fontSize: Typography.sm,
      color: Colors.textMuted,
      marginBottom: Spacing.sm,
    },
    quantityInputRow: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: Colors.surface,
      borderRadius: Radius.control,
      borderWidth: 1,
      borderColor: Colors.border,
      paddingHorizontal: Spacing.md,
      marginVertical: Spacing.md,
    },
    quantityInput: {
      fontSize: Typography.lg,
      fontFamily: Fonts.mono.semibold,
      color: Colors.text,
      paddingVertical: 13,
      minWidth: 70,
    },
    quantityUnit: {
      fontSize: Typography.sm,
      color: Colors.textSub,
      marginLeft: Spacing.sm,
    },
    primaryBtn: {
      backgroundColor: Colors.green,
      borderRadius: Radius.pill,
      paddingVertical: 13,
      alignItems: "center",
    },
    primaryBtnText: {
      fontSize: Typography.base,
      fontWeight: Typography.bold,
      color: Colors.bg,
    },
  }),
);
