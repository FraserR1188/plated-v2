// ============================================================
// src/screens/AboutScreen.tsx — About & legal
//
// Fully static: app name/version, the running build (PL-043), data-source
// attribution (rendered generically from src/content/attributions.ts — never
// hardcode a source here), and legal/support links. No fetch, no Supabase
// call, no store subscription — this screen must render correctly with no
// network.
//
// ============================================================

import React from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Alert,
  Clipboard,
  Platform,
} from "react-native";
import * as Updates from "expo-updates";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  Colors,
  Spacing,
  Radius,
  Typography,
  Fonts,
  withDefaultFont,
} from "../theme/tokens";
import { DATA_SOURCES, type Licence } from "../content/attributions";
import { openURL } from "../lib/links";
import { formatBuildInfo, type BuildInfo } from "../lib/buildInfo";
import appJson from "../../app.json";

const APP_VERSION = appJson.expo.version;
const PRIVACY_URL = "https://platedapp.uk/plated-privacy.html";
const ATTRIBUTIONS_URL = "https://platedapp.uk/attributions.html";
const SUPPORT_EMAIL = "robbie@fraseranalytics.com";

// PL-043. Read once: these are fixed for the life of a launch. Wrapped so a
// dev client, or anything unexpected from the native module, degrades to
// "unknown" rather than taking the screen down.
function readBuildInfo(): BuildInfo {
  try {
    return formatBuildInfo({
      runtimeVersion: Updates.runtimeVersion,
      channel: Updates.channel,
      updateId: Updates.updateId,
      isEmbeddedLaunch: Updates.isEmbeddedLaunch,
    });
  } catch {
    return formatBuildInfo({
      runtimeVersion: null,
      channel: null,
      updateId: null,
      isEmbeddedLaunch: true,
    });
  }
}

// Clipboard is React Native core's DEPRECATED module — the only clipboard
// native to the current binary (Android ClipboardModule, iOS RCTClipboard).
// expo-clipboard would move the fingerprint; swap to it with the next native
// build. Copies build values only: nothing user-identifying.
function copyBuildInfo(info: BuildInfo) {
  Clipboard.setString(`plated ${APP_VERSION} (${Platform.OS}) · ${info.copyText}`);
  Alert.alert("Copied", "Paste it into your report.");
}

export function AboutScreen() {
  const buildInfo = React.useMemo(readBuildInfo, []);
  return (
    <SafeAreaView style={styles.safe} edges={["left", "right", "bottom"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* ── App identity ───────────────────────────── */}
        <View style={styles.appHeader}>
          <Text style={styles.appName}>plated</Text>
          <Text style={styles.appVersion}>Version {APP_VERSION}</Text>
          <Pressable
            onPress={() => copyBuildInfo(buildInfo)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Copy build details"
            style={({ pressed }) => [styles.buildInfo, pressed && { opacity: 0.6 }]}
          >
            {buildInfo.lines.map((line) => (
              <Text key={line} style={styles.buildLine}>
                {line}
              </Text>
            ))}
            <Text style={styles.buildHint}>Tap to copy for a report</Text>
          </Pressable>
        </View>

        {/* ── Data sources ────────────────────────────── */}
        <SectionLabel title="Data sources" />
        {DATA_SOURCES.map((source) => (
          <View key={source.id} style={styles.card}>
            <Text style={styles.sourceName}>{source.name}</Text>
            <Text style={styles.sourceUsedFor}>{source.usedFor}</Text>
            <Text style={styles.sourceStatement}>{source.statement}</Text>

            <LinkRow label={source.name} onPress={() => openURL(source.sourceUrl)} />
            {source.licences.map((licence: Licence) => (
              <LinkRow
                key={licence.name}
                label={
                  licence.appliesTo
                    ? `${licence.name} — ${licence.appliesTo}`
                    : licence.name
                }
                onPress={() => openURL(licence.url)}
              />
            ))}
          </View>
        ))}

        {/* ── Legal ────────────────────────────────────── */}
        <SectionLabel title="Legal" />
        <View style={styles.card}>
          <LinkRow label="Privacy policy" onPress={() => openURL(PRIVACY_URL)} />
          <LinkRow label="Data sources and attribution" onPress={() => openURL(ATTRIBUTIONS_URL)} />
        </View>

        {/* ── Support ──────────────────────────────────── */}
        <SectionLabel title="Support" />
        <View style={styles.card}>
          <LinkRow
            label={SUPPORT_EMAIL}
            onPress={() => openURL(`mailto:${SUPPORT_EMAIL}`)}
          />
        </View>

        <View style={{ height: Spacing.xxl }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Sub-components ────────────────────────────────────────────

function SectionLabel({ title }: { title: string }) {
  return (
    <View style={sectionStyles.row}>
      <Text style={sectionStyles.label}>{title}</Text>
    </View>
  );
}

function LinkRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.linkRow,
        pressed && { backgroundColor: Colors.surface2 },
      ]}
      onPress={onPress}
    >
      <Text style={styles.linkRowText} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.linkChevron}>›</Text>
    </Pressable>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const sectionStyles = StyleSheet.create(
  withDefaultFont({
    row: {
      flexDirection: "row",
      alignItems: "center",
      marginTop: Spacing.sm,
      marginBottom: Spacing.sm,
    },
    label: {
      fontSize: Typography.xs,
      fontWeight: Typography.semibold,
      color: Colors.textMuted,
      textTransform: "uppercase",
      letterSpacing: 0.7,
    },
  }),
);

const styles = StyleSheet.create(
  withDefaultFont({
    safe: {
      flex: 1,
      backgroundColor: Colors.bg,
    },
    scroll: {
      paddingHorizontal: Spacing.md,
      paddingTop: Spacing.md,
    },
    appHeader: {
      alignItems: "center",
      paddingVertical: Spacing.lg,
    },
    appName: {
      fontSize: Typography.xl,
      fontWeight: Typography.bold,
      color: Colors.text,
      letterSpacing: -0.5,
    },
    appVersion: {
      fontSize: Typography.sm,
      color: Colors.textMuted,
      marginTop: 4,
    },
    buildInfo: {
      alignItems: "center",
      marginTop: Spacing.sm,
    },
    buildLine: {
      fontSize: Typography.xs,
      color: Colors.textMuted,
      fontFamily: Fonts.mono.regular,
    },
    buildHint: {
      fontSize: Typography.xs,
      color: Colors.textDim,
      marginTop: 4,
    },
    card: {
      backgroundColor: Colors.surface,
      borderRadius: Radius.card,
      borderWidth: 1,
      borderColor: Colors.border,
      padding: Spacing.md,
      marginBottom: Spacing.md,
    },
    sourceName: {
      fontSize: Typography.base,
      fontWeight: Typography.semibold,
      color: Colors.text,
    },
    sourceUsedFor: {
      fontSize: Typography.xs,
      color: Colors.textMuted,
      marginTop: 2,
      marginBottom: Spacing.sm,
    },
    sourceStatement: {
      fontSize: Typography.sm,
      color: Colors.textSub,
      lineHeight: 20,
      marginBottom: Spacing.sm,
    },
    linkRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: 11,
      borderRadius: Radius.control,
      marginHorizontal: -4,
      paddingHorizontal: 4,
    },
    linkRowText: {
      flex: 1,
      fontSize: Typography.sm,
      fontWeight: Typography.medium,
      color: Colors.green,
    },
    linkChevron: {
      fontSize: 18,
      color: Colors.textDim,
      marginLeft: Spacing.sm,
    },
  }),
);
