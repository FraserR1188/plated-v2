// ============================================================
// src/screens/RecipeScanScreen.tsx
// ============================================================
// Entry point for the recipe scanner: paste text, or take/choose a photo.
// Either input goes to the same scan-recipe Edge Function and lands on the
// same RecipeConfirmScreen — see scanRecipe.ts and RecipeConfirmScreen for
// why the two paths converge immediately after this screen.
//
// A captured/picked photo shows a PREVIEW before it's submitted (unlike
// mealPhotoCapture's flow, which has no such step) — recipe photos are
// exactly the case where "wrong page" or "too blurry to read" is worth
// catching before spending an AI call on it, and unlike a meal there's no
// urgency pushing straight to the camera each time.
//
// No result is handed back through navigation params here — this screen
// only ever navigates FORWARD with plain parsed data (see types/index.ts's
// RecipeConfirm param comment for why that's not the onPick/onScanned
// anti-pattern). Nothing touches the batch draft until RecipeConfirmScreen's
// "Add to batch".
// ============================================================

import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  Image,
  Pressable,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { scanRecipeText, scanRecipeImage, RecipeScanSuccess } from "../lib/scanRecipe";
import { captureRecipePhoto, pickRecipeImage } from "../lib/recipeImageCapture";
import type { PreparedImage } from "../lib/imagePrep";
import { Colors, Spacing, Radius, Typography, withDefaultFont } from "../theme/tokens";
import { RootStackParamList } from "../types";

type Nav = NativeStackNavigationProp<RootStackParamList, "RecipeScan">;
type Tab = "text" | "photo";

