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
// LAYOUT IS MEASURED, NEVER ASSUMED. The first device pass found points
// clipped at the edges; the second found the whole svg wider than its own
// card, because the width came from the container and the card adds its
// padding and border inside that. The plot now measures itself with
// onLayout, and the y-axis labels are real <Text> in a column the layout
// engine sizes — a fixed gutter had clipped "2,800" to ",800".
//
// react-native-svg is already a dependency (CalorieRing uses it), so this
// adds nothing to the runtime fingerprint and ships by OTA.
// ============================================================

import React, { useState } from "react";
import { View, Text, StyleSheet, LayoutChangeEvent } from "react-native";
import Svg, { Circle, Line, Path, Text as SvgText } from "react-native-svg";
import {
  POINT_EXTENT,
  POINT_RADIUS,
  POINT_STROKE,
  TrendPoint,
  TrendRange,
  TrendSeries,
  X_LABEL_HEIGHT,
  buildChartScale,
  buildPathSegments,
  formatNutrientValue,
  goalCaption,
  xAxisLabelBounds,
  xAxisLabels,
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

const CHART_HEIGHT = 108;
const AXIS_FONT = 9;

/** JetBrains Mono's advance width is 0.6em, and it is monospaced — which is
 *  the whole reason the label bounds can be computed instead of measured.
 *  Svg text does not respond to the system font scale, so this stays true
 *  at the largest Dynamic Type setting. */
const AXIS_CHAR_W = AXIS_FONT * 0.6;

interface Props {
  series: TrendSeries;
  range: TrendRange;
}

const isHollow = (p: TrendPoint) => p.incomplete || p.soFar;

/** "19 Sep" — for the headline when the most recent value isn't today's. */
function shortDay(key: string): string {
  const MONTH = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const [, m, d] = key.split("-").map(Number);
  return `${d} ${MONTH[m - 1]}`;
}

export function TrendChart({ series, range }: Props) {
  // The MEASURED inside of the card. Nothing is drawn until it is known.
  const [plotWidth, setPlotWidth] = useState(0);

  const color = NUTRIENT_COLOR[series.nutrient] ?? Colors.green;
  const values = series.points
    .map((p) => p.value)
    .filter((v): v is number => v != null);

  // Its own scale, anchored at zero. The goal is included so the dashed
  // target line is always on the canvas rather than off the top of it.
  const max = Math.max(
    ...values,
    0,
    ...(series.goal != null ? [series.goal] : []),
  );
  const scale = buildChartScale({
    width: Math.max(plotWidth, 1),
    height: CHART_HEIGHT,
    pointCount: series.points.length,
    max,
  });

  const segments = buildPathSegments(series.points, scale.x, scale.y);
  const axis = xAxisLabelBounds(
    xAxisLabels(series.points.map((p) => p.date), range),
    scale,
    series.points.length,
    AXIS_CHAR_W,
  );

  const latest = [...series.points].reverse().find((p) => p.value != null);
  const hasAnyData = values.length > 0;
  const scaleTop = max > 0 ? max : 1;
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

      {hasAnyData ? (
        <View style={styles.plotRow}>
          {/* The y-axis, OUTSIDE the svg so the layout engine sizes it.
              Both labels are width-independent: plotTop and plotBottom come
              from the height and the point extent alone. */}
          <View style={styles.yAxis}>
            <Text
              style={[
                styles.axisText,
                { top: scale.plotTop - AXIS_FONT / 2 - 1 },
              ]}
            >
              {formatNutrientValue(scaleTop, series.meta.unit)}
            </Text>
            <Text
              style={[
                styles.axisText,
                { top: scale.plotBottom - AXIS_FONT / 2 - 1 },
              ]}
            >
              0
            </Text>
          </View>

          <View style={styles.plot} onLayout={onPlotLayout}>
            {plotWidth > 0 && (
              <Svg width={plotWidth} height={CHART_HEIGHT}>
                {/* The baseline, so zero is a place on the chart rather
                    than a label floating beside nothing. */}
                <Line
                  x1={scale.plotLeft}
                  y1={scale.plotBottom}
                  x2={scale.plotRight}
                  y2={scale.plotBottom}
                  stroke={Colors.border}
                  strokeWidth={1}
                />

                {/* The goal line — dashed and UNLABELLED. The number is in
                    the card header; inside the plot it collided with the
                    y-axis top label whenever the goal was the top of the
                    scale, which is common. */}
                {series.goal != null && (
                  <Line
                    x1={scale.plotLeft}
                    y1={scale.y(series.goal)}
                    x2={scale.plotRight}
                    y2={scale.y(series.goal)}
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
                      cx={scale.x(i)}
                      cy={scale.y(p.value)}
                      r={POINT_RADIUS}
                      // Hollow = "this number is not the whole story".
                      // Filled = a complete, finished day.
                      fill={isHollow(p) ? Colors.bg : color}
                      stroke={color}
                      strokeWidth={isHollow(p) ? POINT_STROKE : 0}
                    />
                  ),
                )}

                {axis.map(({ index, label, anchor }) => (
                  <SvgText
                    key={`${index}-${label}`}
                    x={scale.x(index)}
                    y={CHART_HEIGHT - 3}
                    fill={Colors.textDim}
                    fontSize={AXIS_FONT}
                    fontFamily={Fonts.mono.regular}
                    // The end labels anchor inward; the rule is in
                    // xAxisLabelBounds, where it is tested against the
                    // canvas bounds rather than eyeballed.
                    textAnchor={anchor}
                  >
                    {label}
                  </SvgText>
                ))}
              </Svg>
            )}
          </View>
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
    plotRow: {
      flexDirection: "row",
      alignItems: "flex-start",
    },
    yAxis: {
      height: CHART_HEIGHT,
      // No fixed width: the column is as wide as its widest label, which
      // is what stops "2,800" being clipped to ",800".
      justifyContent: "flex-start",
      marginRight: 4,
    },
    axisText: {
      position: "absolute",
      right: 0,
      fontSize: AXIS_FONT,
      fontFamily: Fonts.mono.regular,
      color: Colors.textDim,
      // Svg text ignores the system font scale, so the axis numbers must
      // too, or the column and the plot disagree about where zero is.
      includeFontPadding: false,
    },
    plot: {
      flex: 1,
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

// Reserved inside buildChartScale for the x-axis strip; referenced so the
// two cannot drift apart unnoticed if the strip is ever resized.
void X_LABEL_HEIGHT;
