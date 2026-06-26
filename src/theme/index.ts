// ─── Colors ─────────────────────────────────────────────────────────────────

export const Colors = {
  // Backgrounds — three-stop depth system
  bg: "#0D0D0D", // canvas
  surface: "#161616", // cards, sheets  ← slightly lighter than before
  surface2: "#1F1F1F", // inputs, inner cards
  surface3: "#282828", // hover / pressed states

  // Borders
  border: "#2A2A2A",
  borderSub: "#1F1F1F", // very subtle internal dividers

  // Text
  text: "#F2F2F7",
  textSub: "#A0A0A8", // secondary labels  ← replaces the old #888
  textMuted: "#606068", // placeholders, disabled
  textDim: "#383840", // decorative / rule lines

  // Brand
  green: "#00D97E",
  greenSoft: "#00D97E18", // green at ~10% — for ring track, pill backgrounds
  greenDim: "#01200F", // deep tint for badges

  // Macro palette — unchanged, they're great
  blue: "#4A9EFF",
  amber: "#FFB340",
  coral: "#FF6B6B",
  purple: "#BF7FFF",
  teal: "#2DD4BF",
  pink: "#FF6EB4",

  // Semantic
  danger: "#FF4444",
  dangerSoft: "#FF444418",
  success: "#00D97E",
  warning: "#FFB340",
};

// ─── Macro colors ────────────────────────────────────────────────────────────

export const MacroColor: Record<string, string> = {
  protein: Colors.blue,
  carbs: Colors.amber,
  fat: Colors.coral,
  salt: Colors.purple,
  fibre: Colors.teal,
  sugar: Colors.pink,
};

// Soft/translucent fills for macro progress track backgrounds
export const MacroColorSoft: Record<string, string> = {
  protein: `${Colors.blue}18`,
  carbs: `${Colors.amber}18`,
  fat: `${Colors.coral}18`,
  salt: `${Colors.purple}18`,
  fibre: `${Colors.teal}18`,
  sugar: `${Colors.pink}18`,
};

// ─── Spacing ─────────────────────────────────────────────────────────────────

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

// ─── Radius ──────────────────────────────────────────────────────────────────

export const Radius = {
  sm: 6,
  md: 12,
  lg: 18,
  xl: 24,
  full: 999,
};

// ─── Typography ──────────────────────────────────────────────────────────────

export const Typography = {
  // Font sizes
  xs: 11,
  sm: 13,
  base: 15,
  md: 17,
  lg: 20,
  xl: 24,
  xxl: 32,
  hero: 52, // calorie ring number

  // Weights
  regular: "400" as const,
  medium: "500" as const,
  semibold: "600" as const,
  bold: "700" as const,

  // Line heights (multipliers → use as lineHeight = size * multiplier)
  tight: 1.15,
  normal: 1.4,
  relaxed: 1.6,
};

// ─── Shadows ─────────────────────────────────────────────────────────────────
// React Native shadows are iOS-only; for Android use elevation.
// Export both so components can spread the right one.

export const Shadow = {
  sm: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 2,
  },
  md: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 6,
  },
  lg: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.45,
    shadowRadius: 24,
    elevation: 12,
  },
  // Green glow — used on the calorie ring arc
  green: {
    shadowColor: Colors.green,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.55,
    shadowRadius: 16,
    elevation: 8,
  },
};

// ─── Common style snippets ────────────────────────────────────────────────────
// Spread these into StyleSheet objects to keep screens DRY.

export const CommonStyles = {
  // Standard screen container — use with SafeAreaView edges={['top','left','right']}
  screen: {
    flex: 1,
    backgroundColor: Colors.bg,
  },

  // Card with standard border
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
  },

  // Inner / nested card
  cardInner: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Colors.borderSub,
    padding: Spacing.md,
  },

  // Horizontal divider
  divider: {
    height: 1,
    backgroundColor: Colors.border,
    marginVertical: Spacing.md,
  },

  // Row with space-between + centered
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
  },

  rowBetween: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
  },
};

// ─── Navigation theme (React Navigation v7) ──────────────────────────────────
// Pass this to <NavigationContainer theme={NavTheme}>

import { DarkTheme } from "@react-navigation/native";

export const NavTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: Colors.green,
    background: Colors.bg,
    card: Colors.surface,
    text: Colors.text,
    border: Colors.border,
    notification: Colors.green,
  },
};

// Add at the bottom of theme/index.ts
export function useHeaderInsets() {
  const insets = useSafeAreaInsets();
  return {
    paddingTop: insets.top + 8, // status bar + breathing room
    paddingBottom: 8,
  };
}
