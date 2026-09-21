// ============================================================
// Structural assertions on the Data tab's UI.
//
// Source-text, not RNTL: this project has no React Native runtime under
// Vitest (see vitest.setup.ts on react-native's Flow syntax), and the
// questions here are structural anyway. Each one pins a decision that is
// invisible to tsc and easy to undo by accident.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const read = (rel: string) =>
  fs
    .readFileSync(path.resolve(process.cwd(), "src", rel), "utf8")
    .replace(/\r\n/g, "\n");

/** The same text with `//` and `/* *​/` comments removed, so an assertion
 *  can't be satisfied by a sentence in a comment that happens to say the
 *  right words. This bit me in PL-024, where a test matched its own note. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const dataScreen = read("screens/DataScreen.tsx");
const trendChart = read("components/TrendChart.tsx");
const trendsPanel = read("components/TrendsPanel.tsx");
const historyScreen = read("screens/HistoryScreen.tsx");

describe("DataScreen", () => {
  const code = stripComments(dataScreen);

  it("opens on History", () => {
    expect(code).toMatch(/useState<Segment>\(\s*"history"\s*\)/);
  });

  it("offers exactly History and Trends, in that order", () => {
    const labels = [...code.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual(["History", "Trends"]);
  });

  it("renders both segments from one screen — no nested navigator", () => {
    // A navigator here would give each segment its own history stack and
    // focus events, and would be a new dependency in a fingerprint that
    // has to stay OTA-compatible.
    expect(code).not.toMatch(/createBottomTabNavigator|createNativeStackNavigator|createMaterialTopTabNavigator/);
    expect(code).toContain("<HistoryScreen embedded />");
    expect(code).toContain("<TrendsPanel />");
  });

  it("does not persist which segment was last open", () => {
    // Deliberate: the tab must always open where you expect. The nutrient
    // selection inside Trends IS remembered, which is a different thing.
    expect(code).not.toContain("readTrendsPrefs");
    expect(code).not.toContain("AsyncStorage");
  });
});

describe("HistoryScreen, embedded", () => {
  const code = stripComments(historyScreen);

  it("takes an `embedded` prop and skips its own safe-area inset with it", () => {
    expect(code).toMatch(/embedded\s*=\s*false/);
    expect(code).toMatch(/const Frame = embedded \? View : SafeAreaView/);
  });

  it("suppresses its own heading when embedded", () => {
    expect(code).toMatch(/\{!embedded && <Text style=\{styles\.heading\}>History<\/Text>\}/);
  });
});

describe("TrendChart", () => {
  const code = stripComments(trendChart);

  // The single most important property of this chart -- and one this file
  // CANNOT check. A sabotage that removed the break left `segments.push`,
  // `p.value == null` and `segments.map(` all present, so an assertion on
  // those tokens passed while the chart drew a straight line across an
  // unlogged day. The behaviour is tested for real in
  // lib/__tests__/trends.test.ts against buildPathSegments; all this file
  // can honestly assert is that the chart DELEGATES to it rather than
  // growing a second copy free to drift.
  it("delegates the line to the tested path builder, and inlines no copy", () => {
    expect(code).toContain("buildPathSegments");
    expect(code).toMatch(/const segments = buildPathSegments\(/);
    expect(code).not.toMatch(/segments\.push/);
    expect(code).not.toMatch(/current\.join/);
  });

  it("renders every segment as its own path", () => {
    // One <Path> for the whole series would rejoin what the builder broke.
    expect(code).toMatch(/segments\.map\(/);
  });

  it("renders no point at all for a null value", () => {
    expect(code).toMatch(/p\.value == null \? null :/);
  });

  it("draws incomplete and so-far points hollow", () => {
    expect(code).toMatch(/isHollow\s*=\s*\(p: TrendPoint\)\s*=>\s*p\.incomplete \|\| p\.soFar/);
    expect(code).toMatch(/fill=\{isHollow\(p\) \? Colors\.bg : color\}/);
  });

  it("draws the goal line only when the series carries one", () => {
    // buildTrendSeries is what nulls the goal when goalsState !== "loaded";
    // this is the render side of PL-026, and it must not second-guess it
    // by falling back to the store's goals.
    expect(code).toMatch(/series\.goal != null &&/);
    expect(code).not.toContain("useStore");
    expect(code).not.toContain("DEFAULT_GOALS");
  });

  it("gives each nutrient its own y-scale, anchored at zero", () => {
    expect(code).toMatch(/const candidates = \[\.\.\.values, 0/);
  });

  it("rounds only for display", () => {
    expect(code).toMatch(/function formatValue/);
    // The rounding helper is used in the JSX, never to build a value that
    // is stored — the PL-028 lesson, one layer up.
    expect(code).not.toMatch(/writeTrendsPrefs\([^)]*formatValue/);
  });
});

describe("TrendsPanel", () => {
  const code = stripComments(trendsPanel);

  it("computes nothing itself — the aggregation is lib/trends", () => {
    expect(code).toContain("buildTrendSeries");
    expect(code).not.toMatch(/getDaySummary\(/);
    expect(code).not.toMatch(/\.reduce\(/);
  });

  it("passes the store's goalsState straight through", () => {
    expect(code).toMatch(/goalsState,/);
    expect(code).toMatch(/useStore\(\(s\) => s\.goalsState\)/);
  });

  it("persists the selection and range per user", () => {
    expect(code).toContain("readTrendsPrefs(userId)");
    expect(code).toContain("writeTrendsPrefs(userId, {");
  });

  it("does not persist anything when there is no user", () => {
    expect(code).toMatch(/if \(!userId\) return;/);
  });

  it("uses toggleNutrient's identity return to detect the cap", () => {
    // The cap lives in one place (lib/trends). A second length check here
    // would be a second definition of the rule, free to drift.
    expect(code).toMatch(/if \(next === nutrients\)/);
    expect(code).not.toMatch(/nutrients\.length >= 3/);
  });

  it("offers both ranges from RANGE_DAYS rather than hard-coding them", () => {
    expect(code).toMatch(/RANGE_DAYS\.map/);
    expect(code).not.toMatch(/\[7, 14\]/);
  });

  it("cancels the preference read if the user changes mid-flight", () => {
    expect(code).toMatch(/cancelled/);
  });
});
