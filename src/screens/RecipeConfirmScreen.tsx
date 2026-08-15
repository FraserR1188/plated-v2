// ============================================================
// src/screens/RecipeConfirmScreen.tsx
// ============================================================
// Human confirmation is the spine of the recipe scanner, not a nicety.
// Nothing the scanner produced is a logged fact until this screen's "Add to
// batch" is pressed — not the product match, not the grams, and not the
// transcription. `row.raw` is shown next to every editable field for
// exactly that last reason: it's the only way to catch a misread quantity
// (150g -> 180g) without the source recipe in front of you.
//
// Local component state only. Nothing touches `batchDraft` until the
// bottom button is pressed — see addBatchIngredients below, the ONLY store
// call this screen makes.
// ============================================================

import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Switch,
  Pressable,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  resolveIngredient,
  resolveRowGrams,
  lookupStapleFromDb,
  type ResolvedCandidate,
  type GramsConfidence,
} from "../lib/ingredients";
import { searchFood } from "../lib/openfoodfacts";
import { captureAndScanLabel } from "../lib/labelCapture";
import { labelExtractionToFoodProduct, type ExtractSuccess } from "../lib/labelExtraction";
import { LabelConfirmSheet, type LabelConfirmApply } from "../components/LabelConfirmSheet";
import { useStore } from "../store/useStore";
import { Colors, Spacing, Radius, Typography, Fonts, withDefaultFont } from "../theme/tokens";
import { FoodProduct, RootStackParamList } from "../types";

type Nav = NativeStackNavigationProp<RootStackParamList, "RecipeConfirm">;
type Route = RouteProp<RootStackParamList, "RecipeConfirm">;

const CONFIDENCE_COLOR: Record<GramsConfidence, string> = {
  exact: Colors.green,
  estimated: Colors.warning,
  unknown: Colors.danger,
};
const CONFIDENCE_LABEL: Record<GramsConfidence, string> = {
  exact: "Exact",
  estimated: "Estimated",
  unknown: "Tap to set",
};

interface ConfirmRow {
  id: string;
  raw: string;
  name: string;
  quantity: string;
  unit: string;
  grams: string;
  confidence: GramsConfidence;
  candidates: ResolvedCandidate[];
  product: FoodProduct | null;
  included: boolean;
  resolving: boolean;
}

const RESOLVE_DEPS = { lookupStaple: lookupStapleFromDb, offSearch: searchFood };

