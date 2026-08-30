// ============================================================
// src/components/CopyTargetPicker.tsx
//
// EXTRACTED FROM TodayScreen's CopyToSheet ("shared" mode's Day/Meal/Time
// rows), so the friend-copy path (CopyConfirmScreen) can present the exact
// same day/time/meal control instead of growing a second implementation of
// the day/time -> eaten_at chain.
//
// Day is always shown. mode="shared" also shows Meal and Time — one chosen
// {meal_type, time} applied to every entry the caller is copying. mode="each"
// hides both: the caller is preserving each entry's own section (and, for
// TodayScreen specifically, its own wall-clock via draftsFromDay) instead of
// collapsing onto one. There is no "show Time but not Meal" combination —
// every caller's copy is either one fully-chosen slot or "just move the day."
//
// The Planned/Logged pill is computed from THIS component's OWN dayKey/time
// via the same sameTimeOnDay + willBePlanned chain the actual insert goes
// through — never from a source entry's original eaten_at — so the preview
// can't drift from what lands. It only renders in "shared" mode; an "each"
// caller renders its own pill from whatever it derives per-entry instead.
// ============================================================

import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { DateTimeField } from "./DateTimeField";

import {
  Colors,
  Spacing,
  Typography,
  Radius,
  Fonts,
} from "../theme/tokens";
import { MealType, MEAL_TYPES, MEAL_LABELS } from "../types";
import {
  TimeOfDay,
  dateKey,
  parseDateKey,
  formatDayLabel,
  formatTimeOfDay,
  sameTimeOnDay,
  willBePlanned,
} from "../lib/time";

interface CopyTargetPickerProps {
  dayKey: string;
  onDayKeyChange: (dayKey: string) => void;
  time: TimeOfDay;
  onTimeChange: (time: TimeOfDay) => void;
  mealType: MealType;
  onMealTypeChange: (mealType: MealType) => void;
  mode: "shared" | "each";
}

export function CopyTargetPicker({
  dayKey,
  onDayKeyChange,
  time,
  onTimeChange,
  mealType,
  onMealTypeChange,
  mode,
}: CopyTargetPickerProps) {
  const [picking, setPicking] = useState<"date" | "time" | null>(null);
  const showTimePicker = mode === "shared";
  const showMealPicker = mode === "shared";

  const timeSeed = new Date();
  timeSeed.setHours(time.hours, time.minutes, 0, 0);

  const prospectiveEatenAt = sameTimeOnDay(time, dayKey);
  const planned = willBePlanned(prospectiveEatenAt);

  return (
    <>
      <Pressable style={styles.row} onPress={() => setPicking("date")}>
        <Text style={styles.rowLabel}>Day</Text>
        <Text style={styles.rowValue}>{formatDayLabel(dayKey)}</Text>
      </Pressable>

      {showMealPicker && (
        <>
          <Text style={styles.rowLabel}>Meal</Text>
          <View style={styles.segmented}>
            {MEAL_TYPES.map((mt) => (
              <Pressable
                key={mt}
                style={[styles.segment, mealType === mt && styles.segmentActive]}
                onPress={() => onMealTypeChange(mt)}
              >
                <Text
                  style={[
                    styles.segmentText,
                    mealType === mt && styles.segmentTextActive,
                  ]}
                >
                  {MEAL_LABELS[mt]}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      )}

      {showTimePicker && (
        <Pressable style={styles.row} onPress={() => setPicking("time")}>
          <Text style={styles.rowLabel}>Time</Text>
          <Text style={styles.rowValue}>{formatTimeOfDay(time)}</Text>
        </Pressable>
      )}

      {showTimePicker && (
        <View
          style={[styles.pill, planned ? styles.pillPlanned : styles.pillLogged]}
        >
          <Text
            style={[
              styles.pillText,
              planned ? styles.pillTextPlanned : styles.pillTextLogged,
            ]}
          >
            {planned ? "Will be saved as Planned" : "Will be saved as Logged"}
          </Text>
        </View>
      )}

      {picking === "date" && (
        <DateTimeField
          visible={picking === "date"}
          value={parseDateKey(dayKey)}
          mode="date"
          onConfirm={(picked) => {
            setPicking(null);
            onDayKeyChange(dateKey(picked));
          }}
          onCancel={() => setPicking(null)}
        />
      )}

      {picking === "time" && showTimePicker && (
        <DateTimeField
          visible={picking === "time" && showTimePicker}
          value={timeSeed}
          mode="time"
          is24Hour
          onConfirm={(picked) => {
            setPicking(null);
            onTimeChange({ hours: picked.getHours(), minutes: picked.getMinutes() });
          }}
          onCancel={() => setPicking(null)}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: Colors.surface,
    borderRadius: Radius.control,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
  },
  rowLabel: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
    fontWeight: Typography.semibold,
    fontFamily: Fonts.sans.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  rowValue: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.text,
  },
  segmented: {
    flexDirection: "row",
    gap: 6,
  },
  segment: {
    flex: 1,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentActive: {
    backgroundColor: Colors.greenSoft,
    borderColor: `${Colors.green}60`,
  },
  segmentText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.textMuted,
  },
  segmentTextActive: {
    color: Colors.green,
  },
  pill: {
    alignSelf: "center",
    marginTop: Spacing.xs,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  pillPlanned: {
    backgroundColor: `${Colors.blue}12`,
    borderColor: `${Colors.blue}40`,
  },
  pillLogged: {
    backgroundColor: Colors.greenSoft,
    borderColor: `${Colors.green}40`,
  },
  pillText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
  },
  pillTextPlanned: { color: Colors.blue },
  pillTextLogged: { color: Colors.green },
});
