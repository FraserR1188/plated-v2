// ============================================================
// src/components/CopyTargetPicker.tsx
//
// EXTRACTED FROM TodayScreen's CopyToSheet ("shared" mode's Day/Meal/Time
// rows), so the friend-copy path (CopyConfirmScreen) can present the exact
// same day/time/meal control instead of growing a second implementation of
// the day/time -> eaten_at chain.
//
// Day is always shown. Meal and Time are each independently optional —
// TodayScreen's "each" mode hides both together (per-entry time isn't a
// single value to show), but a caller collapsing a friend's meal_section
// (one shared meal_type across every entry) wants Time editable without
// necessarily wanting Meal editable in every case, so the two flags are not
// coupled here.
//
// The Planned/Logged pill is computed from THIS component's OWN dayKey/time
// via the same sameTimeOnDay + willBePlanned chain the actual insert goes
// through — never from a source entry's original eaten_at — so the preview
// can't drift from what lands. It only renders when showTimePicker is true;
// a caller hiding Time (no single instant to preview) renders its own pill
// from whatever it derives per-entry instead.
// ============================================================

import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";

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
  showTimePicker: boolean;
  mealType: MealType;
  onMealTypeChange: (mealType: MealType) => void;
  showMealPicker: boolean;
}

export function CopyTargetPicker({
  dayKey,
  onDayKeyChange,
  time,
  onTimeChange,
  showTimePicker,
  mealType,
  onMealTypeChange,
  showMealPicker,
}: CopyTargetPickerProps) {
  const [picking, setPicking] = useState<"date" | "time" | null>(null);

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
        <DateTimePicker
          value={parseDateKey(dayKey)}
          mode="date"
          display="default"
          onChange={(event: any, picked?: Date) => {
            setPicking(null);
            if (event?.type === "dismissed" || !picked) return;
            onDayKeyChange(dateKey(picked));
          }}
        />
      )}

      {picking === "time" && showTimePicker && (
        <DateTimePicker
          value={timeSeed}
          mode="time"
          is24Hour
          display="default"
          onChange={(event: any, picked?: Date) => {
            setPicking(null);
            if (event?.type === "dismissed" || !picked) return;
            onTimeChange({ hours: picked.getHours(), minutes: picked.getMinutes() });
          }}
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