export function RecipeScanScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  const [tab, setTab] = useState<Tab>("text");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<PreparedImage | null>(null);
  const [busy, setBusy] = useState(false);

  const goToConfirm = (result: RecipeScanSuccess) => {
    navigation.navigate("RecipeConfirm", {
      ingredients: result.ingredients,
      servings: result.servings,
      yieldText: result.yieldText,
    });
  };

  const handleScanText = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const result = await scanRecipeText(trimmed);
      if (!result.ok) {
        Alert.alert("Couldn't scan that recipe", result.message);
        return;
      }
      goToConfirm(result);
    } finally {
      setBusy(false);
    }
  };

  const handleCapture = async (source: "camera" | "library") => {
    setBusy(true);
    try {
      const result =
        source === "camera" ? await captureRecipePhoto() : await pickRecipeImage();
      switch (result.status) {
        case "cancelled":
          return;
        case "permission_denied":
          Alert.alert(
            source === "camera" ? "Camera access needed" : "Photos access needed",
            source === "camera"
              ? "Enable camera access in Settings to photograph a recipe."
              : "Enable photo access in Settings to choose a screenshot.",
          );
          return;
        case "prep_failed":
          Alert.alert("Couldn't process that photo", "Try again.");
          return;
        case "ok":
          setPreview(result.image);
          return;
      }
    } finally {
      setBusy(false);
    }
  };

  const handleScanPhoto = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await scanRecipeImage(preview.base64, "image/jpeg");
      if (!result.ok) {
        Alert.alert("Couldn't scan that recipe", result.message);
        return;
      }
      goToConfirm(result);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <Pressable
            onPress={() => navigation.goBack()}
            style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
            hitSlop={12}
          >
            <Text style={styles.backArrow}>‹</Text>
          </Pressable>
          <Text style={styles.headerTitle}>Scan Recipe</Text>
          <View style={{ width: 36 }} />
        </View>

        <View style={styles.tabBar}>
          {(["text", "photo"] as Tab[]).map((t) => (
            <Pressable
              key={t}
              style={[styles.tabBtn, tab === t && styles.tabBtnActive]}
              onPress={() => setTab(t)}
            >
              <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
                {t === "text" ? "Paste text" : "Photo"}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.body}>
          {tab === "text" ? (
            <>
              <TextInput
                style={styles.textArea}
                value={text}
                onChangeText={setText}
                placeholder="Paste the recipe's ingredient list here…"
                placeholderTextColor={Colors.textMuted}
                multiline
                textAlignVertical="top"
              />
              <Pressable
                style={({ pressed }) => [
                  styles.primaryBtn,
                  (!text.trim() || busy) && styles.primaryBtnDisabled,
                  pressed && { opacity: 0.88 },
                ]}
                onPress={handleScanText}
                disabled={!text.trim() || busy}
              >
                {busy ? (
                  <ActivityIndicator size="small" color={Colors.bg} />
                ) : (
                  <Text style={styles.primaryBtnText}>Scan</Text>
                )}
              </Pressable>
            </>
          ) : preview ? (
            <>
              <Image source={{ uri: preview.uri }} style={styles.previewImage} resizeMode="contain" />
              <View style={styles.previewActions}>
                <Pressable
                  style={({ pressed }) => [styles.secondaryBtn, pressed && { opacity: 0.75 }]}
                  onPress={() => setPreview(null)}
                  disabled={busy}
                >
                  <Text style={styles.secondaryBtnText}>Retake</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [
                    styles.primaryBtn,
                    { flex: 1 },
                    busy && styles.primaryBtnDisabled,
                    pressed && { opacity: 0.88 },
                  ]}
                  onPress={handleScanPhoto}
                  disabled={busy}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color={Colors.bg} />
                  ) : (
                    <Text style={styles.primaryBtnText}>Scan this photo</Text>
                  )}
                </Pressable>
              </View>
            </>
          ) : (
            <View style={styles.photoChoices}>
              <Pressable
                style={({ pressed }) => [styles.photoChoiceBtn, pressed && { opacity: 0.75 }]}
                onPress={() => handleCapture("camera")}
                disabled={busy}
              >
                <Text style={styles.photoChoiceIcon}>📷</Text>
                <Text style={styles.photoChoiceText}>Take photo</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.photoChoiceBtn, pressed && { opacity: 0.75 }]}
                onPress={() => handleCapture("library")}
                disabled={busy}
              >
                <Text style={styles.photoChoiceIcon}>🖼️</Text>
                <Text style={styles.photoChoiceText}>Choose from library</Text>
              </Pressable>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
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
    tabBtn: { flex: 1, paddingVertical: 8, borderRadius: Radius.pill, alignItems: "center" },
    tabBtnActive: { backgroundColor: Colors.green },
    tabText: { fontSize: Typography.sm, fontWeight: Typography.medium, color: Colors.textSub },
    tabTextActive: { color: Colors.bg, fontWeight: Typography.bold },

    body: { flex: 1, paddingHorizontal: Spacing.md, gap: Spacing.md },

    textArea: {
      flex: 1,
      backgroundColor: Colors.surface,
      borderRadius: Radius.card,
      borderWidth: 1,
      borderColor: Colors.border,
      padding: Spacing.md,
      fontSize: Typography.sm,
      color: Colors.text,
    },

    primaryBtn: {
      backgroundColor: Colors.green,
      borderRadius: Radius.pill,
      paddingVertical: 13,
      alignItems: "center",
      justifyContent: "center",
    },
    primaryBtnDisabled: { opacity: 0.5 },
    primaryBtnText: { fontSize: Typography.base, fontWeight: Typography.bold, color: Colors.bg },

    secondaryBtn: {
      borderRadius: Radius.pill,
      borderWidth: 1,
      borderColor: Colors.border,
      backgroundColor: Colors.surface,
      paddingVertical: 13,
      paddingHorizontal: Spacing.lg,
      alignItems: "center",
      justifyContent: "center",
    },
    secondaryBtnText: { fontSize: Typography.base, fontWeight: Typography.semibold, color: Colors.textSub },

    photoChoices: { flex: 1, justifyContent: "center", gap: Spacing.md },
    photoChoiceBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      backgroundColor: Colors.surface,
      borderRadius: Radius.card,
      borderWidth: 1,
      borderColor: Colors.border,
      paddingVertical: Spacing.lg,
    },
    photoChoiceIcon: { fontSize: 22 },
    photoChoiceText: { fontSize: Typography.base, fontWeight: Typography.semibold, color: Colors.text },

    previewImage: {
      flex: 1,
      borderRadius: Radius.card,
      backgroundColor: Colors.surface,
      borderWidth: 1,
      borderColor: Colors.border,
    },
    previewActions: { flexDirection: "row", gap: Spacing.sm },
  }),
);
