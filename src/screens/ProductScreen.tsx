import React, { useState, useEffect, useRef, useCallback } from "react";
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
import {
  useNavigation,
  useRoute,
  useFocusEffect,
  RouteProp,
} from "@react-navigation/native";
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
import {
  FoodProduct,
  RootStackParamList,
  MealType,
  MEAL_TYPES,
  MEAL_LABELS,
} from "../types";
import { getSignedImageUrl } from "../lib/customFoodImages";
import { SourceNotice } from "../components/SourceNotice";
import { scanMealPhoto, mealScanToFoodProduct, MacroKey } from "../lib/mealRecognition";
import {
  computeServingTotals,
  needsManualEntry,
  canSubmitProduct,
} from "../lib/macros";

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

// ─── Per-100g macro grid — data-driven so it can render as either static
// Text (every non-AI product) or an editable TextInput (an AI draft, before
// it's logged). get/set close over FoodProduct's actual field names so the
// rest of the file never does a computed-key lookup. ──────────────────────
type MacroMeta = {
  key: MacroKey;
  label: string;
  unit: string;
  color: string;
  get: (p: FoodProduct) => number;
  set: (p: FoodProduct, v: number) => FoodProduct;
  // Energy/protein/carbs/fat: the Phase 2 "no usable nutrition" detector
  // gates ALL FOUR of these together (needsManualEntry), never individually.
  bigFour?: boolean;
  // Sat-fat/salt/fibre/sugar: genuinely nullable per-100g fields (Phase 1).
  // `raw` reads the UNCOALESCED value so the grid can tell "known 0" apart
  // from "we don't have this" — `get` above always coalesces to 0 and can't
  // make that distinction, it exists only to seed the editable TextInput.
  raw?: (p: FoodProduct) => number | undefined;
};

const MACRO_META: MacroMeta[] = [
  {
    key: "cal",
    label: "Calories",
    unit: "kcal",
    color: Colors.green,
    get: (p) => p.cal_per100,
    set: (p, v) => ({ ...p, cal_per100: v }),
    bigFour: true,
  },
  {
    key: "protein",
    label: "Protein",
    unit: "g",
    color: MacroColor.protein,
    get: (p) => p.protein_per100,
    set: (p, v) => ({ ...p, protein_per100: v }),
    bigFour: true,
  },
  {
    key: "carbs",
    label: "Carbs",
    unit: "g",
    color: MacroColor.carbs,
    get: (p) => p.carbs_per100,
    set: (p, v) => ({ ...p, carbs_per100: v }),
    bigFour: true,
  },
  {
    key: "fat",
    label: "Fat",
    unit: "g",
    color: MacroColor.fat,
    get: (p) => p.fat_per100,
    set: (p, v) => ({ ...p, fat_per100: v }),
    bigFour: true,
  },
  {
    key: "satFat",
    label: "Sat fat",
    unit: "g",
    color: MacroColor.satFat,
    get: (p) => p.sat_fat_per100 ?? 0,
    set: (p, v) => ({ ...p, sat_fat_per100: v }),
    raw: (p) => p.sat_fat_per100,
  },
  {
    key: "salt",
    label: "Salt",
    unit: "g",
    color: MacroColor.salt,
    get: (p) => p.salt_per100 ?? 0,
    set: (p, v) => ({ ...p, salt_per100: v }),
    raw: (p) => p.salt_per100,
  },
  {
    key: "fibre",
    label: "Fibre",
    unit: "g",
    color: MacroColor.fibre,
    get: (p) => p.fibre_per100 ?? 0,
    set: (p, v) => ({ ...p, fibre_per100: v }),
    raw: (p) => p.fibre_per100,
  },
  {
    key: "sugar",
    label: "Sugar",
    unit: "g",
    color: MacroColor.sugar,
    get: (p) => p.sugar_per100 ?? 0,
    set: (p, v) => ({ ...p, sugar_per100: v }),
    raw: (p) => p.sugar_per100,
  },
];

/**
 * Should this cell render "—" instead of a value? Big-four cells are gated
 * together on the Phase 2 detector (never individually — a legitimate
 * single-zero, e.g. 0g protein in a pure-fat oil, must still show "0", not
 * "—"); sat-fat/salt/fibre/sugar are gated individually on their own
 * genuine NULL (Phase 1), independent of the big-four detector.
 */
