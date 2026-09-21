// ============================================================
// One small multiple: a single nutrient's line over the selected window.
//
// The honesty rules live in lib/trends.ts; this only has to DRAW them
// without quietly undoing any:
//
//   value === null   → no point, and the line BREAKS. Never interpolated
//                      across, because a straight line between Monday and
//                      Wednesday is a drawn claim about Tuesday.
//   incomplete       → hollow point. The value is an undercount.
//   soFar            → hollow point, reached by a DASHED leg. A solid line
//                      dropping into a low point reads as a collapse
//                      rather than as a day that is only half over.
//   goal === null    → no goal line, and no goal in the header (PL-026).
//   y-axis           → always anchored at zero, per nutrient.
//
// THIS FILE COMPUTES NOTHING. Every number below comes out of
// buildChartLayout: the scale, the ticks and their labels, the gutter, the
// x labels and their positions, the goal's y. The component's whole job is
// to map those arrays onto svg elements.
//
// That split is not tidiness. This project has no React Native runtime
// under vitest, so the only thing a test can do to this file is read its
// source text — and four separate times in this feature a source-text
// assertion passed while the thing it was written for was broken. Anything
// that can be got WRONG rather than merely misspelled has to live where a
// test can execute it.
//
// PL-034 is the latest of those. The y labels were RN <Text> in a column
// with no width, on the theory that the layout engine would size it to its
// widest label; absolutely positioned children don't size their parent, so
// the column measured zero and "2,800" rendered as ",800" — the same
// symptom as the fixed gutter it replaced. The labels are svg text in a
// computed gutter now, and the structural test that asserted the old
// column had no width is gone with it.
//
// react-native-svg is already a dependency (CalorieRing uses it), so this
// adds nothing to the runtime fingerprint and ships by OTA.
// ============================================================

import React, { useState } from "react";
import { View, Text, StyleSheet, LayoutChangeEvent } from "react-native";
import Svg, { Circle, Line, Path, Text as SvgText } from "react-native-svg";
import {
  AXIS_CAP_HEIGHT,
  AXIS_CHAR_W,
  AXIS_FONT_SIZE,
  POINT_RADIUS,
  POINT_STROKE,
  TrendPoint,
  TrendRange,
  TrendSeries,
  buildChartLayout,
  buildPathSegments,
  formatNutrientValue,
  goalCaption,
  shortDay,
} from "../lib/trends";
import {
  Colors,
  Fonts,
  MacroColor,
  Radius,
  Spacing,
  Typography,
  withDefaultFont,
} from "../theme/tokens";

/** The per-macro colour language, applied to the chart. Lives here rather
 *  than in lib/trends.ts: that module must stay importable in vitest's node
 *  environment, and theme/tokens.ts pulls in React Navigation.
 *
 *  Calories has no macro colour of its own in the app-wide language, so it
 *  takes the energy accent — the same green the calorie ring uses. */
const NUTRIENT_COLOR: Record<string, string> = {
  calories: Colors.green,
  protein: MacroColor.protein,
  carbs: MacroColor.carbs,
  fat: MacroColor.fat,
  satFat: MacroColor.satFat,
  salt: MacroColor.salt,
  fibre: MacroColor.fibre,
  sugar: MacroColor.sugar,
};

/** 108 before the axes. The extra 42px all went to the plot — the x-label
 *  strip is unchanged at X_LABEL_HEIGHT — because gridlines are only worth
 *  drawing if there is room to read a point off them. */
const CHART_HEIGHT = 150;

interface Props {
  series: TrendSeries;
  range: TrendRange;
}

const isHollow = (p: TrendPoint) => p.incomplete || p.soFar;

