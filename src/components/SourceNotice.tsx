// ============================================================
// src/components/SourceNotice.tsx — in-context data-source attribution.
//
// Discharges ODbL §4.3 ("associated with the Produced Work") and the
// CC-BY-SA credit for OFF product photos, at the point a product is
// actually shown — not only on the About screen. Text always comes from
// src/content/attributions.ts; never hardcode a source's wording here.
//
// Two variants:
//   SourceNotice     — one product (ProductScreen). Links to that
//                       product's own OFF page when a barcode is known.
//   SourceListNotice — a result SET (a search list). No single barcode to
//                       link to, so it points at Open Food Facts itself.
//                       Deliberately quieter than SourceNotice — it is a
//                       provenance label above a list, not a per-item call
//                       to action.
//
// Both render null for anything that isn't Open Food Facts. custom foods
// and CoFID staples carry their own attribution paths (CoFID has no
// per-product UI surface — its only user-facing product is core_ingredients
// staples, which are read-only reference rows, not something a user browses
// as a "result list" the way OFF search results are).
// ============================================================

import React from "react";
import { Text, Pressable, StyleSheet } from "react-native";
import { Colors, Typography, Spacing, withDefaultFont } from "../theme/tokens";
import { DATA_SOURCES, isOpenFoodFactsSourced } from "../content/attributions";
import type { FoodProduct } from "../types";
import { openURL } from "../lib/links";

const OFF = DATA_SOURCES.find((s) => s.id === "open-food-facts")!;

function offProductUrl(barcode?: string | null): string {
  return barcode && barcode.trim()
    ? `https://world.openfoodfacts.org/product/${barcode.trim()}`
    : OFF.sourceUrl;
}

export function SourceNotice({
  source,
  barcode,
}: {
  source: FoodProduct["source"];
  barcode?: string | null;
}) {
  if (!isOpenFoodFactsSourced(source)) return null;

  return (
    <Pressable onPress={() => openURL(offProductUrl(barcode))} hitSlop={6}>
      <Text style={styles.notice}>{OFF.inlineNotice}</Text>
    </Pressable>
  );
}

export function SourceListNotice({ results }: { results: FoodProduct[] }) {
  if (!results.some((r) => isOpenFoodFactsSourced(r.source))) return null;

  return (
    <Pressable onPress={() => openURL(OFF.sourceUrl)} hitSlop={6}>
      <Text style={styles.listNotice}>{OFF.listNotice}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create(
  withDefaultFont({
    notice: {
      fontSize: Typography.xs,
      color: Colors.textMuted,
      marginTop: Spacing.xs,
    },
    listNotice: {
      fontSize: Typography.xs,
      color: Colors.textDim,
      textAlign: "center",
      marginBottom: Spacing.sm,
    },
  }),
);
