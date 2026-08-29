// ============================================================
// supabase/functions/health-connect-ingest/mapping.ts
//
// Pure normalisation and validation logic, deliberately factored OUT of
// index.ts and free of any Deno-only import (no _shared/*, no Deno.*
// global) — index.ts imports from here for the real handler, and
// src/lib/__tests__/healthConnectIngest.test.ts imports the exact same
// file directly for coverage. index.ts alone cannot be unit-tested with
// Vitest: it transitively pulls in `jsr:@supabase/supabase-js@2` via
// _shared/auth.ts, which Node/Vite cannot resolve, and calls Deno.serve()
// at module load — importing it at all would throw in a Node test
// environment before a single assertion ran.
// ============================================================

// ─── Coercion. Mirrors whoop-sync/index.ts's num()/int() exactly: a value
// the provider did not report is NULL, never 0. ──────────────────────────

export const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ─── origin_package validation ───────────────────────────────────────────
//
// Same shape check as the DB CHECK constraint
// (20260829072742_biometric_provider_neutral_tables.sql) — rejected here,
// in code, with a clear message, rather than left for Postgres to surface
// as an opaque constraint-violation error. The '.direct' rejection is
// case-INsensitive on purpose even though the DB's own `LIKE '%.direct'`
// comparison is case-sensitive: better to catch a differently-cased
// evasion here with a clear message than let it either slip through or
// hit the DB constraint with a worse one.

export const ORIGIN_PACKAGE_SHAPE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

export type OriginResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

export function validateOriginPackage(raw: unknown): OriginResult {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: "origin_package missing or empty" };
  }
  if (!ORIGIN_PACKAGE_SHAPE.test(raw)) {
    return {
      ok: false,
      error: `origin_package "${raw}" does not match the required package-name shape`,
    };
  }
  if (raw.toLowerCase().endsWith(".direct")) {
    return {
      ok: false,
      error: `origin_package "${raw}" uses the reserved '.direct' namespace — a health_connect row must never claim it`,
    };
  }
  return { ok: true, value: raw };
}

/**
 * Prefers metadata.clientRecordId (stable across a phone switch — set by
 * the WRITING app, not by this device) and falls back to metadata.id
 * (Health Connect's own device-local UUID, which changes if the user
 * switches phones and would re-insert the same real-world record as a
 * new row under a fresh id). Neither present means the record cannot be
 * identified — skipped rather than inserted with a fabricated id.
 */
export function providerRecordId(metadata: unknown): string | null {
  const m = (metadata ?? {}) as { clientRecordId?: unknown; id?: unknown };
  if (typeof m.clientRecordId === "string" && m.clientRecordId.length > 0) {
    return m.clientRecordId;
  }
  if (typeof m.id === "string" && m.id.length > 0) {
    return m.id;
  }
  return null;
}

// deno-lint-ignore no-explicit-any
export type RawRecord = Record<string, any>;

// ─── Row mappers ─────────────────────────────────────────────
//
// EXPLICIT snake_case, every column listed, no spreads — same discipline
// as whoop-sync/index.ts:147-148. ingest_transport is a LITERAL here,
// never read off the incoming record: a client-supplied transport value
// has nowhere to go because these mappers never look for one.

