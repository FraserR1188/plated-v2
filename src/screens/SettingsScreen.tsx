import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
  Pressable,
  Switch,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { RootStackParamList } from "../types";
import { useStore } from "../store/useStore";
import { exportCSV, last30Days } from "../lib/csv";
import {
  Colors,
  Spacing,
  Radius,
  Typography,
  MacroColor,
  Fonts,
  withDefaultFont,
} from "../theme/tokens";
import {
  getMyProfile,
  upsertProfile,
  isUsernameAvailable,
  setSharePlanned,
} from "../lib/social";
import {
  getWhoopConnection,
  connectWhoop,
  disconnectWhoop,
  syncWhoop,
  classifySyncStatus,
  type WhoopConnection,
} from "../lib/whoop";
import {
  getHealthConnectAvailability,
  getHealthConnectGrantState,
  requestHealthConnectAccess,
  openHealthConnectSettingsScreen,
  openHealthConnectPlayStore,
  isHealthConnectFullyDenied,
  type HealthConnectAvailability,
  type HealthConnectGrantState,
} from "../lib/healthConnect";
import { syncHealthConnect } from "../lib/healthConnectSync";
import { reportError } from "../lib/reportError";

import { supabase } from "../lib/supabase";

// Map each goal field to its macro colour for the input accent
const GOAL_FIELDS: {
  key:
    | "calories"
    | "protein"
    | "carbs"
    | "fat"
    | "satFat"
    | "salt"
    | "fibre"
    | "sugar";
  label: string;
  unit: string;
  color: string;
}[] = [
  { key: "calories", label: "Calories", unit: "kcal", color: Colors.green },
  { key: "protein", label: "Protein", unit: "g", color: MacroColor.protein },
  { key: "carbs", label: "Carbs", unit: "g", color: MacroColor.carbs },
  { key: "fat", label: "Fat", unit: "g", color: MacroColor.fat },
  { key: "satFat", label: "Sat fat", unit: "g", color: MacroColor.satFat },
  { key: "salt", label: "Salt", unit: "g", color: MacroColor.salt },
  { key: "fibre", label: "Fibre", unit: "g", color: MacroColor.fibre },
  { key: "sugar", label: "Sugar", unit: "g", color: MacroColor.sugar },
];

type Nav = NativeStackNavigationProp<RootStackParamList>;

// Username validation — mirrors DB constraint
const USERNAME_REGEX = /^[a-z0-9_]{3,30}$/;

/** "2 hours ago", "yesterday", "12 Jul" — no dependency, no ceremony. */
function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;

  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;

  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