export function RecipeConfirmScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const insets = useSafeAreaInsets();
  const { ingredients, servings: initialServings, yieldText } = route.params;

  const addBatchIngredients = useStore((s) => s.addBatchIngredients);
  const setBatchDraftTotalYieldG = useStore((s) => s.setBatchDraftTotalYieldG);
  const setBatchDraftPortionSizeG = useStore((s) => s.setBatchDraftPortionSizeG);
  const setBatchDraftPortionLabel = useStore((s) => s.setBatchDraftPortionLabel);

  const [servings, setServings] = useState(initialServings != null ? String(initialServings) : "");
  const [rows, setRows] = useState<ConfirmRow[]>(() =>
    ingredients.map((line, i) => {
      const { grams, confidence } = resolveRowGrams(null, line.estimatedGrams);
      return {
        id: `line-${i}`,
        raw: line.raw,
        name: line.name,
        quantity: line.quantity != null ? String(line.quantity) : "",
        unit: line.unit ?? "",
        grams: grams != null ? String(Math.round(grams)) : "",
        confidence,
        candidates: [],
        product: null,
        included: true,
        resolving: true,
      };
    }),
  );

  // Resolve every line against the existing product resolver — in parallel,
  // each row updates itself as soon as ITS resolution lands rather than
  // waiting for the slowest one.
  useEffect(() => {
    let cancelled = false;
    ingredients.forEach((line, i) => {
      resolveIngredient(
        {
          name: line.name,
          quantity: line.quantity ?? undefined,
          unit: line.unit ?? undefined,
          brandPresent: line.brandPresent,
        },
        RESOLVE_DEPS,
      )
        .then((candidates) => {
          if (cancelled) return;
          const preselected = candidates.find((c) => c.preselected) ?? candidates[0] ?? null;
          const { grams, confidence } = resolveRowGrams(preselected, line.estimatedGrams);
          setRows((prev) =>
            prev.map((r, idx) =>
              idx === i
                ? {
                    ...r,
                    candidates,
                    product: preselected?.product ?? null,
                    grams: grams != null ? String(Math.round(grams)) : "",
                    confidence,
                    resolving: false,
                  }
                : r,
            ),
          );
        })
        .catch(() => {
          if (cancelled) return;
          setRows((prev) => (prev[i] ? prev.map((r, idx) => (idx === i ? { ...r, resolving: false } : r)) : prev));
        });
    });
    return () => {
      cancelled = true;
    };
    // Resolving is keyed to the ingredients this screen was opened with —
    // it never needs to re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateRow = (id: string, patch: Partial<ConfirmRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const removeRow = (id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  };

  const handleAddMissing = () => {
    setRows((prev) => [
      ...prev,
      {
        id: `manual-${Date.now()}`,
        raw: "",
        name: "",
        quantity: "",
        unit: "",
        grams: "",
        confidence: "unknown",
        candidates: [],
        product: null,
        included: true,
        resolving: false,
      },
    ]);
  };

  const handleAddToBatch = () => {
    const included = rows.filter((r) => r.included);
    if (included.length === 0) {
      Alert.alert("Nothing to add", "Include at least one ingredient, or go back.");
      return;
    }
    const withoutProduct = included.filter((r) => !r.product);
    if (withoutProduct.length > 0) {
      Alert.alert(
        "Pick a match",
        `${withoutProduct.length} included ingredient${withoutProduct.length > 1 ? "s" : ""} still need${withoutProduct.length > 1 ? "" : "s"} a product match.`,
      );
      return;
    }
    const withoutGrams = included.filter((r) => {
      const g = parseFloat(r.grams.replace(",", "."));
      return !Number.isFinite(g) || g <= 0;
    });
    if (withoutGrams.length > 0) {
      Alert.alert(
        "Set a weight",
        `${withoutGrams.length} included ingredient${withoutGrams.length > 1 ? "s" : ""} still need${withoutGrams.length > 1 ? "" : "s"} a weight in grams.`,
      );
      return;
    }

    const items = included.map((r) => ({
      product: r.product!,
      quantityG: parseFloat(r.grams.replace(",", ".")),
    }));
    addBatchIngredients(items);

    const totalG = items.reduce((sum, item) => sum + item.quantityG, 0);
    setBatchDraftTotalYieldG(String(Math.round(totalG)));

    const servingsN = parseFloat(servings.replace(",", "."));
    if (Number.isFinite(servingsN) && servingsN > 0) {
      setBatchDraftPortionSizeG(String(Math.round(totalG / servingsN)));
    }
    if (yieldText) setBatchDraftPortionLabel(yieldText);

    // RecipeScan is reachable only from BatchEditor's "Scan Recipe" button,
    // so the stack here is always [...BatchEditor, RecipeScan, RecipeConfirm]
    // — goBack() would pop just one level, stranding the user back on the
    // camera/paste screen instead of the editor holding what they just added.
    navigation.pop(2);
  };

  const includedCount = rows.filter((r) => r.included).length;

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <Pressable
            onPress={() => navigation.goBack()}
            style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
            hitSlop={12}
          >
            <Text style={styles.backArrow}>‹</Text>
          </Pressable>
          <Text style={styles.headerTitle}>Confirm ingredients</Text>
          <View style={{ width: 36 }} />
        </View>

        <View style={styles.topBar}>
          <Text style={styles.countText}>
            {rows.length} ingredient{rows.length === 1 ? "" : "s"} found
          </Text>
          <View style={styles.servingsRow}>
            <Text style={styles.servingsLabel}>Servings</Text>
            <TextInput
              style={styles.servingsInput}
              value={servings}
              onChangeText={setServings}
              keyboardType="decimal-pad"
              placeholder="—"
              placeholderTextColor={Colors.textMuted}
            />
          </View>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          {rows.map((row) => (
            <IngredientRow key={row.id} row={row} onUpdate={(patch) => updateRow(row.id, patch)} onRemove={() => removeRow(row.id)} />
          ))}

          <Pressable
            style={({ pressed }) => [styles.addMissingRow, pressed && { backgroundColor: Colors.surface2 }]}
            onPress={handleAddMissing}
          >
            <Text style={styles.addMissingIcon}>＋</Text>
            <Text style={styles.addMissingText}>Add missing ingredient</Text>
          </Pressable>

          <View style={{ height: Spacing.xxl }} />
        </ScrollView>

        <View style={[styles.footer, { paddingBottom: insets.bottom + Spacing.sm }]}>
          <Pressable
            style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.88 }]}
            onPress={handleAddToBatch}
          >
            <Text style={styles.primaryBtnText}>
              Add {includedCount} to batch
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Row ───────────────────────────────────────────────────