function isMacroCellMissing(
  m: MacroMeta,
  product: FoodProduct,
  bigFourMissing: boolean,
): boolean {
  if (m.bigFour) return bigFourMissing;
  return m.raw ? m.raw(product) == null : false;
}

function initMacroText(product: FoodProduct): Record<MacroKey, string> {
  const out = {} as Record<MacroKey, string>;
  for (const m of MACRO_META) out[m.key] = String(m.get(product));
  return out;
}

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
    mealType: routeMealType,
    editEntryId,
    initialServingG,
    initialEatenAt,
  } = useRoute<Route>().params;
  const { addEntry, updateEntry, deleteEntry, saveIngredient } = useStore();
  const consumeManualEntryResult = useStore((s) => s.consumeManualEntryResult);
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);

  const isEditing = !!editEntryId;

  // The route's mealType is only ever a STARTING guess now — derived from
  // the time picked on Today (sectionForTime), not chosen by the user. This
  // is the one place it becomes overridable: an editable tag on CREATE only.
  // meal_type is sticky once a row exists (MealEntryPatch has no field for
  // it — see CLAUDE.md's architecture invariants), so on an EDIT this stays
  // fixed at the entry's real, already-set section and the tag renders
  // read-only.
  const [mealType, setMealType] = useState<MealType>(routeMealType);

  // ── Editable draft ──────────────────────────────────────────
  //
  // `product` (the route param) is the ORIGINAL, untouched result — never
  // mutated. Every render and the final submit read from `draft`, which
  // starts equal to `product` and is only ever replaced wholesale (a
  // corrected re-estimate) or field-by-field (a hand-edited per-100g
  // macro). Only an AI draft (draft.aiEstimate present) is editable at
  // all — a looked-up OFF/custom/library product renders exactly as
  // before.
  const [draft, setDraft] = useState<FoodProduct>(product);
  const [macroText, setMacroText] = useState<Record<MacroKey, string>>(() =>
    initMacroText(product),
  );

  // ── Correction flow state ───────────────────────────────────
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(product.name);
  const [reestimating, setReestimating] = useState(false);
  const [reestimateError, setReestimateError] = useState<string | null>(null);

  const openCorrection = (prefill?: string) => {
    setTitleDraft(prefill ?? draft.name);
    setReestimateError(null);
    setTitleEditing(true);
    // The affordance that opens this can live on the identity card, well
    // below the AI card where the edit surface actually renders — without
    // this, "fix it" would silently do nothing visible until the user
    // scrolled up themselves.
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  };

  // Re-estimate is an explicit, billed, rate-limited AI call — never fired
  // on blur. It resends the SAME photo bytes the first scan used, plus the
  // new label, and on success REPLACES the whole draft (title, per-100g
  // macros, portion) — any hand-edited macros are discarded, because
  // hand-tuning is meant to happen once identity is settled, not survive
  // across a re-identification.
  const runReestimate = async (label: string) => {
    const trimmed = label.trim();
    if (!trimmed || reestimating) return;
    const sourceImageBase64 = draft.aiEstimate?.sourceImageBase64;
    if (!sourceImageBase64) return; // not an AI draft — shouldn't be reachable

    setReestimating(true);
    setReestimateError(null);
    try {
      const result = await scanMealPhoto(sourceImageBase64, trimmed);
      if (!result.ok) {
        setReestimateError(result.message);
        return;
      }
      const next = mealScanToFoodProduct(result, sourceImageBase64, true);
      setDraft(next);
      setMacroText(initMacroText(next));
      setServing(String(Math.round(next.serving_g ?? 100)));
      setTitleEditing(false);
    } finally {
      setReestimating(false);
    }
  };

  // Phase 3: consumes CreateFoodScreen's write-once handoff (see
  // useStore.ts's manualEntryResult comment) when this screen regains
  // focus after an "Enter nutrition manually" round-trip. useFocusEffect,
  // not a plain useEffect watching the store value, is what scopes this to
  // the CURRENTLY FOCUSED ProductScreen instance — CreateFood opened from
  // Scanner or AddIngredient never writes to the slice (returnToOpener is
  // never set on those routes), so this is already a no-op for those flows
  // regardless of focus, but focus-scoping is also what stops a
  // backgrounded/unfocused ProductScreen instance from reacting to a
  // result meant for whichever instance the user is actually looking at.
  //
  // Deliberately NOT the full runReestimate swap: setServing is skipped.
  // Re-estimate replaces the food's IDENTITY, so resetting the serving to
  // the new product's own default makes sense there; manual entry only
  // supplies nutrition data for the SAME already-chosen food and portion —
  // the grams the user already typed must survive untouched.
  useFocusEffect(
    useCallback(() => {
      const result = consumeManualEntryResult();
      if (!result) return;
      setDraft(result);
      setMacroText(initMacroText(result));
    }, [consumeManualEntryResult]),
  );

  const updateMacro = (meta: MacroMeta, text: string) => {
    setMacroText((prev) => ({ ...prev, [meta.key]: text }));
    const parsed = parseFloat(text.replace(",", "."));
    setDraft((prev) => meta.set(prev, Number.isFinite(parsed) ? parsed : 0));
  };

  // ── Serving portion ─────────────────────────────────────────
  const servingPreset =
    draft.serving_g && draft.serving_g > 0 ? Math.round(draft.serving_g) : null;

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

  // Phase 2 guard: energy + protein + carbs + fat all zero ⇒ no usable
  // nutrition (see lib/macros.ts needsManualEntry — a genuine OFF
  // crowd-sourced zero and a pre-Phase-1 null-coerced zero are
  // indistinguishable by this point, and both need the same treatment).
  // needsManualEntry additionally exempts `source: "custom"` products —
  // Phase 3: a custom food's big-four were necessarily human-typed already
  // (CreateFoodScreen won't save one otherwise), so a manually-entered
  // all-zero (water) must not trip this again the moment it comes back
  // from CreateFoodScreen — see that function's own comment for why.
  //
  // Scoped to the CREATE flow only. `isEditing`'s `draft` comes from
  // mealEntryToProduct() on an already-confirmed MealEntry — re-litigating
  // already-logged history here (e.g. blocking a genuine 0-kcal water entry
  // from being re-saved) would be a regression this phase isn't asked to fix.
  const bigFourMissing = !isEditing && needsManualEntry(draft);

  // What the DB trigger will decide. ADVISORY — the database is the authority;
  // this only lets the UI tell the truth about what it's about to do.
  //
  // The bundle sheet's Logged/Planned pills use this same call, per item, and
  // the same copy. It is the same distinction; keep the language identical.
  const isPlanned = willBePlanned(eatenAt.toISOString());

  // Serving-scaled preview. Pulled into lib/macros.ts so "edit a macro, see
  // the total recompute" is testable without RNTL, and so salt goes through
  // roundSalt here too — this card used to round it with .toFixed(2)
  // instead, the exact float-noise problem roundSalt exists to fix.
  const preview = computeServingTotals(draft, g);

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
    // On an EDIT, every macro below is recomputed from `draft`, which
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
    // meal_composition_items directly and never routes through FoodProduct.)
    // NULL-not-zero: an unknown per-100g value (draft.X_per100 == null — the
    // same condition previewRows' `missing` flags below key off) must stay
    // NULL through the scale-to-serving step, not get coalesced into a
    // fabricated 0. That 0 would be indistinguishable from a real zero the
    // instant it lands in meal_entries, permanently — see the WRITING rule
    // on MealEntry in src/types/index.ts.
    const macros = {
      serving_g: g,
      calories: draft.cal_per100 * f,
      protein: draft.protein_per100 * f,
      carbs: draft.carbs_per100 * f,
      fat: draft.fat_per100 * f,
      sat_fat: draft.sat_fat_per100 != null ? draft.sat_fat_per100 * f : null,
      salt: draft.salt_per100 != null ? draft.salt_per100 * f : null,
      fibre: draft.fibre_per100 != null ? draft.fibre_per100 * f : null,
      sugar: draft.sugar_per100 != null ? draft.sugar_per100 * f : null,
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
      await saveIngredient(draft);
      await addEntry({
        date,
        meal_type: mealType,
        name: draft.name,
        brand: draft.brand,
        ...macros,
        // AI-recognized drafts have no barcode and aren't source: "custom",
        // so without this check first they'd silently fall through to
        // "search" and the estimate's provenance would be lost. A
        // corrected draft is STILL "ai_photo" — the correction changes the
        // identity, not the provenance of the estimate.
        source: draft.aiEstimate
          ? "ai_photo"
          : draft.source === "custom"
            ? "custom"
            : draft.barcode
              ? "barcode"
              : "search",
        barcode: draft.barcode,
        off_id: draft.off_id,

        // A PLANNED time is always an estimate, however deliberately you picked
        // it — you have not eaten this yet, so 19:00 is a forecast, not a fact.
        // It only becomes real if you adjust the time while confirming.
        //
        // For a meal you HAVE eaten, the old rule stands: an untouched picker
        // says "when I opened the app", not "when I ate".
        eaten_at_estimated: isPlanned ? true : !timeTouched,

        image_url: draft.image_url ?? null,
        image_path: draft.image_path ?? null,
        custom_food_id: draft.custom_food_id ?? null,
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
      `Remove "${draft.name}" from ${MEAL_LABELS[mealType]}?`,
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
  const canSubmit = canSubmitProduct(draft, g, isEditing);
  const dayLabel = formatDayLabel(dateKey(eatenAt));

  // Phase 3: the escape hatch for the Phase 2 no-usable-nutrition gate.
  // Opens CreateFoodScreen as a sheet over this screen (CreateFood is
  // already `presentation: "modal"` in AppNavigator, same as this screen —
  // no new modal infra needed) prefilled with whatever identity we have.
  // Macros are deliberately left for the user to type — CreateFoodScreen's
  // grid starts empty (EMPTY_MACROS), never prefilled with OFF's
  // untrustworthy zeros. `returnToOpener: true` is what tells
  // CreateFoodScreen's handleSave to hand the result back via the store
  // and goBack() instead of replacing this screen — see that flag's
  // comment on the CreateFood route param.
  const handleEnterManually = () => {
    navigation.navigate("CreateFood", {
      date: dateKey(eatenAt),
      mealType,
      eatenAt: eatenAt.toISOString(),
      barcode: draft.barcode,
      initialName: draft.name || undefined,
      initialBrand: draft.brand || undefined,
      returnToOpener: true,
    });
  };

  const previewRows: {
    label: string;
    value: string;
    unit: string;
    color: string;
    missing: boolean;
  }[] = [
    {
      label: "Calories",
      value: String(preview.calories),
      unit: "kcal",
      color: Colors.green,
      missing: bigFourMissing,
    },
    {
      label: "Protein",
      value: String(preview.protein),
      unit: "g",
      color: MacroColor.protein,
      missing: bigFourMissing,
    },
    {
      label: "Carbs",
      value: String(preview.carbs),
      unit: "g",
      color: MacroColor.carbs,
      missing: bigFourMissing,
    },
    {
      label: "Fat",
      value: String(preview.fat),
      unit: "g",
      color: MacroColor.fat,
      missing: bigFourMissing,
    },
    {
      label: "Sat fat",
      value: String(preview.satFat),
      unit: "g",
      color: MacroColor.satFat,
      // Orthogonal NULL-display fix: gated on this field's OWN nullness,
      // independent of the big-four detector above.
      missing: draft.sat_fat_per100 == null,
    },
    {
      label: "Salt",
      value: String(preview.salt),
      unit: "g",
      color: MacroColor.salt,
      missing: draft.salt_per100 == null,
    },
    {
      label: "Fibre",
      value: String(preview.fibre),
      unit: "g",
      color: MacroColor.fibre,
      missing: draft.fibre_per100 == null,
    },
    {
      label: "Sugar",
      value: String(preview.sugar),
      unit: "g",
      color: MacroColor.sugar,
      missing: draft.sugar_per100 == null,
    },
  ];

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <ScrollView
        ref={scrollRef}
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
            {isEditing ? (
              <View style={styles.mealPill}>
                <Text style={styles.mealPillText}>{mealLabel}</Text>
              </View>
            ) : (
              <View style={styles.mealTypeRow}>
                {MEAL_TYPES.map((mt) => (
                  <Pressable
                    key={mt}
                    onPress={() => setMealType(mt)}
                    style={({ pressed }) => [
                      styles.mealTypeChip,
                      mealType === mt && styles.mealTypeChipActive,
                      pressed && { opacity: 0.75 },
                    ]}
                  >
                    <Text
                      style={[
                        styles.mealTypeChipText,
                        mealType === mt && styles.mealTypeChipTextActive,
                      ]}
                    >
                      {MEAL_LABELS[mt]}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        </View>

        {/* ── AI estimate notice ──────────────────────── */}
        {/* Only present on a draft built from scan-meal-photo. Two very
            different states share this card:
              - First pass: "AI estimate" header, confidence badge, the
                model's alternatives as tappable chips, a "Something else…"
                escape hatch.
              - Corrected pass (userCorrected): the identity is now
                user-asserted and guaranteed correct — but the MACROS still
                came entirely from the model and still depend on it having
                honoured the correction. That's a MORE deceptive failure
                mode than an honest wrong guess (a confidently-wrong name
                makes the whole card read as trustworthy), so this state
                keeps a loud, high-contrast warning instead of the muted
                first-pass notes, and escalates further if the server
                flagged identityDivergence. */}
        {draft.aiEstimate ? (
          <View style={styles.aiCard}>
            <View style={styles.aiHeaderRow}>
              <Text style={styles.aiTitle}>
                {draft.aiEstimate.userCorrected
                  ? "✏️ From your correction"
                  : "🤖 AI estimate"}
              </Text>
              {!draft.aiEstimate.userCorrected && (
                <View
                  style={[
                    styles.confidencePill,
                    { backgroundColor: `${AI_CONFIDENCE_COLOR[draft.aiEstimate.confidence]}18` },
                  ]}
                >
                  <Text
                    style={[
                      styles.confidencePillText,
                      { color: AI_CONFIDENCE_COLOR[draft.aiEstimate.confidence] },
                    ]}
                  >
                    {AI_CONFIDENCE_LABEL[draft.aiEstimate.confidence]} confidence
                  </Text>
                </View>
              )}
            </View>

            {draft.aiEstimate.userCorrected ? (
              <View
                style={[
                  styles.correctedWarningBox,
                  draft.aiEstimate.identityDivergence &&
                    styles.correctedWarningBoxDanger,
                ]}
              >
                <Text
                  style={[
                    styles.correctedWarningText,
                    draft.aiEstimate.identityDivergence &&
                      styles.correctedWarningTextDanger,
                  ]}
                >
                  Macros still estimated — check before logging.
                  {draft.aiEstimate.identityDivergence
                    ? " The AI's own read of this photo didn't match your correction — these numbers may still reflect the old guess."
                    : ""}
                </Text>
              </View>
            ) : (
              draft.aiEstimate.notes.map((note, i) => (
                <Text key={i} style={styles.aiNote}>
                  {note}
                </Text>
              ))
            )}

            {!titleEditing && (
              <View style={styles.chipsRow}>
                {!draft.aiEstimate.userCorrected &&
                  draft.aiEstimate.alternatives.map((alt) => (
                    <Pressable
                      key={alt}
                      style={({ pressed }) => [
                        styles.chip,
                        pressed && { opacity: 0.7 },
                        reestimating && styles.chipDisabled,
                      ]}
                      onPress={() => runReestimate(alt)}
                      disabled={reestimating}
                    >
                      <Text style={styles.chipText} numberOfLines={1}>
                        {alt}
                      </Text>
                    </Pressable>
                  ))}
                <Pressable
                  style={({ pressed }) => [
                    styles.chip,
                    styles.chipGhost,
                    pressed && { opacity: 0.7 },
                    reestimating && styles.chipDisabled,
                  ]}
                  onPress={() => openCorrection()}
                  disabled={reestimating}
                >
                  <Text style={styles.chipGhostText}>Something else…</Text>
                </Pressable>
              </View>
            )}

            {titleEditing && (
              <View style={styles.titleEditRow}>
                <TextInput
                  style={styles.titleEditInput}
                  value={titleDraft}
                  onChangeText={setTitleDraft}
                  placeholder="What is this actually?"
                  placeholderTextColor={Colors.textMuted}
                  autoFocus
                  returnKeyType="done"
                  onSubmitEditing={() => runReestimate(titleDraft)}
                  editable={!reestimating}
                />
                <View style={styles.titleEditActions}>
                  <Pressable
                    style={({ pressed }) => [
                      styles.titleEditCancel,
                      pressed && { opacity: 0.7 },
                    ]}
                    onPress={() => setTitleEditing(false)}
                    disabled={reestimating}
                  >
                    <Text style={styles.titleEditCancelText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [
                      styles.titleEditSubmit,
                      pressed && { opacity: 0.88 },
                      (!titleDraft.trim() || reestimating) &&
                        styles.titleEditSubmitDisabled,
                    ]}
                    onPress={() => runReestimate(titleDraft)}
                    disabled={!titleDraft.trim() || reestimating}
                  >
                    {reestimating ? (
                      <ActivityIndicator size="small" color={Colors.bg} />
                    ) : (
                      <Text style={styles.titleEditSubmitText}>
                        Re-estimate macros
                      </Text>
                    )}
                  </Pressable>
                </View>
              </View>
            )}

            {reestimateError ? (
              <Text style={styles.aiErrorText}>{reestimateError}</Text>
            ) : null}
          </View>
        ) : null}

        {/* ── Product identity card ───────────────────── */}
        <View style={styles.productCard}>
          <View style={styles.identityRow}>
            <ProductThumb uri={draft.image_url} path={draft.image_path} />
            <View style={styles.identityText}>
              <Text style={styles.productName}>{draft.name}</Text>
              {draft.brand ? (
                <Text style={styles.productBrand}>{draft.brand}</Text>
              ) : null}
              {/* The correction MACHINERY lives in the AI card above, next
                  to the guess it corrects — but the user's eye lands here
                  first. Without this, the only door into that flow is a
                  chip that may be a full screen-height away. */}
              {draft.aiEstimate && !titleEditing ? (
                <Pressable
                  onPress={() => openCorrection()}
                  disabled={reestimating}
                  hitSlop={6}
                >
                  <Text style={styles.fixItLink}>Not the right dish? Fix it</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
          <SourceNotice source={draft.source} barcode={draft.barcode} />
          <View style={styles.cardDivider} />
          <Text style={styles.refLabel}>Per 100g</Text>
          <View style={styles.macroGrid}>
            {MACRO_META.map((m) => (
              <View
                key={m.key}
                style={[styles.macroCell, { backgroundColor: `${m.color}12` }]}
              >
                {draft.aiEstimate ? (
                  <View style={styles.macroCellValueRow}>
                    <TextInput
                      style={[styles.macroCellInput, { color: m.color }]}
                      value={macroText[m.key]}
                      onChangeText={(t) => updateMacro(m, t)}
                      keyboardType="decimal-pad"
                      selectTextOnFocus
                    />
                    <Text style={[styles.macroCellUnit, { color: m.color }]}>
                      {" "}
                      {m.unit}
                    </Text>
                  </View>
                ) : isMacroCellMissing(m, draft, bigFourMissing) ? (
                  <Text style={styles.macroCellValMissing}>—</Text>
                ) : (
                  <Text style={[styles.macroCellVal, { color: m.color }]}>
                    {m.get(draft)}
                    <Text style={styles.macroCellUnit}> {m.unit}</Text>
                  </Text>
                )}
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
                {draft.serving_label ?? `${servingPreset}g`}
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
          {bigFourMissing ? (
            <Text style={styles.calValueMissing}>No data</Text>
          ) : (
            <View style={styles.calRow}>
              <Text style={styles.calValue}>{preview.calories}</Text>
              <Text style={styles.calUnit}>kcal</Text>
            </View>
          )}
          <View style={styles.cardDivider} />
          <View style={styles.previewGrid}>
            {previewRows.slice(1).map((m) => (
              <View key={m.label} style={styles.previewCell}>
                {m.missing ? (
                  <Text style={styles.previewCellValMissing}>—</Text>
                ) : (
                  <Text style={[styles.previewCellVal, { color: m.color }]}>
                    {m.value}
                    <Text style={styles.previewCellUnit}>{m.unit}</Text>
                  </Text>
                )}
                <Text style={styles.previewCellLabel}>{m.label}</Text>
              </View>
            ))}
          </View>
          {bigFourMissing && (
            <>
              <Text style={styles.noDataCaption}>
                This product has no usable nutrition data from Open Food
                Facts, so it can't be logged yet.
              </Text>
              <Pressable
                onPress={handleEnterManually}
                hitSlop={8}
                style={({ pressed }) => [
                  styles.manualEntryLink,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={styles.manualEntryLinkText}>
                  Enter nutrition manually
                </Text>
              </Pressable>
            </>
          )}
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
          disabled={!canSubmit || saving || reestimating}
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
  mealTypeRow: {
    flexDirection: "row",
    gap: 4,
  },
  mealTypeChip: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  mealTypeChipActive: {
    backgroundColor: Colors.greenSoft,
    borderColor: `${Colors.green}35`,
  },
  mealTypeChipText: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.textMuted,
  },
  mealTypeChipTextActive: {
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
  aiNote: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    lineHeight: 16,
  },
  aiErrorText: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    color: Colors.danger,
    lineHeight: 18,
  },

  // Corrected-pass warning — deliberately LOUDER than the first-pass aiNote
  // styling above. The identity now looks certain (it's user-asserted), so
  // the one thing left to distrust — the macros — needs to stay visible,
  // not fade into muted disclaimer text.
  correctedWarningBox: {
    backgroundColor: `${Colors.warning}15`,
    borderWidth: 1,
    borderColor: `${Colors.warning}45`,
    borderRadius: Radius.control,
    padding: Spacing.sm,
  },
  correctedWarningBoxDanger: {
    backgroundColor: `${Colors.danger}15`,
    borderColor: `${Colors.danger}45`,
  },
  correctedWarningText: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    color: Colors.warning,
    lineHeight: 18,
  },
  correctedWarningTextDanger: {
    color: Colors.danger,
  },

  // Chips — alternatives + "Something else…"
  chipsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  chip: {
    maxWidth: 200,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 7,
  },
  chipDisabled: {
    opacity: 0.5,
  },
  chipText: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.text,
  },
  chipGhost: {
    backgroundColor: "transparent",
    borderStyle: "dashed",
    borderColor: Colors.borderSub,
  },
  chipGhostText: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.textSub,
  },

  // Free-text correction entry
  titleEditRow: {
    gap: Spacing.sm,
  },
  titleEditInput: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.control,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.text,
  },
  titleEditActions: {
    flexDirection: "row",
    gap: Spacing.sm,
  },
  titleEditCancel: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  titleEditCancelText: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    color: Colors.textSub,
  },
  titleEditSubmit: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.green,
    borderRadius: Radius.pill,
    paddingVertical: 10,
  },
  titleEditSubmitDisabled: {
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  titleEditSubmitText: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    color: Colors.bg,
  },

  fixItLink: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.green,
    marginTop: 2,
    marginBottom: Spacing.xs,
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
  // Phase 2: a genuinely-unknown value (either the whole product has no
  // usable nutrition, or this one field is individually NULL) — never "0".
  macroCellValMissing: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    fontFamily: Fonts.mono.bold,
    color: Colors.textDim,
  },
  macroCellValueRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "center",
  },
  macroCellInput: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    fontFamily: Fonts.mono.bold,
    letterSpacing: -0.2,
    minWidth: 34,
    padding: 0,
    textAlign: "right",
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
  calValueMissing: {
    fontSize: Typography.lg,
    fontWeight: Typography.semibold,
    color: Colors.textMuted,
    paddingVertical: Spacing.xs,
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
  previewCellValMissing: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    fontFamily: Fonts.mono.bold,
    color: Colors.textDim,
  },
  noDataCaption: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    marginTop: Spacing.sm,
    lineHeight: Typography.xs * 1.4,
  },
  manualEntryLink: {
    marginTop: Spacing.sm,
    alignSelf: "flex-start",
  },
  manualEntryLinkText: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    color: Colors.green,
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
