// ============================================================
// src/content/attributions.ts — single source of truth for data-source
// attribution.
//
// plated serves nutrient data from licensed third-party sources, and each
// licence carries its own attribution obligation. This file is the ONLY
// place those obligations are worded. AboutScreen, any future in-context
// notice (e.g. ProductScreen's OFF badge), and platedapp.uk/attributions.html
// must all render FROM this data, not restate it.
//
// Adding a data source means adding an entry to DATA_SOURCES below — never
// hardcoding a source's name/statement into a screen. A screen that special-
// cases one source by name has already drifted from this file being the
// source of truth.
//
// The OGL v3.0 statement (CoFID entry, `statement` field) is close to a
// fixed form mandated by the licence — do not reword, reorder, or drop the
// version number when editing it.
// ============================================================

export type Licence = {
  /** Display name, e.g. "Open Database License (ODbL) v1.0". */
  name: string;
  /** Canonical licence text URI. */
  url: string;
  /** e.g. "Product images" — omit when the licence covers the whole source. */
  appliesTo?: string;
};

export type DataSource = {
  /** Stable key, e.g. "cofid-2021". */
  id: string;
  /** Full dataset/service name. */
  name: string;
  publisher: string;
  /** Plain-English: what a user sees from this source. */
  usedFor: string;
  /** The full attribution paragraph. */
  statement: string;
  /** One-line version for in-context use (e.g. ProductScreen's OFF badge). */
  inlineNotice: string;
  sourceUrl: string;
  licences: Licence[];
};

export const DATA_SOURCES: DataSource[] = [
  {
    id: "cofid-2021",
    name: "McCance and Widdowson's The Composition of Foods Integrated Dataset 2021",
    publisher: "Public Health England",
    usedFor: "Nutrient data for generic foods and cooking ingredients",
    statement:
      "Nutrient data for generic foods and cooking ingredients is derived from McCance and Widdowson's The Composition of Foods Integrated Dataset 2021, Public Health England. © Crown copyright 2021. Contains public sector information licensed under the Open Government Licence v3.0.",
    inlineNotice: "Source: CoFID 2021, Public Health England (OGL v3.0)",
    sourceUrl:
      "https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid",
    licences: [
      {
        name: "Open Government Licence v3.0",
        url: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
      },
    ],
  },
  {
    id: "open-food-facts",
    name: "Open Food Facts",
    publisher: "Open Food Facts and its contributors",
    usedFor: "Branded and barcoded product information, and product photos",
    statement:
      "Branded product information and product photos are provided by Open Food Facts and its contributors. Contains information from Open Food Facts, which is made available here under the Open Database License (ODbL). Product photos are made available under the Creative Commons Attribution-ShareAlike licence.",
    inlineNotice: "Source: Open Food Facts (ODbL)",
    sourceUrl: "https://world.openfoodfacts.org",
    licences: [
      {
        name: "Open Database License (ODbL) v1.0",
        url: "https://opendatacommons.org/licenses/odbl/1-0/",
        appliesTo: "Product data",
      },
      {
        name: "Creative Commons Attribution-ShareAlike",
        url: "https://world.openfoodfacts.org/terms-of-use",
        appliesTo: "Product photos",
      },
    ],
  },
];
