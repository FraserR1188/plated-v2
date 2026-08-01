import React, { useState, useEffect } from "react";
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
import { useStore, todayKey, MealEntryPatch } from "../store/useStore";
import {
  formatTime,
  formatDayLabel,
  resolveEatenAt,
  resolveEatenAtAndDate,
  parseDateKey,
  dateKey,
  willBePlanned,
  DEFAULT_HOUR,
} from "../lib/time";
import {
  Colors,
  Spacing,
  Radius,
  Typography,
  MacroColor,
  Fonts,
  withDefaultFont,
} from "../theme/tokens";
import { RootStackParamList, MEAL_LABELS } from "../types";
import { getSignedImageUrl } from "../lib/customFoodImages";

type Nav = NativeStackNavigationProp<RootStackParamList, "Product">;
type Route = RouteProp<RootStackParamList, "Product">;

const DEFAULT_PRESETS = [50, 75, 100, 150, 200];

// Traffic-light mapping for aiEstimate.confidence — "trust this less" reads
// the same way across the app as any other warning colour.
const AI_CONFIDENCE_COLOR: Record<"high" | "medium" | "low", string> = {
  high: Colors.green,
  medium: Colors.warning,
  low: Colors.danger,
};
const AI_CONFIDENCE_LABEL: Record<"high" | "medium" | "low", string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

// NOTE (D4): DEFAULT_HOUR used to be declared here. It now lives in
// src/lib/time.ts, because it is a policy about TIME, not about this screen —
// bundles need the same answer, and two definitions would drift. It is imported
// above. Do not re-add it here.

