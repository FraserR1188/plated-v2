// ============================================================
// src/components/KeyboardScreen.tsx
//
// The one keyboard-avoiding container for every screen with a text input
// (PL-004). targetSdk 36 makes Android edge-to-edge, where adjustResize no
// longer shrinks the window: the keyboard arrives as an inset change and
// draws over whatever is underneath. keyboard-controller's
// KeyboardAvoidingView reads that inset directly and behaves the same on
// both platforms, so there's no Platform.OS branch here or at any call
// site — the same one-contract shape as DateTimeField.
//
// behavior="padding": the view pads its bottom by however much of the
// keyboard overlaps it, so a flex: 1 ScrollView shrinks and a footer below
// it in normal layout rides on top of the keyboard. ("height" freezes the
// height measured at layout and forces flex: 0, which fights flex: 1.)
//
// OFFSET. keyboard-controller measures its frame relative to its parent,
// so it under-lifts by the distance from the top of the screen to the top
// of that parent. Under a native-stack header that distance is the header
// height, which is what HeaderHeightContext holds. It's read with
// useContext, not useHeaderHeight(), which throws outside a navigator.
// native-stack and bottom-tabs put 0 there for headerShown: false screens,
// and outside any navigator it's undefined, so 0.
// Sheets rendered in a Modal pass offset={0}: the context passes through
// the Modal portal, so a sheet would otherwise inherit its host screen's
// header height.
//
// USE: directly inside the screen's root view (the SafeAreaView at the top
// of the screen), around a ScrollView with flex: 1 and
// keyboardShouldPersistTaps="handled", plus any footer in normal layout.
// Not position: absolute — an absolutely positioned footer isn't
// guaranteed to follow the padding.
// ============================================================

import React, { useContext } from "react";
import { StyleProp, StyleSheet, ViewStyle } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { HeaderHeightContext } from "@react-navigation/elements";

type Props = {
  children: React.ReactNode;
  /** Distance from the top of the screen to this view's parent. Defaults to
   *  the navigator's header height; sheets in a Modal pass 0. */
  offset?: number;
  style?: StyleProp<ViewStyle>;
};

export function KeyboardScreen({ children, offset, style }: Props) {
  const headerHeight = useContext(HeaderHeightContext);
  return (
    <KeyboardAvoidingView
      behavior="padding"
      keyboardVerticalOffset={offset ?? headerHeight ?? 0}
      style={[styles.fill, style]}
    >
      {children}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
