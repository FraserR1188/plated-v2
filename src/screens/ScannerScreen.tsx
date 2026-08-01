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
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { lookupFood } from "../lib/foodLookup";
import {
  Colors,
  Spacing,
  Radius,
  Typography,
  Overlay,
  Fonts,
  withDefaultFont,
} from "../theme/tokens";
import { RootStackParamList } from "../types";

type Nav = NativeStackNavigationProp<RootStackParamList, "Scanner">;
type Route = RouteProp<RootStackParamList, "Scanner">;

const VF_WIDTH = 260;
const VF_HEIGHT = 160;
const CORNER = 24;
const CORNER_W = 3;

// "not_found": both sources answered, product unknown → offer manual add.
// "network":   lookup failed → only retry is safe (product may exist in OFF).
type ErrorKind = "not_found" | "network" | null;

export function ScannerScreen() {
  const navigation = useNavigation<Nav>();
  const { date, mealType } = useRoute<Route>().params;
  const insets = useSafeAreaInsets();

  const [hasPermission, setPermission] = useState<boolean | null>(null);
  const [scanned, setScanned] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorKind, setErrorKind] = useState<ErrorKind>(null);
  const [failedBarcode, setFailedBarcode] = useState<string | null>(null);

  // Measured position of the vfWrap — drives the mask hole
  const [vfLayout, setVfLayout] = useState<{
    y: number;
    height: number;
  } | null>(null);

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
    setErrorKind(null);

    const result = await lookupFood(data);

    if (result.status === "found") {
      navigation.replace("Product", {
        product: result.product,
        date,
        mealType,
      });
      return;
    }

    setFailedBarcode(data);
    setErrorKind(result.status === "not_found" ? "not_found" : "network");
    setLoading(false);
  };

  const handleRetry = () => {
    setScanned(false);
    setErrorKind(null);
    setFailedBarcode(null);
  };

  const handleAddManually = () => {
    navigation.replace("CreateFood", {
      barcode: failedBarcode ?? undefined,
      date,
      mealType,
    });
  };

  // ── Permission loading ────────────────────────────────────────────────────
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

  // ── Permission denied ─────────────────────────────────────────────────────
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

  // ── Derived mask measurements ─────────────────────────────────────────────
  const maskTopHeight = vfLayout
    ? vfLayout.y + (vfLayout.height - VF_HEIGHT) / 2
    : null;

  const scanLineTranslateY = scanLine.interpolate({
    inputRange: [0, 1],
    outputRange: [0, VF_HEIGHT - 2],
  });

  const errorMessage =
    errorKind === "not_found"
      ? `This product isn't in the database yet.\nAdd it once and it'll scan instantly next time.`
      : "Lookup failed — check your connection and try again.";

  return (
    <View style={styles.root}>
      {/* ── Full-screen camera feed ─────────────────────────────────────── */}
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

      {/* ── Vignette overlay ────────────────────────────────────────────── */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {maskTopHeight === null ? (
          <View style={styles.maskFull} />
        ) : (
          <>
            <View style={[styles.maskTop, { height: maskTopHeight }]} />
            <View style={styles.maskMiddleRow}>
              <View style={styles.maskSide} />
              <View style={styles.vfHole} />
              <View style={styles.maskSide} />
            </View>
            <View style={styles.maskBottom} />
          </>
        )}
      </View>

      {/* ── UI layer ─────────────────────────────────────────────────────── */}
      <View style={styles.ui}>
        {/* Top bar */}
        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
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
          <View style={{ width: 40 }} />
        </View>

        {/* Viewfinder */}
        <View
          style={styles.vfWrap}
          onLayout={(e) => {
            const { y, height } = e.nativeEvent.layout;
            setVfLayout({ y, height });
          }}
        >
          <View style={[styles.vf, { width: VF_WIDTH, height: VF_HEIGHT }]}>
            <Corner position="tl" />
            <Corner position="tr" />
            <Corner position="bl" />
            <Corner position="br" />

            {!scanned && !loading && (
              <Animated.View
                style={[
                  styles.scanLine,
                  { transform: [{ translateY: scanLineTranslateY }] },
                ]}
              />
            )}

            {scanned && !errorKind && <View style={styles.scannedFlash} />}
          </View>
        </View>

        {/* Bottom status */}
        <View style={styles.bottom}>
          {loading ? (
            <View style={styles.statusCard}>
              <ActivityIndicator color={Colors.green} size="small" />
              <Text style={styles.statusText}>Looking up product…</Text>
            </View>
          ) : errorKind ? (
            <View style={styles.errorCard}>
              <Text style={styles.errorEmoji}>
                {errorKind === "not_found" ? "🍽️" : "⚠️"}
              </Text>
              {errorKind === "not_found" && failedBarcode ? (
                <Text style={styles.barcodeText}>{failedBarcode}</Text>
              ) : null}
              <Text style={styles.errorText}>{errorMessage}</Text>

              {errorKind === "not_found" ? (
                <>
                  {/* Primary: the productive path */}
                  <Pressable
                    style={({ pressed }) => [
                      styles.primaryBtn,
                      pressed && { opacity: 0.85 },
                    ]}
                    onPress={handleAddManually}
                  >
                    <Text style={styles.primaryText}>Add it manually</Text>
                  </Pressable>
                  <View style={styles.errorActions}>
                    <Pressable
                      style={({ pressed }) => [
                        styles.secondaryBtn,
                        pressed && { opacity: 0.75 },
                      ]}
                      onPress={handleRetry}
                    >
                      <Text style={styles.secondaryText}>Scan again</Text>
                    </Pressable>
                    <Pressable
                      style={({ pressed }) => [
                        styles.secondaryBtn,
                        pressed && { opacity: 0.75 },
                      ]}
                      onPress={() => navigation.goBack()}
                    >
                      <Text style={styles.secondaryText}>Search by name</Text>
                    </Pressable>
                  </View>
                </>
              ) : (
                <View style={styles.errorActions}>
                  <Pressable
                    style={({ pressed }) => [
                      styles.primaryBtn,
                      styles.retryOnlyBtn,
                      pressed && { opacity: 0.85 },
                    ]}
                    onPress={handleRetry}
                  >
                    <Text style={styles.primaryText}>Try again</Text>
                  </Pressable>
                </View>
              )}
            </View>
          ) : (
            <View style={styles.hintCard}>
              <Text style={styles.hintText}>
                Point your camera at the barcode on your food's packaging
              </Text>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

// ─── Corner bracket ───────────────────────────────────────────────────────────

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

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create(
  withDefaultFont({
  root: { flex: 1, backgroundColor: Overlay.black },

  // ── Permission screens ───────────────────────────────────────────────────
  permSafe: { flex: 1, backgroundColor: Colors.bg },
  centred: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: Spacing.xl,
    gap: Spacing.md,
  },
  permEmoji: { fontSize: 48, marginBottom: Spacing.xs },
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
    borderRadius: Radius.pill,
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

  // ── Vignette mask ────────────────────────────────────────────────────────
  maskFull: { flex: 1, backgroundColor: "rgba(0,0,0,0.65)" },
  maskTop: { backgroundColor: "rgba(0,0,0,0.65)" },
  maskMiddleRow: { flexDirection: "row", height: VF_HEIGHT },
  maskSide: { flex: 1, backgroundColor: "rgba(0,0,0,0.65)" },
  vfHole: { width: VF_WIDTH },
  maskBottom: { flex: 1, backgroundColor: "rgba(0,0,0,0.65)" },

  // ── UI layer ─────────────────────────────────────────────────────────────
  ui: { ...StyleSheet.absoluteFillObject, flexDirection: "column" },

  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.md,
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
    color: Overlay.white,
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
  },
  topTitle: {
    color: Overlay.white,
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    letterSpacing: 0.1,
  },

  vfWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
  vf: { position: "relative" },
  corner: {
    position: "absolute",
    width: CORNER,
    height: CORNER,
    borderColor: Colors.green,
  },

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
  scannedFlash: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: `${Colors.green}30`,
    borderRadius: 2,
  },

  // Bottom status area
  bottom: {
    minHeight: 140,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.xl,
    alignItems: "center",
    justifyContent: "flex-start",
  },
  hintCard: {
    backgroundColor: "rgba(0,0,0,0.6)",
    borderRadius: Radius.card,
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
  statusCard: {
    flexDirection: "row",
    gap: Spacing.sm,
    backgroundColor: "rgba(0,0,0,0.75)",
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: `${Colors.green}30`,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    alignItems: "center",
  },
  statusText: {
    color: Overlay.white,
    fontSize: Typography.base,
    fontWeight: Typography.medium,
  },
  errorCard: {
    backgroundColor: "rgba(0,0,0,0.88)",
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    padding: Spacing.lg,
    alignItems: "center",
    gap: Spacing.sm,
    width: "100%",
  },
  errorEmoji: { fontSize: 28 },
  barcodeText: {
    color: "rgba(255,255,255,0.45)",
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    fontFamily: Fonts.mono.semibold,
    letterSpacing: 1.5,
    fontVariant: ["tabular-nums"],
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

  primaryBtn: {
    backgroundColor: Colors.green,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.xl,
    paddingVertical: 12,
    alignSelf: "stretch",
    alignItems: "center",
    marginTop: Spacing.xs,
  },
  retryOnlyBtn: { alignSelf: "auto", paddingHorizontal: Spacing.xl },
  primaryText: {
    color: Colors.bg,
    fontWeight: Typography.bold,
    fontSize: Typography.sm,
  },
  secondaryBtn: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.1)",
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    paddingVertical: 10,
    alignItems: "center",
  },
  secondaryText: {
    color: "rgba(255,255,255,0.75)",
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
  },
  }),
);
