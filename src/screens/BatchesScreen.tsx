// ============================================================
// src/screens/BatchesScreen.tsx
// ============================================================
// The "Batches" tab. Lists compositions of kind='batch' only — bundles live
// entirely in TodayScreen's sheets, unchanged, and never appear here. Tap a
// row to edit it; tap "Log" to open the eat-time sheet (ScheduleBatchSheet,
// below) — it defaults to right now, so confirming immediately reproduces
// the old log-now-only behaviour, but the day/time are both editable before
// committing. Long-press to delete.
// ============================================================

import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
  Modal,
  RefreshControl,
} from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SafeAreaView } from "react-native-safe-area-context";
import DateTimePicker from "@react-native-community/datetimepicker";
import { useStore } from "../store/useStore";
import { batchPortionCalories } from "../lib/compositions";
import {
  dateKey,
  formatDayLabel,
  formatTime,
  willBePlanned,
} from "../lib/time";
import {
  Colors,
  Spacing,
  Radius,
  Typography,
  Fonts,
  withDefaultFont,
} from "../theme/tokens";
import { RootStackParamList, MealCompositionWithItems } from "../types";

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function BatchesScreen() {
  const navigation = useNavigation<Nav>();
  const { compositions, fetchCompositions, applyBatchNow, removeComposition } =
    useStore();
  const [refreshing, setRefreshing] = useState(false);
  const [loggingId, setLoggingId] = useState<string | null>(null);
  // The batch currently in the eat-time sheet — non-null keeps it open.
  // Log-now-only v1 used to apply on tap; this just interposes a picker
  // before the same applyBatchNow call.
  const [schedulingBatch, setSchedulingBatch] =
    useState<MealCompositionWithItems | null>(null);

  useFocusEffect(
    useCallback(() => {
      fetchCompositions();
    }, []),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchCompositions();
    setRefreshing(false);
  };

  const batches = compositions.filter((c) => c.kind === "batch");

  // Tap "Log" opens the eat-time sheet rather than applying immediately —
  // the actual apply happens in handleConfirmSchedule, once a time is
  // confirmed (which may just be "now", untouched).
  const handleLog = (batch: MealCompositionWithItems) => {
    setSchedulingBatch(batch);
  };

  const handleConfirmSchedule = async (
    batch: MealCompositionWithItems,
    chosenAt: Date,
  ) => {
    setSchedulingBatch(null);
    setLoggingId(batch.id);
    const { error } = await applyBatchNow(batch, chosenAt);
    setLoggingId(null);
    if (error) {
      Alert.alert("Couldn't log that", error);
      return;
    }
    // Native Alert as the confirmation — same "toast-style feedback" pattern
    // CopyConfirmScreen already uses, not a custom toast component. Wording
    // reflects what the trigger will actually decide (willBePlanned mirrors
    // it — see draftsFromBatch), not just "logged" regardless of the time.
    if (willBePlanned(chosenAt.toISOString())) {
      Alert.alert(
        "Planned",
        `${batch.name} planned for ${formatTime(chosenAt.toISOString())}, ` +
          `${formatDayLabel(dateKey(chosenAt)).toLowerCase()}.`,
      );
    } else {
      Alert.alert("Logged", `${batch.name} added to today's log.`);
    }
  };

  const handleDelete = (batch: MealCompositionWithItems) => {
    Alert.alert("Delete batch", `Delete "${batch.name}"? This can't be undone.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const { error } = await removeComposition(batch.id);
          if (error) Alert.alert("Couldn't delete that", error);
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Batches</Text>
        <Pressable
          style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.8 }]}
          onPress={() => navigation.navigate("BatchEditor", {})}
        >
          <Text style={styles.addBtnText}>＋ New</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors.green}
            colors={[Colors.green]}
          />
        }
      >
        {batches.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyEmoji}>🍲</Text>
            <Text style={styles.emptyTitle}>No batches yet</Text>
            <Text style={styles.emptySub}>
              A batch is a recipe — combine ingredients, weigh what it makes,
              and log a single portion any time. Good for pancakes, chilli,
              soup, anything cooked in a big pot.
            </Text>
            <Pressable
              style={({ pressed }) => [
                styles.primaryBtn,
                pressed && { opacity: 0.88 },
              ]}
              onPress={() => navigation.navigate("BatchEditor", {})}
            >
              <Text style={styles.primaryBtnText}>Create a batch</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.list}>
            {batches.map((batch, i) => {
              const kcal = batchPortionCalories(batch);
              return (
                <Pressable
                  key={batch.id}
                  style={({ pressed }) => [
                    styles.row,
                    i < batches.length - 1 && styles.rowBorder,
                    pressed && { backgroundColor: Colors.surface2 },
                  ]}
                  onPress={() =>
                    navigation.navigate("BatchEditor", {
                      compositionId: batch.id,
                    })
                  }
                  onLongPress={() => handleDelete(batch)}
                >
                  <View style={styles.rowBody}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {batch.name}
                    </Text>
                    <Text style={styles.rowMeta}>
                      {kcal != null ? `${kcal} kcal` : "—"}
                      {batch.portion_label ? ` · ${batch.portion_label}` : ""}
                      {" · "}
                      {batch.items.length}{" "}
                      {batch.items.length === 1 ? "ingredient" : "ingredients"}
                    </Text>
                  </View>

                  <Pressable
                    style={({ pressed }) => [
                      styles.logBtn,
                      pressed && { opacity: 0.8 },
                    ]}
                    onPress={() => handleLog(batch)}
                    disabled={loggingId === batch.id}
                  >
                    {loggingId === batch.id ? (
                      <ActivityIndicator size="small" color={Colors.bg} />
                    ) : (
                      <Text style={styles.logBtnText}>Log</Text>
                    )}
                  </Pressable>
                </Pressable>
              );
            })}
          </View>
        )}
        <View style={{ height: Spacing.xxl }} />
      </ScrollView>

      <ScheduleBatchSheet
        visible={schedulingBatch != null}
        batch={schedulingBatch}
        onClose={() => setSchedulingBatch(null)}
        onConfirm={handleConfirmSchedule}
      />
    </SafeAreaView>
  );
}

// ─── Eat-time sheet ─────────────────────────────────────────────────────────
//
// Same date/time-chip + caption pattern as ProductScreen's "When did/will you
// eat this?" card — reused rather than reinvented, because it's already the
// app's one existing precedent for letting a user pick eaten_at and see,
// before committing, whether that lands as Logged or Planned. The caption is
// this batch's version of ApplyBundleSheet's Logged/Planned pills: a batch is
// exactly one row, so there's nothing to preview per-item, but the same "show
// them before they commit" principle applies to the one row there is.
function ScheduleBatchSheet({
  visible,
  batch,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  batch: MealCompositionWithItems | null;
  onClose: () => void;
  onConfirm: (batch: MealCompositionWithItems, chosenAt: Date) => void;
}) {
  const [eatenAt, setEatenAt] = useState(() => new Date());
  const [pickerMode, setPickerMode] = useState<"date" | "time" | null>(null);

  // Reset to "now" every time the sheet opens (including for a different
  // batch) — otherwise a previous pick would leak into the next tap's
  // default, and confirming immediately wouldn't reproduce the old
  // log-now behaviour.
  useEffect(() => {
    if (visible) {
      setEatenAt(new Date());
      setPickerMode(null);
    }
  }, [visible, batch?.id]);

  if (!batch) return null;

  const isPlanned = willBePlanned(eatenAt.toISOString());
  const dayLabel = formatDayLabel(dateKey(eatenAt));

  const onDateChange = (event: any, picked?: Date) => {
    setPickerMode(null);
    if (event?.type === "dismissed" || !picked) return;
    const next = new Date(eatenAt);
    next.setFullYear(picked.getFullYear(), picked.getMonth(), picked.getDate());
    setEatenAt(next);
  };

  const onTimeChange = (event: any, picked?: Date) => {
    setPickerMode(null);
    if (event?.type === "dismissed" || !picked) return;
    const next = new Date(eatenAt);
    next.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
    setEatenAt(next);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={sheetStyles.backdrop} onPress={onClose} />
      <View style={sheetStyles.sheet}>
        <View style={sheetStyles.grabber} />
        <Text style={sheetStyles.title} numberOfLines={1}>
          Log {batch.name}
        </Text>

        <Text style={sheetStyles.cardSectionLabel}>
          {isPlanned ? "When will you eat this?" : "When did you eat this?"}
        </Text>

        <View style={sheetStyles.whenRow}>
          <Pressable
            style={({ pressed }) => [
              sheetStyles.whenChip,
              isPlanned && sheetStyles.whenChipPlanned,
              pressed && { opacity: 0.8 },
            ]}
            onPress={() => setPickerMode("date")}
          >
            <Text style={sheetStyles.whenIcon}>{isPlanned ? "📅" : "🗓"}</Text>
            <Text
              style={[
                sheetStyles.whenValue,
                isPlanned && sheetStyles.whenValuePlanned,
              ]}
              numberOfLines={1}
            >
              {dayLabel}
            </Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [
              sheetStyles.whenChip,
              isPlanned && sheetStyles.whenChipPlanned,
              pressed && { opacity: 0.8 },
            ]}
            onPress={() => setPickerMode("time")}
          >
            <Text style={sheetStyles.whenIcon}>🕐</Text>
            <Text
              style={[
                sheetStyles.whenValue,
                sheetStyles.whenValueMono,
                isPlanned && sheetStyles.whenValuePlanned,
              ]}
            >
              {formatTime(eatenAt.toISOString())}
            </Text>
          </Pressable>
        </View>

        <Text style={sheetStyles.whenCaption}>
          {isPlanned ? (
            <>
              Will save as a plan.{" "}
              <Text style={sheetStyles.whenCaptionStrong}>
                We'll ask if you actually ate it.
              </Text>
            </>
          ) : (
            <>
              Logs at{" "}
              <Text style={sheetStyles.whenCaptionStrong}>
                {formatTime(eatenAt.toISOString())}
              </Text>
              , {dayLabel.toLowerCase()}.
            </>
          )}
        </Text>

        {pickerMode && (
          <DateTimePicker
            value={eatenAt}
            mode={pickerMode}
            is24Hour
            display="default"
            onChange={pickerMode === "date" ? onDateChange : onTimeChange}
          />
        )}

        <View style={sheetStyles.actionsRow}>
          <Pressable
            style={({ pressed }) => [
              sheetStyles.cancelBtn,
              pressed && { opacity: 0.8 },
            ]}
            onPress={onClose}
          >
            <Text style={sheetStyles.cancelBtnText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              sheetStyles.confirmBtn,
              isPlanned && sheetStyles.confirmBtnPlanned,
              pressed && { opacity: 0.85 },
            ]}
            onPress={() => onConfirm(batch, eatenAt)}
          >
            <Text style={sheetStyles.confirmBtnText}>
              {isPlanned ? "Plan" : "Log"}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create(
  withDefaultFont({
    safe: {
      flex: 1,
      backgroundColor: Colors.bg,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: Spacing.md,
      paddingTop: Spacing.sm,
      paddingBottom: Spacing.md,
    },
    headerTitle: {
      fontSize: Typography.lg,
      fontWeight: Typography.bold,
      color: Colors.text,
      letterSpacing: -0.3,
    },
    addBtn: {
      backgroundColor: Colors.green,
      borderRadius: Radius.pill,
      paddingHorizontal: Spacing.md,
      paddingVertical: 8,
    },
    addBtnText: {
      fontSize: Typography.sm,
      fontWeight: Typography.bold,
      color: Colors.bg,
    },
    scroll: {
      paddingHorizontal: Spacing.md,
    },

    list: {
      backgroundColor: Colors.surface,
      borderRadius: Radius.card,
      borderWidth: 1,
      borderColor: Colors.border,
      overflow: "hidden",
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      padding: Spacing.md,
    },
    rowBorder: {
      borderBottomWidth: 1,
      borderBottomColor: Colors.borderSub,
    },
    rowBody: {
      flex: 1,
      marginRight: Spacing.sm,
    },
    rowName: {
      fontSize: Typography.base,
      fontWeight: Typography.semibold,
      color: Colors.text,
      marginBottom: 3,
    },
    rowMeta: {
      fontSize: Typography.xs,
      color: Colors.textMuted,
      fontWeight: Typography.medium,
    },
    logBtn: {
      backgroundColor: Colors.green,
      borderRadius: Radius.pill,
      paddingHorizontal: Spacing.md,
      paddingVertical: 8,
      minWidth: 56,
      alignItems: "center",
    },
    logBtnText: {
      fontSize: Typography.sm,
      fontWeight: Typography.bold,
      color: Colors.bg,
    },

    emptyState: {
      alignItems: "center",
      paddingTop: Spacing.xxl,
      paddingHorizontal: Spacing.lg,
      gap: Spacing.sm,
    },
    emptyEmoji: {
      fontSize: 40,
      marginBottom: Spacing.xs,
    },
    emptyTitle: {
      fontSize: Typography.md,
      fontWeight: Typography.semibold,
      color: Colors.text,
    },
    emptySub: {
      fontSize: Typography.sm,
      color: Colors.textSub,
      textAlign: "center",
      lineHeight: 20,
      maxWidth: 300,
      marginBottom: Spacing.sm,
    },
    primaryBtn: {
      backgroundColor: Colors.green,
      borderRadius: Radius.pill,
      paddingVertical: 13,
      paddingHorizontal: Spacing.xl,
      alignItems: "center",
    },
    primaryBtnText: {
      fontSize: Typography.base,
      fontWeight: Typography.bold,
      color: Colors.bg,
      letterSpacing: 0.1,
    },
  }),
);

// Chip/caption tokens deliberately match ProductScreen's "when" card and
// TodayScreen's Logged/Planned pills (Colors.blue = planned, throughout the
// app) rather than inventing a third vocabulary for the same distinction.
const sheetStyles = StyleSheet.create(
  withDefaultFont({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.55)",
    },
    sheet: {
      backgroundColor: Colors.bg,
      borderTopLeftRadius: Radius.card,
      borderTopRightRadius: Radius.card,
      borderTopWidth: 1,
      borderColor: Colors.border,
      paddingHorizontal: Spacing.md,
      paddingTop: Spacing.sm,
      paddingBottom: Spacing.lg,
      gap: Spacing.sm,
    },
    grabber: {
      alignSelf: "center",
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: Colors.border,
      marginBottom: Spacing.sm,
    },
    title: {
      fontSize: Typography.md,
      fontWeight: Typography.bold,
      color: Colors.text,
      letterSpacing: -0.3,
      marginBottom: Spacing.xs,
    },
    cardSectionLabel: {
      fontSize: Typography.xs,
      fontWeight: Typography.semibold,
      color: Colors.textMuted,
      textTransform: "uppercase",
      letterSpacing: 0.6,
      marginBottom: Spacing.sm,
    },
    whenRow: {
      flexDirection: "row",
      gap: Spacing.sm,
    },
    whenChip: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: Spacing.sm,
      backgroundColor: Colors.surface2,
      borderRadius: Radius.control,
      borderWidth: 1,
      borderColor: Colors.border,
      paddingHorizontal: Spacing.sm,
      paddingVertical: Spacing.md,
    },
    whenChipPlanned: {
      backgroundColor: `${Colors.blue}12`,
      borderColor: `${Colors.blue}40`,
    },
    whenIcon: {
      fontSize: 15,
    },
    whenValue: {
      fontSize: Typography.base,
      fontWeight: Typography.bold,
      color: Colors.text,
      letterSpacing: -0.2,
      flexShrink: 1,
    },
    whenValueMono: {
      fontFamily: Fonts.mono.bold,
      fontVariant: ["tabular-nums"],
    },
    whenValuePlanned: {
      color: Colors.blue,
    },
    whenCaption: {
      fontSize: Typography.xs,
      color: Colors.textMuted,
      fontWeight: Typography.medium,
      marginTop: Spacing.sm,
    },
    whenCaptionStrong: {
      color: Colors.textSub,
      fontWeight: Typography.semibold,
    },
    actionsRow: {
      flexDirection: "row",
      gap: Spacing.sm,
      marginTop: Spacing.md,
    },
    cancelBtn: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 13,
      borderRadius: Radius.pill,
      backgroundColor: Colors.surface2,
      borderWidth: 1,
      borderColor: Colors.border,
    },
    cancelBtnText: {
      fontSize: Typography.base,
      fontWeight: Typography.bold,
      color: Colors.textSub,
    },
    confirmBtn: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 13,
      borderRadius: Radius.pill,
      backgroundColor: Colors.green,
    },
    confirmBtnPlanned: {
      backgroundColor: Colors.blue,
    },
    confirmBtnText: {
      fontSize: Typography.base,
      fontWeight: Typography.bold,
      color: Colors.bg,
      letterSpacing: 0.1,
    },
  }),
);
