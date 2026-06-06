import React                              from 'react';
import { Text }                           from 'react-native';
import { NavigationContainer }            from '@react-navigation/native';
import { createNativeStackNavigator }     from '@react-navigation/native-stack';
import { createBottomTabNavigator }       from '@react-navigation/bottom-tabs';
import { TodayScreen }                    from '../screens/TodayScreen';
import { HistoryScreen }                  from '../screens/HistoryScreen';
import { SettingsScreen }                 from '../screens/SettingsScreen';
import { AddIngredientScreen }            from '../screens/AddIngredientScreen';
import { ScannerScreen }                  from '../screens/ScannerScreen';
import { ProductScreen }                  from '../screens/ProductScreen';
import { Colors, Typography }             from '../theme';
import { RootStackParamList, BottomTabParamList } from '../types';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab   = createBottomTabNavigator<BottomTabParamList>();

function TabIcon({ icon, focused }: { icon: string; focused: boolean }) {
  return <Text style={{ fontSize: 22, opacity: focused ? 1 : 0.4 }}>{icon}</Text>;
}

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: Colors.surface,
          borderTopColor:  Colors.border,
          borderTopWidth:  1,
          height:          62,
          paddingBottom:   10,
        },
        tabBarActiveTintColor:   Colors.green,
        tabBarInactiveTintColor: Colors.textDim,
        tabBarLabelStyle: { fontSize: Typography.xs, fontWeight: Typography.medium },
      }}
    >
      <Tab.Screen name="Today"    component={TodayScreen}    options={{ tabBarIcon: ({ focused }) => <TabIcon icon="🍽️" focused={focused} />, tabBarLabel: 'Today' }} />
      <Tab.Screen name="History"  component={HistoryScreen}  options={{ tabBarIcon: ({ focused }) => <TabIcon icon="📊" focused={focused} />, tabBarLabel: 'History' }} />
      <Tab.Screen name="Settings" component={SettingsScreen} options={{ tabBarIcon: ({ focused }) => <TabIcon icon="⚙️" focused={focused} />, tabBarLabel: 'Settings' }} />
    </Tab.Navigator>
  );
}

export function AppNavigator() {
  return (
    <NavigationContainer
      theme={{
        dark: true,
        colors: {
          background:   Colors.bg,
          card:         Colors.surface,
          text:         Colors.text,
          border:       Colors.border,
          primary:      Colors.green,
          notification: Colors.green,
        },
      }}
    >
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="MainTabs"      component={MainTabs} />
        <Stack.Screen name="AddIngredient" component={AddIngredientScreen} options={{ presentation: 'modal' }} />
        <Stack.Screen name="Scanner"       component={ScannerScreen}       options={{ presentation: 'fullScreenModal' }} />
        <Stack.Screen name="Product"       component={ProductScreen}       options={{ presentation: 'modal' }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