export function mapSleepSession(
  userId: string,
  originPackage: string,
  r: RawRecord,
) {
  const stages: Array<{ startTime: string; endTime: string; stage: number }> =
    Array.isArray(r.stages) ? r.stages : [];

  // SleepStageType (react-native-health-connect@4.1.3's constants.d.ts):
  // UNKNOWN=0, AWAKE=1, SLEEPING=2, OUT_OF_BED=3, LIGHT=4, DEEP=5, REM=6.
  const AWAKE = 1;
  const SLEEPING = 2;
  const LIGHT = 4;
  const DEEP = 5;
  const REM = 6;

  const stageMs = (types: number[]): number =>
    stages
      .filter((s) => types.includes(s.stage))
      .reduce(
        (sum, s) =>
          sum +
          (new Date(s.endTime).getTime() - new Date(s.startTime).getTime()),
        0,
      );

  // NULL only when there is genuinely no stage breakdown at all — a stage
  // type present in the array with zero total duration is a real measured
  // zero, not an absence, and stageMs() correctly returns 0 for that case
  // on its own (filter() over an empty match set sums to 0).
  const hasStages = stages.length > 0;

  return {
    user_id: userId,
    ingest_transport: "health_connect",
    origin_package: originPackage,
    provider_record_id: providerRecordId(r.metadata)!,
    timezone_offset: r.startZoneOffset?.id ?? null,
    raw: r,
    source_updated_at: r.metadata?.lastModifiedTime ?? null,
    synced_at: new Date().toISOString(),

    period_start: r.startTime,
    period_end: r.endTime,
    // is_nap intentionally OMITTED, not set to a guessed value. Health
    // Connect's SleepSessionRecord carries no nap signal at all (WHOOP has
    // one; this doesn't). The column's own `not null default false` is the
    // honest "we don't know" answer — letting Postgres apply it is
    // different from this function asserting false as a fact it doesn't
    // have.

    // total_in_bed_ms: the whole session span. Health Connect's
    // SleepSessionRecord IS a "time in bed" session by definition (start/
    // end bound the attempt to sleep, not only the asleep portion) — the
    // same convention WHOOP uses for its own total_in_bed_time_milli.
    total_in_bed_ms: Math.round(
      new Date(r.endTime).getTime() - new Date(r.startTime).getTime(),
    ),
    total_awake_ms: hasStages ? stageMs([AWAKE]) : null,
    total_light_ms: hasStages ? stageMs([LIGHT]) : null,
    // Health Connect's DEEP stage is its own vocabulary — see the column
    // comment on biometric_sleep_sessions.total_deep_ms
    // (20260829072742_biometric_provider_neutral_tables.sql): related to
    // WHOOP's slow-wave-sleep metric, not identical to it. Mapped as-is,
    // never renamed or conflated.
    total_deep_ms: hasStages ? stageMs([DEEP]) : null,
    total_rem_ms: hasStages ? stageMs([REM]) : null,
    // "Actually asleep" = SLEEPING (generic, stage-unspecified) + LIGHT +
    // DEEP + REM. Deliberately excludes AWAKE and OUT_OF_BED.
    total_sleep_ms: hasStages ? stageMs([SLEEPING, LIGHT, DEEP, REM]) : null,
    // Health Connect computes no equivalent to WHOOP's sleep performance/
    // efficiency score. Always null here, not a mapping gap.
    sleep_efficiency_percentage: null,
  };
}

export function mapHrv(userId: string, originPackage: string, r: RawRecord) {
  return {
    user_id: userId,
    ingest_transport: "health_connect",
    origin_package: originPackage,
    provider_record_id: providerRecordId(r.metadata)!,
    timezone_offset: r.zoneOffset?.id ?? null,
    raw: r,
    source_updated_at: r.metadata?.lastModifiedTime ?? null,
    synced_at: new Date().toISOString(),

    measured_at: r.time,
    hrv_value: num(r.heartRateVariabilityMillis),
    // hrv_method / hrv_unit are NEVER defaulted at the table level (see
    // biometric_hrv_samples — both are NOT NULL with no DEFAULT precisely
    // so an ingest path cannot forget to state them). Health Connect only
    // ever reports RMSSD, in milliseconds — written explicitly per row.
    hrv_method: "rmssd",
    // Health Connect's HeartRateVariabilityRmssdRecord is a single
    // point-in-time reading with no windowing metadata at all (no "sleep"
    // or "5min" concept the way some devices report) — 'instantaneous' is
    // what the record actually says, not a borrowed WHOOP label.
    hrv_window: "instantaneous",
    hrv_unit: "ms",
  };
}

export function mapRestingHr(
  userId: string,
  originPackage: string,
  r: RawRecord,
) {
  return {
    user_id: userId,
    ingest_transport: "health_connect",
    origin_package: originPackage,
    provider_record_id: providerRecordId(r.metadata)!,
    timezone_offset: r.zoneOffset?.id ?? null,
    raw: r,
    source_updated_at: r.metadata?.lastModifiedTime ?? null,
    synced_at: new Date().toISOString(),

    measured_at: r.time,
    resting_heart_rate: num(r.beatsPerMinute),
    // RestingHeartRateRecord is InstantaneousRecord (a single `time` +
    // beatsPerMinute) per react-native-health-connect@4.1.3's actual type
    // declarations — NOT a calendar-day aggregate. 'period' is correct:
    // the same single-bounded-reading shape as WHOOP's own per-cycle (not
    // daily-rolled-up) resting heart rate.
    measurement_scope: "period",
  };
}

