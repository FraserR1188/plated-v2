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
//   goal === null    → no goal line at all (PL-026).
//   y-axis           → always anchored at zero, per nutrient.
//
// The geometry is in lib/trends.ts too, so "nothing falls off the canvas"
// is asserted against real numbers rather than eyeballed. The device pass
// found today's hollow point cut in half by the right-hand edge.
//
// react-native-svg is already a dependency (CalorieRing uses it), so this
// adds nothing to the runtime fingerprint and ships by OTA.
// ============================================================

import React from "react";
import { View, Text, StyleSheet } from "react-native";
import Svg, { Circle, Line, Path, Text as SvgText } from "react-native-svg";
import {
  POINT_EXTENT,
  POINT_RADIUS,
  POINT_STROKE,
  TrendPoint,
  TrendRange,
  TrendSeries,
  buildChartScale,
  buildPathSegments,
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

interface Props {
  series: TrendSeries;
  range: TrendRange;
  /** Measured by the parent; the chart is width-driven, never fixed. */
  width: number;
}

/** Thousands separator, by hand rather than toLocaleString: the device's
 *  locale must not decide what a chart axis says. */
function withThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Rounds for display only. The underlying value is never rounded — see
 *  PL-028, where rounding to display precision on a WRITE was the defect. */
function formatValue(value: number, unit: "kcal" | "g"): string {
  if (unit === "kcal") return withThousands(Math.round(value));
  return value >= 10 ? withThousands(Math.round(value)) : value.toFixed(1);
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

export function TrendChart({ series, range, width }: Props) {
  const color = NUTRIENT_COLOR[series.nutrient] ?? Colors.green;
  const values = series.points
    .map((p) => p.value)
    .filter((v): v is number => v != null);

  // Its own scale, anchored at zero. The goal is included so the target
  // line is always on the canvas rather than off the top of it.
  const max = Math.max(
    ...values,
    0,
    ...(series.goal != null ? [series.goal] : []),
  );
  const scale = buildChartScale({
    width,
    height: CHART_HEIGHT,
    pointCount: series.points.length,
    max,
  });

  const segments = buildPathSegments(series.points, scale.x, scale.y);
  const axis = xAxisLabels(
    series.points.map((p) => p.date),
    range,
  );

  const latest = [...series.points].reverse().find((p) => p.value != null);
  const hasAnyData = values.length > 0;
  const scaleTop = max > 0 ? max : 1;
  const lastIndex = series.points.length - 1;

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View style={styles.titleWrap}>
          <View style={[styles.swatch, { backgroundColor: color }]} />
          <Text style={styles.title} numberOfLines={1}>
            {series.meta.label}
          </Text>
        </View>
        {latest?.value != null && (
          <View style={styles.latestWrap}>
            <Text style={[styles.latest, { color }]} numberOfLines={1}>
              {formatValue(latest.value, series.meta.unit)}
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
        <Svg width={width} height={CHART_HEIGHT}>
          {/* ── y-axis: the top of the scale, and zero ── */}
          <SvgText
            x={scale.plotLeft - POINT_EXTENT - 4}
            y={scale.plotTop + AXIS_FONT / 2}
            fill={Colors.textDim}
            fontSize={AXIS_FONT}
            fontFamily={Fonts.mono.regular}
            textAnchor="end"
          >
            {formatValue(scaleTop, series.meta.unit)}
          </SvgText>
          <SvgText
            x={scale.plotLeft - POINT_EXTENT - 4}
            y={scale.plotBottom + AXIS_FONT / 3}
            fill={Colors.textDim}
            fontSize={AXIS_FONT}
            fontFamily={Fonts.mono.regular}
            textAnchor="end"
          >
            0
          </SvgText>

          {/* The baseline, so zero is a place on the chart rather than a
              label floating beside nothing. */}
          <Line
            x1={scale.plotLeft}
            y1={scale.plotBottom}
            x2={scale.plotRight}
            y2={scale.plotBottom}
            stroke={Colors.border}
            strokeWidth={1}
          />

          {/* ── Goal line — dashed, behind the data, and LABELLED. Absent
                 unless goals are loaded and a target is set; see PL-026. */}
          {series.goal != null && (
            <>
              <Line
                x1={scale.plotLeft}
                y1={scale.y(series.goal)}
                x2={scale.plotRight}
                y2={scale.y(series.goal)}
                stroke={Colors.textDim}
                strokeWidth={1}
                strokeDasharray="3 4"
              />
              {/* Left-aligned, not right: today's point sits at the right
                  edge, and a label there would land on top of it. */}
              <SvgText
                x={scale.plotLeft + 2}
                y={Math.max(scale.y(series.goal) - 3, AXIS_FONT)}
                fill={Colors.textDim}
                fontSize={AXIS_FONT}
                fontFamily={Fonts.mono.regular}
                textAnchor="start"
              >
                {`goal ${formatValue(series.goal, series.meta.unit)}`}
              </SvgText>
            </>
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
              // The leg into today: the day isn't over, so the line isn't
              // solid either.
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
                // Hollow = "this number is not the whole story". Filled =
                // a complete, finished day.
                fill={isHollow(p) ? Colors.bg : color}
                stroke={color}
                strokeWidth={isHollow(p) ? POINT_STROKE : 0}
              />
            ),
          )}

          {/* ── x-axis dates ── */}
          {axis.map(({ index, label }) => (
            <SvgText
              key={`${index}-${label}`}
              x={scale.x(index)}
              y={CHART_HEIGHT - 3}
              fill={Colors.textDim}
              fontSize={AXIS_FONT}
              fontFamily={Fonts.mono.regular}
              // Centred under its point, except at the two ends, where
              // centring would push the label past the edge of the canvas.
              textAnchor={
                index === 0 ? "start" : index === lastIndex ? "end" : "middle"
              }
            >
              {label}
            </SvgText>
          ))}
        </Svg>
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
      alignItems: "center",
      gap: 6,
      flexShrink: 1,
      paddingTop: 2,
    },
    swatch: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    title: {
      fontSize: Typography.sm,
      fontWeight: Typography.semibold,
      color: Colors.text,
      flexShrink: 1,
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