export function TrendChart({ series, range }: Props) {
  // The MEASURED inside of the card. Nothing is drawn until it is known.
  const [plotWidth, setPlotWidth] = useState(0);

  const color = NUTRIENT_COLOR[series.nutrient] ?? Colors.green;

  const layout = buildChartLayout({
    width: plotWidth,
    height: CHART_HEIGHT,
    dates: series.points.map((p) => p.date),
    range,
    values: series.points.map((p) => p.value),
    goal: series.goal,
    charW: AXIS_CHAR_W,
    capHeight: AXIS_CAP_HEIGHT,
  });

  const segments = buildPathSegments(
    series.points,
    layout.scale.x,
    layout.scale.y,
  );

  const latest = [...series.points].reverse().find((p) => p.value != null);
  const goalText = goalCaption(series.goal, series.meta.unit);

  const onPlotLayout = (e: LayoutChangeEvent) =>
    setPlotWidth(e.nativeEvent.layout.width);

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View style={styles.titleWrap}>
          <View style={[styles.swatch, { backgroundColor: color }]} />
          {/* Two lines allowed, so "Sat fat · goal 20 g" wraps the goal
              onto its own line at the largest font rather than truncating
              the nutrient's name. */}
          <Text style={styles.title} numberOfLines={2}>
            {series.meta.label}
            {goalText != null && (
              <Text style={styles.goal}>{` · ${goalText}`}</Text>
            )}
          </Text>
        </View>
        {latest?.value != null && (
          <View style={styles.latestWrap}>
            <Text style={[styles.latest, { color }]} numberOfLines={1}>
              {formatNutrientValue(latest.value, series.meta.unit)}
              <Text style={styles.unit}> {series.meta.unit}</Text>
            </Text>
            {/* Say WHICH day the headline number is. Without this it reads
                as a total for the whole window, which it is not. */}
            <Text style={styles.latestNote} numberOfLines={1}>
              {latest.soFar ? "today so far" : shortDay(latest.date)}
            </Text>
          </View>
        )}
      </View>

      {layout.hasData ? (
        <View style={styles.plot} onLayout={onPlotLayout}>
          {plotWidth > 0 && (
            <Svg width={plotWidth} height={CHART_HEIGHT}>
              {/* Gridlines first, so everything else draws over them. The
                  card's own border colour: a grid you have to look for is
                  a grid that isn't competing with the data. The tick the
                  goal line sits on has none — two lines at the same y is
                  just a thicker line, and the dashes stop reading. */}
              {layout.yTicks.map((tick) =>
                tick.gridline ? (
                  <Line
                    key={`grid-${tick.value}`}
                    x1={layout.gridLeft}
                    y1={tick.y}
                    x2={layout.gridRight}
                    y2={tick.y}
                    stroke={Colors.border}
                    strokeWidth={1}
                  />
                ) : null,
              )}

              {/* The goal — dashed and UNLABELLED. The number is in the
                  card header; inside the plot it collided with the y-axis
                  top label whenever the goal was the top of the scale. */}
              {layout.goalY != null && (
                <Line
                  x1={layout.gridLeft}
                  y1={layout.goalY}
                  x2={layout.gridRight}
                  y2={layout.goalY}
                  stroke={Colors.textDim}
                  strokeWidth={1}
                  strokeDasharray="3 4"
                />
              )}

              {segments.map((segment, i) => (
                <Path
                  key={i}
                  d={segment.d}
                  stroke={color}
                  strokeWidth={2}
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  // The leg into today: the day isn't over, so the line
                  // isn't solid either.
                  strokeDasharray={segment.dashed ? "4 3" : undefined}
                />
              ))}

              {series.points.map((p, i) =>
                p.value == null ? null : (
                  <Circle
                    key={p.date}
                    cx={layout.scale.x(i)}
                    cy={layout.scale.y(p.value)}
                    r={POINT_RADIUS}
                    // Hollow = "this number is not the whole story".
                    // Filled = a complete, finished day.
                    fill={isHollow(p) ? Colors.bg : color}
                    stroke={color}
                    strokeWidth={isHollow(p) ? POINT_STROKE : 0}
                  />
                ),
              )}

              {/* The y axis, inside the svg and inside a gutter the layout
                  sized from the widest label. Anchored "end" against the
                  right of that gutter; the baseline is computed from the
                  font's measured cap height rather than handed to
                  alignmentBaseline, which the two platform backends do not
                  treat alike. */}
              {layout.yTicks.map((tick) => (
                <SvgText
                  key={`tick-${tick.value}`}
                  x={layout.yLabelX}
                  y={tick.baseline}
                  fill={Colors.textDim}
                  fontSize={AXIS_FONT_SIZE}
                  fontFamily={Fonts.mono.regular}
                  textAnchor="end"
                >
                  {tick.label}
                </SvgText>
              ))}

              {/* Every date label is centred on its own point. The layout
                  reserves half a label at each end so the first and last
                  can be, which is why there is no anchor rule left here. */}
              {layout.xLabels.map((label) => (
                <SvgText
                  key={`date-${label.index}`}
                  x={label.x}
                  y={layout.xLabelBaseline}
                  fill={Colors.textDim}
                  fontSize={AXIS_FONT_SIZE}
                  fontFamily={Fonts.mono.regular}
                  textAnchor="middle"
                >
                  {label.text}
                </SvgText>
              ))}
            </Svg>
          )}
        </View>
      ) : (
        <View style={[styles.empty, { height: CHART_HEIGHT }]}>
          <Text style={styles.emptyText}>Nothing logged in this window</Text>
        </View>
      )}

      <Caption series={series} />
    </View>
  );
}

