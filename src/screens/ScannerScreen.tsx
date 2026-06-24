import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  Pressable,
  Animated,
} from "react-native";
import { Camera, CameraView } from "expo-camera";
import { useNavigation } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SafeAreaView } from "react-native-safe-area-context";
import { lookupBarcode } from "../lib/openfoodfacts";
import { Colors, Spacing, Radius, Typography } from "../theme";
import { RootStackParamList } from "../types";
import { todayKey } from "../store/useStore";

type Nav = NativeStackNavigationProp<RootStackParamList, "Scanner">;

const VF_WIDTH = 260;
const VF_HEIGHT = 160;
const CORNER = 24;
const CORNER_W = 3;

export function ScannerScreen() {
  const navigation = useNavigation<Nav>();
  const [hasPermission, setPermission] = useState<boolean | null>(null);
  const [scanned, setScanned] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Scanning line animation
  const scanLine = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Camera.requestCameraPermissionsAsync().then(({ status }) => {
      setPermission(status === "granted");
    });
  }, []);

  useEffect(() => {
    if (hasPermission && !scanned && !loading) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(scanLine, {
            toValue: 1,
            duration: 1800,
            useNativeDriver: true,
          }),
          Animated.timing(scanLine, {
            toValue: 0,
            duration: 1800,
            useNativeDriver: true,
          }),
        ]),
      );
      loop.start();
      return () => loop.stop();
    }
  }, [hasPermission, scanned, loading]);

  const handleBarcode = async ({ data }: { data: string }) => {
    if (scanned || loading) return;
    setScanned(true);
    setLoading(true);
    setError("");
    try {
      const product = await lookupBarcode(data);
      if (product) {
        navigation.replace("Product", {
          product,
          date: todayKey(),
          mealType: "breakfast",
        });
      } else {
        setError(
          `No product found for barcode ${data}.\nTry searching by name instead.`,
        );
        setLoading(false);
      }
    } catch {
      setError("Lookup failed — check your connection and try again.");
      setLoading(false);
    }
  };

  const handleRetry = () => {
    setScanned(false);
    setError("");
  };

  // ── Permission loading ──────────────────────────────────────────────────────
  if (hasPermission === null) {
    return (
      <SafeAreaView style={styles.permSafe}>
        <View style={styles.centred}>
          <ActivityIndicator size="large" color={Colors.green} />
          <Text style={styles.permMsg}>Requesting camera access…</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── Permission denied ───────────────────────────────────────────────────────
  if (!hasPermission) {
    return (
      <SafeAreaView style={styles.permSafe}>
        <View style={styles.centred}>
          <Text style={styles.permEmoji}>📷</Text>
          <Text style={styles.permTitle}>Camera access needed</Text>
          <Text style={styles.permMsg}>
            Go to Settings → Apps → plated → Permissions → Camera and allow
            access.
          </Text>
          <Pressable
            style={({ pressed }) => [
              styles.permBtn,
              pressed && { opacity: 0.8 },
            ]}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.permBtnText}>Go back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // ── Camera view ─────────────────────────────────────────────────────────────
  const scanLineTranslateY = scanLine.interpolate({
    inputRange: [0, 1],
    outputRange: [0, VF_HEIGHT - 2],
  });

  return (
    <View style={styles.root}>
      {/* Full-screen camera feed */}
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        onBarcodeScanned={scanned ? undefined : handleBarcode}
        barcodeScannerSettings={{
          barcodeTypes: [
            "ean13",
            "ean8",
            "upc_a",
            "upc_e",
            "code128",
            "code39",
            "qr",
          ],
        }}
      />

      {/* Dark vignette overlay — everything except the viewfinder */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {/* Top mask */}
        <View style={styles.maskTop} />
        <View style={styles.maskMiddleRow}>
          {/* Left mask */}
          <View style={styles.maskSide} />
          {/* Clear viewfinder hole */}
          <View style={styles.vfHole} />
          {/* Right mask */}
          <View style={styles.maskSide} />
        </View>
        {/* Bottom mask */}
        <View style={styles.maskBottom} />
      </View>

      {/* UI layer */}
      <SafeAreaView style={styles.ui}>
        {/* ── Top bar ──────────────────────────────────── */}
        <View style={styles.topBar}>
          <Pressable
            style={({ pressed }) => [
              styles.closeBtn,
              pressed && { opacity: 0.7 },
            ]}
            onPress={() => navigation.goBack()}
            hitSlop={8}
          >
            <Text style={styles.closeTxt}>✕</Text>
          </Pressable>
          <Text style={styles.topTitle}>Scan barcode</Text>
          {/* Spacer to balance close button */}
          <View style={{ width: 40 }} />
        </View>

        {/* ── Viewfinder ───────────────────────────────── */}
        <View style={styles.vfWrap}>
          <View style={[styles.vf, { width: VF_WIDTH, height: VF_HEIGHT }]}>
            {/* Corner brackets */}
            <Corner position="tl" />
            <Corner position="tr" />
            <Corner position="bl" />
            <Corner position="br" />

            {/* Animated scan line */}
            {!scanned && !loading && (
              <Animated.View
                style={[
                  styles.scanLine,
                  { transform: [{ translateY: scanLineTranslateY }] },
                ]}
              />
            )}

            {/* Scanned flash */}
            {scanned && !error && <View style={styles.scannedFlash} />}
          </View>
        </View>

        {/* ── Bottom status area ───────────────────────── */}
        <View style={styles.bottom}>
          {loading ? (
            <View style={styles.statusCard}>
              <ActivityIndicator color={Colors.green} size="small" />
              <Text style={styles.statusText}>Looking up product…</Text>
            </View>
          ) : error ? (
            <View style={styles.errorCard}>
              <Text style={styles.errorEmoji}>⚠️</Text>
              <Text style={styles.errorText}>{error}</Text>
              <View style={styles.errorActions}>
                <Pressable
                  style={({ pressed }) => [
                    styles.retryBtn,
                    pressed && { opacity: 0.85 },
                  ]}
                  onPress={handleRetry}
                >
                  <Text style={styles.retryText}>Scan again</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [
                    styles.searchBtn,
                    pressed && { opacity: 0.75 },
                  ]}
                  onPress={() => navigation.goBack()}
                >
                  <Text style={styles.searchText}>Search by name</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <View style={styles.hintCard}>
              <Text style={styles.hintText}>
                Point your camera at the barcode on your food's packaging
              </Text>
            </View>
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

// ─── Corner bracket component ────────────────────────────────────────────────

type CornerPos = "tl" | "tr" | "bl" | "br";

function Corner({ position }: { position: CornerPos }) {
  const isTop = position[0] === "t";
  const isLeft = position[1] === "l";

  return (
    <View
      style={[
        styles.corner,
        isTop ? { top: 0 } : { bottom: 0 },
        isLeft ? { left: 0 } : { right: 0 },
        {
          borderTopWidth: isTop ? CORNER_W : 0,
          borderBottomWidth: isTop ? 0 : CORNER_W,
          borderLeftWidth: isLeft ? CORNER_W : 0,
          borderRightWidth: isLeft ? 0 : CORNER_W,
          borderTopLeftRadius: isTop && isLeft ? 6 : 0,
          borderTopRightRadius: isTop && !isLeft ? 6 : 0,
          borderBottomLeftRadius: !isTop && isLeft ? 6 : 0,
          borderBottomRightRadius: !isTop && !isLeft ? 6 : 0,
        },
      ]}
    />
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

// Viewfinder vertical position from top of screen
const VF_TOP_OFFSET = 180;

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000",
  },

  // Permission screens
  permSafe: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  centred: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: Spacing.xl,
    gap: Spacing.md,
  },
  permEmoji: {
    fontSize: 48,
    marginBottom: Spacing.xs,
  },
  permTitle: {
    fontSize: Typography.md,
    fontWeight: Typography.bold,
    color: Colors.text,
    textAlign: "center",
  },
  permMsg: {
    fontSize: Typography.sm,
    color: Colors.textSub,
    textAlign: "center",
    lineHeight: 21,
    maxWidth: 280,
  },
  permBtn: {
    marginTop: Spacing.sm,
    backgroundColor: Colors.surface,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.sm,
  },
  permBtnText: {
    color: Colors.text,
    fontWeight: Typography.semibold,
    fontSize: Typography.base,
  },

  // Vignette masks — punch a hole for the viewfinder
  maskTop: {
    height: VF_TOP_OFFSET,
    backgroundColor: "rgba(0,0,0,0.65)",
  },
  maskMiddleRow: {
    flexDirection: "row",
    height: VF_HEIGHT,
  },
  maskSide: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.65)",
  },
  vfHole: {
    width: VF_WIDTH,
  },
  maskBottom: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.65)",
  },

  // UI overlay
  ui: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "space-between",
  },

  // Top bar
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.md,
  },
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  closeTxt: {
    color: "#fff",
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
  },
  topTitle: {
    color: "#fff",
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    letterSpacing: 0.1,
  },

  // Viewfinder
  vfWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  vf: {
    position: "relative",
  },
  corner: {
    position: "absolute",
    width: CORNER,
    height: CORNER,
    borderColor: Colors.green,
  },

  // Animated scan line
  scanLine: {
    position: "absolute",
    left: 8,
    right: 8,
    height: 2,
    borderRadius: 1,
    backgroundColor: Colors.green,
    opacity: 0.85,
    shadowColor: Colors.green,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 6,
    elevation: 4,
  },

  // Scanned flash
  scannedFlash: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: `${Colors.green}30`,
    borderRadius: 2,
  },

  // Bottom area
  bottom: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.xl,
    alignItems: "center",
    minHeight: 140,
    justifyContent: "flex-start",
    paddingTop: Spacing.lg,
  },

  // Hint card
  hintCard: {
    backgroundColor: "rgba(0,0,0,0.6)",
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    maxWidth: 300,
  },
  hintText: {
    color: "rgba(255,255,255,0.65)",
    fontSize: Typography.sm,
    textAlign: "center",
    lineHeight: 21,
    fontWeight: Typography.medium,
  },

  // Status card (loading)
  statusCard: {
    flexDirection: "row",
    gap: Spacing.sm,
    backgroundColor: "rgba(0,0,0,0.75)",
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: `${Colors.green}30`,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    alignItems: "center",
  },
  statusText: {
    color: "#fff",
    fontSize: Typography.base,
    fontWeight: Typography.medium,
  },

  // Error card
  errorCard: {
    backgroundColor: "rgba(0,0,0,0.88)",
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    padding: Spacing.lg,
    alignItems: "center",
    gap: Spacing.sm,
    width: "100%",
  },
  errorEmoji: {
    fontSize: 28,
  },
  errorText: {
    color: "rgba(255,255,255,0.75)",
    fontSize: Typography.sm,
    textAlign: "center",
    lineHeight: 20,
    fontWeight: Typography.medium,
  },
  errorActions: {
    flexDirection: "row",
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  retryBtn: {
    backgroundColor: Colors.green,
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 10,
  },
  retryText: {
    color: Colors.bg,
    fontWeight: Typography.bold,
    fontSize: Typography.sm,
  },
  searchBtn: {
    backgroundColor: "rgba(255,255,255,0.1)",
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    paddingHorizontal: Spacing.lg,
    paddingVertical: 10,
  },
  searchText: {
    color: "rgba(255,255,255,0.75)",
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
  },
});
