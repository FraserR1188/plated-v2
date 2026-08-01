/**
 * ScreenWrapper
 *
 * A single component that handles safe area insets correctly for every screen
 * type in plated. Use this instead of raw <SafeAreaView> on every screen.
 *
 * Usage:
 *
 *   // Standard tab screen (top + sides, tab bar handles bottom):
 *   <ScreenWrapper>...</ScreenWrapper>
 *
 *   // Modal / sheet (bottom too):
 *   <ScreenWrapper edges={['top','bottom','left','right']}>...</ScreenWrapper>
 *
 *   // Screen that uses a ScrollView — pass scrollable and the wrapper
 *   // sets flex:1 but does NOT add padding so the scroll content can breathe:
 *   <ScreenWrapper scrollable>
 *     <ScrollView contentContainerStyle={{ padding: Spacing.md }}>
 *       ...
 *     </ScrollView>
 *   </ScreenWrapper>
 */

import React from "react";
import { StyleSheet, View, ViewStyle } from "react-native";
import { SafeAreaView, Edge } from "react-native-safe-area-context";
import { Colors, Spacing } from "../theme/tokens";

type Props = {
  children: React.ReactNode;
  /**
   * Which edges to apply safe-area insets on.
   * Default: ['top', 'left', 'right']
   * (Bottom is omitted by default because the tab bar handles it.)
   */
  edges?: Edge[];
  /**
   * When true the wrapper doesn't add its own padding so an inner ScrollView
   * can control its own contentContainerStyle.
   */
  scrollable?: boolean;
  style?: ViewStyle;
};

export function ScreenWrapper({
  children,
  edges = ["top", "left", "right"],
  scrollable = false,
  style,
}: Props) {
  return (
    <SafeAreaView style={[styles.safe, style]} edges={edges}>
      {scrollable ? children : <View style={styles.inner}>{children}</View>}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  inner: {
    flex: 1,
    paddingHorizontal: Spacing.md,
  },
});
