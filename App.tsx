import "./instrument";
import * as Sentry from "@sentry/react-native";
import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  AppState,
  ScrollView,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  KeyboardProvider,
  KeyboardAvoidingView,
} from "react-native-keyboard-controller";
import * as Linking from "expo-linking";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import { AppNavigator } from "./src/navigation/AppNavigator";
import { supabase, signIn, signUp } from "./src/lib/supabase";
import { parseRecoveryLink } from "./src/lib/passwordReset";
import { ForgotPasswordScreen } from "./src/screens/ForgotPasswordScreen";
import {
  ResetPasswordScreen,
  RecoveryStatus,
} from "./src/screens/ResetPasswordScreen";
import { useStore } from "./src/store/useStore";
import {
  Colors,
  Spacing,
  Radius,
  Typography,
  FontsToLoad,
  withDefaultFont,
} from "./src/theme/tokens";
import { syncWhoop } from "./src/lib/whoop";
import { reportError } from "./src/lib/reportError";

function ErrorFallback({ onReset }: { onReset: () => void }) {
  return (
    <View style={styles.errorWrap}>
      <Text style={styles.errorHeading}>Something went wrong</Text>
      <Text style={styles.errorBody}>
        plated hit an unexpected error. Give it another try.
      </Text>
      <TouchableOpacity style={styles.submitBtn} onPress={onReset}>
        <Text style={styles.submitText}>Try again</Text>
      </TouchableOpacity>
    </View>
  );
}

function App() {
  const { setUserId, fetchEntries, fetchGoals, fetchSavedIngredients, reset } =
    useStore();
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [fontsLoaded] = useFonts(FontsToLoad);

  // Pre-auth view (no session at all) vs. recovery status (may arrive with
  // ANY pre-auth view showing, or with none — a cold start) are kept as two
  // independent pieces of state on purpose. Recovery must be able to
  // interrupt "signin" or "forgot" equally, and must also win over a
  // completed cold-start session check before either has settled — folding
  // them into one enum would make some of those combinations unrepresentable
  // and reintroduce exactly the race the recovery effect below exists to
  // avoid.
  const [preAuthView, setPreAuthView] = useState<"signin" | "forgot">(
    "signin",
  );
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryStatus | "none">(
    "none",
  );

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

  // ── Password recovery deep link ────────────────────────────
  //
  // Its OWN top-level effect, same reasoning as the WHOOP sync effect below:
  // this must not be nested inside the auth effect's callback above.
  //
  // plated://reset-password never goes through WebBrowser.openAuthSessionAsync
  // the way whoop-callback does (see src/lib/whoop.ts's connectWhoop) — that
  // flow works because the APP itself opens the browser and gets the redirect
  // back as the resolved value of that one promise. A reset link is opened
  // from an email client or the system browser, possibly while this app is
  // backgrounded or not running at all, so it needs a real global Linking
  // subscription (warm/background resume) plus a cold-start check via
  // getInitialURL() — there is no other listener anywhere in this codebase
  // that does that today.
  //
  // THE SHARP EDGE: setSession() below always fires the ordinary SIGNED_IN
  // event, never PASSWORD_RECOVERY — that event only comes from auth-js's
  // own URL-detection code path (verifyOtp / _getSessionFromURL), which
  // detectSessionInUrl: false disables. So the instant setSession() succeeds,
  // the auth effect above sees a truthy session and would render
  // <AppNavigator/> on its own — before a new password has been set. Setting
  // recoveryStatus to "verifying" HERE, synchronously, before setSession is
  // even called, and checking it ahead of `session` in the render logic
  // below, is what keeps that from happening.
  useEffect(() => {
    function handleUrl(url: string) {
      const result = parseRecoveryLink(url);
      if (result.kind === "not_a_recovery_link") return;

      if (result.kind === "dead") {
        setRecoveryStatus(result.reason);
        return;
      }

      setRecoveryStatus("verifying");
      supabase.auth
        .setSession({
          access_token: result.access_token,
          refresh_token: result.refresh_token,
        })
        .then(({ error }) => {
          if (error) {
            // Tokens parsed fine, but Supabase rejected them — already used,
            // or expired between the click and this call. Never log `error`
            // as-is: reportError's scrubErrorForReport already restricts it
            // to code/name, so this can't leak anything from the tokens.
            reportError("passwordRecoverySetSession", error, {
              fingerprint: ["password-recovery-set-session"],
            });
            setRecoveryStatus("expired");
            return;
          }
          setRecoveryStatus("ready");
        })
        .catch((e) => {
          reportError("passwordRecoverySetSession", e, {
            fingerprint: ["password-recovery-set-session"],
          });
          setRecoveryStatus("expired");
        });
    }

    Linking.getInitialURL().then((url) => {
      if (url) handleUrl(url);
    });
    const sub = Linking.addEventListener("url", ({ url }) => handleUrl(url));
    return () => sub.remove();
  }, []);

  // The one place this flow signs out and clears local state — reached from
  // the expired/invalid dead-end screen's own button, AND from a session
  // that dies mid-form after setSession() had already succeeded (see
  // ResetPasswordScreen's handleSubmit). Whichever path got here, a
  // recovery session may genuinely exist in storage even though the flow is
  // ending, so this always attempts a real sign-out rather than only
  // clearing local state when we know setSession() itself failed.
  const handleBackToSignInFromRecovery = useCallback(async () => {
    reset();
    try {
      await supabase.auth.signOut();
    } catch {
      // Best-effort. supabase-js's signOut() only clears local storage
      // after its server-side revoke call succeeds (401/403/404 and "no
      // session" are already treated as success inside the SDK) — a plain
      // network failure at this exact moment can leave a live session in
      // storage. Null it here directly so THIS render can never fall
      // through to AppNavigator regardless; a session that outlives a
      // failed revoke call across a full app restart is a known, narrow gap
      // consistent with the app's existing no-retry posture elsewhere.
      setSession(null);
    }
    setRecoveryStatus("none");
  }, [reset]);

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

    syncWhoop().catch((e) =>
      reportError("whoopBackgroundSync", e, {
        fingerprint: ["whoop-background-sync"],
      }),
    );

    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        syncWhoop().catch((e) =>
          reportError("whoopBackgroundSync", e, {
            fingerprint: ["whoop-background-sync"],
          }),
        );
      }
    });
    return () => sub.remove();
  }, [session]);

  let content: React.ReactNode;
  if (loading || !fontsLoaded) {
    content = (
      <View style={styles.splash}>
        <Text style={styles.splashName}>plated.</Text>
        <ActivityIndicator
          color={Colors.green}
          style={{ marginTop: Spacing.lg }}
        />
      </View>
    );
  } else if (recoveryStatus !== "none") {
    // Checked BEFORE `session` — see the recovery effect's comment above.
    content = (
      <ResetPasswordScreen
        status={recoveryStatus}
        onDone={() => setRecoveryStatus("none")}
        onBackToSignIn={handleBackToSignInFromRecovery}
      />
    );
  } else if (session) {
    content = <AppNavigator />;
  } else if (preAuthView === "forgot") {
    content = <ForgotPasswordScreen onBack={() => setPreAuthView("signin")} />;
  } else {
    content = (
      <AuthScreen onForgotPassword={() => setPreAuthView("forgot")} />
    );
  }

  return (
    <SafeAreaProvider>
      <KeyboardProvider>
        <Sentry.ErrorBoundary
          fallback={({ resetError }) => <ErrorFallback onReset={resetError} />}
        >
          {content}
        </Sentry.ErrorBoundary>
        <StatusBar style="light" />
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}

