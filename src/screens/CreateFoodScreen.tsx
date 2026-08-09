// ============================================================
// src/screens/CreateFoodScreen.tsx — add a food OFF doesn't know
// Session A: saturated fat as the 8th macro input.
// Session B (Half 2): front-of-pack photo capture.
// Session B (UX): keyboard-aware scrolling.
// Session C: nutrition-label photo -> AI extraction -> prefilled grid.
//
// KEYBOARD HANDLING — why it's hand-rolled:
// KeyboardAvoidingView does nothing on Android (behavior is undefined
// there). Android uses adjustResize, which SHRINKS the window but does
// not SCROLL anything — so the field you just tapped can sit behind the
// keyboard. Fix: remember each card's y offset via onLayout, and on
// focus scroll that card to the top of the visible area. Dynamic bottom
// padding (= keyboard height) gives the ScrollView room to actually get
// there; without it the lower cards have nowhere to scroll to.
//
// SESSION C — THREE THINGS TO KNOW:
//
// 1. PICKER OPTIONS ARE NOW PER-KIND. Session B used one module-level
//    IMAGE_OPTIONS with allowsEditing + a 1:1 aspect. That's right for a
//    product thumbnail and WRONG for a nutrition label: UK nutrition
//    tables are tall and narrow, and a square crop reliably eats the
//    bottom rows — which is where salt and fibre live. Labels are
//    captured uncropped.
//
//    And `aspect` is ANDROID-ONLY. On iOS, allowsEditing: true forces a
//    square crop regardless. So "just use a 3:4 aspect for labels" would
//    have worked on the Pixel and silently mangled every label on iOS.
//
// 2. EVERY PHOTO GOES THROUGH prepareImage(). It resizes to 1568px on the
//    long edge and re-encodes as JPEG. That's what makes the hardcoded
//    "image/jpeg" contentType in customFoodImages.ts actually TRUE, and
//    it's what keeps us under Anthropic's 5MB ceiling.
//
// 3. EXTRACTION IS DECOUPLED FROM UPLOAD. The Edge Function is stateless:
//    base64 in, macros out. It never touches the database. So we can
//    extract at capture time, long before the custom_foods row exists.
//    The photos still upload on save, through Session B's path, unchanged.
// ============================================================

import React, { useMemo, useState, useRef, useEffect } from "react";
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
  Image,
  Alert,
  ActionSheetIOS,
  Keyboard,
} from "react-native";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import {
  createCustomFood,
  customFoodToProduct,
  setCustomFoodImages,
} from "../lib/foodLookup";
import { uploadCustomFoodImage, type PhotoKind } from "../lib/customFoodImages";
import { prepareImage } from "../lib/imagePrep";
import {
  extractNutritionLabel,
  macroSetToFields,
  type ExtractSuccess,
  type MacroKey,
} from "../lib/labelExtraction";
import {
  LabelConfirmSheet,
  type LabelConfirmApply,
} from "../components/LabelConfirmSheet";
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

type Nav = NativeStackNavigationProp<RootStackParamList, "CreateFood">;
type Route = RouteProp<RootStackParamList, "CreateFood">;

// ─── Photo state ─────────────────────────────────────────────

// A captured-but-not-yet-uploaded photo. Upload happens on save, once
// the custom_foods row exists and we have a real id for the path.
type PendingPhoto = {
  uri: string; // local file URI, for the preview
  base64: string; // JPEG bytes — uploaded, and sent for extraction
};

type PhotoState = Partial<Record<PhotoKind, PendingPhoto>>;

/**
 * Picker options, per kind. NOT a shared constant — see note 1 at the top.
 *
 * front: square crop is ideal for a thumbnail, and the user framing it
 *        themselves beats any centre-crop we could do.
 * label: NO crop UI at all. The model wants the whole table, and every
 *        pixel the user crops away is lossy preprocessing done by hand.
 *        (This also sidesteps the iOS forced-square-crop trap entirely.)
 *
 * `quality` here is the picker's own encode; prepareImage() re-encodes
 * afterwards anyway, so this is just about not shipping a needlessly
 * enormous intermediate through the bridge.
 */
