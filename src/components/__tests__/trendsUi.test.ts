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
    expect(code).toMatch(/layout\.goalY != null &&/);
    expect(code).not.toContain("useStore");
    expect(code).not.toContain("DEFAULT_GOALS");
  });

  // The zero-anchored scale, the nice-number ticks, the gutter and the x
  // label text all moved into lib/trends.ts' buildChartLayout -- same
  // reasoning as the path builder: "nothing falls off the canvas", "the
  // axis starts at zero" and "the top is a round number above the data"
  // are behavioural, and a regex cannot check any of them. They are
  // asserted against real numbers in lib/__tests__/trends.test.ts; all this
  // file checks is that the chart delegates instead of keeping its own.
  it("delegates the whole layout to the tested builder, and keeps no second copy", () => {
    expect(code).toMatch(/const layout = buildChartLayout\(/);
    // No second scale, no second axis, no second maximum. Math.max is
    // banned outright: every use of it here would be re-deriving something
    // the layout already decided (the width guard lives in the layout too).
    expect(code).not.toMatch(/buildChartScale\(/);
    expect(code).not.toMatch(/niceTicks\(/);
    expect(code).not.toMatch(/Math\.max\(/);
    expect(code).not.toMatch(/Math\.min\(/);
    expect(code).not.toContain("scaleTop");
    expect(code).not.toMatch(/const plotH =/);
    expect(code).not.toMatch(/const PAD_LEFT/);
  });

  it("sizes the point from the same constants the geometry uses", () => {
    // The clipping bug: the padding had been sized for the LINE, and a
    // hollow dot is wider than its centre by its radius plus half its
    // stroke. The dot is drawn from those constants here; how much ROOM it
    // needs at the canvas edge is the layout's answer to give, and a local
    // POINT_EXTENT here would be a second one.
    expect(code).toMatch(/r=\{POINT_RADIUS\}/);
    expect(code).toMatch(/strokeWidth=\{isHollow\(p\) \? POINT_STROKE : 0\}/);
    expect(code).not.toContain("POINT_EXTENT");
  });

  it("dashes the leg into today rather than drawing it solid", () => {
    expect(code).toMatch(/strokeDasharray=\{segment\.dashed \?/);
  });

  // Moved to the card header after the second device pass: inside the plot
  // the goal label sat on top of the y-axis top number whenever the goal
  // WAS the top of the scale, which is common ("2,800" over "goal 2,800").
  it("puts the goal in the header, not in the plot", () => {
    expect(code).toContain("goalCaption(series.goal, series.meta.unit)");
    expect(code).toMatch(/<Text style=\{styles\.goal\}>\{` · \$\{goalText\}`\}<\/Text>/);
    // No goal text inside the svg. The dashed line stays, unlabelled.
    const svg = code.slice(code.indexOf("<Svg"), code.indexOf("</Svg>"));
    expect(svg).not.toContain("goalText");
    expect(svg).toMatch(/strokeDasharray="3 4"/);
  });

  it("renders no goal at all when the series has none", () => {
    // goalCaption returns null rather than "", so there is nothing to hide,
    // and buildChartLayout returns a null goalY rather than a y for a goal
    // that isn't there.
    expect(code).toMatch(/goalText != null &&/);
    expect(code).toMatch(/layout\.goalY != null &&/);
  });

  it("lets the header wrap instead of truncating the nutrient name", () => {
    // "Sat fat · goal 20 g" beside "4.0 g / today so far" is the longest
    // case at 360dp and the largest font.
    expect(code).toMatch(/style=\{styles\.title\} numberOfLines=\{2\}/);
  });

  it("says which day the headline number belongs to", () => {
    expect(code).toMatch(/latest\.soFar \? "today so far" : shortDay\(latest\.date\)/);
  });

  it("draws the y ticks and the x dates from the layout's own arrays", () => {
    // Was: a top label formatted here from a local scaleTop, and a bottom
    // one hard-coded to "0". The axis is a computed set of ticks now, so
    // there is no maximum for the component to hold or to get wrong.
    expect(code).toMatch(/layout\.yTicks\.map\(/);
    expect(code).toMatch(/layout\.xLabels\.map\(/);
    expect(code).not.toContain("scaleTop");
    expect(code).not.toMatch(/>0</);
  });

  // PL-034. The previous fix put the y labels in an RN <Text> column with
  // no width, on the theory that the layout engine would size it to its
  // widest label. It cannot: both labels were position:"absolute", and an
  // absolutely positioned child does not size its parent. The column
  // measured ZERO wide, every label hung off its left edge, and "2,800"
  // rendered as ",800" again -- the same symptom the fixed gutter had.
  //
  // This test's predecessor asserted the very property that caused it
  // ("the yAxis style has no width:"), which is why it is replaced rather
  // than repaired: the subject it was written about no longer exists.
  //
  // The labels are svg <Text> in a gutter the LAYOUT computes from the
  // widest label, so the width is arithmetic, not a hope about Yoga.
  it("draws the y labels as svg text inside the computed gutter", () => {
    const svg = code.slice(code.indexOf("<Svg"), code.indexOf("</Svg>"));
    expect(svg).toContain("tick.label");
    expect(svg).toMatch(/x=\{layout\.yLabelX\}/);
    expect(svg).toMatch(/y=\{tick\.baseline\}/);
    expect(svg).toMatch(/textAnchor="end"/);
    // The RN column and its absolutely positioned labels are gone, and so
    // is any attempt to centre the text by asking svg to do it.
    expect(code).not.toContain("yAxis");
    expect(code).not.toContain("axisText");
    expect(code).not.toMatch(/position:\s*"absolute"/);
    expect(code).not.toContain("alignmentBaseline");
  });

  it("draws a gridline at every tick but the one the goal sits on", () => {
    const svg = code.slice(code.indexOf("<Svg"), code.indexOf("</Svg>"));
    // Which tick loses its line is decided in the layout and tested there;
    // what this file can say is that the chart asks, rather than drawing a
    // line at every tick regardless.
    expect(svg).toMatch(/tick\.gridline/);
    expect(svg).toMatch(/stroke=\{Colors\.border\}/);
  });

  it("gives the plot the taller canvas the ticks need", () => {
    expect(code).toMatch(/const CHART_HEIGHT = 150;/);
  });

  // The svg was wider than its own card: the width came from the
  // container, and the card's padding and border live inside that.
  it("measures its own plot width rather than being handed one", () => {
    expect(code).not.toMatch(/width: number;/);
    expect(code).toMatch(/onLayout=\{onPlotLayout\}/);
    expect(code).toMatch(/setPlotWidth\(e\.nativeEvent\.layout\.width\)/);
    expect(code).toMatch(/plotWidth > 0 &&/);
  });

  it("centres every x label on its point", () => {
    // The end labels used to anchor inward so they could not hang off the
    // canvas. They are centred like every other label now: the layout
    // reserves half a label's width at each end instead, which is what
    // lets the first and last labels sit ON their points rather than
    // beside them. The old anchor rule -- and its helper -- are gone.
    expect(code).toMatch(/layout\.xLabels\.map\(/);
    expect(code).toMatch(/textAnchor="middle"/);
    expect(code).not.toContain("xAxisLabelBounds");
    expect(code).not.toContain("anchor={");
    expect(code).not.toMatch(/index === 0 \? "start"/);
  });

  it("formats numbers without asking the device's locale", () => {
    // A chart axis that says 2,800 in one place and 2.800 in another is a
    // different number, not a different style.
    expect(code).not.toContain("toLocaleString");
    expect(code).not.toContain("toLocaleDateString");
  });

  // A "delegates" assertion has to forbid the ALTERNATIVE, not just
  // require the delegation. A sabotage that replaced ONE call site with
  // String(Math.round(...)) passed a toContain("formatNutrientValue")
  // check, because the helper is still used elsewhere in the file. The
  // fourth time in this feature a structural test has missed its target.
  it("delegates number formatting and does no rounding of its own", () => {
    expect(code).toContain("formatNutrientValue");
    expect(code).not.toMatch(/function formatValue/);
    expect(code).not.toMatch(/function withThousands/);
    // Any local rounding IS a second formatter, wherever it appears.
    expect(code).not.toMatch(/Math\.round\(/);
    expect(code).not.toMatch(/\.toFixed\(/);
    expect(code).not.toContain("toLocaleString");
  });

  it("formats every displayed number through the same helper", () => {
    // The headline is the only number the CARD formats now -- the axis
    // labels are formatted in the layout, next to the ticks they belong
    // to, and the goal goes through goalCaption, which uses the same
    // helper underneath.
    const calls = code.match(/formatNutrientValue\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(code).toContain("goalCaption(series.goal, series.meta.unit)");
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

  it("shows the cap as a standing hint, not only after a failed tap", () => {
    expect(code).toMatch(/`Pick up to \$\{MAX_SELECTED\}`/);
    expect(code).toMatch(/`\$\{nutrients\.length\}\/\$\{MAX_SELECTED\}`/);
  });

  // A sabotage that made the call dead (`void 0 && setCapMessage(...)`)
  // still matched a regex for `setCapMessage(` -- the same blind spot as
  // the path builder. The MESSAGE is now decided by capMessageFor in
  // lib/trends.ts and tested there against toggleNutrient over every
  // combination; what this file can honestly assert is that the panel
  // holds no wording of its own to drift. That the call is actually wired
  // is a device check, not something source text can prove.
  it("delegates the refusal wording rather than holding its own", () => {
    expect(code).toContain("capMessageFor(nutrients, nutrient)");
    expect(code).not.toContain("Keep at least one");
    expect(code).not.toContain("already");
  });

  it("announces the message to screen readers", () => {
    expect(code).toMatch(/accessibilityLiveRegion="polite"/);
  });

  it("clears that message on a timer, and clears the timer on unmount", () => {
    expect(code).toMatch(/setTimeout\(\(\) => setCapMessage\(null\)/);
    expect(code).toMatch(/clearTimeout\(capTimer\.current\)/);
  });

  it("hands each chart no width — the chart measures its own card", () => {
    expect(code).not.toMatch(/width=\{width\}/);
    expect(code).not.toMatch(/setWidth\(/);
  });

  it("tells each chart which range it is drawing", () => {
    // xAxisLabels formats differently at 7 and 14 days; a chart that had to
    // infer the range from the point count would be a second definition.
    expect(code).toMatch(/range=\{range\}/);
  });

});
