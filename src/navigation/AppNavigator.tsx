// ============================================================
// src/navigation/AppNavigator.tsx — updated for social feature
// ============================================================
//
// Structure:
//   Stack navigator (root)
//   └── MainTabs (bottom tab bar)
//       ├── Today    → TodayScreen
//       ├── History  → HistoryScreen
//       ├── Friends  → FriendsScreen        ← NEW
//       └── Settings → SettingsScreen
//   ├── AddIngredient  (modal)
//   ├── Scanner        (full-screen modal)
//   ├── Product        (modal)
//   ├── ConnectedUserLog  (push)             ← NEW
//   ├── CopyConfirm       (push)             ← NEW
//   └── BundleApplyReview (push)             ← NEW (apply-time quantity review)
// ============================================================

import React, { useRef } from "react";
import { Text } from "react-native";
import {
  NavigationContainer,
  useNavigationContainerRef,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import * as Sentry from "@sentry/react-native";

import { TodayScreen } from "../screens/TodayScreen";
import { HistoryScreen } from "../screens/HistoryScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { AddIngredientScreen } from "../screens/AddIngredientScreen";
import { ScannerScreen } from "../screens/ScannerScreen";
import { ProductScreen } from "../screens/ProductScreen";
import { FriendsScreen } from "../screens/FriendsScreen";
import { BatchesScreen } from "../screens/BatchesScreen";
import { BatchEditorScreen } from "../screens/BatchEditorScreen";
import { BundleApplyReviewScreen } from "../screens/BundleApplyReviewScreen";
import { BatchIngredientPickerScreen } from "../screens/BatchIngredientPickerScreen";
import { RecipeScanScreen } from "../screens/RecipeScanScreen";
import { RecipeConfirmScreen } from "../screens/RecipeConfirmScreen";
import { ConnectedUserLogScreen } from "../screens/ConnectedUserLogScreen";
import { CopyConfirmScreen } from "../screens/CopyConfirmScreen";
import { TabBar } from "../components/TabBar";
import { Colors, Fonts, NavTheme } from "../theme/tokens";
import { RootStackParamList, BottomTabParamList } from "../types";
import { CreateFoodScreen } from "../screens/CreateFoodScreen";
import { AboutScreen } from "../screens/AboutScreen";
import { DeleteAccountScreen } from "../screens/DeleteAccountScreen";

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<BottomTabParamList>();

// ─── Tab icons ───────────────────────────────────────────────
//
// ⚠ THIS MAP DOESN'T ACTUALLY RENDER ANYTHING. MainTabs uses a fully custom
// `tabBar` prop (TabBar, below), and TabBar.tsx keys its OWN icon lookup off
// the route LABEL, never reading `options.tabBarIcon` from here. This map
// (and TabIcon below) only exists to satisfy React Navigation's typed
// `tabBarIcon` option — pre-existing before Batches, not introduced by it.
// The icon that actually shows up is TabBar.tsx's TAB_ICONS. Kept both in
// sync below so this doesn't quietly rot further, but if you're trying to
// change what's on screen, that file is the one to edit.

const TAB_ICONS: Record<keyof BottomTabParamList, string> = {
  Today: "○", // replace with your SVG icon components
  History: "◫",
  Friends: "◎", // ← people / friends icon
  Batches: "⊞",
  Settings: "⊙",
};

function TabIcon({
  name,
  focused,
}: {
  name: keyof BottomTabParamList;
  focused: boolean;
}) {
  return (
    <Text
      style={{
        fontSize: 22,
        opacity: focused ? 1 : 0.45,
        color: focused ? Colors.green : Colors.text,
      }}
    >
      {TAB_ICONS[name]}
    </Text>
  );
}

// ─── Bottom tabs ─────────────────────────────────────────────

function MainTabs() {
  return (
    <Tab.Navigator
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tab.Screen
        name="Today"
        component={TodayScreen}
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon name="Today" focused={focused} />
          ),
          tabBarLabel: "Today",
        }}
      />
      <Tab.Screen
        name="History"
        component={HistoryScreen}
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon name="History" focused={focused} />
          ),
          tabBarLabel: "History",
        }}
      />
      <Tab.Screen
        name="Friends"
        component={FriendsScreen}
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon name="Friends" focused={focused} />
          ),
          tabBarLabel: "Friends",
        }}
      />
      <Tab.Screen
        name="Batches"
        component={BatchesScreen}
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon name="Batches" focused={focused} />
          ),
          tabBarLabel: "Batches",
        }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon name="Settings" focused={focused} />
          ),
          tabBarLabel: "Settings",
        }}
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

        {/* Batches */}
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