// ExerciseType (react-native-health-connect@4.1.3's constants.d.ts),
// inverted for display. Transcribed from the installed package — not
// guessed.
export const EXERCISE_TYPE_NAMES: Record<number, string> = {
  0: "OTHER_WORKOUT",
  1: "BACK_EXTENSION",
  2: "BADMINTON",
  3: "BARBELL_SHOULDER_PRESS",
  4: "BASEBALL",
  5: "BASKETBALL",
  6: "BENCH_PRESS",
  7: "BENCH_SIT_UP",
  8: "BIKING",
  9: "BIKING_STATIONARY",
  10: "BOOT_CAMP",
  11: "BOXING",
  12: "BURPEE",
  13: "CALISTHENICS",
  14: "CRICKET",
  15: "CRUNCH",
  16: "DANCING",
  17: "DEADLIFT",
  18: "DUMBBELL_CURL_LEFT_ARM",
  19: "DUMBBELL_CURL_RIGHT_ARM",
  20: "DUMBBELL_FRONT_RAISE",
  21: "DUMBBELL_LATERAL_RAISE",
  22: "DUMBBELL_TRICEPS_EXTENSION_LEFT_ARM",
  23: "DUMBBELL_TRICEPS_EXTENSION_RIGHT_ARM",
  24: "DUMBBELL_TRICEPS_EXTENSION_TWO_ARM",
  25: "ELLIPTICAL",
  26: "EXERCISE_CLASS",
  27: "FENCING",
  28: "FOOTBALL_AMERICAN",
  29: "FOOTBALL_AUSTRALIAN",
  30: "FORWARD_TWIST",
  31: "FRISBEE_DISC",
  32: "GOLF",
  33: "GUIDED_BREATHING",
  34: "GYMNASTICS",
  35: "HANDBALL",
  36: "HIGH_INTENSITY_INTERVAL_TRAINING",
  37: "HIKING",
  38: "ICE_HOCKEY",
  39: "ICE_SKATING",
  40: "JUMPING_JACK",
  41: "JUMP_ROPE",
  42: "LAT_PULL_DOWN",
  43: "LUNGE",
  44: "MARTIAL_ARTS",
  46: "PADDLING",
  47: "PARAGLIDING",
  48: "PILATES",
  49: "PLANK",
  50: "RACQUETBALL",
  51: "ROCK_CLIMBING",
  52: "ROLLER_HOCKEY",
  53: "ROWING",
  54: "ROWING_MACHINE",
  55: "RUGBY",
  56: "RUNNING",
  57: "RUNNING_TREADMILL",
  58: "SAILING",
  59: "SCUBA_DIVING",
  60: "SKATING",
  61: "SKIING",
  62: "SNOWBOARDING",
  63: "SNOWSHOEING",
  64: "SOCCER",
  65: "SOFTBALL",
  66: "SQUASH",
  67: "SQUAT",
  68: "STAIR_CLIMBING",
  69: "STAIR_CLIMBING_MACHINE",
  70: "STRENGTH_TRAINING",
  71: "STRETCHING",
  72: "SURFING",
  73: "SWIMMING_OPEN_WATER",
  74: "SWIMMING_POOL",
  75: "TABLE_TENNIS",
  76: "TENNIS",
  77: "UPPER_TWIST",
  78: "VOLLEYBALL",
  79: "WALKING",
  80: "WATER_POLO",
  81: "WEIGHTLIFTING",
  82: "WHEELCHAIR",
  83: "YOGA",
};

export function mapExerciseSession(
  userId: string,
  originPackage: string,
  r: RawRecord,
) {
  return {
    user_id: userId,
    ingest_transport: "health_connect",
    origin_package: originPackage,
    provider_record_id: providerRecordId(r.metadata)!,
    timezone_offset: r.startZoneOffset?.id ?? null,
    raw: r,
    source_updated_at: r.metadata?.lastModifiedTime ?? null,
    synced_at: new Date().toISOString(),

    period_start: r.startTime,
    period_end: r.endTime,
    activity_type:
      typeof r.exerciseType === "number"
        ? (EXERCISE_TYPE_NAMES[r.exerciseType] ?? null)
        : null,
    // ExerciseSessionRecord carries no heart-rate, calorie, distance, or
    // altitude fields at all in Health Connect's data model — those live
    // on separate record types (HeartRate, TotalCaloriesBurned, Distance,
    // ElevationGained) gated by permissions this app deliberately did not
    // request. Always null here — a scope consequence, not a mapping gap.
    // No strain either: WHOOP-proprietary, no Health Connect equivalent,
    // not synthesized.
    average_heart_rate: null,
    max_heart_rate: null,
    energy_kilojoule: null,
    distance_meter: null,
    altitude_gain_meter: null,
  };
}

// ─── Collection registry ─────────────────────────────────────

export type Collection = {
  table: string;
  conflict: string;
  map: (
    userId: string,
    originPackage: string,
    r: RawRecord,
  ) => Record<string, unknown>;
};

export const COLLECTIONS: Record<string, Collection> = {
  SleepSession: {
    table: "biometric_sleep_sessions",
    conflict: "user_id,origin_package,provider_record_id",
    map: mapSleepSession,
  },
  HeartRateVariabilityRmssd: {
    table: "biometric_hrv_samples",
    conflict: "user_id,origin_package,provider_record_id",
    map: mapHrv,
  },
  RestingHeartRate: {
    table: "biometric_resting_hr",
    conflict: "user_id,origin_package,provider_record_id",
    map: mapRestingHr,
  },
  ExerciseSession: {
    table: "biometric_workout_sessions",
    conflict: "user_id,origin_package,provider_record_id",
    map: mapExerciseSession,
  },
};
