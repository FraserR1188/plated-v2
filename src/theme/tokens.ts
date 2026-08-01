import { DarkTheme } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  HankenGrotesk_400Regular,
  HankenGrotesk_500Medium,
  HankenGrotesk_600SemiBold,
  HankenGrotesk_700Bold,
} from "@expo-google-fonts/hanken-grotesk";
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_600SemiBold,
  JetBrainsMono_700Bold,
} from "@expo-google-fonts/jetbrains-mono";

// ─── Dark-slate design tokens ─────────────────────────────────────────────────
// Second theme source, alongside the original ../theme (theme/index.ts).
// Screens migrate one at a time (see CLAUDE.md working notes) by switching
// their import from "../theme" to "../theme/tokens" — the export names below
// deliberately mirror the old module so that swap is close to a no-op.

// ─── Fonts ──────────────────────────────────────────────────────────────────
// Pass FontsToLoad straight to useFonts() before rendering anything that reads
// Fonts.* — the family name strings only resolve to the right glyphs once
// expo-font has actually loaded them.

export const FontsToLoad = {
  HankenGrotesk_400Regular,
  HankenGrotesk_500Medium,
  HankenGrotesk_600SemiBold,
  HankenGrotesk_700Bold,
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_600SemiBold,
  JetBrainsMono_700Bold,
};

// Hanken Grotesk for all text. JetBrains Mono for numbers — its digits are
// monospaced by design, so tabular alignment falls out for free.
export const Fonts = {
  sans: {
    regular: "HankenGrotesk_400Regular",
    medium: "HankenGrotesk_500Medium",
    semibold: "HankenGrotesk_600SemiBold",
    bold: "HankenGrotesk_700Bold",
  },
  mono: {
    regular: "JetBrainsMono_400Regular",
    medium: "JetBrainsMono_500Medium",
    semibold: "JetBrainsMono_600SemiBold",
    bold: "JetBrainsMono_700Bold",
  },
};

const SANS_BY_WEIGHT: Record<string, string> = {
  "400": Fonts.sans.regular,
  "500": Fonts.sans.medium,
  "600": Fonts.sans.semibold,
  "700": Fonts.sans.bold,
};

/**
 * Fills in `fontFamily` on every style that declares a `fontWeight` but no
 * `fontFamily` of its own — the default case (Hanken Grotesk at the matching
 * weight). A style that already sets its own `fontFamily` (a JetBrains Mono
 * numeric readout) is left untouched. Apply to the plain object literal
 * BEFORE StyleSheet.create, e.g. `StyleSheet.create(withDefaultFont({...}))`
 * — saves hand-adding a fontFamily line next to every fontWeight line.
 */
export function withDefaultFont<T extends Record<string, any>>(sheet: T): T {
  const out: any = {};
  for (const key in sheet) {
    const style = sheet[key];
    if (
      style &&
      typeof style === "object" &&
      "fontWeight" in style &&
      !("fontFamily" in style)
    ) {
      out[key] = {
        fontFamily: SANS_BY_WEIGHT[String(style.fontWeight)] ?? Fonts.sans.regular,
        ...style,
      };
    } else {
      out[key] = style;
    }
  }
  return out;
}

// ─── Macro colors — unchanged palette, restated as fixed hex per spec ────────

export const MacroColor: Record<string, string> = {
  protein: "#5B9DFF",
  carbs: "#FFB454",
  fat: "#FF7A7A",
  satFat: "#B4513C",
  salt: "#A78BFA",
  fibre: "#2DD4BF",
  sugar: "#F472B6",
};

export const MacroColorSoft: Record<string, string> = {
  protein: `${MacroColor.protein}18`,
  carbs: `${MacroColor.carbs}18`,
  fat: `${MacroColor.fat}18`,
  satFat: `${MacroColor.satFat}18`,
  salt: `${MacroColor.salt}18`,
  fibre: `${MacroColor.fibre}18`,
  sugar: `${MacroColor.sugar}18`,
};