function pickerOptionsFor(kind: PhotoKind): ImagePicker.ImagePickerOptions {
  if (kind === "label") {
    return {
      mediaTypes: ["images"],
      allowsEditing: false,
      quality: 1, // prepareImage does the compressing; don't double-encode
      base64: false, // we re-encode anyway — don't pay to marshal bytes twice
      exif: false,
    };
  }
  return {
    mediaTypes: ["images"],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1,
    base64: false,
    exif: false,
  };
}

const PHOTO_SHEET_TITLE: Record<PhotoKind, string> = {
  front: "Front of pack",
  label: "Nutrition label",
};

// ─── Macro input definitions ─────────────────────────────────

// MacroKey is imported from labelExtraction rather than redeclared here.
// The Edge Function's response is keyed by these exact strings, so a
// single definition means the two can't silently drift apart.

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
  { key: "satFat", label: "Sat fat", unit: "g", color: MacroColor.satFat },
  { key: "salt", label: "Salt", unit: "g", color: MacroColor.salt },
  { key: "fibre", label: "Fibre", unit: "g", color: MacroColor.fibre },
  { key: "sugar", label: "Sugar", unit: "g", color: MacroColor.sugar },
];

const EMPTY_MACROS: Record<MacroKey, string> = {
  cal: "",
  protein: "",
  carbs: "",
  fat: "",
  satFat: "",
  salt: "",
  fibre: "",
  sugar: "",
};

const num = (s: string): number => {
  const v = parseFloat(s.replace(",", "."));
  return Number.isFinite(v) && v >= 0 ? v : 0;
};

// Which cards we scroll-to-focus. Keyed so the y offsets survive re-renders.
type CardKey = "identity" | "nutrition" | "serving";