export default Sentry.wrap(App);

function AuthScreen({
  onForgotPassword,
}: {
  onForgotPassword: () => void;
}) {
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
          "Sign in with your new account to get started.",
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
      {/* targetSdk 36 + edge-to-edge (enforced from API 35) means the keyboard
          arrives as a WindowInsets change, not a window resize — there is no
          native reflow to lean on here (see DeleteAccountScreen, which
          predates this fix and still assumes one). This is
          react-native-keyboard-controller's KeyboardAvoidingView, which reads
          the live IME inset directly and works the same on both platforms —
          RN's built-in version measures Android's keyboard height as 0 on
          API 30+ and needed the old Platform.OS branch to do nothing there.
          The ScrollView below is the actual scroll fallback on short
          screens; this view supplies the lift. */}
      <KeyboardAvoidingView behavior="padding" style={styles.authSafe}>
        <ScrollView
          contentContainerStyle={styles.authWrap}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.authName}>plated.</Text>
          <Text style={styles.authSub}>
            Track every ingredient, every macro.
          </Text>
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
            {mode === "signin" && (
              <TouchableOpacity
                style={styles.forgotBtn}
                onPress={onForgotPassword}
              >
                <Text style={styles.forgotText}>Forgot password?</Text>
              </TouchableOpacity>
            )}
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
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create(
  withDefaultFont({
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
    errorWrap: {
      flex: 1,
      backgroundColor: Colors.bg,
      alignItems: "center",
      justifyContent: "center",
      padding: Spacing.lg,
    },
    errorHeading: {
      fontSize: Typography.lg,
      fontWeight: Typography.bold,
      color: Colors.text,
      marginBottom: Spacing.xs,
    },
    errorBody: {
      fontSize: Typography.base,
      color: Colors.textMuted,
      textAlign: "center",
      marginBottom: Spacing.lg,
    },
    authSafe: { flex: 1, backgroundColor: Colors.bg },
    authWrap: {
      flexGrow: 1,
      padding: Spacing.lg,
      justifyContent: "center",
    },
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
      borderRadius: Radius.card,
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
      borderRadius: Radius.control,
      padding: Spacing.md,
      fontSize: Typography.base,
      color: Colors.text,
      marginBottom: Spacing.sm,
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
    switchBtn: { paddingVertical: Spacing.md, alignItems: "center" },
    switchText: { fontSize: Typography.sm, color: Colors.textMuted },
    forgotBtn: { alignItems: "flex-end", marginBottom: Spacing.xs },
    forgotText: { fontSize: Typography.sm, color: Colors.textMuted },
  }),
);
