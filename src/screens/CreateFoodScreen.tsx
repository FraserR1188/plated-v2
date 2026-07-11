// ============================================================
// src/screens/CreateFoodScreen.tsx — add a food OFF doesn't know
// Session A: saturated fat as the 8th macro input.
// Session B (Half 2): front-of-pack photo capture.
//
// SESSION C READINESS: photo state is keyed by PhotoKind and rendered
// via the reusable <PhotoSlot> component. Adding the nutrition-label
// photo later = render a second <PhotoSlot kind="label" /> and handle
// its base64 — no restructuring of this screen.
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
  Image,
  Alert,
  ActionSheetIOS,
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
  setCustomFoodImage,
} from "../lib/foodLookup";
import { uploadCustomFoodImage, type PhotoKind } from "../lib/customFoodImages";
import { Colors, Spacing, Radius, Typography, MacroColor } from "../theme";
import { RootStackParamList, MEAL_LABELS } from "../types";

type Nav = NativeStackNavigationProp<RootStackParamList, "CreateFood">;
type Route = RouteProp<RootStackParamList, "CreateFood">;

// ─── Photo state ─────────────────────────────────────────────

// A captured-but-not-yet-uploaded photo. Upload happens on save, once
// the custom_foods row exists and we have a real id for the path.
type PendingPhoto = {
  uri: string; // local file URI, for the preview
  base64: string; // what we actually upload
};

// Keyed by kind so Session C's "label" photo slots in alongside "front".
type PhotoState = Partial<Record<PhotoKind, PendingPhoto>>;

// Quality/size: 0.7 JPEG at max 1200px is plenty for a product thumbnail
// and keeps us comfortably under the bucket's 10MB ceiling.
const IMAGE_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ["images"],
  allowsEditing: true,
  aspect: [1, 1],
  quality: 0.7,
  base64: true,
};

// ─── Macro input definitions ─────────────────────────────────

type MacroKey =
  | "cal"
  | "protein"
  | "carbs"
  | "fat"
  | "satFat"
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
  { key: "satFat", label: "Sat fat", unit: "g", color: MacroColor.satFat },
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
    satFat: "",
    salt: "",
    fibre: "",
    sugar: "",
  });
  const [servingG, setServingG] = useState("");
  const [servingLabel, setServingLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Session C: this same object will also hold photos.label
  const [photos, setPhotos] = useState<PhotoState>({});

  const setMacro = (key: MacroKey, value: string) =>
    setMacros((m) => ({ ...m, [key]: value }));

  const setPhoto = (kind: PhotoKind, photo: PendingPhoto | undefined) =>
    setPhotos((p) => ({ ...p, [kind]: photo }));

  // Name + calories are the minimum for a useful entry.
  const canSave = useMemo(
    () => name.trim().length > 0 && macros.cal.trim().length > 0 && !saving,
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
    const result = await ImagePicker.launchCameraAsync(IMAGE_OPTIONS);
    applyPickerResult(kind, result);
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
    const result = await ImagePicker.launchImageLibraryAsync(IMAGE_OPTIONS);
    applyPickerResult(kind, result);
  };

  const applyPickerResult = (
    kind: PhotoKind,
    result: ImagePicker.ImagePickerResult,
  ) => {
    if (result.canceled) return;
    const asset = result.assets?.[0];
    if (!asset?.base64 || !asset.uri) {
      setError("Couldn't read that image — try another.");
      return;
    }
    setError("");
    setPhoto(kind, { uri: asset.uri, base64: asset.base64 });
  };

  // Camera / gallery / remove chooser.
  const handlePhotoPress = (kind: PhotoKind) => {
    const hasPhoto = !!photos[kind];

    const options = hasPhoto
      ? ["Take photo", "Choose from library", "Remove photo", "Cancel"]
      : ["Take photo", "Choose from library", "Cancel"];
    const cancelIndex = options.length - 1;
    const destructiveIndex = hasPhoto ? 2 : undefined;

    const handleChoice = (index: number) => {
      if (index === 0) handlePickFromCamera(kind);
      else if (index === 1) handlePickFromLibrary(kind);
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

    // Android: Alert with up to three buttons.
    Alert.alert("Product photo", undefined, [
      { text: "Take photo", onPress: () => handlePickFromCamera(kind) },
      {
        text: "Choose from library",
        onPress: () => handlePickFromLibrary(kind),
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

  // ── Save ──────────────────────────────────────────────────

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError("");

    const sg = num(servingG);

    // 1) Insert the row first — we need its id to build the storage path.
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

    // 2) Upload the photo, then write its path back to the row.
    //    Deliberately NON-FATAL: the food is already saved, so a failed
    //    upload shouldn't block the user from logging their meal. They
    //    keep the food; they just don't get the picture.
    let saved = food;
    const front = photos.front;

    if (front) {
      const { path } = await uploadCustomFoodImage(
        food.id,
        front.base64,
        "front",
      );
      if (path) {
        const { food: updated } = await setCustomFoodImage(food.id, path);
        if (updated) saved = updated;
      }
    }

    setSaving(false);

    // Straight into the normal logging flow with the new food.
    navigation.replace("Product", {
      product: customFoodToProduct(saved),
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

            {/* Photo tile + name/brand side by side.
                Session C: render a second <PhotoSlot kind="label" /> in
                this row (or below it) — the state and handlers already
                take a `kind`, so nothing else changes. */}
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
              Copy these from the nutrition table on the packaging. Sat fat is
              the "of which saturates" line.
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

// ─── PhotoSlot ───────────────────────────────────────────────
// Reusable capture tile. Kind-agnostic by design: Session C's
// nutrition-label photo uses this same component with a different
// `kind` passed to the handler.

function PhotoSlot({
  photo,
  onPress,
  disabled,
}: {
  photo?: PendingPhoto;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.photoSlot,
        photo && styles.photoSlotFilled,
        pressed && { opacity: 0.75 },
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
          <Text style={styles.photoSlotIcon}>📷</Text>
          <Text style={styles.photoSlotLabel}>Add photo</Text>
        </>
      )}
    </Pressable>
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

  // ── Photo tile ──
  photoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
    marginBottom: Spacing.sm,
  },
  photoSlot: {
    width: 88,
    height: 88,
    borderRadius: Radius.md,
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
  photoSlotIcon: {
    fontSize: 24,
    opacity: 0.5,
  },
  photoSlotLabel: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
  },
  photoImage: {
    width: "100%",
    height: "100%",
  },
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
  photoHintBox: {
    flex: 1,
    gap: 3,
  },
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
