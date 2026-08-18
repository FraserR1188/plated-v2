// ============================================================
// src/lib/links.ts — open an external URL, with a user-facing failure.
//
// Extracted from AboutScreen when SourceNotice became a second caller.
// Uses expo-linking (already a dependency, already used by whoop.ts's
// OAuth flow) rather than adding a new one.
// ============================================================

import * as Linking from "expo-linking";
import { Alert } from "react-native";

export async function openURL(url: string): Promise<void> {
  try {
    await Linking.openURL(url);
  } catch {
    Alert.alert("Couldn't open link", "Check your connection and try again.");
  }
}
