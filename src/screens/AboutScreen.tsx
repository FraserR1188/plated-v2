// ============================================================
// src/screens/AboutScreen.tsx — About & legal
//
// Fully static: app name/version, data-source attribution (rendered
// generically from src/content/attributions.ts — never hardcode a source
// here), and legal/support links. No fetch, no Supabase call, no store
// subscription — this screen must render correctly with no network.
//
// The attributions page (platedapp.uk/attributions.html) does not exist yet
// (ships commit 3) — deliberately not linked below. A dead link in front of
// a Play Store reviewer is worse than no link.
// ============================================================

import React from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, Alert } from "react-native";
import * as Linking from "expo-linking";
import { SafeAreaView } from "react-native-safe-area-context";
import { Colors, Spacing, Radius, Typography, withDefaultFont } from "../theme/tokens";
import { DATA_SOURCES, type Licence } from "../content/attributions";
import appJson from "../../app.json";

const APP_VERSION = appJson.expo.version;
const PRIVACY_URL = "https://platedapp.uk/plated-privacy.html";
// const ATTRIBUTIONS_URL = "https://platedapp.uk/attributions.html"; // commit 3
const SUPPORT_EMAIL = "robbie@fraseranalytics.com";

async function openURL(url: string) {
  try {
    await Linking.openURL(url);
  } catch {
    Alert.alert("Couldn't open link", "Check your connection and try again.");
  }
}

export function AboutScreen() {
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
          {/* Attributions page ships in commit 3 — do not link until it exists. */}
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