function IngredientRow({
  row,
  onUpdate,
  onRemove,
}: {
  row: ConfirmRow;
  onUpdate: (patch: Partial<ConfirmRow>) => void;
  onRemove: () => void;
}) {
  const navigation = useNavigation<Nav>();
  const [expanded, setExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FoodProduct[]>([]);
  const [searching, setSearching] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // ── Label scan state — mirrors CreateFoodScreen's own extraction-state
  // cluster, minus the photo/upload bookkeeping this screen has no use for
  // (nothing here is ever saved to custom_foods or Storage).
  const [labelSheetVisible, setLabelSheetVisible] = useState(false);
  const [labelExtracting, setLabelExtracting] = useState(false);
  const [labelResult, setLabelResult] = useState<ExtractSuccess | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);

  const runSearch = (q: string) => {
    clearTimeout(timer.current);
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    timer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const found = await searchFood(trimmed);
        setSearchResults(found);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 500);
  };

  const selectCandidate = (c: ResolvedCandidate) => {
    onUpdate({ product: c.product });
    setExpanded(false);
  };

  const selectSearchResult = (p: FoodProduct) => {
    onUpdate({ product: p });
    setExpanded(false);
    setSearchQuery("");
    setSearchResults([]);
  };

  // Third onScanned call site (see AddIngredientScreen and
  // BatchIngredientPickerScreen for the other two) — a fresh closure per
  // row, same as the candidate/search picks above: only `product` is ever
  // touched. grams/confidence are this row's own business and must survive
  // a product swap from any source untouched.
  const handleScanBarcode = () => {
    navigation.navigate("Scanner", { onScanned: (product) => onUpdate({ product }) });
  };

  // captureAndScanLabel() bundles permission + camera + prepare + extract
  // into one call (mirrors captureAndScanMealPhoto), so the sheet is opened
  // BEFORE awaiting it — the native camera UI covers the screen regardless
  // of what's rendered underneath, and by the time control returns to this
  // app the sheet is already there to show either a spinner or a result.
  // Permission/prep failures are capture-level problems, not "the label
  // scanner read a bad photo" — those get an Alert like
  // BatchIngredientPickerScreen.handleScanMeal, not the sheet's own error
  // state, which is reserved for a genuine extraction failure.
  const handleScanLabel = async () => {
    if (labelExtracting) return;
    setLabelSheetVisible(true);
    setLabelExtracting(true);
    setLabelResult(null);
    setLabelError(null);

    const capture = await captureAndScanLabel();

    switch (capture.status) {
      case "cancelled":
        setLabelSheetVisible(false);
        setLabelExtracting(false);
        return;
      case "permission_denied":
        setLabelSheetVisible(false);
        setLabelExtracting(false);
        Alert.alert("Camera access needed", "Allow camera access to scan a nutrition label.");
        return;
      case "prep_failed":
        setLabelSheetVisible(false);
        setLabelExtracting(false);
        Alert.alert("Couldn't process that photo", "Try taking it again.");
        return;
      case "scan_failed":
        setLabelExtracting(false);
        setLabelError(capture.message);
        return;
      case "ok":
        setLabelExtracting(false);
        setLabelResult(capture.result);
        return;
    }
  };

  const dismissLabelSheet = () => {
    setLabelSheetVisible(false);
    setLabelExtracting(false);
    setLabelResult(null);
    setLabelError(null);
  };

  // requireAllMacros guarantees the sheet's apply button is disabled
  // whenever any of the big four is missing, so `!coerced.ok` here is
  // unreachable in practice — defensive only, never a user-facing path.
  const handleApplyLabel = (payload: LabelConfirmApply) => {
    const coerced = labelExtractionToFoodProduct(
      payload.productName,
      payload.per100g,
      payload.servingG,
      payload.servingLabel,
    );
    if (!coerced.ok) return;
    onUpdate({ product: coerced.product });
    dismissLabelSheet();
  };

  return (
    <>
      <View style={[rowStyles.card, row.confidence === "unknown" && rowStyles.cardUnknown]}>
        <View style={rowStyles.topRow}>
          {row.raw ? (
            <Text style={rowStyles.raw} numberOfLines={2}>
              "{row.raw}"
            </Text>
          ) : (
            <Text style={rowStyles.raw}>Added by hand</Text>
          )}
          <Switch
            value={row.included}
            onValueChange={(v) => onUpdate({ included: v })}
            trackColor={{ false: Colors.border, true: Colors.green }}
          />
        </View>

        <Pressable onPress={() => setExpanded((e) => !e)} style={rowStyles.matchRow}>
          {row.resolving ? (
            <ActivityIndicator size="small" color={Colors.textSub} />
          ) : row.product ? (
            <View style={{ flex: 1 }}>
              <Text style={rowStyles.matchName} numberOfLines={1}>
                {row.product.name}
              </Text>
              {row.product.brand ? <Text style={rowStyles.matchBrand}>{row.product.brand}</Text> : null}
            </View>
          ) : (
            <Text style={rowStyles.noMatch}>No match — tap to search</Text>
          )}
          <Text style={rowStyles.chevron}>{expanded ? "︿" : "﹀"}</Text>
        </Pressable>

        {expanded && (
          <View style={rowStyles.expandPanel}>
            {row.candidates.map((c, i) => (
              <Pressable
                key={i}
                style={({ pressed }) => [rowStyles.candidateRow, pressed && { backgroundColor: Colors.surface2 }]}
                onPress={() => selectCandidate(c)}
              >
                <Text style={rowStyles.candidateName} numberOfLines={1}>
                  {c.product.name}
                  {c.product.brand ? ` — ${c.product.brand}` : ""}
                </Text>
              </Pressable>
            ))}
            <View style={rowStyles.scanBtnRow}>
              <Pressable
                style={({ pressed }) => [rowStyles.scanBtn, pressed && { opacity: 0.75 }]}
                onPress={handleScanBarcode}
              >
                <Text style={rowStyles.scanBtnIcon}>⌗</Text>
                <Text style={rowStyles.scanBtnText}>Scan barcode</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [rowStyles.scanBtn, pressed && { opacity: 0.75 }]}
                onPress={handleScanLabel}
                disabled={labelExtracting}
              >
                {labelExtracting ? (
                  <ActivityIndicator size="small" color={Colors.textSub} />
                ) : (
                  <>
                    <Text style={rowStyles.scanBtnIcon}>📷</Text>
                    <Text style={rowStyles.scanBtnText}>Scan label</Text>
                  </>
                )}
              </Pressable>
            </View>
            <TextInput
              style={rowStyles.searchInput}
              value={searchQuery}
              onChangeText={(t) => {
                setSearchQuery(t);
                runSearch(t);
              }}
              placeholder="Search for a different product…"
              placeholderTextColor={Colors.textMuted}
            />
            {searching && <ActivityIndicator size="small" color={Colors.textSub} style={{ marginVertical: 4 }} />}
            {searchResults.map((p, i) => (
              <Pressable
                key={i}
                style={({ pressed }) => [rowStyles.candidateRow, pressed && { backgroundColor: Colors.surface2 }]}
                onPress={() => selectSearchResult(p)}
              >
                <Text style={rowStyles.candidateName} numberOfLines={1}>
                  {p.name}
                  {p.brand ? ` — ${p.brand}` : ""}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        <View style={rowStyles.fieldsRow}>
          <TextInput
            style={[rowStyles.fieldInput, { flex: 2 }]}
            value={row.name}
            onChangeText={(t) => onUpdate({ name: t })}
            placeholder="Name"
            placeholderTextColor={Colors.textMuted}
          />
          <TextInput
            style={[rowStyles.fieldInput, { flex: 1 }]}
            value={row.quantity}
            onChangeText={(t) => onUpdate({ quantity: t })}
            placeholder="Qty"
            placeholderTextColor={Colors.textMuted}
            keyboardType="decimal-pad"
          />
          <TextInput
            style={[rowStyles.fieldInput, { flex: 1 }]}
            value={row.unit}
            onChangeText={(t) => onUpdate({ unit: t })}
            placeholder="Unit"
            placeholderTextColor={Colors.textMuted}
          />
        </View>

        <View style={rowStyles.gramsRow}>
          <TextInput
            style={rowStyles.gramsInput}
            value={row.grams}
            // A manual edit is the most trustworthy source there is — once the
            // human types a number, this row's null-grams contract is
            // satisfied, so the badge should stop demanding a tap.
            onChangeText={(t) => onUpdate({ grams: t, confidence: "exact" })}
            placeholder="0"
            placeholderTextColor={Colors.textMuted}
            keyboardType="decimal-pad"
          />
          <Text style={rowStyles.gramsUnit}>g</Text>
          <View style={[rowStyles.confidencePill, { backgroundColor: `${CONFIDENCE_COLOR[row.confidence]}18` }]}>
            <Text style={[rowStyles.confidencePillText, { color: CONFIDENCE_COLOR[row.confidence] }]}>
              {CONFIDENCE_LABEL[row.confidence]}
            </Text>
          </View>
          <Pressable onPress={onRemove} hitSlop={8} style={{ marginLeft: "auto" }}>
            <Text style={rowStyles.removeText}>Remove</Text>
          </Pressable>
        </View>
      </View>

      <LabelConfirmSheet
        visible={labelSheetVisible}
        loading={labelExtracting}
        error={labelError}
        result={labelResult}
        onApply={handleApplyLabel}
        onDismiss={dismissLabelSheet}
        onRetry={handleScanLabel}
        requireAllMacros
      />
    </>
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
    backArrow: { fontSize: 22, color: Colors.textSub, lineHeight: 26, marginTop: -2 },
    headerTitle: { fontSize: Typography.base, fontWeight: Typography.bold, color: Colors.text },

    topBar: {
      paddingHorizontal: Spacing.md,
      paddingBottom: Spacing.sm,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    countText: { fontSize: Typography.sm, color: Colors.textSub, fontWeight: Typography.medium },
    servingsRow: { flexDirection: "row", alignItems: "center", gap: Spacing.xs },
    servingsLabel: { fontSize: Typography.sm, color: Colors.textSub },
    servingsInput: {
      width: 48,
      textAlign: "center",
      backgroundColor: Colors.surface,
      borderRadius: Radius.control,
      borderWidth: 1,
      borderColor: Colors.border,
      color: Colors.text,
      paddingVertical: 6,
      fontFamily: Fonts.mono.semibold,
    },

    scroll: { paddingHorizontal: Spacing.md, gap: Spacing.sm },

    addMissingRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.xs,
      paddingVertical: Spacing.md,
      borderRadius: Radius.card,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: Colors.border,
      marginTop: Spacing.xs,
    },
    addMissingIcon: { fontSize: 16, color: Colors.textSub },
    addMissingText: { fontSize: Typography.sm, fontWeight: Typography.semibold, color: Colors.textSub },

    footer: {
      paddingHorizontal: Spacing.md,
      paddingTop: Spacing.sm,
      borderTopWidth: 1,
      borderTopColor: Colors.borderSub,
    },
    primaryBtn: {
      backgroundColor: Colors.green,
      borderRadius: Radius.pill,
      paddingVertical: 13,
      alignItems: "center",
    },
    primaryBtnText: { fontSize: Typography.base, fontWeight: Typography.bold, color: Colors.bg },
  }),
);

const rowStyles = StyleSheet.create(
  withDefaultFont({
    card: {
      backgroundColor: Colors.surface,
      borderRadius: Radius.card,
      borderWidth: 1,
      borderColor: Colors.border,
      padding: Spacing.md,
      gap: Spacing.sm,
    },
    cardUnknown: { borderColor: Colors.danger },

    topRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: Spacing.sm },
    raw: { flex: 1, fontSize: Typography.xs, color: Colors.textMuted, fontStyle: "italic" },

    matchRow: { flexDirection: "row", alignItems: "center", gap: Spacing.xs },
    matchName: { fontSize: Typography.sm, fontWeight: Typography.semibold, color: Colors.text },
    matchBrand: { fontSize: Typography.xs, color: Colors.textMuted },
    noMatch: { flex: 1, fontSize: Typography.sm, color: Colors.danger, fontWeight: Typography.medium },
    chevron: { fontSize: Typography.xs, color: Colors.textMuted },

    expandPanel: {
      backgroundColor: Colors.surface2,
      borderRadius: Radius.control,
      padding: Spacing.xs,
      gap: 2,
    },
    candidateRow: { paddingVertical: 8, paddingHorizontal: Spacing.sm, borderRadius: Radius.control },
    candidateName: { fontSize: Typography.sm, color: Colors.text },
    scanBtnRow: { flexDirection: "row", gap: Spacing.xs, marginTop: 2 },
    scanBtn: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingVertical: 8,
      borderRadius: Radius.control,
      backgroundColor: Colors.surface,
      borderWidth: 1,
      borderColor: Colors.border,
      minHeight: 34,
    },
    scanBtnIcon: { fontSize: Typography.sm, color: Colors.textSub, fontWeight: Typography.bold },
    scanBtnText: { fontSize: Typography.sm, fontWeight: Typography.semibold, color: Colors.textSub },
    searchInput: {
      marginTop: 4,
      backgroundColor: Colors.surface,
      borderRadius: Radius.control,
      borderWidth: 1,
      borderColor: Colors.border,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 8,
      fontSize: Typography.sm,
      color: Colors.text,
    },

    fieldsRow: { flexDirection: "row", gap: Spacing.xs },
    fieldInput: {
      backgroundColor: Colors.surface2,
      borderRadius: Radius.control,
      borderWidth: 1,
      borderColor: Colors.border,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 8,
      fontSize: Typography.sm,
      color: Colors.text,
    },

    gramsRow: { flexDirection: "row", alignItems: "center", gap: Spacing.xs },
    gramsInput: {
      backgroundColor: Colors.surface2,
      borderRadius: Radius.control,
      borderWidth: 1,
      borderColor: Colors.border,
      paddingHorizontal: Spacing.sm,
      paddingVertical: 8,
      fontSize: Typography.sm,
      color: Colors.text,
      fontFamily: Fonts.mono.semibold,
      minWidth: 56,
    },
    gramsUnit: { fontSize: Typography.xs, color: Colors.textMuted },
    confidencePill: { borderRadius: Radius.pill, paddingHorizontal: 9, paddingVertical: 3 },
    confidencePillText: { fontSize: Typography.xs, fontWeight: Typography.semibold },
    removeText: { fontSize: Typography.xs, color: Colors.textMuted, fontWeight: Typography.medium },
  }),
);
