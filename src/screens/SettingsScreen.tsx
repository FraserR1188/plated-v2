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
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useStore } from "../store/useStore";
import { exportCSV, last30Days } from "../lib/csv";
import { Colors, Spacing, Radius, Typography, MacroColor } from "../theme";
import {
  getMyProfile,
  upsertProfile,
  isUsernameAvailable,
} from "../lib/social";
import {
  getWhoopConnection,
  connectWhoop,
  disconnectWhoop,
  type WhoopConnection,
} from "../lib/whoop";

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
  const {
    goals,
    saveGoals,
    getAllEntries,
    savedIngredients,
    deleteIngredient,
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

  // ── WHOOP state ───────────────────────────────────────────
  const [whoop, setWhoop] = useState<WhoopConnection | null>(null);
  const [whoopLoading, setWhoopLoading] = useState(true);
  const [whoopBusy, setWhoopBusy] = useState(false);
  const [whoopError, setWhoopError] = useState<string | null>(null);

  // Load existing profile on mount
  useEffect(() => {
    getMyProfile()
      .then((profile) => {
        if (profile) {
          setCurrentUsername(profile.username);
          setUsernameInput(profile.username);
          setDisplayNameInput(profile.display_name ?? "");
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
    } catch {
      setUsernameError("Could not save username. Please try again.");
    } finally {
      setUsernameSaving(false);
    }
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
      "plated will stop pulling your recovery, sleep and strain. Anything already synced stays.",
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

  // ── Goal handlers ─────────────────────────────────────────
  const handleChange = (key: string, val: string) => {
    setValues((prev) => ({ ...prev, [key]: val }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    await saveGoals({
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

  const connected = whoop?.status === "connected";
  const revoked = whoop?.status === "revoked";
  const lastSync = relativeTime(whoop?.last_sync_at ?? null);

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
                  <View style={styles.whoopDot} />
                  <View>
                    <Text style={styles.whoopStatusText}>Connected</Text>
                    <Text style={styles.whoopStatusSub}>
                      {lastSync ? `Last synced ${lastSync}` : "Not synced yet"}
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
                  styles.whoopDisconnectBtn,
                  pressed && { opacity: 0.85 },
                ]}
                onPress={handleDisconnectWhoop}
                disabled={whoopBusy}
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

const sectionStyles = StyleSheet.create({
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
    borderRadius: Radius.full,
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  badgeText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    color: Colors.textSub,
  },
});

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
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
    borderRadius: Radius.lg,
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
    borderRadius: Radius.full,
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
    borderRadius: Radius.sm,
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
    borderRadius: Radius.full,
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
    borderRadius: Radius.full,
    alignItems: "center",
    paddingHorizontal: Spacing.lg,
  },
  saveUsernameBtnText: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.bg,
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
    borderRadius: Radius.full,
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
    borderRadius: Radius.full,
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
    borderRadius: Radius.sm,
    borderWidth: 1,
    paddingHorizontal: Spacing.md,
    paddingVertical: 7,
    fontSize: Typography.base,
    fontWeight: Typography.bold,
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
    borderRadius: Radius.full,
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
    borderRadius: Radius.sm,
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
    borderRadius: Radius.full,
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
    borderRadius: Radius.lg,
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
    borderRadius: Radius.sm,
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
});
