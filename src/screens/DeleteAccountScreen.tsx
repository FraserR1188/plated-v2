// ============================================================
// src/screens/DeleteAccountScreen.tsx — in-app account deletion
//
// A dedicated screen, not an Alert. The existing destructive-alert
// pattern (SettingsScreen's WHOOP disconnect / remove-ingredient) is a
// two-tap gesture built for reversible-in-spirit actions. This one is
// permanent and cross-system, so it gets its own screen: consequences
// spelled out in plain language, and a typed confirmation rather than a
// single tap.
//
// Confirmation is the user's OWN account email, read from the live
// session (never passed through navigation params — see the DeleteAccount
// route type). Nothing here can be pre-filled or spoofed by a param.
// ============================================================

import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Pressable,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { RootStackParamList } from "../types";
import { supabase } from "../lib/supabase";
import { deleteAccount } from "../lib/account";
import { useStore } from "../store/useStore";
import {
  Colors,
  Spacing,
  Radius,
  Typography,
  withDefaultFont,
} from "../theme/tokens";

type Nav = NativeStackNavigationProp<RootStackParamList>;

const CONSEQUENCES = [
  "Every logged meal, plan, and custom food you've created",
  "Photos attached to your custom foods",
  "Your WHOOP connection — access is revoked at WHOOP and all synced recovery, sleep, and strain data is removed",
  "Your profile, and everyone's follow relationships with it",
  "Your daily goals and saved ingredients",
];

export function DeleteAccountScreen() {
  const navigation = useNavigation<Nav>();
  const reset = useStore((s) => s.reset);

  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setAccountEmail(data.user?.email ?? null);
    });
  }, []);

  const matches =
    !!accountEmail &&
    input.trim().toLowerCase() === accountEmail.trim().toLowerCase();

  const handleDelete = async () => {
    if (!matches || deleting) return;

    setDeleting(true);
    setError(null);

    const { error: deleteErr } = await deleteAccount();

    if (deleteErr) {
      setError(deleteErr);
      setDeleting(false);
      return;
    }

    // Clear the in-memory store BEFORE the sign-out resolves — same
    // ordering as SettingsScreen's handleSignOut, so nothing from this
    // account is visible for even a frame once the screen swaps.
    reset();

    // 'local' scope, not the default: the account row is already gone, so
    // a server-side sign-out would fail against a session with nothing
    // behind it. Ignore the result either way — the store is already
    // clear and App.tsx's auth listener reacts to the local session
    // clearing regardless of whether the server call succeeded.
    await supabase.auth.signOut({ scope: "local" }).catch(() => {});
  };

  return (
    <SafeAreaView style={styles.safe} edges={["left", "right", "bottom"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.heading}>Delete account</Text>
        <Text style={styles.intro}>
          This permanently deletes your plated account. It cannot be undone.
        </Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>This removes</Text>
          {CONSEQUENCES.map((line) => (
            <View key={line} style={styles.bulletRow}>
              <Text style={styles.bulletDot}>·</Text>
              <Text style={styles.bulletText}>{line}</Text>
            </View>
          ))}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>This does not remove</Text>
          <View style={styles.bulletRow}>
            <Text style={styles.bulletDot}>·</Text>
            <Text style={styles.bulletText}>
              Entries a friend copied from your log into theirs — those
              became their own record at the moment they copied it, with no
              link back to your account.
            </Text>
          </View>
        </View>

        <View style={styles.confirmWrap}>
          <Text style={styles.confirmLabel}>
            Type your account email to confirm
          </Text>
          <Text style={styles.confirmEmail}>{accountEmail ?? "…"}</Text>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={(t) => {
              setInput(t);
              setError(null);
            }}
            placeholder="you@example.com"
            placeholderTextColor={Colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            editable={!deleting}
          />
        </View>

        {error && <Text style={styles.errorText}>{error}</Text>}

        <Pressable
          style={({ pressed }) => [
            styles.deleteBtn,
            !matches && styles.deleteBtnDisabled,
            pressed && matches && { opacity: 0.85 },
          ]}
          onPress={handleDelete}
          disabled={!matches || deleting}
        >
          {deleting ? (
            <ActivityIndicator color={Colors.bg} />
          ) : (
            <Text
              style={[
                styles.deleteBtnText,
                !matches && styles.deleteBtnTextDisabled,
              ]}
            >
              Permanently delete my account
            </Text>
          )}
        </Pressable>

        <Pressable
          style={styles.cancelBtn}
          onPress={() => navigation.goBack()}
          disabled={deleting}
        >
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </Pressable>

        <View style={{ height: Spacing.xxl }} />
      </ScrollView>
    </SafeAreaView>
  );
}

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
    heading: {
      fontSize: Typography.xl,
      fontWeight: Typography.bold,
      color: Colors.text,
      letterSpacing: -0.5,
      marginBottom: Spacing.xs,
    },
    intro: {
      fontSize: Typography.sm,
      color: Colors.textSub,
      lineHeight: 20,
      marginBottom: Spacing.lg,
    },
    card: {
      backgroundColor: Colors.surface,
      borderRadius: Radius.card,
      borderWidth: 1,
      borderColor: Colors.border,
      padding: Spacing.md,
      marginBottom: Spacing.md,
    },
    cardTitle: {
      fontSize: Typography.xs,
      fontWeight: Typography.semibold,
      color: Colors.textMuted,
      textTransform: "uppercase",
      letterSpacing: 0.7,
      marginBottom: Spacing.sm,
    },
    bulletRow: {
      flexDirection: "row",
      gap: Spacing.xs,
      marginBottom: 6,
    },
    bulletDot: {
      color: Colors.textMuted,
      fontSize: Typography.sm,
    },
    bulletText: {
      flex: 1,
      fontSize: Typography.sm,
      color: Colors.textSub,
      lineHeight: 20,
    },
    confirmWrap: {
      marginTop: Spacing.sm,
      marginBottom: Spacing.md,
      gap: 4,
    },
    confirmLabel: {
      fontSize: Typography.xs,
      fontWeight: Typography.semibold,
      color: Colors.textMuted,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    confirmEmail: {
      fontSize: Typography.sm,
      fontWeight: Typography.semibold,
      color: Colors.text,
      marginBottom: 4,
    },
    input: {
      backgroundColor: Colors.surface2,
      borderRadius: Radius.control,
      borderWidth: 1,
      borderColor: Colors.border,
      paddingHorizontal: Spacing.md,
      paddingVertical: 11,
      fontSize: Typography.base,
      color: Colors.text,
    },
    errorText: {
      fontSize: Typography.xs,
      color: Colors.danger,
      marginBottom: Spacing.sm,
      textAlign: "center",
      lineHeight: 17,
    },
    deleteBtn: {
      backgroundColor: Colors.danger,
      borderRadius: Radius.pill,
      paddingVertical: 14,
      alignItems: "center",
      marginTop: Spacing.sm,
    },
    deleteBtnDisabled: {
      backgroundColor: Colors.surface2,
      borderWidth: 1,
      borderColor: Colors.border,
    },
    deleteBtnText: {
      fontSize: Typography.base,
      fontWeight: Typography.bold,
      color: Colors.bg,
    },
    deleteBtnTextDisabled: {
      color: Colors.textDim,
    },
    cancelBtn: {
      alignItems: "center",
      paddingVertical: Spacing.md,
    },
    cancelBtnText: {
      fontSize: Typography.base,
      fontWeight: Typography.medium,
      color: Colors.textSub,
    },
  }),
);
