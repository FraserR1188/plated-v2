// ============================================================
// src/screens/BatchesScreen.tsx
// ============================================================
// The "Batches" tab. Lists compositions of kind='batch' only — bundles live
// entirely in TodayScreen's sheets, unchanged, and never appear here. Tap a
// row to edit it; tap "Log" to apply it right now (log-now only for v1 — no
// day, no time picker, because there is nothing to pick: eaten_at is always
// "now"). Long-press to delete.
// ============================================================

import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
  RefreshControl,
} from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SafeAreaView } from "react-native-safe-area-context";
import { useStore } from "../store/useStore";
import { batchPortionCalories } from "../lib/compositions";
import {
  Colors,
  Spacing,
  Radius,
  Typography,
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

  const handleLog = async (batch: MealCompositionWithItems) => {
    setLoggingId(batch.id);
    const { error } = await applyBatchNow(batch);
    setLoggingId(null);
    if (error) {
      Alert.alert("Couldn't log that", error);
    } else {
      // Native Alert as the confirmation — same "toast-style feedback"
      // pattern CopyConfirmScreen already uses, not a custom toast component.
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
    </SafeAreaView>
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
