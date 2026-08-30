// ============================================================
// src/components/DateTimeField.tsx
//
// Wraps @react-native-community/datetimepicker so every caller sees the
// same contract regardless of platform: onConfirm fires exactly once with
// a final value, or onCancel fires — never an intermediate value.
//
// Android's dialog already behaves this way (headless, fires onChange once
// with event.type "set" or "dismissed"), so that branch is a thin
// pass-through with display="default".
//
// iOS's display="default" renders an inline spinner that occupies layout
// space, fires onChange continuously as the wheel scrolls, and never sends
// a "dismissed" event — so a handler that commits on every onChange (the
// pattern this replaces) commits mid-scroll, including firing navigation
// or a write before the user has settled on a value. The iOS branch below
// holds the scroll in local state behind an explicit Cancel/Done sheet and
// only calls onConfirm/onCancel once.
// ============================================================

import React, { useEffect, useState } from "react";
import { Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";

import {
  Colors,
  Spacing,
  Radius,
  Typography,
  withDefaultFont,
} from "../theme/tokens";

interface DateTimeFieldProps {
  visible: boolean;
  value: Date;
  mode: "date" | "time";
  is24Hour?: boolean;
  onConfirm: (picked: Date) => void;
  onCancel: () => void;
}

export function DateTimeField(props: DateTimeFieldProps) {
  if (Platform.OS === "android") {
    return <AndroidDateTimeField {...props} />;
  }
  return <IOSDateTimeField {...props} />;
}

function AndroidDateTimeField({
  visible,
  value,
  mode,
  is24Hour,
  onConfirm,
  onCancel,
}: DateTimeFieldProps) {
  if (!visible) return null;

  return (
    <DateTimePicker
      value={value}
      mode={mode}
      is24Hour={is24Hour}
      display="default"
      onChange={(event: any, picked?: Date) => {
        if (event?.type === "dismissed" || !picked) {
          onCancel();
        } else {
          onConfirm(picked);
        }
      }}
    />
  );
}

function IOSDateTimeField({
  visible,
  value,
  mode,
  is24Hour,
  onConfirm,
  onCancel,
}: DateTimeFieldProps) {
  const [draft, setDraft] = useState(value);

  // Reset to the caller's seed every time the sheet opens — otherwise a
  // cancelled scroll would leak into the next open's starting position.
  useEffect(() => {
    if (visible) setDraft(value);
  }, [visible, value]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <Pressable style={sheetStyles.backdrop} onPress={onCancel} />
      <View style={sheetStyles.sheet}>
        <View style={sheetStyles.grabber} />

        <DateTimePicker
          value={draft}
          mode={mode}
          is24Hour={is24Hour}
          display="spinner"
          onChange={(_event: any, picked?: Date) => {
            if (picked) setDraft(picked);
          }}
        />

        <View style={sheetStyles.actionsRow}>
          <Pressable
            style={({ pressed }) => [
              sheetStyles.cancelBtn,
              pressed && { opacity: 0.8 },
            ]}
            onPress={onCancel}
          >
            <Text style={sheetStyles.cancelBtnText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              sheetStyles.confirmBtn,
              pressed && { opacity: 0.85 },
            ]}
            onPress={() => onConfirm(draft)}
          >
            <Text style={sheetStyles.confirmBtnText}>Done</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

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
    confirmBtnText: {
      fontSize: Typography.base,
      fontWeight: Typography.bold,
      color: Colors.bg,
      letterSpacing: 0.1,
    },
  }),
);