/** Says why any hollow points are hollow. Only states what is true of THIS
 *  chart — an unconditional legend would explain a notation that isn't on
 *  screen, which is its own kind of noise. */
function Caption({ series }: { series: TrendSeries }) {
  const drawn = series.points.filter((p) => p.value != null);
  const incomplete = drawn.filter((p) => p.incomplete).length;
  const unknownDays = series.points.filter(
    (p) => p.value == null && !p.unlogged,
  ).length;
  const unlogged = series.points.filter((p) => p.unlogged).length;
  const noun = series.meta.label.toLowerCase();

  const parts: string[] = [];
  if (incomplete > 0) {
    parts.push(
      `${incomplete} day${incomplete === 1 ? "" : "s"} missing some ${noun}`,
    );
  }
  if (unknownDays > 0) {
    parts.push(`${unknownDays} with no ${noun} data at all`);
  }
  if (unlogged > 0) {
    parts.push(`${unlogged} not logged`);
  }
  if (parts.length === 0) return null;

  return (
    <Text style={styles.caption} numberOfLines={2}>
      {parts.join(" · ")}
    </Text>
  );
}

const styles = StyleSheet.create(
  withDefaultFont({
    card: {
      backgroundColor: Colors.surface,
      borderRadius: Radius.card,
      borderWidth: 1,
      borderColor: Colors.border,
      padding: Spacing.sm,
      marginBottom: Spacing.sm,
    },
    head: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      marginBottom: Spacing.xs,
      gap: Spacing.sm,
    },
    titleWrap: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 6,
      flexShrink: 1,
      paddingTop: 2,
    },
    swatch: {
      width: 8,
      height: 8,
      borderRadius: 4,
      marginTop: 4,
    },
    title: {
      fontSize: Typography.sm,
      fontWeight: Typography.semibold,
      color: Colors.text,
      flexShrink: 1,
    },
    goal: {
      fontSize: Typography.xs,
      fontWeight: Typography.regular,
      color: Colors.textDim,
    },
    latestWrap: {
      alignItems: "flex-end",
      flexShrink: 0,
    },
    latest: {
      fontSize: Typography.md,
      fontFamily: Fonts.mono.semibold,
    },
    unit: {
      fontSize: Typography.xs,
      fontFamily: Fonts.mono.regular,
      color: Colors.textDim,
    },
    latestNote: {
      fontSize: Typography.xs,
      color: Colors.textDim,
      marginTop: -1,
    },
    // The whole inside of the card: the axis gutter lives inside the svg
    // now, so there is no sibling column to leave room for.
    plot: {
      height: CHART_HEIGHT,
    },
    empty: {
      alignItems: "center",
      justifyContent: "center",
    },
    emptyText: {
      fontSize: Typography.sm,
      color: Colors.textDim,
    },
    caption: {
      fontSize: Typography.xs,
      color: Colors.textDim,
      marginTop: Spacing.xs,
    },
  }),
);
