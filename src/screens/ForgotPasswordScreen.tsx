// ============================================================
// src/screens/ForgotPasswordScreen.tsx — request a password reset email.
//
// Rendered as a sibling of AuthScreen directly from App.tsx's own state
// (preAuthView), NOT through AppNavigator's Stack — that Stack only mounts
// once there's a session, and this screen exists precisely because there
// isn't one yet.
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
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { requestPasswordReset } from "../lib/supabase";
import {
  Colors,
  Spacing,
  Radius,
  Typography,
  withDefaultFont,
} from "../theme/tokens";

export function ForgotPasswordScreen({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!email.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      await requestPasswordReset(email.trim());
    } catch (e: any) {
      // requestPasswordReset never reveals whether the address has an
      // account — a thrown error here is a real failure (network, rate
      // limit), so it's shown, not swallowed into the same "check your
      // email" confirmation a genuine send would get.
      setError(e?.message ?? "Something went wrong. Try again.");
      setLoading(false);
      return;
    }
    setLoading(false);
    setSent(true);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior="padding" style={styles.safe}>
        <ScrollView
          contentContainerStyle={styles.wrap}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.name}>plated.</Text>
          <View style={styles.card}>
            {sent ? (
              <>
                <Text style={styles.title}>Check your email</Text>
                <Text style={styles.body}>
                  If an account exists for {email.trim()}, we've sent a link
                  to reset your password.
                </Text>
                <TouchableOpacity style={styles.submitBtn} onPress={onBack}>
                  <Text style={styles.submitText}>Back to sign in</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={styles.title}>Reset your password</Text>
                <Text style={styles.body}>
                  Enter the email address on your account and we'll send you
                  a link to reset your password.
                </Text>
                <TextInput
                  style={styles.input}
                  value={email}
                  onChangeText={(t) => {
                    setEmail(t);
                    setError(null);
                  }}
                  placeholder="Email address"
                  placeholderTextColor={Colors.textDim}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!loading}
                  autoFocus
                />
                {error && <Text style={styles.errorText}>{error}</Text>}
                <TouchableOpacity
                  style={styles.submitBtn}
                  onPress={handleSubmit}
                  disabled={loading || !email.trim()}
                >
                  {loading ? (
                    <ActivityIndicator color={Colors.bg} />
                  ) : (
                    <Text style={styles.submitText}>Send reset link</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.backBtn}
                  onPress={onBack}
                  disabled={loading}
                >
                  <Text style={styles.backText}>Back to sign in</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
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
    title: {
      fontSize: Typography.lg,
      fontWeight: Typography.bold,
      color: Colors.text,
      marginBottom: Spacing.xs,
    },
    body: {
      fontSize: Typography.sm,
      color: Colors.textSub,
      lineHeight: 20,
      marginBottom: Spacing.md,
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
    backBtn: { paddingVertical: Spacing.md, alignItems: "center" },
    backText: { fontSize: Typography.sm, color: Colors.textMuted },
  }),
);
