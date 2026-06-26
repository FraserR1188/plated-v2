// ============================================================
// src/components/TabBar.tsx
// ============================================================
// Custom bottom tab bar — green pill active indicator,
// dark surface background, safe-area aware.
// Supports 3 or 4 tabs without any hardcoded tab count.
// ============================================================

import React, { useEffect, useRef } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Animated,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { Colors, Radius, Spacing, Typography } from "../theme";

// Tab icon map — emoji/unicode placeholders.
// Swap these for your SVG icon components if you have them.
const TAB_ICONS: Record<string, { default: string; active: string }> = {
  Today: { default: "⊕", active: "⊕" },
  History: { default: "◫", active: "◫" },
  Friends: { default: "◎", active: "◎" },
  Settings: { default: "⊙", active: "⊙" },
};

// ─── Single tab item ─────────────────────────────────────────

interface TabItemProps {
  label: string;
  focused: boolean;
  onPress: () => void;
  onLongPress: () => void;
}

function TabItem({ label, focused, onPress, onLongPress }: TabItemProps) {
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
        <Text
          style={[
            styles.tabIcon,
            { color: focused ? Colors.green : Colors.textMuted },
          ]}
        >
          {focused ? icons.active : icons.default}
        </Text>
        <Text
          style={[
            styles.tabLabel,
            { color: focused ? Colors.green : Colors.textMuted },
          ]}
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

  return (
    <View
      style={[
        styles.container,
        { paddingBottom: Math.max(insets.bottom, Spacing.sm) },
      ]}
    >
      <View style={styles.inner}>
        {state.routes.map((route, index) => {
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
    borderRadius: Radius.full,
    gap: 2,
  },
  tabInnerActive: {
    backgroundColor: `${Colors.green}15`,
  },

  tabIcon: {
    fontSize: 20,
    lineHeight: 24,
  },
  tabLabel: {
    fontSize: Typography.xs,
    fontWeight: Typography.medium,
    letterSpacing: 0.2,
  },
});
