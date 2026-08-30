// ============================================================
// src/lib/workoutLabels.ts — readable provider / activity labels
//
// Display-only. Never touches what's stored, never touches
// biometric_workouts — origin_package and sport_name/ingest_transport
// reach here exactly as the view returns them. Lives outside
// TodayScreen's JSX because a Garmin-only tester's day stream and the
// (future) period-spine UI need the exact same two lookups.
// ============================================================

// ─── Provider label ────────────────────────────────────────────────
//
// Keyed on origin_package, NOT ingest_transport. This is the same
// reason biometric_workouts itself badges origin_package rather than
// transport (20260830090000_biometric_workouts_health_connect_arm.sql):
// transport alone can't tell a direct integration apart from the same
// vendor's app writing into Health Connect. Today that distinction only
// exists for WHOOP ('whoop.direct' vs 'com.whoop.android'), which is why
// 'com.whoop.android' gets its own explicit, distinguishable label
// below rather than reusing the plain "WHOOP" string — once dedup has
// collapsed a genuine duplicate pair the distinction is moot, but
// wherever it hasn't (different time windows, one side missing a
// permission), two cards reading identically would look like a second
// bug, not a known limitation.
//
// com.fitbit.FitbitMobile's mixed case is preserved verbatim and must
// match exactly: Health Connect package names are case-sensitive (see
// mapping.ts's validateOriginPackage comment) — this is a plain lookup,
// not case-insensitive, so a mismatched case here simply falls through
// to the fallback rather than silently mismatching.
const PROVIDER_LABELS: Record<string, string> = {
  "whoop.direct": "WHOOP",
  "com.whoop.android": "WHOOP · Health Connect",
  "com.garmin.android.apps.connectmobile": "Garmin",
  "com.fitbit.FitbitMobile": "Fitbit",
  "com.sec.android.app.shealth": "Samsung Health",
  "com.ouraring.oura": "Oura",
  "com.alltrails.alltrails": "AllTrails",
  "com.google.android.apps.fitness": "Google Fit",
};

/**
 * Falls back to "Health Connect" for an unrecognised Health-Connect-routed
 * package (not a placeholder like "Unknown" — the transport is a real,
 * true fact we still have even when the specific app isn't in the map
 * yet, and it's more useful than nothing) rather than deriving a name
 * from the package string itself (the last dotted segment gives
 * "Connectmobile" for Garmin — worse than saying nothing useful, since
 * it looks like a real name and isn't one).
 *
 * "Connected" is the last-resort fallback for a hypothetical future
 * direct integration not yet in this map — dead code today (the only
 * non-Health-Connect transport, 'whoop', is always in the map above),
 * kept so the function is total rather than assuming the map is
 * exhaustive for every transport forever.
 */
export function getProviderLabel(
  originPackage: string,
  ingestTransport: string,
): string {
  const known = PROVIDER_LABELS[originPackage];
  if (known) return known;
  if (ingestTransport === "health_connect") return "Health Connect";
  return "Connected";
}

// ─── Activity label ────────────────────────────────────────────────
//
// WHOOP's sport_name and Health Connect's activity_type are different,
// unrelated vocabularies sharing one column (biometric_workouts.
// sport_name) — see that view's own migration comment. ingest_transport
// is read ONLY to pick which of the two rules below applies; it is never
// used to translate one vocabulary's value into the other's.

function titleCaseFromSnake(value: string): string {
  return value
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * WHOOP's sport_name values are its own internal codes (confirmed real
 * values: 'weightlifting_msk', 'running') — opaque enough that they need
 * hand-curated overrides, not a full dictionary guessed without
 * evidence. Only 'weightlifting_msk' is listed: the mechanical fallback
 * already renders 'running' correctly ("Running"), so curating it too
 * would just duplicate what the fallback already gets right. Do not add
 * a WHOOP sport name here without a confirmed real value — this project
 * does not guess values it hasn't seen.
 */
const WHOOP_ACTIVITY_OVERRIDES: Record<string, string> = {
  // "_msk" is a WHOOP-internal qualifier (not documented as
  // user-facing); dropped for display rather than shown verbatim.
  weightlifting_msk: "Weightlifting",
};

export function getActivityLabel(
  sportName: string | null,
  ingestTransport: string,
): string {
  if (sportName == null) return "Workout";

  if (ingestTransport === "whoop") {
    return WHOOP_ACTIVITY_OVERRIDES[sportName] ?? titleCaseFromSnake(sportName);
  }

  // Health Connect's ExerciseType names (mapping.ts's EXERCISE_TYPE_NAMES)
  // are already self-describing UPPER_SNAKE_CASE English — 'WALKING',
  // 'STAIR_CLIMBING_MACHINE', 'OTHER_WORKOUT'. The mechanical transform
  // alone is enough for the whole vocabulary, known or not: it needs no
  // hand-curated map to keep in sync with that enum, and an activity type
  // the library adds in the future degrades to readable text (e.g.
  // "Rock Climbing") without this file changing at all — never to a
  // placeholder that hides what was actually recorded.
  return titleCaseFromSnake(sportName);
}