export function CreateFoodScreen() {
  const navigation = useNavigation<Nav>();
  const { date, mealType, eatenAt, barcode, initialName } =
    useRoute<Route>().params;
  const insets = useSafeAreaInsets();

  const [name, setName] = useState(initialName ?? "");
  const [brand, setBrand] = useState("");
  const [code, setCode] = useState(barcode ?? "");
  const [macros, setMacros] = useState<Record<MacroKey, string>>(EMPTY_MACROS);
  const [servingG, setServingG] = useState("");
  const [servingLabel, setServingLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [photos, setPhotos] = useState<PhotoState>({});

  // ── Label extraction state ────────────────────────────────

  const [sheetVisible, setSheetVisible] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractResult, setExtractResult] = useState<ExtractSuccess | null>(
    null,
  );
  const [extractError, setExtractError] = useState<string | null>(null);

  // Guards a late response from a photo the user has already replaced or
  // discarded — otherwise a slow call can repopulate a sheet they closed,
  // or overwrite values from a newer scan.
  const extractionSeq = useRef(0);

  // ── Keyboard-aware scrolling ──────────────────────────────

  const scrollRef = useRef<ScrollView>(null);
  const cardY = useRef<Partial<Record<CardKey, number>>>({});
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    // Android only fires the "did" events; iOS gives us the "will" ones,
    // which animate in step with the keyboard.
    const showEvent =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const showSub = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Remember where each card starts, so we can scroll it into view later.
  const onCardLayout = (key: CardKey) => (e: any) => {
    cardY.current[key] = e.nativeEvent.layout.y;
  };

  // Bring a card to the top of the visible area when one of its inputs is
  // focused. The keyboard then covers only empty space beneath it.
  const scrollToCard = (key: CardKey) => {
    const y = cardY.current[key];
    if (y == null) return;
    // Small delay: on Android the resize lands a frame or two after focus,
    // so scrolling immediately would compute against the old viewport.
    setTimeout(() => {
      scrollRef.current?.scrollTo({ y: Math.max(y - 12, 0), animated: true });
    }, 80);
  };

  const keyboardOpen = keyboardHeight > 0;

  // ── Handlers ──────────────────────────────────────────────

  const setMacro = (key: MacroKey, value: string) => {
    setMacros((m) => ({ ...m, [key]: value }));
    // Clear a stale save error the moment the user starts fixing things.
    if (error) setError("");
  };

  const setPhoto = (kind: PhotoKind, photo: PendingPhoto | undefined) =>
    setPhotos((p) => ({ ...p, [kind]: photo }));

  // Name + a REAL calorie figure are the minimum for a useful entry.
  //
  // Session B checked only `macros.cal.trim().length > 0`, but num("abc")
  // returns 0 — so typing junk in the calorie box enabled Save and
  // persisted a 0 kcal food. That gets likelier now the grid arrives
  // pre-filled and users are editing populated cells rather than empty ones.
  const canSave = useMemo(
    () => name.trim().length > 0 && num(macros.cal) > 0 && !saving,
    [name, macros.cal, saving],
  );

  const mealLabel = MEAL_LABELS[mealType];

  // ── Photo capture ─────────────────────────────────────────

  const handlePickFromCamera = async (kind: PhotoKind) => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        "Camera access needed",
        "Enable camera access in Settings to photograph your food.",
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync(pickerOptionsFor(kind));
    await applyPickerResult(kind, result);
  };

  const handlePickFromLibrary = async (kind: PhotoKind) => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        "Photos access needed",
        "Enable photo access in Settings to choose an existing photo.",
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync(
      pickerOptionsFor(kind),
    );
    await applyPickerResult(kind, result);
  };

  const applyPickerResult = async (
    kind: PhotoKind,
    result: ImagePicker.ImagePickerResult,
  ) => {
    if (result.canceled) return;
    const asset = result.assets?.[0];
    if (!asset?.uri || !asset.width || !asset.height) {
      setError("Couldn't read that image — try another.");
      return;
    }
    setError("");

    // Resize + re-encode as JPEG. This is what makes the "image/jpeg"
    // contentType we upload with, and the media_type we send Anthropic,
    // actually true — the picker hands back PNG from the library and
    // HEIC on iOS, and Anthropic rejects HEIC outright.
    const prepared = await prepareImage(
      { uri: asset.uri, width: asset.width, height: asset.height },
      kind,
    );
    if (!prepared) {
      setError("Couldn't process that image — try another.");
      return;
    }

    setPhoto(kind, prepared);

    // A label photo has exactly one purpose. Don't make them tap again.
    if (kind === "label") {
      void runExtraction(prepared.base64);
    }
  };

  // Camera / gallery / remove chooser.
  const handlePhotoPress = (kind: PhotoKind) => {
    Keyboard.dismiss(); // don't fight the picker for screen space
    const hasPhoto = !!photos[kind];

    const options = hasPhoto
      ? ["Take photo", "Choose from library", "Remove photo", "Cancel"]
      : ["Take photo", "Choose from library", "Cancel"];
    const cancelIndex = options.length - 1;
    const destructiveIndex = hasPhoto ? 2 : undefined;

    const handleChoice = (index: number) => {
      if (index === 0) void handlePickFromCamera(kind);
      else if (index === 1) void handlePickFromLibrary(kind);
      else if (hasPhoto && index === 2) setPhoto(kind, undefined);
    };

    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex: cancelIndex,
          destructiveButtonIndex: destructiveIndex,
          userInterfaceStyle: "dark",
        },
        handleChoice,
      );
      return;
    }

    Alert.alert(PHOTO_SHEET_TITLE[kind], undefined, [
      { text: "Take photo", onPress: () => void handlePickFromCamera(kind) },
      {
        text: "Choose from library",
        onPress: () => void handlePickFromLibrary(kind),
      },
      ...(hasPhoto
        ? [
            {
              text: "Remove photo",
              style: "destructive" as const,
              onPress: () => setPhoto(kind, undefined),
            },
          ]
        : []),
      { text: "Cancel", style: "cancel" as const },
    ]);
  };

  // ── Label extraction ──────────────────────────────────────

  const runExtraction = async (base64: string) => {
    const seq = ++extractionSeq.current;

    setSheetVisible(true);
    setExtracting(true);
    setExtractResult(null);
    setExtractError(null);

    const res = await extractNutritionLabel(base64);

    // A newer scan started, or the user closed the sheet. Drop this one.
    if (seq !== extractionSeq.current) return;

    setExtracting(false);
    if (res.ok) {
      setExtractResult(res);
    } else {
      setExtractError(res.message);
    }
  };

  const handleRescan = () => {
    const label = photos.label;
    if (label) void runExtraction(label.base64);
  };

  const dismissSheet = () => {
    // Invalidate any call still in flight so it can't reopen this.
    extractionSeq.current++;
    setSheetVisible(false);
    setExtracting(false);
    setExtractResult(null);
    setExtractError(null);
  };

  // Retake: close the sheet, go straight back to the camera.
  const handleRetakeLabel = () => {
    dismissSheet();
    void handlePickFromCamera("label");
  };

  const handleApplyExtraction = (payload: LabelConfirmApply) => {
    setMacros(macroSetToFields(payload.per100g));

    if (payload.servingG != null && payload.servingG > 0) {
      setServingG(String(payload.servingG));
    }
    if (payload.servingLabel) {
      setServingLabel(payload.servingLabel);
    }
    // Only fill the name if the user hasn't already typed one — never
    // overwrite something a human deliberately entered.
    if (payload.productName && !name.trim()) {
      setName(payload.productName);
    }

    setSheetVisible(false);
    setExtractResult(null);
    setExtractError(null);
    setError("");
  };

  // ── Save ──────────────────────────────────────────────────

  const handleSave = async () => {
    if (!canSave) return;
    Keyboard.dismiss();
    setSaving(true);
    setError("");

    const sg = num(servingG);

    // 1) Insert the row first — we need its id to build the storage paths.
    const { food, error: err } = await createCustomFood({
      name: name.trim(),
      brand: brand.trim() ? brand.trim() : null,
      barcode: code.trim() ? code.trim() : null,
      cal_per100: Math.round(num(macros.cal)),
      protein_per100: num(macros.protein),
      carbs_per100: num(macros.carbs),
      fat_per100: num(macros.fat),
      sat_fat_per100: num(macros.satFat),
      salt_per100: num(macros.salt),
      fibre_per100: num(macros.fibre),
      sugar_per100: num(macros.sugar),
      serving_g: sg > 0 ? sg : null,
      serving_label: servingLabel.trim() ? servingLabel.trim() : null,
    });

    if (!food) {
      setSaving(false);
      setError(err ?? "Couldn't save — please try again.");
      return;
    }

    // 2) Upload whichever photos we have, then write both paths back in a
    //    SINGLE update.
    //    Deliberately NON-FATAL: the food is already saved, so a failed
    //    upload must not block the user from logging their meal.
    let saved = food;

    const uploads = await Promise.all(
      (["front", "label"] as PhotoKind[]).map(async (kind) => {
        const photo = photos[kind];
        if (!photo) return { kind, path: null as string | null };
        const { path } = await uploadCustomFoodImage(
          food.id,
          photo.base64,
          kind,
        );
        return { kind, path };
      }),
    );

    const frontPath = uploads.find((u) => u.kind === "front")?.path ?? null;
    const labelPath = uploads.find((u) => u.kind === "label")?.path ?? null;

    if (frontPath || labelPath) {
      const { food: updated } = await setCustomFoodImages(food.id, {
        front: frontPath,
        label: labelPath,
      });
      if (updated) saved = updated;
    }

    setSaving(false);

    navigation.replace("Product", {
      product: customFoodToProduct(saved),
      date,
      mealType,
      initialEatenAt: eatenAt,
    });
  };

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          ref={scrollRef}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[
            styles.scroll,
            // Room to actually scroll the lower cards clear of the keyboard.
            // Without this the ScrollView simply runs out of content.
            { paddingBottom: keyboardOpen ? keyboardHeight + 24 : 100 },
          ]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
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
          <View style={styles.card} onLayout={onCardLayout("identity")}>
            <Text style={styles.cardSectionLabel}>Product</Text>

            <View style={styles.photoRow}>
              <PhotoSlot
                photo={photos.front}
                onPress={() => handlePhotoPress("front")}
                disabled={saving}
              />
              <View style={styles.photoHintBox}>
                <Text style={styles.photoHintTitle}>Front of pack</Text>
                <Text style={styles.photoHintText}>
                  Optional. Tap to take a photo or choose one from your library.
                </Text>
              </View>
            </View>

            <Text style={styles.fieldLabel}>Name *</Text>
            <TextInput
              style={styles.textField}
              value={name}
              onChangeText={setName}
              onFocus={() => scrollToCard("identity")}
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
              onFocus={() => scrollToCard("identity")}
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
              onFocus={() => scrollToCard("identity")}
              placeholder="Optional"
              placeholderTextColor={Colors.textMuted}
              keyboardType="number-pad"
              returnKeyType="done"
            />
          </View>

          {/* ── Nutrition card ──────────────────────────── */}
          <View style={styles.card} onLayout={onCardLayout("nutrition")}>
            <Text style={styles.cardSectionLabel}>Nutrition per 100g</Text>

            {/* Scan-the-label affordance. Sits ABOVE the grid because it's
                the fast path — typing 8 numbers is the fallback, not the
                default. */}
            <View style={styles.scanRow}>
              <PhotoSlot
                photo={photos.label}
                onPress={() => handlePhotoPress("label")}
                disabled={saving || extracting}
                emptyIcon="🔬"
                emptyLabel="Scan label"
              />
              <View style={styles.photoHintBox}>
                <Text style={styles.photoHintTitle}>Scan the label</Text>
                <Text style={styles.photoHintText}>
                  Photograph the nutrition table and I'll fill these in. Get the
                  whole table in frame.
                </Text>
                {photos.label && !extracting && (
                  <Pressable
                    onPress={handleRescan}
                    style={({ pressed }) => [
                      styles.rescanBtn,
                      pressed && { opacity: 0.7 },
                    ]}
                    hitSlop={8}
                  >
                    <Text style={styles.rescanBtnText}>Read it again</Text>
                  </Pressable>
                )}
              </View>
            </View>

            <Text style={styles.nutritionHint}>
              Or copy them from the packaging by hand. Sat fat is the "of which
              saturates" line.
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
                      onFocus={() => scrollToCard("nutrition")}
                      placeholder="0"
                      placeholderTextColor={`${m.color}55`}
                      keyboardType="decimal-pad"
                      returnKeyType="done"
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
          <View style={styles.card} onLayout={onCardLayout("serving")}>
            <Text style={styles.cardSectionLabel}>
              Typical serving (optional)
            </Text>
            <View style={styles.servingRow}>
              <TextInput
                style={[styles.textField, styles.servingInput]}
                value={servingG}
                onChangeText={setServingG}
                onFocus={() => scrollToCard("serving")}
                placeholder="45"
                placeholderTextColor={Colors.textMuted}
                keyboardType="decimal-pad"
                returnKeyType="done"
                maxLength={6}
              />
              <Text style={styles.servingUnit}>g</Text>
              <TextInput
                style={[styles.textField, styles.servingLabelInput]}
                value={servingLabel}
                onChangeText={setServingLabel}
                onFocus={() => scrollToCard("serving")}
                placeholder='e.g. "1 bowl"'
                placeholderTextColor={Colors.textMuted}
                returnKeyType="done"
              />
            </View>
          </View>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          {/* When the keyboard is up the sticky FAB is hidden, so surface a
              save affordance inline — otherwise there's no way to submit
              without dismissing the keyboard first. */}
          {keyboardOpen && (
            <Pressable
              style={({ pressed }) => [
                styles.inlineSaveBtn,
                !canSave && styles.saveBtnDisabled,
                pressed && canSave && { opacity: 0.88 },
              ]}
              onPress={handleSave}
              disabled={!canSave}
            >
              <Text
                style={[
                  styles.saveBtnText,
                  !canSave && styles.saveBtnTextDisabled,
                ]}
              >
                Save & add to {mealLabel}
              </Text>
            </Pressable>
          )}
        </ScrollView>

        {/* ── Sticky save button ───────────────────────── */}
        {/* Hidden while typing: pinned to the bottom it would be squeezed
            against the keyboard, stealing space from the fields. */}
        {!keyboardOpen && (
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
        )}
      </KeyboardAvoidingView>

      {/* ── "Is this what you've plated?" ──────────────── */}
      <LabelConfirmSheet
        visible={sheetVisible}
        loading={extracting}
        error={extractError}
        result={extractResult}
        onApply={handleApplyExtraction}
        onDismiss={dismissSheet}
        onRetry={handleRetakeLabel}
      />
    </SafeAreaView>
  );
}

