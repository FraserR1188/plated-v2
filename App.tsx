import "react-native-url-polyfill/auto";
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  AppState,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { AppNavigator } from "./src/navigation/AppNavigator";
import { supabase, signIn, signUp } from "./src/lib/supabase";
import { useStore } from "./src/store/useStore";
import { Colors, Spacing, Radius, Typography } from "./src/theme";
import { syncWhoop } from "./src/lib/whoop";

export default function App() {
  const { setUserId, fetchEntries, fetchGoals, fetchSavedIngredients } =
    useStore();
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // ── Auth ────────────────────────────────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session?.user) {
        setUserId(session.user.id);
        fetchEntries();
        fetchGoals();
        fetchSavedIngredients();
      }
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session?.user) {
        setUserId(session.user.id);
        fetchEntries();
        fetchGoals();
        fetchSavedIngredients();
      } else {
        setUserId(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // ── WHOOP sync ──────────────────────────────────────────────
  //
  // Its OWN top-level effect. This must NOT be nested inside the auth effect's
  // callback — a hook called from inside another hook's callback is a
  // rules-of-hooks violation, and React either throws "Invalid hook call" or
  // silently never registers it.
  //
  // Fire-and-forget, deliberately. The 15-minute throttle lives on the SERVER
  // and is keyed on last_sync_attempt_at, so it holds even when WHOOP is down.
  // A client-side throttle would just be a second, worse copy of a decision
  // already made correctly — and it would reset on every app restart, which is
  // exactly when a user is most likely to foreground twice.
  //
  // A failure here is silent BY DESIGN. Settings owns the visible sync state.
  // An error banner on the Today screen because a background poll timed out is
  // the app complaining to someone who never asked it to do anything.
  useEffect(() => {
    if (!session) return;

    syncWhoop().catch(() => {});

    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") syncWhoop().catch(() => {});
    });
    return () => sub.remove();
  }, [session]);

  if (loading) {
    return (
      <View style={styles.splash}>
        <StatusBar style="light" />
        <Text style={styles.splashName}>plated.</Text>
        <ActivityIndicator
          color={Colors.green}
          style={{ marginTop: Spacing.lg }}
        />
      </View>
    );
  }

  if (session) {
    return (
      <SafeAreaProvider>
        <StatusBar style="light" />
        <AppNavigator />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <AuthScreen />
    </SafeAreaProvider>
  );
}

function AuthScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!email.trim() || !password) return;
    setLoading(true);
    try {
      if (mode === "signin") {
        await signIn(email.trim(), password);
      } else {
        await signUp(email.trim(), password);
        Alert.alert(
          "Account created",
          "Check your email to confirm, then sign in.",
        );
        setMode("signin");
      }
    } catch (e: any) {
      Alert.alert("Error", e.message ?? "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.authSafe}>
      <View style={styles.authWrap}>
        <Text style={styles.authName}>plated.</Text>
        <Text style={styles.authSub}>Track every ingredient, every macro.</Text>
        <View style={styles.authCard}>
          <Text style={styles.authTitle}>
            {mode === "signin" ? "Sign in" : "Create account"}
          </Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="Email address"
            placeholderTextColor={Colors.textDim}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor={Colors.textDim}
            secureTextEntry
          />
          <TouchableOpacity
            style={styles.submitBtn}
            onPress={handleSubmit}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color={Colors.bg} />
            ) : (
              <Text style={styles.submitText}>
                {mode === "signin" ? "Sign in" : "Create account"}
              </Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.switchBtn}
            onPress={() => setMode(mode === "signin" ? "signup" : "signin")}
          >
            <Text style={styles.switchText}>
              {mode === "signin"
                ? "Don't have an account? Sign up"
                : "Already have an account? Sign in"}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: Colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  splashName: {
    fontSize: Typography.hero,
    fontWeight: Typography.bold,
    color: Colors.green,
    letterSpacing: -2,
  },
  authSafe: { flex: 1, backgroundColor: Colors.bg },
  authWrap: { flex: 1, padding: Spacing.lg, justifyContent: "center" },
  authName: {
    fontSize: Typography.hero - 8,
    fontWeight: Typography.bold,
    color: Colors.green,
    letterSpacing: -1.5,
    marginBottom: Spacing.xs,
  },
  authSub: {
    fontSize: Typography.base,
    color: Colors.textMuted,
    marginBottom: Spacing.xl,
  },
  authCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
  },
  authTitle: {
    fontSize: Typography.lg,
    fontWeight: Typography.bold,
    color: Colors.text,
    marginBottom: Spacing.md,
  },
  input: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.sm,
    padding: Spacing.md,
    fontSize: Typography.base,
    color: Colors.text,
    marginBottom: Spacing.sm,
  },
  submitBtn: {
    backgroundColor: Colors.green,
    borderRadius: Radius.full,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: Spacing.sm,
  },
  submitText: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.bg,
  },
  switchBtn: { paddingVertical: Spacing.md, alignItems: "center" },
  switchText: { fontSize: Typography.sm, color: Colors.textMuted },
});
