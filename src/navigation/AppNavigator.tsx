// ============================================================
// src/navigation/AppNavigator.tsx
// ============================================================
//
// Structure:
//   Stack navigator (root)
//   └── MainTabs (bottom tab bar)
//       ├── Today    → TodayScreen
//       ├── Data     → DataScreen      ← History | Trends, one screen
//       ├── Insights → InsightsScreen   ← centre slot, stub for now
//       ├── Batches  → BatchesScreen
//       └── Settings → SettingsScreen
//   ├── Friends        (push, native header)  ← was a tab; opened from the
//   │                                            Friends row in Settings
//   ├── AddIngredient  (modal)
//   ├── Scanner        (full-screen modal)
//   ├── Product        (modal)
//   ├── BatchEditor / BatchIngredientPicker / RecipeScan / RecipeConfirm (modals)
//   ├── ConnectedUserLog  (push)
//   ├── CopyConfirm       (push)
//   └── BundleApplyReview (push — apply-time quantity review)
//
// Friends sits on the ROOT stack, not inside a tab: ConnectedUserLog and
// CopyConfirm are already siblings here, so their pushes and native-header
// backs are unchanged. The one call that CARED was CopyConfirm's exit —
// popToTop() used to land on whichever tab was active, which was Friends
// and is now Settings. It pops to Today on the copied day instead; see
// src/lib/copyDestination.ts.
// ============================================================

import React, { useRef } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import {
  NavigationContainer,
  useNavigationContainerRef,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import * as Sentry from "@sentry/react-native";

import { TodayScreen } from "../screens/TodayScreen";
import { DataScreen } from "../screens/DataScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { AddIngredientScreen } from "../screens/AddIngredientScreen";
import { ScannerScreen } from "../screens/ScannerScreen";
import { ProductScreen } from "../screens/ProductScreen";
import { FriendsScreen } from "../screens/FriendsScreen";
import { InsightsScreen } from "../screens/InsightsScreen";
import { BatchesScreen } from "../screens/BatchesScreen";
import { BatchEditorScreen } from "../screens/BatchEditorScreen";
import { BundleApplyReviewScreen } from "../screens/BundleApplyReviewScreen";
import { BatchIngredientPickerScreen } from "../screens/BatchIngredientPickerScreen";
import { RecipeScanScreen } from "../screens/RecipeScanScreen";
import { RecipeConfirmScreen } from "../screens/RecipeConfirmScreen";
import { ConnectedUserLogScreen } from "../screens/ConnectedUserLogScreen";
import { CopyConfirmScreen } from "../screens/CopyConfirmScreen";
import { TabBar } from "../components/TabBar";
import { Colors, Fonts, NavTheme, Typography } from "../theme/tokens";
import { RootStackParamList, BottomTabParamList } from "../types";
import { CreateFoodScreen } from "../screens/CreateFoodScreen";
import { AboutScreen } from "../screens/AboutScreen";
import { DeleteAccountScreen } from "../screens/DeleteAccountScreen";

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<BottomTabParamList>();

// Header actions rendered into the native header — tokens only, matching
// the screen-drawn headers elsewhere (BatchEditor, CreateFood).
const headerStyles = StyleSheet.create({
  action: {
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    fontFamily: Fonts.sans.bold,
    color: Colors.green,
  },
});

// ─── Bottom tabs ─────────────────────────────────────────────
//
// No tabBarIcon options here. MainTabs uses a fully custom `tabBar` prop
// (TabBar, below), which keys its own icon map off the ROUTE NAME and
// never reads options.tabBarIcon — so the pair of TAB_ICONS/TabIcon that
// used to sit here rendered nothing at all, existed only to satisfy the
// typed option, and had already drifted from the icons actually on screen.
// TabBar.tsx is the one place an icon is now declared, and its map is
// typed to BottomTabParamList so a tab without one won't compile.

function MainTabs() {
  return (
    <Tab.Navigator
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tab.Screen
        name="Today"
        component={TodayScreen}
        options={{ tabBarLabel: "Today" }}
      />
      <Tab.Screen
        name="Data"
        component={DataScreen}
        options={{ tabBarLabel: "Data" }}
      />
      {/* Centre of five, deliberately: this is where the product's
          differentiator lands once the readiness query exists. */}
      <Tab.Screen
        name="Insights"
        component={InsightsScreen}
        options={{ tabBarLabel: "Insights" }}
      />
      <Tab.Screen
        name="Batches"
        component={BatchesScreen}
        options={{ tabBarLabel: "Batches" }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ tabBarLabel: "Settings" }}
      />
    </Tab.Navigator>
  );
}

