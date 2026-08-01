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
//   └── CopyConfirm       (push)             ← NEW
// ============================================================

import React from "react";
import { Text } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";

import { TodayScreen } from "../screens/TodayScreen";
import { HistoryScreen } from "../screens/HistoryScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { AddIngredientScreen } from "../screens/AddIngredientScreen";
import { ScannerScreen } from "../screens/ScannerScreen";
import { ProductScreen } from "../screens/ProductScreen";
import { FriendsScreen } from "../screens/FriendsScreen";
import { ConnectedUserLogScreen } from "../screens/ConnectedUserLogScreen";
import { CopyConfirmScreen } from "../screens/CopyConfirmScreen";
import { TabBar } from "../components/TabBar";
import { Colors, Fonts, NavTheme } from "../theme/tokens";
import { RootStackParamList, BottomTabParamList } from "../types";
import { CreateFoodScreen } from "../screens/CreateFoodScreen";

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<BottomTabParamList>();

// ─── Tab icons ───────────────────────────────────────────────

const TAB_ICONS: Record<keyof BottomTabParamList, string> = {
  Today: "○", // replace with your SVG icon components
  History: "◫",
  Friends: "◎", // ← people / friends icon
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
  return (
    <NavigationContainer theme={NavTheme}>
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
      </Stack.Navigator>
    </NavigationContainer>
  );
}