// ─── Colors — dark-slate surfaces ─────────────────────────────────────────────

export const Colors = {
  // Surfaces
  bg: "#242A31", // page
  surface: "#343B44", // card
  surface2: "#414954", // elevated
  surface3: "#414954", // no distinct 4th tier in the new spec — aliases elevated
  border: "rgba(255,255,255,0.10)",
  borderSub: "rgba(255,255,255,0.10)", // spec gives one border value; old two-tier kept for API parity

  // Text
  text: "#F2F4F6", // primary
  textSub: "#C4CAD1", // secondary
  textMuted: "#8B939C", // muted
  textDim: "#7B838C", // faint

  // Brand / accents
  green: "#C6F94E", // energy / primary accent
  greenSoft: "#C6F94E18",
  greenDim: "#2A331A", // deep tint for badges — inferred, not spec'd
  whoop: "#22D3EE",

  // Macro palette, aliased under the old names some components still use
  blue: MacroColor.protein,
  amber: MacroColor.carbs,
  coral: MacroColor.fat,
  purple: MacroColor.salt,
  teal: MacroColor.fibre,
  pink: MacroColor.sugar,

  // Semantic — not part of the new spec, kept as-is
  danger: "#FF4444",
  dangerSoft: "#FF444418",
  success: "#C6F94E",
  // Deliberately NOT MacroColor.carbs — this is "uncertain / medium
  // confidence" (AI estimate confidence, label-scan low-confidence readings)
  // and must stay visually distinct from the carbs macro colour, or a
  // low-confidence salt reading and a carbs bar become the same amber.
  warning: "#F5A623",
};

// ─── Overlay primitives ───────────────────────────────────────────────────────
// True black/white for compositing over a live camera feed (ScannerScreen) —
// deliberately outside the surface palette: a viewfinder needs true contrast
// against video, not the app's slate tone.

export const Overlay = {
  black: "#000000",
  white: "#FFFFFF",
};

// ─── Spacing (unchanged) ─────────────────────────────────────────────────────

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
  card: 18,
  control: 10,
  pill: 999,
};

// ─── Typography (sizes/weights unchanged; family now lives in Fonts above) ──

export const Typography = {
  xs: 11,
  sm: 13,
  base: 15,
  md: 17,
  lg: 20,
  xl: 24,
  xxl: 32,
  hero: 52,

  regular: "400" as const,
  medium: "500" as const,
  semibold: "600" as const,
  bold: "700" as const,

  tight: 1.15,
  normal: 1.4,
  relaxed: 1.6,
};

// ─── Shadows (unchanged, green glow now keys off the new accent) ────────────

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
  green: {
    shadowColor: "#C6F94E",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.55,
    shadowRadius: 16,
    elevation: 8,
  },
};

// ─── Common style snippets ────────────────────────────────────────────────────

export const CommonStyles = {
  screen: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
  },
  cardInner: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.control,
    borderWidth: 1,
    borderColor: Colors.borderSub,
    padding: Spacing.md,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.border,
    marginVertical: Spacing.md,
  },
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
// Not wired into AppNavigator yet — that swap happens when nav chrome is
// migrated (step 3). Defined here now so the v7 `fonts` object ships alongside
// the rest of the token system rather than getting bolted on later.

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
  fonts: {
    regular: { fontFamily: Fonts.sans.regular, fontWeight: "400" as const },
    medium: { fontFamily: Fonts.sans.medium, fontWeight: "500" as const },
    bold: { fontFamily: Fonts.sans.bold, fontWeight: "700" as const },
    heavy: { fontFamily: Fonts.sans.bold, fontWeight: "700" as const },
  },
};

export function useHeaderInsets() {
  const insets = useSafeAreaInsets();
  return {
    paddingTop: insets.top + 8,
    paddingBottom: 8,
  };
}