// Product identity thumbnail.
//   • OFF products arrive with image_url — a directly renderable URL.
//   • Custom foods arrive with image_path — a path into the PRIVATE bucket,
//     which has to be signed before it can be displayed.
function ProductThumb({ uri, path }: { uri?: string; path?: string }) {
  const [errored, setErrored] = useState(false);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!path) {
      setSignedUrl(null);
      return;
    }
    getSignedImageUrl(path).then((url) => {
      if (!cancelled) setSignedUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const source = uri ?? signedUrl ?? undefined;
  const showImage = !!source && !errored;

  return (
    <View style={styles.thumb}>
      {showImage ? (
        <Image
          source={{ uri: source }}
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
    date: routeDate,
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
    ? [servingPreset, 50, 100, 150, 200].filter((v, i, a) => a.indexOf(v) === i)
    : DEFAULT_PRESETS;

  // initialServingG is `number | null` as of D4 (MealEntry.serving_g is nullable
  // in the DB, and the type used to lie about it). `??` already handles null.
  const [serving, setServing] = useState(
    String(initialServingG ?? servingPreset ?? 100),
  );

  // ── Eaten-at: ONE Date carrying both the day and the time ───
  //
  // Deliberately not two pieces of state. `date` and `eaten_at` diverging is
  // the D2 bug; the surest way to prevent two values disagreeing is to only
  // have one. `date` is DERIVED from this at submit, never picked alongside it.
  const [eatenAt, setEatenAt] = useState<Date>(() => {
    if (initialEatenAt) return new Date(initialEatenAt); // editing: keep it exactly

    const day = parseDateKey(routeDate ?? todayKey());
    if ((routeDate ?? todayKey()) === todayKey()) return new Date(); // today: now

    // Another day: "now" is meaningless. Start from the shape of the meal.
    day.setHours(DEFAULT_HOUR[mealType] ?? 12, 0, 0, 0);
    return day;
  });

  const [pickerMode, setPickerMode] = useState<"date" | "time" | null>(null);

  // Did the user actually PICK a time, or are we still showing the default?
  // This is the entire difference between a timestamp you can correlate against
  // WHOOP recovery and one that just says "whenever I opened the app".
  const [timeTouched, setTimeTouched] = useState(false);

  // Did the user explicitly choose a DAY? This gates the midnight roll-back.
  //
  // resolveEatenAt() guesses that a 23:45 picked at 00:30 means LAST night. That
  // guess is right, and it must survive — but it is also lethal to planning,
  // because tomorrow's 19:00 is ~27h ahead and would get rolled back into today.
  // So: guess only when not told. Arriving on a non-today screen counts as being
  // told, because you navigated there on purpose.
  const [dateTouched, setDateTouched] = useState(false);
  const dayIsExplicit =
    isEditing || dateTouched || (routeDate ?? todayKey()) !== todayKey();

  const [saving, setSaving] = useState(false);

  const g = parseFloat(serving) || 0;
  const f = g / 100;
  const satFat100 = product.sat_fat_per100 ?? 0;

  // What the DB trigger will decide. ADVISORY — the database is the authority;
  // this only lets the UI tell the truth about what it's about to do.
  //
  // The bundle sheet's Logged/Planned pills use this same call, per item, and
  // the same copy. It is the same distinction; keep the language identical.
  const isPlanned = willBePlanned(eatenAt.toISOString());

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

  const onDateChange = (event: any, picked?: Date) => {
    setPickerMode(null);
    if (event?.type === "dismissed" || !picked) return;

    setDateTouched(true);
    const next = new Date(eatenAt);
    next.setFullYear(picked.getFullYear(), picked.getMonth(), picked.getDate());
    setEatenAt(next);
  };

  const onTimeChange = (event: any, picked?: Date) => {
    setPickerMode(null);
    if (event?.type === "dismissed" || !picked) return;

    setTimeTouched(true); // below the guard, so a cancel doesn't count

    if (dayIsExplicit) {
      // The day is settled. Swap the time and leave it alone.
      const next = new Date(eatenAt);
      next.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
      setEatenAt(next);
    } else {
      // Today, day untouched → let the roll-back heuristic do its job.
      setEatenAt(
        new Date(resolveEatenAt(picked.getHours(), picked.getMinutes())),
      );
    }
  };

  const handleSubmit = async () => {
    if (!g) return;
    setSaving(true);

    // The pair, derived together, from one value. `date` is never picked.
    const { eaten_at, date } = resolveEatenAtAndDate(
      eatenAt.getHours(),
      eatenAt.getMinutes(),
      eatenAt,
    );

    // ⚠ KNOWN BUG, NOT FIXED IN D4 — flagged so nobody "discovers" it later.
    //
    // On an EDIT, every macro below is recomputed from `product`, which
    // mealEntryToProduct() reconstructed by DIVIDING the stored per-serving
    // values and rounding (Math.round / toFixed). The round-trip does not
    // commute: a 250g entry at 437 kcal comes back as 175 kcal/100g and
    // multiplies out to 437.5.
    //
    // So editing a logged meal's TIME silently moves its CALORIES, and it
    // compounds on every edit. The fix is to only recompute when `serving`
    // actually changed — a ProductScreen redesign, not a patch. Until then, know
    // that this is here.
    //
    // (This is also why createBundleFromEntries snapshots MealEntry →
    // meal_bundle_items directly and never routes through FoodProduct.)
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
      eaten_at,
    };

    if (isEditing) {
      // Only ever UPGRADE the flag. An edit that doesn't open the picker
      // (changing the serving size, say) must NOT downgrade a previously
      // confirmed time back to "estimated" — that would quietly destroy the one
      // piece of provenance the correlation depends on.
      //
      // `date` is NOT in this patch: the store derives it from eaten_at. That is
      // the only place the relationship is enforced, and MealEntryPatch is shaped
      // so this screen cannot bypass it even by accident.
      const patch: MealEntryPatch = { ...macros };
      if (timeTouched) patch.eaten_at_estimated = false;

      // ⚠ D4: updateEntry RETURNS AN ERROR NOW, AND THIS SCREEN MUST NOT POP ON IT.
      //
      // Migration 5 added meal_entries_no_future_logged_bu, which REFUSES an
      // update that leaves a logged meal (planned = false) with an eaten_at in
      // the future. That closes a real hole: before it, you could open a
      // breakfast you'd eaten, move it to next Thursday, and the freeze trigger
      // would pin planned = false — giving you a row the DB believes you ATE,
      // dated in the future, which passes the WHOOP correlation's gate on its
      // first clause and is invisible to the banner, getPendingEntries() and
      // whoop_unassigned_meals.
      //
      // But this screen used to popToTop() unconditionally while updateEntry
      // swallowed failures into a console.warn. Adding the trigger without this
      // check would have turned a silent CORRUPTION into a silent NO-OP: the
      // screen closes, the row is unchanged, and the user is told nothing.
      //
      // So: check, tell them, and STAY.
      const { error } = await updateEntry(editEntryId!, patch);
      if (error) {
        setSaving(false);
        Alert.alert("Can't save that", error, [{ text: "OK" }]);
        return; // ← DO NOT POP. The edit did not happen.
      }
    } else {
      await saveIngredient(product);
      await addEntry({
        date,
        meal_type: mealType,
        name: product.name,
        brand: product.brand,
        ...macros,
        // AI-recognized drafts have no barcode and aren't source: "custom",
        // so without this check first they'd silently fall through to
        // "search" and the estimate's provenance would be lost.
        source: product.aiEstimate
          ? "ai_photo"
          : product.source === "custom"
            ? "custom"
            : product.barcode
              ? "barcode"
              : "search",
        barcode: product.barcode,
        off_id: product.off_id,

        // A PLANNED time is always an estimate, however deliberately you picked
        // it — you have not eaten this yet, so 19:00 is a forecast, not a fact.
        // It only becomes real if you adjust the time while confirming.
        //
        // For a meal you HAVE eaten, the old rule stands: an untouched picker
        // says "when I opened the app", not "when I ate".
        eaten_at_estimated: isPlanned ? true : !timeTouched,

        image_url: product.image_url ?? null,
        image_path: product.image_path ?? null,
        custom_food_id: product.custom_food_id ?? null,
      });
      // NOTE: addEntry still swallows its errors into console.warn and returns
      // void, so an insert failure here pops as if it worked. Less urgent than
      // the edit path (nothing is being corrupted — the meal just isn't saved,
      // and the user will notice the empty section), but it is the same class of
      // bug and it should go the same way.
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
  const dayLabel = formatDayLabel(dateKey(eatenAt));

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
              {isEditing
                ? "Edit entry"
                : isPlanned
                  ? "Plan a meal"
                  : "Add to meal"}
            </Text>
            <View style={styles.mealPill}>
              <Text style={styles.mealPillText}>{mealLabel}</Text>
            </View>
          </View>
        </View>

        {/* ── AI estimate notice ──────────────────────── */}
        {/* Only present on a draft built from scan-meal-photo. The macros
            below are a photo-based guess, not a lookup — this says so
            before the user sees a single number, states how confident the
            guess is, and offers the model's other reads of the same photo
            as plain information (not selectable — only the primary dish
            got a macro estimate). */}
        {product.aiEstimate ? (
          <View style={styles.aiCard}>
            <View style={styles.aiHeaderRow}>
              <Text style={styles.aiTitle}>🤖 AI estimate</Text>
              <View
                style={[
                  styles.confidencePill,
                  { backgroundColor: `${AI_CONFIDENCE_COLOR[product.aiEstimate.confidence]}18` },
                ]}
              >
                <Text
                  style={[
                    styles.confidencePillText,
                    { color: AI_CONFIDENCE_COLOR[product.aiEstimate.confidence] },
                  ]}
                >
                  {AI_CONFIDENCE_LABEL[product.aiEstimate.confidence]} confidence
                </Text>
              </View>
            </View>
            {product.aiEstimate.alternatives.length > 0 ? (
              <Text style={styles.aiAlternatives}>
                Could also be: {product.aiEstimate.alternatives.join(", ")}
              </Text>
            ) : null}
            {product.aiEstimate.notes.map((note, i) => (
              <Text key={i} style={styles.aiNote}>
                {note}
              </Text>
            ))}
          </View>
        ) : null}

        {/* ── Product identity card ───────────────────── */}
        <View style={styles.productCard}>
          <View style={styles.identityRow}>
            <ProductThumb uri={product.image_url} path={product.image_path} />
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

        {/* ── Timing card — TWO chips ─────────────────── */}
        {/*
          Two chips, not one control: Android's picker cannot do date and time in
          a single dialog. Two taps for a planned meal, and — crucially — ZERO
          extra taps for the 95% case of logging something you just ate, because
          the date chip already says Today.
        */}
        <View style={styles.card}>
          <Text style={styles.cardSectionLabel}>
            {isPlanned ? "When will you eat this?" : "When did you eat this?"}
          </Text>

          <View style={styles.whenRow}>
            <Pressable
              style={({ pressed }) => [
                styles.whenChip,
                isPlanned && styles.whenChipPlanned,
                pressed && { opacity: 0.8 },
              ]}
              onPress={() => setPickerMode("date")}
            >
              <Text style={styles.whenIcon}>{isPlanned ? "📅" : "🗓"}</Text>
              <Text
                style={[styles.whenValue, isPlanned && styles.whenValuePlanned]}
                numberOfLines={1}
              >
                {dayLabel}
              </Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [
                styles.whenChip,
                isPlanned && styles.whenChipPlanned,
                pressed && { opacity: 0.8 },
              ]}
              onPress={() => setPickerMode("time")}
            >
              <Text style={styles.whenIcon}>🕐</Text>
              <Text
                style={[
                  styles.whenValue,
                  styles.whenValueMono,
                  isPlanned && styles.whenValuePlanned,
                ]}
              >
                {formatTime(eatenAt.toISOString())}
              </Text>
            </Pressable>
          </View>

          <Text style={styles.whenCaption}>
            {isPlanned ? (
              <>
                Saved as a plan.{" "}
                <Text style={styles.whenCaptionStrong}>
                  We'll ask if you actually ate it.
                </Text>
              </>
            ) : (
              <>
                Plated at{" "}
                <Text style={styles.whenCaptionStrong}>
                  {formatTime(eatenAt.toISOString())}
                </Text>
                , {dayLabel.toLowerCase()}.
              </>
            )}
          </Text>

          {pickerMode && (
            <DateTimePicker
              value={eatenAt}
              mode={pickerMode}
              is24Hour
              display="default"
              onChange={pickerMode === "date" ? onDateChange : onTimeChange}
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
              {isEditing
                ? "Update entry"
                : isPlanned
                  ? `Plan ${mealLabel.toLowerCase()} for ${dayLabel.toLowerCase()}`
                  : `Add to ${mealLabel}`}
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

const styles = StyleSheet.create(
  withDefaultFont({
  safe: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  scroll: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
  },

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

  productCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  aiCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    gap: Spacing.xs,
  },
  aiHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  aiTitle: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    color: Colors.text,
  },
  confidencePill: {
    borderRadius: Radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  confidencePillText: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
  },
  aiAlternatives: {
    fontSize: Typography.sm,
    color: Colors.textSub,
  },
  aiNote: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    lineHeight: 16,
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
    borderRadius: Radius.control,
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

  macroGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  macroCell: {
    borderRadius: Radius.control,
    padding: Spacing.sm,
    alignItems: "center",
    minWidth: "22%",
    flex: 1,
  },
  macroCellVal: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    fontFamily: Fonts.mono.bold,
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

  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.card,
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
    borderRadius: Radius.control,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    fontSize: Typography.xxl,
    fontWeight: Typography.bold,
    fontFamily: Fonts.mono.bold,
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
    borderRadius: Radius.control,
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
    fontFamily: Fonts.mono.semibold,
    color: Colors.textMuted,
  },
  presetTextActive: {
    color: Colors.green,
  },

  // Timing — two chips side by side
  whenRow: {
    flexDirection: "row",
    gap: Spacing.sm,
  },
  whenChip: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.sm,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.control,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.md,
  },
  whenChipPlanned: {
    backgroundColor: `${MacroColor.protein}12`,
    borderColor: `${MacroColor.protein}40`,
  },
  whenIcon: {
    fontSize: 15,
  },
  whenValue: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.text,
    letterSpacing: -0.2,
    flexShrink: 1,
  },
  whenValueMono: {
    fontFamily: Fonts.mono.bold,
    fontVariant: ["tabular-nums"],
  },
  whenValuePlanned: {
    color: MacroColor.protein,
  },
  whenCaption: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
    marginTop: Spacing.sm,
  },
  whenCaptionStrong: {
    color: Colors.textSub,
    fontWeight: Typography.semibold,
  },

  previewHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: Spacing.sm,
  },
  previewServingBadge: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.pill,
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
    fontFamily: Fonts.mono.bold,
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
    fontFamily: Fonts.mono.bold,
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
    borderRadius: Radius.pill,
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
    borderRadius: Radius.pill,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: Spacing.sm,
  },
  deleteBtnText: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    color: Colors.danger,
  },
  }),
);
