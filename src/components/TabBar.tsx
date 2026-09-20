// ============================================================
// src/components/TabBar.tsx
// ============================================================
// Custom bottom tab bar — green pill active indicator,
// dark surface background, safe-area aware.
// No hardcoded tab count — each tabItem is flex:1, so it divides evenly at
// 3, 4 or 5 tabs. Batches left the bar when it became a pushed screen off
// Today's header; the slot it freed is what Insights now occupies, so the
// count is unchanged at 5. At 5 and 360dp each tab gets ~70dp, of which
// ~42dp is label room after the pill's padding — the widest label in use
// ("Settings") measures ~41dp, so labels fit without shrinking, and
// numberOfLines/adjustsFontSizeToFit remain as the defensive floor for a
// larger system font scale.
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
import { BottomTabParamList } from "../types";

// Tab icon map — emoji/unicode placeholders.
// Swap these for your SVG icon components if you have them.
//
// Keyed by ROUTE NAME and typed to BottomTabParamList, not Record<string>
// and not the tab's label: a label is a display string that nothing stops
// drifting from the route, and under Record<string> a tab with no entry
// here compiled cleanly and silently rendered the "·" placeholder below.
// Adding a tab without an icon is now a compile error at this literal.
const TAB_ICONS: Record<
  keyof BottomTabParamList,
  { default: string; active: string }
> = {
  Today: { default: "⊕", active: "⊕" },
  History: { default: "◫", active: "◫" },
  Friends: { default: "◎", active: "◎" },
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
  /** Resolved by the caller from the route name — see TAB_ICONS. */
  icons: { default: string; active: string };
  focused: boolean;
  /** Unread count overlay on the icon. Omitted or 0 renders no badge — never a "0". */
  badgeCount?: number;
  onPress: () => void;
  onLongPress: () => void;
}

function TabItem({
  label,
  icons,
  focused,
  badgeCount,
  onPress,
  onLongPress,
}: TabItemProps) {
  const scaleAnim = useRef(new Animated.Value(1)).current;

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

          // Unreachable by typing — TAB_ICONS covers every
          // BottomTabParamList key — but a tab bar that throws is a worse
          // failure than one placeholder glyph, so the fallback stays.
          const icons = TAB_ICONS[route.name as keyof BottomTabParamList] ?? {
            default: "·",
            active: "·",
          };

          return (
            <TabItem
              key={route.key}
              label={label}
              icons={icons}
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