export function SettingsScreen() {
  const navigation = useNavigation<Nav>();
  const {
    goals,
    saveGoals,
    getAllEntries,
    savedIngredients,
    deleteIngredient,
    reset, // ← ADD
  } = useStore();

  // ── Goal state ────────────────────────────────────────────
  const [values, setValues] = useState<Record<string, string>>({
    calories: String(goals.calories),
    protein: String(goals.protein),
    carbs: String(goals.carbs),
    fat: String(goals.fat),
    satFat: String(goals.satFat),
    salt: String(goals.salt),
    fibre: String(goals.fibre),
    sugar: String(goals.sugar),
  });
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [saved, setSaved] = useState(false);

  // ── Username state ────────────────────────────────────────
  const [currentUsername, setCurrentUsername] = useState<string | null>(null);
  const [usernameInput, setUsernameInput] = useState("");
  const [displayNameInput, setDisplayNameInput] = useState("");
  const [usernameEditing, setUsernameEditing] = useState(false);
  const [usernameLoading, setUsernameLoading] = useState(true);
  const [usernameSaving, setUsernameSaving] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [usernameSaved, setUsernameSaved] = useState(false);

  // ── Share planned meals state ───────────────────────────────
  const [sharePlannedOn, setSharePlannedOn] = useState(false);
  const [sharePlannedSaving, setSharePlannedSaving] = useState(false);
  const [sharePlannedError, setSharePlannedError] = useState<string | null>(
    null,
  );

  // ── WHOOP state ───────────────────────────────────────────
  const [whoop, setWhoop] = useState<WhoopConnection | null>(null);
  const [whoopLoading, setWhoopLoading] = useState(true);
  const [whoopBusy, setWhoopBusy] = useState(false);
  const [whoopError, setWhoopError] = useState<string | null>(null);
  const [whoopSyncing, setWhoopSyncing] = useState(false); // ← ADD
  const [syncNote, setSyncNote] = useState<string | null>(null); // ← ADD

  // ── Health Connect state ─────────────────────────────────────
  const [hcAvailability, setHcAvailability] =
    useState<HealthConnectAvailability | null>(null);
  const [hcGrants, setHcGrants] = useState<HealthConnectGrantState | null>(
    null,
  );
  const [hcLoading, setHcLoading] = useState(true);
  const [hcBusy, setHcBusy] = useState(false);
  // Tracks whether a request that GENUINELY COMPLETED (dialog resolved,
  // one way or another) has come back with nothing granted. Only set on a
  // successful ('ok') requestHealthConnectAccess() result — NOT set when
  // the request itself errored, since then nothing was actually decided.
  // Android's permission system is generally documented to auto-suppress
  // a repeated request after enough refusals, but there is no signal from
  // this library distinguishing that wall from a single dismissal — both
  // resolve identically. So this state means "asked, got nothing back",
  // not "permanently blocked"; the UI offers retry AND the settings deep
  // link rather than asserting which one is true.
  const [hcHasRequested, setHcHasRequested] = useState(false);
  // A genuine native failure (e.g. CLIENT_NOT_INITIALIZED) from the last
  // grant-state read or request — distinct from hcHasRequested/denial.
  // Must win over every other Health Connect branch: there is no
  // trustworthy permission data to render underneath it.
  const [hcNativeError, setHcNativeError] = useState<string | null>(null);
  const [hcError, setHcError] = useState<string | null>(null);
  const [hcSyncing, setHcSyncing] = useState(false);
  const [hcSyncNote, setHcSyncNote] = useState<string | null>(null);

  // Load existing profile on mount
  useEffect(() => {
    getMyProfile()
      .then((profile) => {
        if (profile) {
          setCurrentUsername(profile.username);
          setUsernameInput(profile.username);
          setDisplayNameInput(profile.display_name ?? "");
          setSharePlannedOn(profile.share_planned);
        } else {
          setUsernameEditing(true); // no profile yet — show form immediately
        }
      })
      .catch(() => {
        /* silently ignore — user can retry via edit button */
      })
      .finally(() => setUsernameLoading(false));
  }, []);

  // Load WHOOP connection on mount
  const refreshWhoop = useCallback(async () => {
    const conn = await getWhoopConnection();
    setWhoop(conn);
    setWhoopLoading(false);
  }, []);

  useEffect(() => {
    refreshWhoop();
  }, [refreshWhoop]);

  // Load Health Connect availability + grant state on mount. Grant state is
  // read fresh from getGrantedPermissions() every time, never cached — a
  // user can revoke from Android's own Health Connect settings app at any
  // point, and this screen has no other way to notice that happened.
  const refreshHealthConnect = useCallback(async () => {
    const availability = await getHealthConnectAvailability();
    setHcAvailability(availability);

    if (availability.status === "available") {
      const result = await getHealthConnectGrantState();
      if (result.status === "ok") {
        setHcGrants(result.grants);
        setHcNativeError(null);
      } else {
        setHcNativeError(result.message);
      }
    }
    setHcLoading(false);
  }, []);

  useEffect(() => {
    refreshHealthConnect();
  }, [refreshHealthConnect]);

  const handleUsernameChange = (text: string) => {
    setUsernameInput(text.toLowerCase().replace(/[^a-z0-9_]/g, ""));
    setUsernameError(null);
    setUsernameSaved(false);
  };

  const handleSaveUsername = async () => {
    const trimmed = usernameInput.trim();

    if (!USERNAME_REGEX.test(trimmed)) {
      setUsernameError(
        "3–30 characters, lowercase letters, numbers, and underscores only.",
      );
      return;
    }

    setUsernameSaving(true);
    setUsernameError(null);

    try {
      // Only check availability if the username changed
      if (trimmed !== currentUsername) {
        const available = await isUsernameAvailable(trimmed);
        if (!available) {
          setUsernameError("That username is already taken.");
          setUsernameSaving(false);
          return;
        }
      }

      await upsertProfile(trimmed, displayNameInput.trim() || undefined);
      setCurrentUsername(trimmed);
      setUsernameEditing(false);
      setUsernameSaved(true);
    } catch (err) {
      reportError("upsertProfile", err);
      setUsernameError(
        err instanceof Error
          ? err.message
          : "Could not save username. Please try again.",
      );
    } finally {
      setUsernameSaving(false);
    }
  };

  // Wait-then-reflect, matching handleSaveUsername — no optimistic flip.
  // The Switch is a controlled component bound to sharePlannedOn, so
  // leaving that state untouched until the write succeeds is what keeps
  // the thumb in place on failure; there's nothing to roll back.
  const handleToggleSharePlanned = async (value: boolean) => {
    setSharePlannedSaving(true);
    setSharePlannedError(null);

    const { error } = await setSharePlanned(value);

    setSharePlannedSaving(false);
    if (error) {
      setSharePlannedError(error);
      return;
    }
    setSharePlannedOn(value);
  };

  // ── WHOOP handlers ────────────────────────────────────────

  const handleConnectWhoop = async () => {
    setWhoopBusy(true);
    setWhoopError(null);

    const result = await connectWhoop();

    if (result.ok) {
      await refreshWhoop();
    } else if (result.error !== "cancelled") {
      // A cancel is a user changing their mind, not a failure. Say nothing
      // and put the button back — an error banner for "you tapped back"
      // is the app blaming someone for a decision they made on purpose.
      setWhoopError(result.message);
    }

    setWhoopBusy(false);
  };

  const handleDisconnectWhoop = () => {
    Alert.alert(
      "Disconnect WHOOP?",
      "Disconnecting stops new syncs and revokes plated's access at WHOOP. Your existing recovery and sleep history is kept, so past correlations still work. Deleting your account removes it.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: async () => {
            setWhoopBusy(true);
            setWhoopError(null);

            const result = await disconnectWhoop();
            if (!result.ok) setWhoopError(result.message);

            await refreshWhoop();
            setWhoopBusy(false);
          },
        },
      ],
    );
  };

  const handleSyncWhoop = async () => {
    setWhoopSyncing(true);
    setWhoopError(null);
    setSyncNote(null);

    // force: this is a deliberate tap, not an app foreground. The server still
    // holds a 60s floor — the throttle is its decision, not ours.
    const result = await syncWhoop({ force: true });

    if (!result.ok) {
      setWhoopError(result.message);
    } else if (result.skipped === "throttled") {
      setSyncNote("Already up to date.");
    } else if (result.partial) {
      // Rows landed, but the window did not advance. Saying "synced" would be
      // a lie, and saying "failed" would be one too.
      setSyncNote("Partly synced — we'll finish next time.");
    } else {
      const total = result.counts
        ? Object.values(result.counts).reduce((a, b) => a + b, 0)
        : 0;
      setSyncNote(total > 0 ? `Synced ${total} records.` : "Nothing new.");
    }

    // Always re-read: a revoked sync has already flipped status server-side,
    // and the card needs to switch to "Reconnect" without a restart.
    await refreshWhoop();
    setWhoopSyncing(false);
  };

  // ── Health Connect handlers ───────────────────────────────

  const handleConnectHealthConnect = async () => {
    setHcBusy(true);
    setHcError(null);
    setHcNativeError(null);

    const result = await requestHealthConnectAccess();

    if (result.status === "ok") {
      setHcGrants(result.grants);
      setHcHasRequested(true);
    } else {
      // Nothing was actually decided — do NOT set hcHasRequested here,
      // that would misrepresent a failed request as a completed, denied one.
      setHcNativeError(result.message);
    }

    setHcBusy(false);
  };

  const handleInstallHealthConnect = async () => {
    await openHealthConnectPlayStore();
  };

  const handleOpenHealthConnectSettings = () => {
    openHealthConnectSettingsScreen();
  };

  const handleSyncHealthConnect = async () => {
    setHcSyncing(true);
    setHcError(null);
    setHcSyncNote(null);

    const result = await syncHealthConnect();

    if (!result.ok) {
      const firstError = Object.values(result.errors)[0];
      setHcError(firstError ?? "Couldn't sync Health Connect.");
    }

    const total = Object.values(result.counts).reduce(
      (a, b) => a + (b ?? 0),
      0,
    );
    setHcSyncNote(total > 0 ? `Synced ${total} records.` : "Nothing new.");

    setHcSyncing(false);
  };

  // ── Goal handlers ─────────────────────────────────────────
  const handleChange = (key: string, val: string) => {
    setValues((prev) => ({ ...prev, [key]: val }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    const { error } = await saveGoals({
      calories: parseInt(values.calories) || 2000,
      protein: parseInt(values.protein) || 150,
      carbs: parseInt(values.carbs) || 200,
      fat: parseInt(values.fat) || 65,
      satFat: parseInt(values.satFat) || 20,
      salt: parseFloat(values.salt) || 6,
      fibre: parseInt(values.fibre) || 30,
      sugar: parseInt(values.sugar) || 30,
    });
    setSaving(false);
    if (error) {
      Alert.alert("Can't save that", error);
      return;
    }
    setSaved(true);
  };

  const handleExport = async () => {
    const entries = last30Days(getAllEntries());
    if (entries.length === 0) {
      Alert.alert("No data", "No entries in the last 30 days.");
      return;
    }
    setExporting(true);
    try {
      await exportCSV(entries);
    } catch (e: any) {
      Alert.alert("Export failed", e.message);
    } finally {
      setExporting(false);
    }
  };

  const handleDeleteIngredient = (id: string, name: string) => {
    Alert.alert(
      "Remove from library",
      `Remove "${name}" from your saved ingredients?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => deleteIngredient(id),
        },
      ],
    );
  };

  const handleSignOut = () => {
    Alert.alert("Sign out?", "You'll need to sign in again to see your log.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: async () => {
          const { error } = await supabase.auth.signOut();
          if (error) {
            Alert.alert("Couldn't sign out", error.message);
            return;
          }
          // Clear the in-memory store BEFORE App.tsx swaps to AuthScreen —
          // otherwise the next user gets a glimpse of this one's meals.
          reset();
        },
      },
    ]);
  };

  const connected = whoop?.status === "connected";
  const revoked = whoop?.status === "revoked";
  const lastSync = relativeTime(whoop?.last_sync_at ?? null);

  // A stale timestamp with no explanation is worse than no timestamp: the user
  // reads "Last synced yesterday", assumes it's still working, and never finds
  // out it has been failing for a week.
  const syncStatus = classifySyncStatus(whoop?.last_sync_error ?? null);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Header ─────────────────────────────────── */}
        <Text style={styles.heading}>Settings</Text>

        {/* ── Username / Profile ─────────────────────── */}
        <SectionLabel title="Your profile" />
        <View style={styles.card}>
          {usernameLoading ? (
            <ActivityIndicator
              color={Colors.green}
              style={{ paddingVertical: Spacing.md }}
            />
          ) : usernameEditing ? (
            /* Edit form */
            <View style={styles.usernameForm}>
              <View style={styles.usernameFieldWrap}>
                <Text style={styles.usernameFieldLabel}>Username</Text>
                <View style={styles.usernameInputRow}>
                  <Text style={styles.usernameAt}>@</Text>
                  <TextInput
                    style={[
                      styles.usernameInput,
                      usernameError ? styles.usernameInputError : null,
                    ]}
                    value={usernameInput}
                    onChangeText={handleUsernameChange}
                    placeholder="your_username"
                    placeholderTextColor={Colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={30}
                  />
                </View>
                <Text style={styles.usernameHint}>
                  3–30 chars · lowercase letters, numbers, underscores
                </Text>
                {usernameError && (
                  <Text style={styles.usernameErrorText}>{usernameError}</Text>
                )}
              </View>

              <View
                style={[styles.usernameFieldWrap, { marginTop: Spacing.sm }]}
              >
                <Text style={styles.usernameFieldLabel}>
                  Display name (optional)
                </Text>
                <TextInput
                  style={styles.usernameInput}
                  value={displayNameInput}
                  onChangeText={setDisplayNameInput}
                  placeholder="Your Name"
                  placeholderTextColor={Colors.textMuted}
                  maxLength={40}
                />
              </View>

              <View style={styles.usernameActions}>
                {currentUsername && (
                  <Pressable
                    onPress={() => {
                      setUsernameInput(currentUsername);
                      setUsernameError(null);
                      setUsernameEditing(false);
                    }}
                    style={styles.cancelBtn}
                  >
                    <Text style={styles.cancelBtnText}>Cancel</Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={handleSaveUsername}
                  disabled={usernameSaving}
                  style={[
                    styles.saveUsernameBtn,
                    {
                      flex: currentUsername ? 1 : undefined,
                      width: currentUsername ? undefined : "100%",
                    },
                  ]}
                >
                  {usernameSaving ? (
                    <ActivityIndicator color={Colors.bg} />
                  ) : (
                    <Text style={styles.saveUsernameBtnText}>Save profile</Text>
                  )}
                </Pressable>
              </View>
            </View>
          ) : (
            /* Display row */
            <View style={styles.usernameDisplay}>
              <View>
                <Text style={styles.usernameDisplayName}>
                  @{currentUsername}
                </Text>
                {displayNameInput ? (
                  <Text style={styles.usernameDisplaySub}>
                    {displayNameInput}
                  </Text>
                ) : null}
                {usernameSaved && (
                  <Text style={styles.usernameSavedText}>✓ Profile saved</Text>
                )}
              </View>
              <Pressable
                onPress={() => setUsernameEditing(true)}
                style={styles.editBtn}
              >
                <Text style={styles.editBtnText}>Edit</Text>
              </Pressable>
            </View>
          )}
        </View>

        {/* ── Sharing ────────────────────────────────── */}
        <SectionLabel title="Sharing" />
        <View style={styles.card}>
          {usernameLoading ? (
            <ActivityIndicator
              color={Colors.green}
              style={{ paddingVertical: Spacing.md }}
            />
          ) : (
            <>
              <View style={styles.sharePlannedRow}>
                <View style={styles.sharePlannedTextWrap}>
                  <Text style={styles.sharePlannedLabel}>
                    Share your meal plans
                  </Text>
                  <Text style={styles.sharePlannedSub}>
                    Friends can see meals you've planned but haven't eaten
                    yet. Off by default.
                  </Text>
                </View>
                {sharePlannedSaving ? (
                  <ActivityIndicator color={Colors.green} size="small" />
                ) : (
                  <Switch
                    value={sharePlannedOn}
                    onValueChange={handleToggleSharePlanned}
                    disabled={sharePlannedSaving}
                    trackColor={{ false: Colors.border, true: Colors.green }}
                  />
                )}
              </View>
              {sharePlannedError && (
                <Text style={styles.sharePlannedErrorText}>
                  {sharePlannedError}
                </Text>
              )}
            </>
          )}
        </View>

        {/* ── WHOOP ──────────────────────────────────── */}
        <SectionLabel title="Whoop" />
        <View style={styles.card}>
          {whoopLoading ? (
            <ActivityIndicator
              color={Colors.green}
              style={{ paddingVertical: Spacing.md }}
            />
          ) : connected ? (
            /* Connected */
            <View>
              <View style={styles.whoopStatusRow}>
                <View style={styles.whoopStatusLeft}>
                  {/* A stale timestamp with no explanation is worse than no
                      timestamp: the user reads "Last synced yesterday", assumes
                      it's still working, and never finds out it has been
                      failing for a week. */}
                  <View
                    style={[
                      styles.whoopDot,
                      syncStatus === "failing" && {
                        backgroundColor: Colors.danger,
                      },
                      syncStatus === "partial" && {
                        backgroundColor: Colors.warning,
                      },
                    ]}
                  />
                  <View>
                    <Text style={styles.whoopStatusText}>Connected</Text>
                    <Text
                      style={[
                        styles.whoopStatusSub,
                        syncStatus === "failing" && { color: Colors.danger },
                        syncStatus === "partial" && { color: Colors.warning },
                      ]}
                    >
                      {syncStatus === "failing"
                        ? lastSync
                          ? `Sync failing · last worked ${lastSync}`
                          : "Sync failing"
                        : syncStatus === "partial"
                          ? lastSync
                            ? `Synced ${lastSync} · some data still catching up`
                            : "Synced, some data still catching up"
                          : lastSync
                            ? `Last synced ${lastSync}`
                            : "Not synced yet"}
                    </Text>
                  </View>
                </View>
              </View>

              <Text style={styles.whoopBody}>
                plated is pulling your recovery, sleep and strain so it can sit
                alongside what you've eaten.
              </Text>

              <Pressable
                style={({ pressed }) => [
                  styles.whoopSyncBtn,
                  pressed && { opacity: 0.85 },
                ]}
                onPress={handleSyncWhoop}
                disabled={whoopSyncing || whoopBusy}
              >
                {whoopSyncing ? (
                  <ActivityIndicator color={Colors.green} size="small" />
                ) : (
                  <Text style={styles.whoopSyncBtnText}>Sync now</Text>
                )}
              </Pressable>

              {syncNote && <Text style={styles.whoopNoteText}>{syncNote}</Text>}

              <Pressable
                style={({ pressed }) => [
                  styles.whoopDisconnectBtn,
                  { marginTop: Spacing.sm },
                  pressed && { opacity: 0.85 },
                ]}
                onPress={handleDisconnectWhoop}
                disabled={whoopBusy || whoopSyncing}
              >
                {whoopBusy ? (
                  <ActivityIndicator color={Colors.danger} size="small" />
                ) : (
                  <Text style={styles.whoopDisconnectBtnText}>Disconnect</Text>
                )}
              </Pressable>
            </View>
          ) : (
            /* Not connected, or revoked */
            <View>
              <Text style={styles.whoopBody}>
                {revoked
                  ? "Your Whoop connection stopped working — access was revoked, or it expired. Reconnect and plated will pick up where it left off."
                  : "Connect Whoop and plated will line up what you eat against how you actually recovered, slept and trained. Food is only half the story."}
              </Text>

              <Pressable
                style={({ pressed }) => [
                  styles.whoopConnectBtn,
                  pressed && { opacity: 0.85 },
                ]}
                onPress={handleConnectWhoop}
                disabled={whoopBusy}
              >
                {whoopBusy ? (
                  <ActivityIndicator color={Colors.bg} />
                ) : (
                  <Text style={styles.whoopConnectBtnText}>
                    {revoked ? "Reconnect Whoop" : "Connect Whoop"}
                  </Text>
                )}
              </Pressable>
            </View>
          )}

          {whoopError && (
            <Text style={styles.whoopErrorText}>{whoopError}</Text>
          )}
        </View>

        {/* ── Health Connect ─────────────────────────── */}
        <SectionLabel title="Health Connect" />
        <View style={styles.card}>
          {hcLoading ? (
            <ActivityIndicator
              color={Colors.green}
              style={{ paddingVertical: Spacing.md }}
            />
          ) : hcAvailability?.status === "unsupported" ? (
            /* Not actionable — nothing to install, nothing to ask for. */
            <Text style={styles.whoopBody}>
              This device can't use Health Connect — the version of Android
              on it is too old, and there's no update that adds support.
            </Text>
          ) : hcAvailability?.status === "not_installed" ? (
            /* Actionable — Health Connect is a separate Play Store app on
               this OS version, not something the device already has. */
            <View>
              <Text style={styles.whoopBody}>
                Health Connect isn't installed yet. Once it is, plated can
                see how your meals line up with sleep, heart rate
                variability, resting heart rate and workouts collected by
                apps like Fitbit or Garmin.
              </Text>
              <Pressable
                style={({ pressed }) => [
                  styles.whoopConnectBtn,
                  pressed && { opacity: 0.85 },
                ]}
                onPress={handleInstallHealthConnect}
              >
                <Text style={styles.whoopConnectBtnText}>
                  Install Health Connect
                </Text>
              </Pressable>
            </View>
          ) : hcNativeError ? (
            /* A genuine native failure reading or requesting grant state —
               NOT a permission decision. Must win over the granted/blocked/
               never-asked branches below: there is no trustworthy grant
               data to render underneath it, and treating this as "denied"
               is exactly the bug this branch exists to prevent. */
            <View>
              <Text style={styles.whoopBody}>
                Health Connect couldn't be reached just now — this isn't
                about your permissions, something went wrong talking to it.
                Try again in a moment.
              </Text>
              <Pressable
                style={({ pressed }) => [
                  styles.whoopConnectBtn,
                  pressed && { opacity: 0.85 },
                ]}
                onPress={handleConnectHealthConnect}
                disabled={hcBusy}
              >
                {hcBusy ? (
                  <ActivityIndicator color={Colors.bg} />
                ) : (
                  <Text style={styles.whoopConnectBtnText}>Try again</Text>
                )}
              </Pressable>
              <Text style={styles.whoopErrorText}>{hcNativeError}</Text>
            </View>
          ) : hcGrants && !isHealthConnectFullyDenied(hcGrants) ? (
            /* At least one domain granted. Shown per-type, honestly — a
               user who grants sleep but denies HRV sees exactly that, not
               a single all-or-nothing "connected" flag. */
            <View>
              <View style={styles.hcGrantList}>
                <HcGrantRow label="Sleep" granted={hcGrants.sleep} />
                <HcGrantRow
                  label="Heart rate variability"
                  granted={hcGrants.hrv}
                />
                <HcGrantRow
                  label="Resting heart rate"
                  granted={hcGrants.resting_hr}
                />
                <HcGrantRow label="Workouts" granted={hcGrants.workouts} />
              </View>

              <Text style={[styles.whoopBody, { marginTop: Spacing.md }]}>
                plated reads what you've granted from Health Connect so it
                can sit alongside what you've eaten.
              </Text>

              <Pressable
                style={({ pressed }) => [
                  styles.whoopSyncBtn,
                  pressed && { opacity: 0.85 },
                ]}
                onPress={handleSyncHealthConnect}
                disabled={hcSyncing || hcBusy}
              >
                {hcSyncing ? (
                  <ActivityIndicator color={Colors.green} size="small" />
                ) : (
                  <Text style={styles.whoopSyncBtnText}>Sync now</Text>
                )}
              </Pressable>

              {hcSyncNote && (
                <Text style={styles.whoopNoteText}>{hcSyncNote}</Text>
              )}

              <Pressable
                style={({ pressed }) => [
                  styles.hcUpdateBtn,
                  { marginTop: Spacing.sm },
                  pressed && { opacity: 0.85 },
                ]}
                onPress={handleConnectHealthConnect}
                disabled={hcBusy || hcSyncing}
              >
                {hcBusy ? (
                  <ActivityIndicator color={Colors.textSub} size="small" />
                ) : (
                  <Text style={styles.hcUpdateBtnText}>Update access</Text>
                )}
              </Pressable>
            </View>
          ) : hcHasRequested ? (
            /* A request genuinely completed and nothing came back granted.
               This MAY be Android's own two-refusal wall, or it may just be
               a single dismissal — requestPermission() exposes no signal
               distinguishing the two (see requestHealthConnectAccess's doc
               comment), so we don't claim either. Offer both a retry (works
               if it wasn't the wall) and the settings deep link (works
               either way). */
            <View>
              <Text style={styles.whoopBody}>
                Health Connect access is off. You can try connecting again,
                or turn it on directly from Health Connect's own settings.
              </Text>
              <Pressable
                style={({ pressed }) => [
                  styles.whoopConnectBtn,
                  pressed && { opacity: 0.85 },
                ]}
                onPress={handleConnectHealthConnect}
                disabled={hcBusy}
              >
                {hcBusy ? (
                  <ActivityIndicator color={Colors.bg} />
                ) : (
                  <Text style={styles.whoopConnectBtnText}>Try again</Text>
                )}
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.hcUpdateBtn,
                  { marginTop: Spacing.sm },
                  pressed && { opacity: 0.85 },
                ]}
                onPress={handleOpenHealthConnectSettings}
              >
                <Text style={styles.hcUpdateBtnText}>
                  Open Health Connect settings
                </Text>
              </Pressable>
            </View>
          ) : (
            /* Never asked yet. */
            <View>
              <Text style={styles.whoopBody}>
                Connect Health Connect and see how your meals line up with
                sleep, heart rate variability, resting heart rate and
                workouts collected by apps like Fitbit or Garmin.
              </Text>
              <Pressable
                style={({ pressed }) => [
                  styles.whoopConnectBtn,
                  pressed && { opacity: 0.85 },
                ]}
                onPress={handleConnectHealthConnect}
                disabled={hcBusy}
              >
                {hcBusy ? (
                  <ActivityIndicator color={Colors.bg} />
                ) : (
                  <Text style={styles.whoopConnectBtnText}>
                    Connect Health Connect
                  </Text>
                )}
              </Pressable>
            </View>
          )}

          {hcError && <Text style={styles.whoopErrorText}>{hcError}</Text>}
        </View>

        {/* ── Daily goals ────────────────────────────── */}
        <SectionLabel title="Daily goals" />
        <View style={styles.card}>
          {GOAL_FIELDS.map((field, i) => (
            <View
              key={field.key}
              style={[
                styles.goalRow,
                i < GOAL_FIELDS.length - 1 && styles.goalBorder,
              ]}
            >
              <View style={styles.goalLeft}>
                <View
                  style={[styles.goalDot, { backgroundColor: field.color }]}
                />
                <Text style={styles.goalLabel}>{field.label}</Text>
              </View>
              <View style={styles.goalRight}>
                <TextInput
                  style={[
                    styles.goalInput,
                    { borderColor: `${field.color}30` },
                  ]}
                  value={values[field.key]}
                  onChangeText={(v) => handleChange(field.key, v)}
                  keyboardType="decimal-pad"
                  selectTextOnFocus
                  placeholderTextColor={Colors.textMuted}
                />
                <Text style={styles.goalUnit}>{field.unit}</Text>
              </View>
            </View>
          ))}

          <Pressable
            style={({ pressed }) => [
              styles.saveBtn,
              saved && styles.saveBtnSaved,
              pressed && { opacity: 0.85 },
            ]}
            onPress={handleSave}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator color={Colors.bg} />
            ) : (
              <Text style={styles.saveBtnText}>
                {saved ? "✓  Goals saved" : "Save goals"}
              </Text>
            )}
          </Pressable>
        </View>

        {/* ── Account ────────────────────────────────── */}
        <SectionLabel title="Account" />
        <View style={styles.card}>
          <Pressable
            style={({ pressed }) => [
              styles.libRow,
              styles.goalBorder,
              pressed && { backgroundColor: Colors.surface2 },
            ]}
            onPress={() => navigation.navigate("About")}
          >
            <View style={styles.libBody}>
              <Text style={styles.libName}>About & legal</Text>
            </View>
            <Text style={styles.libChevron}>›</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.signOutBtn,
              { marginTop: Spacing.md },
              pressed && { opacity: 0.85 },
            ]}
            onPress={handleSignOut}
          >
            <Text style={styles.signOutBtnText}>Sign out</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.deleteAccountBtn,
              { marginTop: Spacing.sm },
              pressed && { opacity: 0.85 },
            ]}
            onPress={() => navigation.navigate("DeleteAccount")}
          >
            <Text style={styles.deleteAccountBtnText}>Delete account</Text>
          </Pressable>
        </View>

        <View style={{ height: Spacing.xxl }} />

        {/* ── CSV Export ─────────────────────────────── */}
        <SectionLabel title="Export data" />
        <View style={styles.card}>
          <Text style={styles.exportInfo}>
            Your data is yours. Export the last 30 days as a CSV to keep, or to
            dig into in a spreadsheet.
          </Text>
          <View style={styles.colsBox}>
            <Text style={styles.colsLabel}>Included columns</Text>
            <Text style={styles.colsText}>
              date · time · meal · ingredient · brand · serving · calories ·
              protein · carbs · fat · sat fat · salt · fibre · sugar · source
            </Text>
          </View>
          {exporting ? (
            <View style={styles.exportLoading}>
              <ActivityIndicator color={Colors.green} size="small" />
              <Text style={styles.exportLoadingText}>Preparing file…</Text>
            </View>
          ) : (
            <Pressable
              style={({ pressed }) => [
                styles.exportBtn,
                pressed && { opacity: 0.85 },
              ]}
              onPress={handleExport}
            >
              <Text style={styles.exportBtnText}>Export last 30 days</Text>
            </Pressable>
          )}
        </View>

        {/* ── Saved ingredients ──────────────────────── */}
        <SectionLabel
          title="Saved ingredients"
          count={savedIngredients.length}
        />
        {savedIngredients.length === 0 ? (
          <View style={styles.emptyLibCard}>
            <Text style={styles.emptyLibText}>
              Ingredients you log frequently will appear here for quick re-use.
            </Text>
          </View>
        ) : (
          <View style={styles.card}>
            {savedIngredients.map((item, i) => (
              <Pressable
                key={item.id}
                style={({ pressed }) => [
                  styles.libRow,
                  i < savedIngredients.length - 1 && styles.goalBorder,
                  pressed && { backgroundColor: Colors.surface2 },
                ]}
                onLongPress={() => handleDeleteIngredient(item.id, item.name)}
              >
                <View style={styles.libBody}>
                  <Text style={styles.libName} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={styles.libSub}>
                    {item.brand ? `${item.brand} · ` : ""}
                    {item.cal_per100} kcal/100g · used {item.use_count}×
                  </Text>
                </View>
                <Text style={styles.libChevron}>›</Text>
              </Pressable>
            ))}
            <Text style={styles.libHint}>
              Long-press to remove from library
            </Text>
          </View>
        )}

        <View style={{ height: Spacing.xxl }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Health Connect grant row ─────────────────────────────────────────────────
// Colors.amber is reserved for the carbs macro elsewhere in the app —
// Colors.warning is the correct semantic token for "not granted" here.

function HcGrantRow({ label, granted }: { label: string; granted: boolean }) {
  const color = granted ? Colors.green : Colors.warning;
  return (
    <View style={styles.hcGrantRow}>
      <View style={[styles.whoopDot, { backgroundColor: color }]} />
      <Text style={styles.hcGrantLabel}>{label}</Text>
      <Text style={[styles.hcGrantStatus, { color }]}>
        {granted ? "Granted" : "Not granted"}
      </Text>
    </View>
  );
}

// ─── Section label ───────────────────────────────────────────────────────────

function SectionLabel({ title, count }: { title: string; count?: number }) {
  return (
    <View style={sectionStyles.row}>
      <Text style={sectionStyles.label}>{title}</Text>
      {count !== undefined && (
        <View style={sectionStyles.badge}>
          <Text style={sectionStyles.badgeText}>{count}</Text>
        </View>
      )}
    </View>
  );
}

const sectionStyles = StyleSheet.create(
  withDefaultFont({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: Spacing.xs,
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
    badge: {
      backgroundColor: Colors.surface2,
      borderRadius: Radius.pill,
      paddingHorizontal: 7,
      paddingVertical: 1,
    },
    // A count — mono, matches the numeric-readout convention elsewhere.
    badgeText: {
      fontSize: Typography.xs,
      fontWeight: Typography.bold,
      fontFamily: Fonts.mono.bold,
      color: Colors.textSub,
    },
  }),
);

// ─── Styles ──────────────────────────────────────────────────────────────────

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

  // ── Username ───────────────────────────────────────────────
  usernameDisplay: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  usernameDisplayName: {
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.text,
  },
  usernameDisplaySub: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
    marginTop: 2,
  },
  usernameSavedText: {
    fontSize: Typography.xs,
    color: Colors.green,
    marginTop: 4,
  },
  editBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  editBtnText: {
    fontSize: Typography.sm,
    fontWeight: Typography.medium,
    color: Colors.textSub,
  },

  usernameForm: {
    gap: Spacing.xs,
  },
  usernameFieldWrap: {
    gap: 4,
  },
  usernameFieldLabel: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  usernameInputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  usernameAt: {
    fontSize: Typography.base,
    color: Colors.textMuted,
    fontWeight: Typography.semibold,
  },
  usernameInput: {
    flex: 1,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.control,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
    paddingVertical: 9,
    fontSize: Typography.base,
    color: Colors.text,
  },
  usernameInputError: {
    borderColor: Colors.danger,
  },
  usernameHint: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    marginTop: 3,
  },
  usernameErrorText: {
    fontSize: Typography.xs,
    color: Colors.danger,
    marginTop: 3,
  },
  usernameActions: {
    flexDirection: "row",
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },
  cancelBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 11,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: "center",
  },
  cancelBtnText: {
    fontSize: Typography.base,
    fontWeight: Typography.medium,
    color: Colors.textSub,
  },
  saveUsernameBtn: {
    paddingVertical: 11,
    backgroundColor: Colors.green,
    borderRadius: Radius.pill,
    alignItems: "center",
    paddingHorizontal: Spacing.lg,
  },
  saveUsernameBtnText: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.bg,
  },

  // ── Sharing ────────────────────────────────────────────────
  sharePlannedRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing.md,
  },
  sharePlannedTextWrap: {
    flex: 1,
  },
  sharePlannedLabel: {
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.text,
  },
  sharePlannedSub: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
    marginTop: 2,
    lineHeight: 18,
  },
  sharePlannedErrorText: {
    fontSize: Typography.xs,
    color: Colors.danger,
    marginTop: Spacing.sm,
  },

  // ── Whoop ──────────────────────────────────────────────────
  whoopStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: Spacing.md,
  },
  whoopStatusLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
  },
  whoopDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.green,
  },
  whoopStatusText: {
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.text,
  },
  whoopStatusSub: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    marginTop: 2,
  },
  whoopBody: {
    fontSize: Typography.sm,
    color: Colors.textSub,
    lineHeight: 20,
    marginBottom: Spacing.md,
  },
  whoopConnectBtn: {
    backgroundColor: Colors.green,
    borderRadius: Radius.pill,
    paddingVertical: 13,
    alignItems: "center",
  },
  whoopConnectBtnText: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.bg,
  },
  whoopDisconnectBtn: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: `${Colors.danger}40`,
    paddingVertical: 13,
    alignItems: "center",
  },
  whoopDisconnectBtnText: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.danger,
  },
  whoopErrorText: {
    fontSize: Typography.xs,
    color: Colors.danger,
    marginTop: Spacing.sm,
    textAlign: "center",
    lineHeight: 17,
  },
  whoopSyncBtn: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: `${Colors.green}40`,
    paddingVertical: 13,
    alignItems: "center",
  },
  whoopSyncBtnText: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.green,
  },
  whoopNoteText: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    marginTop: Spacing.sm,
    textAlign: "center",
  },
  // ── Health Connect ─────────────────────────────────────────
  hcGrantList: {
    gap: Spacing.sm,
  },
  hcGrantRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
  },
  hcGrantLabel: {
    flex: 1,
    fontSize: Typography.sm,
    fontWeight: Typography.medium,
    color: Colors.text,
  },
  hcGrantStatus: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
  },
  hcUpdateBtn: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: 13,
    alignItems: "center",
  },
  hcUpdateBtnText: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.textSub,
  },

  signOutBtn: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: 13,
    alignItems: "center",
  },
  signOutBtnText: {
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.danger,
  },
  deleteAccountBtn: {
    paddingVertical: 13,
    alignItems: "center",
  },
  deleteAccountBtnText: {
    fontSize: Typography.sm,
    fontWeight: Typography.medium,
    color: Colors.textDim,
  },

  // ── Goals ──────────────────────────────────────────────────
  goalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 11,
  },
  goalBorder: {
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderSub,
  },
  goalLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
  },
  goalDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  goalLabel: {
    fontSize: Typography.base,
    fontWeight: Typography.medium,
    color: Colors.text,
  },
  goalRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
  },
  goalInput: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.control,
    borderWidth: 1,
    paddingHorizontal: Spacing.md,
    paddingVertical: 7,
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    fontFamily: Fonts.mono.bold,
    color: Colors.text,
    minWidth: 76,
    textAlign: "center",
  },
  goalUnit: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
    width: 32,
  },
  saveBtn: {
    backgroundColor: Colors.green,
    borderRadius: Radius.pill,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: Spacing.md,
  },
  saveBtnSaved: {
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: `${Colors.green}40`,
  },
  saveBtnText: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.bg,
  },

  // ── Export ─────────────────────────────────────────────────
  exportInfo: {
    fontSize: Typography.sm,
    color: Colors.textSub,
    lineHeight: 20,
    marginBottom: Spacing.md,
  },
  colsBox: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.control,
    padding: Spacing.sm,
    marginBottom: Spacing.md,
    gap: 4,
  },
  colsLabel: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  colsText: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontStyle: "italic",
    lineHeight: 17,
  },
  exportLoading: {
    flexDirection: "row",
    gap: Spacing.sm,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: Spacing.md,
  },
  exportLoadingText: {
    fontSize: Typography.sm,
    color: Colors.textSub,
  },
  exportBtn: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: 13,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    gap: Spacing.sm,
  },
  exportBtnText: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.text,
  },

  // ── Ingredient library ─────────────────────────────────────
  emptyLibCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
    alignItems: "center",
    marginBottom: Spacing.md,
  },
  emptyLibText: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
    textAlign: "center",
    lineHeight: 20,
  },
  libRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 11,
    borderRadius: Radius.control,
    marginHorizontal: -4,
    paddingHorizontal: 4,
  },
  libBody: { flex: 1 },
  libName: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    color: Colors.text,
    letterSpacing: -0.1,
  },
  libSub: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    marginTop: 2,
    fontWeight: Typography.medium,
  },
  libChevron: {
    fontSize: 18,
    color: Colors.textDim,
    marginLeft: Spacing.sm,
  },
  libHint: {
    fontSize: Typography.xs,
    color: Colors.textDim,
    marginTop: Spacing.sm,
    textAlign: "center",
    fontWeight: Typography.medium,
  },
  }),
);