// ─── PhotoSlot ───────────────────────────────────────────────
// Reusable capture tile. Kind-agnostic: the empty state is customisable
// so the label slot can say "Scan label" rather than "Add photo".

function PhotoSlot({
  photo,
  onPress,
  disabled,
  emptyIcon = "📷",
  emptyLabel = "Add photo",
}: {
  photo?: PendingPhoto;
  onPress: () => void;
  disabled?: boolean;
  emptyIcon?: string;
  emptyLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.photoSlot,
        photo && styles.photoSlotFilled,
        pressed && { opacity: 0.75 },
        disabled && { opacity: 0.5 },
      ]}
    >
      {photo ? (
        <>
          <Image
            source={{ uri: photo.uri }}
            style={styles.photoImage}
            resizeMode="cover"
          />
          <View style={styles.photoEditBadge}>
            <Text style={styles.photoEditBadgeText}>Edit</Text>
          </View>
        </>
      ) : (
        <>
          <Text style={styles.photoSlotIcon}>{emptyIcon}</Text>
          <Text style={styles.photoSlotLabel}>{emptyLabel}</Text>
        </>
      )}
    </Pressable>
  );
}

// ─── Styles ──────────────────────────────────────────────────

const styles = StyleSheet.create(
  withDefaultFont({
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

  introText: {
    fontSize: Typography.sm,
    color: Colors.textSub,
    lineHeight: 20,
    marginBottom: Spacing.md,
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

  // ── Photo tiles ──
  photoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
    marginBottom: Spacing.sm,
  },
  scanRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
    marginBottom: Spacing.md,
    paddingBottom: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  photoSlot: {
    width: 88,
    height: 88,
    borderRadius: Radius.control,
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    gap: 4,
  },
  photoSlotFilled: {
    borderStyle: "solid",
    borderColor: `${Colors.green}45`,
  },
  photoSlotIcon: { fontSize: 24, opacity: 0.5 },
  photoSlotLabel: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
    textAlign: "center",
  },
  photoImage: { width: "100%", height: "100%" },
  photoEditBadge: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(0,0,0,0.6)",
    paddingVertical: 3,
    alignItems: "center",
  },
  photoEditBadgeText: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.text,
  },
  photoHintBox: { flex: 1, gap: 3 },
  photoHintTitle: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    color: Colors.text,
  },
  photoHintText: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    lineHeight: 17,
  },
  rescanBtn: {
    alignSelf: "flex-start",
    marginTop: 4,
    paddingVertical: 3,
  },
  rescanBtnText: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.green,
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
    borderRadius: Radius.control,
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
    fontFamily: Fonts.mono.medium,
    letterSpacing: 1.5,
    fontVariant: ["tabular-nums"],
  },

  nutritionHint: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    marginBottom: Spacing.sm,
  },
  macroGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  macroInputCell: {
    borderRadius: Radius.control,
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
    fontFamily: Fonts.mono.bold,
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
    fontFamily: Fonts.mono.medium,
  },
  servingUnit: {
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.textSub,
  },
  servingLabelInput: { flex: 1, marginBottom: 0 },

  errorText: {
    fontSize: Typography.sm,
    color: Colors.danger,
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
    borderRadius: Radius.pill,
    paddingVertical: 16,
    alignItems: "center",
  },
  // Same button, but flowing in the scroll content rather than pinned.
  inlineSaveBtn: {
    backgroundColor: Colors.green,
    borderRadius: Radius.pill,
    paddingVertical: 16,
    alignItems: "center",
    marginBottom: Spacing.md,
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
  }),
);
