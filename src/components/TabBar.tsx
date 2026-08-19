// ============================================================
// src/components/TabBar.tsx
// ============================================================
// Custom bottom tab bar — green pill active indicator,
// dark surface background, safe-area aware.
// No hardcoded tab count — each tabItem is flex:1, so it divides evenly at
// 3, 4, or (as of Batches) 5 tabs. At 5, each tab's share shrinks by about a
// fifth versus 4 — labels use numberOfLines/adjustsFontSizeToFit as a
// defensive floor, but the actual fit on a real device hasn't been screen-
// checked from here (no device access in this environment) — eyeball it.
// ============================================================

import React, { useEffect, useRef } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Animated,
  Platform,
  AppState,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import {
  Colors,
  Radius,
  Spacing,
  Typography,
  Fonts,
  Overlay,
} from "../theme/tokens";
import { useStore } from "../store/useStore";

// Tab icon map — emoji/unicode placeholders.
// Swap these for your SVG icon components if you have them.
const TAB_ICONS: Record<string, { default: string; active: string }> = {
  Today: { default: "⊕", active: "⊕" },
  History: { default: "◫", active: "◫" },
  Friends: { default: "◎", active: "◎" },
  Batches: { default: "⊞", active: "⊞" },
  Settings: { default: "⊙", active: "⊙" },
};

// The accept gate is live: migration 20260819110000_friendship_accept_gate.sql
// converted follows into a mutual friendship (pending/accepted), and
// meal_entries_select_follower now requires status = 'accepted' in both
// directions — verified a pending row grants 0 cross-user meal_entries rows.
// The client (social.ts, FriendsScreen) is written against that policy set.
// Flip back to false, rather than deleting this flag, if a regression needs
// the tab hidden again without a redeploy.
const SOCIAL_ENABLED = true;

// ─── Single tab item ─────────────────────────────────────────

interface TabItemProps {
  label: string;
  focused: boolean;
  /** Unread count overlay on the icon. Omitted or 0 renders no badge — never a "0". */
  badgeCount?: number;
  onPress: () => void;
  onLongPress: () => void;
}

function TabItem({
  label,
  focused,
  badgeCount,
  onPress,
  onLongPress,
}: TabItemProps) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const icons = TAB_ICONS[label] ?? { default: "·", active: "·" };

  // Subtle pop on focus
  useEffect(() => {
    if (focused) {
      Animated.sequence([
        Animated.timing(scaleAnim, {
          toValue: 0.88,
          duration: 80,
          useNativeDriver: true,
        }),
        Animated.spring(scaleAnim, {
          toValue: 1,
          useNativeDriver: true,
          damping: 12,
          stiffness: 200,
        }),
      ]).start();
    }
  }, [focused]);

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={styles.tabItem}
      accessibilityRole="button"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={label}
    >
      <Animated.View
        style={[
          styles.tabInner,
          focused && styles.tabInnerActive,
          { transform: [{ scale: scaleAnim }] },
        ]}
      >
        <View style={styles.iconWrap}>
          <Text
            style={[
              styles.tabIcon,
              { color: focused ? Colors.green : Colors.textMuted },
            ]}
          >
            {focused ? icons.active : icons.default}
          </Text>
          {!!badgeCount && badgeCount > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText} numberOfLines={1}>
                {badgeCount > 9 ? "9+" : badgeCount}
              </Text>
            </View>
          )}
        </View>
        <Text
          style={[
            styles.tabLabel,
            { color: focused ? Colors.green : Colors.textMuted },
          ]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.8}
        >
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

// ─── Tab bar ─────────────────────────────────────────────────

export function TabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const incomingRequestCount = useStore((s) => s.incomingRequestCount);
  const fetchIncomingRequestCount = useStore(
    (s) => s.fetchIncomingRequestCount,
  );

  // Refresh on mount and on app foreground. No polling — there is no push
  // infrastructure, so this badge is deliberately eventually-consistent
  // within a session. Skipped entirely while the tab is hidden: no point
  // spending a request on a count nobody can see.
  useEffect(() => {
    if (!SOCIAL_ENABLED) return;

    fetchIncomingRequestCount();

    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") fetchIncomingRequestCount();
    });
    return () => sub.remove();
  }, [fetchIncomingRequestCount]);

  return (
    <View
      style={[
        styles.container,
        { paddingBottom: Math.max(insets.bottom, Spacing.sm) },
      ]}
    >
      <View style={styles.inner}>
        {state.routes.map((route, index) => {
          if (route.name === "Friends" && !SOCIAL_ENABLED) return null;

          const { options } = descriptors[route.key];
          const label =
            typeof options.tabBarLabel === "string"
              ? options.tabBarLabel
              : (options.title ?? route.name);

          const focused = state.index === index;

          const onPress = () => {
            const event = navigation.emit({
              type: "tabPress",
              target: route.key,
              canPreventDefault: true,
            });
            if (!focused && !event.defaultPrevented) {
              navigation.navigate(route.name);
            }
          };

          const onLongPress = () => {
            navigation.emit({
              type: "tabLongPress",
              target: route.key,
            });
          };

          return (
            <TabItem
              key={route.key}
              label={label}
              focused={focused}
              badgeCount={
                route.name === "Friends" ? incomingRequestCount : undefined
              }
              onPress={onPress}
              onLongPress={onLongPress}
            />
          );
        })}
      </View>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    backgroundColor: Colors.surface,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingTop: Spacing.xs,
  },
  inner: {
    flexDirection: "row",
    paddingHorizontal: Spacing.xs,
  },

  // Each tab takes equal space
  tabItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: Spacing.xs,
  },

  // Pill wrapper — only visible when focused
  tabInner: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: Radius.pill,
    gap: 2,
  },
  tabInnerActive: {
    backgroundColor: `${Colors.green}15`,
  },

  iconWrap: {
    position: "relative",
  },
  tabIcon: {
    fontSize: 20,
    lineHeight: 24,
  },
  badge: {
    position: "absolute",
    top: -4,
    right: -8,
    minWidth: 15,
    height: 15,
    borderRadius: 8,
    paddingHorizontal: 3,
    backgroundColor: Colors.danger,
    borderWidth: 1,
    borderColor: Colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    fontSize: 9,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Overlay.white,
  },
  tabLabel: {
    fontSize: Typography.xs,
    fontWeight: Typography.medium,
    fontFamily: Fonts.sans.medium,
    letterSpacing: 0.2,
  },
});
