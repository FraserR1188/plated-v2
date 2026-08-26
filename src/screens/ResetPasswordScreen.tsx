// ============================================================
// src/screens/ResetPasswordScreen.tsx — set a new password after following
// a plated://reset-password recovery link.
//
// Rendered ahead of the `session` check in App.tsx (see the recovery
// effect there) — a truthy session is not enough to reach AppNavigator
// while `status` is non-"none", because setSession() fires the ordinary
// SIGNED_IN event here (auth-js only emits PASSWORD_RECOVERY from its own
// URL-detection code path, which detectSessionInUrl: false disables), and
// App.tsx's session effect can't tell a recovery session from a normal one
// on its own.
//
// By the time status === "ready", supabase.auth already has that live
// session, so updateUser() below only needs the new password.
// ============================================================

import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { updatePassword } from "../lib/supabase";
import { reportError } from "../lib/reportError";
import {
  Colors,
  Spacing,
  Radius,
  Typography,
  withDefaultFont,
} from "../theme/tokens";

export type RecoveryStatus = "verifying" | "ready" | "expired" | "invalid";

export function ResetPasswordScreen({
  status,
  onDone,
  onBackToSignIn,
}: {
  status: RecoveryStatus;
  /** Called once updateUser() succeeds — the live session is real, route into the app. */
  onDone: () => void;
  /**
   * The ONE place this flow signs out and clears local state, whatever
   * triggered it: the dead-end screen's own button below, or a session
   * that died mid-form after setSession() had already succeeded (see the
   * catch block in handleSubmit). Never bypass it with a plain state reset
   * — that's exactly how a live session with the OLD password survives
   * under a screen that told the user the link was dead.
   */
  onBackToSignIn: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await updatePassword(password);
      onDone();
    } catch (e: any) {
      const sessionDied =
        e?.name === "AuthSessionMissingError" || e?.status === 401;
      if (sessionDied) {
        // The recovery session (from setSession() in App.tsx) died between
        // landing here and submitting — already used elsewhere, or expired
        // mid-form. Route through the same sign-out-and-reset path as the
        // expired/invalid screen below, not just a local form error.
        Alert.alert(
          "Link expired",
          "This reset link is no longer valid. Request a new one from the sign-in screen.",
        );
        onBackToSignIn();
        return;
      }
      reportError("passwordRecoveryUpdateUser", e, {
        fingerprint: ["password-recovery-update-user"],
      });
      setError(e?.message ?? "Couldn't update your password. Try again.");
      setLoading(false);
    }
  };

  let body: React.ReactNode;
  if (status === "verifying") {
    body = (
      <View style={styles.centerBlock}>
        <ActivityIndicator color={Colors.green} />
        <Text style={styles.body}>Verifying your reset link…</Text>
      </View>
    );
  } else if (status === "expired" || status === "invalid") {
    body = (
      <View style={styles.centerBlock}>
        <Text style={styles.title}>
          {status === "expired" ? "Link expired" : "Link not valid"}
        </Text>
        <Text style={styles.body}>
          {status === "expired"
            ? "This reset link has expired. Request a new one from the sign-in screen."
            : "This reset link isn't valid, or has already been used."}
        </Text>
        <TouchableOpacity style={styles.submitBtn} onPress={onBackToSignIn}>
          <Text style={styles.submitText}>Back to sign in</Text>
        </TouchableOpacity>
      </View>
    );
  } else {
    body = (
      <>
        <Text style={styles.title}>Set a new password</Text>
        <Text style={styles.body}>
          Choose a new password for your account.
        </Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={(t) => {
            setPassword(t);
            setError(null);
          }}
          placeholder="New password"
          placeholderTextColor={Colors.textDim}
          secureTextEntry
          editable={!loading}
        />
        <TextInput
          style={styles.input}
          value={confirm}
          onChangeText={(t) => {
            setConfirm(t);
            setError(null);
          }}
          placeholder="Confirm new password"
          placeholderTextColor={Colors.textDim}
          secureTextEntry
          editable={!loading}
        />
        {error && <Text style={styles.errorText}>{error}</Text>}
        <TouchableOpacity
          style={styles.submitBtn}
          onPress={handleSubmit}
          disabled={loading || !password || !confirm}
        >
          {loading ? (
            <ActivityIndicator color={Colors.bg} />
          ) : (
            <Text style={styles.submitText}>Set new password</Text>
          )}
        </TouchableOpacity>
      </>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior="padding" style={styles.safe}>
        <ScrollView
          contentContainerStyle={styles.wrap}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.name}>plated.</Text>
          <View style={styles.card}>{body}</View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create(
  withDefaultFont({
    safe: { flex: 1, backgroundColor: Colors.bg },
    wrap: { flexGrow: 1, padding: Spacing.lg, justifyContent: "center" },
    name: {
      fontSize: Typography.hero - 8,
      fontWeight: Typography.bold,
      color: Colors.green,
      letterSpacing: -1.5,
      marginBottom: Spacing.xl,
    },
    card: {
      backgroundColor: Colors.surface,
      borderRadius: Radius.card,
      padding: Spacing.lg,
    },
    centerBlock: { alignItems: "center", gap: Spacing.sm },
    title: {
      fontSize: Typography.lg,
      fontWeight: Typography.bold,
      color: Colors.text,
      marginBottom: Spacing.xs,
      textAlign: "center",
    },
    body: {
      fontSize: Typography.sm,
      color: Colors.textSub,
      lineHeight: 20,
      marginBottom: Spacing.md,
      textAlign: "center",
    },
    input: {
      backgroundColor: Colors.surface2,
      borderRadius: Radius.control,
      padding: Spacing.md,
      fontSize: Typography.base,
      color: Colors.text,
      marginBottom: Spacing.sm,
    },
    errorText: {
      fontSize: Typography.xs,
      color: Colors.danger,
      marginBottom: Spacing.sm,
      lineHeight: 17,
    },
    submitBtn: {
      backgroundColor: Colors.green,
      borderRadius: Radius.pill,
      paddingVertical: 14,
      alignItems: "center",
      marginTop: Spacing.sm,
    },
    submitText: {
      fontSize: Typography.base,
      fontWeight: Typography.bold,
      color: Colors.bg,
    },
  }),
);
