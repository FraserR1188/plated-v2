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
//   soFar            → hollow point. Today isn't finished.
//   goal === null    → no goal line at all (PL-026).
//
// react-native-svg is already a dependency (CalorieRing uses it), so this
// adds nothing to the runtime fingerprint and ships by OTA.
// ============================================================

import React from "react";
import { View, Text, StyleSheet } from "react-native";
import Svg, { Circle, Line, Path, Text as SvgText } from "react-native-svg";
import { TrendPoint, TrendSeries, buildPathSegments } from "../lib/trends";
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
 *  takes the energy accent -- the same green the calorie ring uses. */
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

const CHART_HEIGHT = 96;
const PAD_TOP = 10;
const PAD_BOTTOM = 16;
const PAD_LEFT = 2;
const PAD_RIGHT = 2;
const DOT_R = 3;

interface Props {
  series: TrendSeries;
  /** Measured by the parent; the chart is width-driven, never fixed. */
  width: number;
}

/** Rounds for display only. The underlying value is never rounded — see
 *  PL-028, where rounding to display precision on a WRITE was a defect. */
function formatValue(value: number, unit: "kcal" | "g"): string {
  if (unit === "kcal") return String(Math.round(value));
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}

export function TrendChart({ series, width }: Props) {
  const color = NUTRIENT_COLOR[series.nutrient] ?? Colors.green;
  const values = series.points
    .map((p) => p.value)
    .filter((v): v is number => v != null);

  const plotW = Math.max(width - PAD_LEFT - PAD_RIGHT, 1);
  const plotH = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;

  // Its OWN y-scale, per the small-multiples decision: each nutrient is
  // read against itself, not against calories. Includes the goal so the
  // line is always on the canvas, and 0 so the height of a bar-like line
  // is proportional to the value rather than to a zoomed window.
  const candidates = [...values, 0, ...(series.goal != null ? [series.goal] : [])];
  const rawMax = Math.max(...candidates);
  const max = rawMax > 0 ? rawMax : 1;

  const x = (i: number) =>
    PAD_LEFT +
    (series.points.length === 1
      ? plotW / 2
      : (i / (series.points.length - 1)) * plotW);
  const y = (v: number) => PAD_TOP + plotH - (v / max) * plotH;

  // Broken at every gap. The logic is in lib/trends.ts, not inlined here,
  // because a structural test cannot tell a line that breaks from one that
  // runs straight through -- a sabotage run proved it by removing the break
  // and leaving every matched token in place. buildPathSegments is checked
  // against real input instead.
  const segments = buildPathSegments(series.points, x, y);

  const latest = [...series.points].reverse().find((p) => p.value != null);
  const hasAnyData = values.length > 0;

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
          <Text style={[styles.latest, { color }]} numberOfLines={1}>
            {formatValue(latest.value, series.meta.unit)}
            <Text style={styles.unit}> {series.meta.unit}</Text>
          </Text>
        )}
      </View>

      {hasAnyData ? (
        <Svg width={width} height={CHART_HEIGHT}>
          {/* Goal line — dashed, behind the data. Absent unless goals are
              loaded AND a target is set; see PL-026. */}
          {series.goal != null && (
            <>
              <Line
                x1={PAD_LEFT}
                y1={y(series.goal)}
                x2={PAD_LEFT + plotW}
                y2={y(series.goal)}
                stroke={Colors.textDim}
                strokeWidth={1}
                strokeDasharray="3 4"
              />
              <SvgText
                x={PAD_LEFT + plotW}
                y={Math.max(y(series.goal) - 3, 8)}
                fill={Colors.textDim}
                fontSize={9}
                fontFamily={Fonts.mono.regular}
                textAnchor="end"
              >
                {formatValue(series.goal, series.meta.unit)}
              </SvgText>
            </>
          )}

          {segments.map((d, i) => (
            <Path
              key={i}
              d={d}
              stroke={color}
              strokeWidth={2}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

          {series.points.map((p, i) =>
            p.value == null ? null : (
              <Circle
                key={p.date}
                cx={x(i)}
                cy={y(p.value)}
                r={DOT_R}
                // Hollow = "this number is not the whole story". Filled =
                // a complete, finished day.
                fill={isHollow(p) ? Colors.bg : color}
                stroke={color}
                strokeWidth={isHollow(p) ? 1.5 : 0}
              />
            ),
          )}
        </Svg>
      ) : (
        <View style={[styles.empty, { height: CHART_HEIGHT }]}>
          <Text style={styles.emptyText}>
            Nothing logged in this window
          </Text>
        </View>
      )}

      <Caption series={series} />
    </View>
  );
}

const isHollow = (p: TrendPoint) => p.incomplete || p.soFar;

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

  const parts: string[] = [];
  if (incomplete > 0) {
    parts.push(
      `${incomplete} day${incomplete === 1 ? "" : "s"} missing some ${series.meta.label.toLowerCase()}`,
    );
  }
  if (unknownDays > 0) {
    parts.push(
      `${unknownDays} with no ${series.meta.label.toLowerCase()} data at all`,
    );
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
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: Spacing.xs,
      gap: Spacing.sm,
    },
    titleWrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      flexShrink: 1,
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
    latest: {
      fontSize: Typography.md,
      fontFamily: Fonts.mono.semibold,
    },
    unit: {
      fontSize: Typography.xs,
      fontFamily: Fonts.mono.regular,
      color: Colors.textDim,
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
