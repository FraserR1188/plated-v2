/**
 * UI Primitives for plated
 *
 * Shared, composable building blocks. Import from here so visual
 * consistency is enforced at the component level, not repeated in every screen.
 */

import React from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextStyle,
  View,
  ViewStyle,
} from "react-native";
import { Colors, Radius, Spacing, Typography } from "../theme";

// ─── Card ────────────────────────────────────────────────────────────────────

type CardProps = {
  children: React.ReactNode;
  style?: ViewStyle;
  onPress?: () => void;
  /** 'default' | 'inner' — inner cards sit inside a default card */
  variant?: "default" | "inner";
};

export function Card({
  children,
  style,
  onPress,
  variant = "default",
}: CardProps) {
  const baseStyle = variant === "inner" ? styles.cardInner : styles.card;

  if (onPress) {
    return (
      <Pressable
        style={({ pressed }) => [
          baseStyle,
          pressed && styles.cardPressed,
          style,
        ]}
        onPress={onPress}
      >
        {children}
      </Pressable>
    );
  }
  return <View style={[baseStyle, style]}>{children}</View>;
}

// ─── SectionHeader ───────────────────────────────────────────────────────────

type SectionHeaderProps = {
  title: string;
  action?: string;
  onAction?: () => void;
  style?: ViewStyle;
};

export function SectionHeader({
  title,
  action,
  onAction,
  style,
}: SectionHeaderProps) {
  return (
    <View style={[styles.sectionRow, style]}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action && (
        <Pressable onPress={onAction} hitSlop={12}>
          <Text style={styles.sectionAction}>{action}</Text>
        </Pressable>
      )}
    </View>
  );
}

// ─── Badge ───────────────────────────────────────────────────────────────────

type BadgeProps = {
  label: string;
  color?: string; // text + border colour — defaults to green
  style?: ViewStyle;
};

export function Badge({ label, color = Colors.green, style }: BadgeProps) {
  return (
    <View style={[styles.badge, { borderColor: `${color}40` }, style]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

// ─── Pill ────────────────────────────────────────────────────────────────────

type PillProps = {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  style?: ViewStyle;
};

export function Pill({ label, selected = false, onPress, style }: PillProps) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.pill, selected && styles.pillSelected, style]}
    >
      <Text style={[styles.pillText, selected && styles.pillTextSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}

// ─── Divider ─────────────────────────────────────────────────────────────────

type DividerProps = {
  style?: ViewStyle;
  inset?: number; // horizontal inset in dp
};

export function Divider({ style, inset = 0 }: DividerProps) {
  return (
    <View
      style={[styles.divider, inset > 0 && { marginHorizontal: inset }, style]}
    />
  );
}

// ─── EmptyState ──────────────────────────────────────────────────────────────

type EmptyStateProps = {
  icon?: string; // emoji or short text
  title: string;
  subtitle?: string;
  action?: string;
  onAction?: () => void;
  style?: ViewStyle;
};

export function EmptyState({
  icon,
  title,
  subtitle,
  action,
  onAction,
  style,
}: EmptyStateProps) {
  return (
    <View style={[styles.emptyState, style]}>
      {icon ? <Text style={styles.emptyIcon}>{icon}</Text> : null}
      <Text style={styles.emptyTitle}>{title}</Text>
      {subtitle ? <Text style={styles.emptySubtitle}>{subtitle}</Text> : null}
      {action ? (
        <Pressable onPress={onAction} style={styles.emptyAction}>
          <Text style={styles.emptyActionText}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // Card
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
  },
  cardInner: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Colors.borderSub,
    padding: Spacing.md,
  },
  cardPressed: {
    opacity: 0.75,
  },

  // SectionHeader
  sectionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: Spacing.sm,
  },
  sectionTitle: {
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.text,
    letterSpacing: 0.1,
  },
  sectionAction: {
    fontSize: Typography.sm,
    fontWeight: Typography.medium,
    color: Colors.green,
  },

  // Badge
  badge: {
    borderRadius: Radius.full,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
    alignSelf: "flex-start",
  },
  badgeText: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    letterSpacing: 0.2,
  },

  // Pill
  pill: {
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs + 2,
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  pillSelected: {
    backgroundColor: Colors.greenSoft,
    borderColor: `${Colors.green}50`,
  },
  pillText: {
    fontSize: Typography.sm,
    fontWeight: Typography.medium,
    color: Colors.textSub,
  },
  pillTextSelected: {
    color: Colors.green,
  },

  // Divider
  divider: {
    height: 1,
    backgroundColor: Colors.border,
  },

  // EmptyState
  emptyState: {
    alignItems: "center",
    paddingVertical: Spacing.xxl,
    gap: Spacing.sm,
  },
  emptyIcon: {
    fontSize: 40,
    marginBottom: Spacing.xs,
  },
  emptyTitle: {
    fontSize: Typography.md,
    fontWeight: Typography.semibold,
    color: Colors.text,
    textAlign: "center",
  },
  emptySubtitle: {
    fontSize: Typography.base,
    color: Colors.textSub,
    textAlign: "center",
    maxWidth: 260,
    lineHeight: Typography.base * 1.5,
  },
  emptyAction: {
    marginTop: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    backgroundColor: Colors.greenSoft,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: `${Colors.green}50`,
  },
  emptyActionText: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    color: Colors.green,
  },
});