// ─── Root stack ──────────────────────────────────────────────

export function AppNavigator() {
  const navigationRef = useNavigationContainerRef<RootStackParamList>();
  const routeNameRef = useRef<string | undefined>(undefined);

  return (
    <NavigationContainer
      theme={NavTheme}
      ref={navigationRef}
      onReady={() => {
        routeNameRef.current = navigationRef.getCurrentRoute()?.name;
      }}
      onStateChange={() => {
        const current = navigationRef.getCurrentRoute()?.name;
        if (current && routeNameRef.current !== current) {
          Sentry.addBreadcrumb({
            category: "navigation",
            message: current,
            level: "info",
          });
          routeNameRef.current = current;
        }
      }}
    >
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: Colors.surface },
          headerTintColor: Colors.text,
          headerTitleStyle: {
            fontWeight: "600",
            fontFamily: Fonts.sans.semibold,
            fontSize: 17,
          },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: Colors.bg },
        }}
      >
        {/* Tabs — no header */}
        <Stack.Screen
          name="MainTabs"
          component={MainTabs}
          options={{ headerShown: false }}
        />

        {/* Existing modals */}
        <Stack.Screen
          name="AddIngredient"
          component={AddIngredientScreen}
          options={{
            presentation: "modal",
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="Scanner"
          component={ScannerScreen}
          options={{
            presentation: "fullScreenModal",
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="Product"
          component={ProductScreen}
          options={{
            presentation: "modal",
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="CreateFood"
          component={CreateFoodScreen}
          options={{
            presentation: "modal",
            headerShown: false, // screen draws its own header
          }}
        />

        {/* Friends — pushed from the Settings row, with the native header
            so it has the platform back affordance. Its own sub-flow
            (ConnectedUserLog, CopyConfirm) are siblings below. */}
        <Stack.Screen
          name="Friends"
          component={FriendsScreen}
          options={{ title: "Friends" }}
        />
        <Stack.Screen
          name="BatchEditor"
          component={BatchEditorScreen}
          options={{
            presentation: "modal",
            headerShown: false, // screen draws its own header
          }}
        />
        <Stack.Screen
          name="BatchIngredientPicker"
          component={BatchIngredientPickerScreen}
          options={{
            presentation: "modal",
            headerShown: false, // screen draws its own header
          }}
        />
        <Stack.Screen
          name="RecipeScan"
          component={RecipeScanScreen}
          options={{
            presentation: "modal",
            headerShown: false, // screen draws its own header
          }}
        />
        <Stack.Screen
          name="RecipeConfirm"
          component={RecipeConfirmScreen}
          options={{
            presentation: "modal",
            headerShown: false, // screen draws its own header
          }}
        />

        {/* Social screens — standard push transitions */}
        <Stack.Screen
          name="ConnectedUserLog"
          component={ConnectedUserLogScreen}
          options={{ title: "" }} // title set dynamically in screen via setOptions
        />
        <Stack.Screen
          name="CopyConfirm"
          component={CopyConfirmScreen}
          options={{ title: "Confirm copy" }}
        />
        <Stack.Screen
          name="BundleApplyReview"
          component={BundleApplyReviewScreen}
          options={{ title: "Adjust & apply" }}
        />
        <Stack.Screen
          name="About"
          component={AboutScreen}
          options={{ title: "About & legal" }}
        />
        <Stack.Screen
          name="DeleteAccount"
          component={DeleteAccountScreen}
          options={{ title: "Delete account" }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
