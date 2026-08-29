// ============================================================
// src/lib/__tests__/healthConnectIngest.test.ts
//
// Tests supabase/functions/health-connect-ingest/mapping.ts directly.
// index.ts itself cannot be imported here — it transitively pulls in
// `jsr:@supabase/supabase-js@2` via _shared/auth.ts (a specifier Node/
// Vite cannot resolve) and calls Deno.serve() at module load, so even
// importing it would throw before a single assertion ran. mapping.ts is
// deliberately free of both, which is what makes this file possible.
//
// This lives under src/lib/__tests__/ purely as a matter of test-runner
// convenience (Vitest discovers tests project-wide, not just under src/);
// the module under test is NOT part of the client app and does not write
// meal_entries — src/lib/__tests__/mealEntriesInsertSites.test.ts's AST
// walk excludes every __tests__ directory already, and this file's import
// target (supabase/functions/health-connect-ingest/mapping.ts) sits
// outside src/ entirely, so it was never in that walk's scope to begin
// with.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  num,
  validateOriginPackage,
  providerRecordId,
  mapSleepSession,
  mapHrv,
  mapRestingHr,
  mapExerciseSession,
} from "../../../supabase/functions/health-connect-ingest/mapping";

describe("num", () => {
  it("passes a finite number through unchanged", () => {
    expect(num(42.5)).toBe(42.5);
  });

  it("is null for undefined — absent means absent, never 0", () => {
    expect(num(undefined)).toBeNull();
  });

  it("is null for a non-numeric string", () => {
    expect(num("not a number")).toBeNull();
  });
});

describe("validateOriginPackage", () => {
  it("accepts a well-formed package name and preserves it verbatim", () => {
    expect(validateOriginPackage("com.garmin.android.apps.connectmobile")).toEqual(
      { ok: true, value: "com.garmin.android.apps.connectmobile" },
    );
  });

  it("preserves MIXED CASE — com.fitbit.FitbitMobile is a real package and must survive round-trip", () => {
    const result = validateOriginPackage("com.fitbit.FitbitMobile");
    expect(result).toEqual({ ok: true, value: "com.fitbit.FitbitMobile" });
    if (result.ok) {
      // Explicitly not lower-cased anywhere along the way.
      expect(result.value).not.toBe(result.value.toLowerCase());
    }
  });

  it("rejects an empty string", () => {
    expect(validateOriginPackage("").ok).toBe(false);
  });

  it("rejects a missing value", () => {
    expect(validateOriginPackage(undefined).ok).toBe(false);
  });

  it("rejects a package with no dot at all", () => {
    expect(validateOriginPackage("fitbit").ok).toBe(false);
  });

  it("rejects the reserved '.direct' namespace — a health_connect row must never claim it", () => {
    const result = validateOriginPackage("whoop.direct");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/reserved '\.direct' namespace/);
  });

  it("rejects '.direct' case-insensitively — a differently-cased evasion is still caught", () => {
    expect(validateOriginPackage("com.example.App.DIRECT").ok).toBe(false);
  });
});

describe("providerRecordId", () => {
  it("prefers metadata.clientRecordId when the writing app set one", () => {
    expect(
      providerRecordId({ clientRecordId: "fitbit-abc123", id: "hc-uuid-1" }),
    ).toBe("fitbit-abc123");
  });

  it("falls back to metadata.id when clientRecordId is absent", () => {
    expect(providerRecordId({ id: "hc-uuid-1" })).toBe("hc-uuid-1");
  });

  it("is null when neither is present — never fabricates an id", () => {
    expect(providerRecordId({})).toBeNull();
    expect(providerRecordId(undefined)).toBeNull();
  });

  it("ignores a non-string clientRecordId and falls back to id", () => {
    expect(providerRecordId({ clientRecordId: 12345, id: "hc-uuid-1" })).toBe(
      "hc-uuid-1",
    );
  });
});

const BASE_SLEEP = {
  startTime: "2026-08-28T22:00:00.000Z",
  endTime: "2026-08-29T06:00:00.000Z",
  metadata: { id: "hc-sleep-1" },
};

describe("mapSleepSession", () => {
  it("maps a full record with every stage present", () => {
    const row = mapSleepSession("user-1", "com.fitbit.FitbitMobile", {
      ...BASE_SLEEP,
      stages: [
        { stage: 1, startTime: "2026-08-28T22:00:00.000Z", endTime: "2026-08-28T22:10:00.000Z" }, // AWAKE, 10min
        { stage: 4, startTime: "2026-08-28T22:10:00.000Z", endTime: "2026-08-28T23:10:00.000Z" }, // LIGHT, 60min
        { stage: 5, startTime: "2026-08-28T23:10:00.000Z", endTime: "2026-08-29T00:10:00.000Z" }, // DEEP, 60min
        { stage: 6, startTime: "2026-08-29T00:10:00.000Z", endTime: "2026-08-29T01:10:00.000Z" }, // REM, 60min
      ],
    });

    expect(row.user_id).toBe("user-1");
    expect(row.ingest_transport).toBe("health_connect");
    expect(row.origin_package).toBe("com.fitbit.FitbitMobile");
    expect(row.provider_record_id).toBe("hc-sleep-1");
    expect(row.period_start).toBe(BASE_SLEEP.startTime);
    expect(row.period_end).toBe(BASE_SLEEP.endTime);
    expect(row.total_in_bed_ms).toBe(8 * 60 * 60 * 1000); // 22:00 -> 06:00
    expect(row.total_awake_ms).toBe(10 * 60 * 1000);
    expect(row.total_light_ms).toBe(60 * 60 * 1000);
    expect(row.total_deep_ms).toBe(60 * 60 * 1000);
    expect(row.total_rem_ms).toBe(60 * 60 * 1000);
    expect(row.total_sleep_ms).toBe(3 * 60 * 60 * 1000); // light+deep+rem, awake excluded
    expect(row.sleep_efficiency_percentage).toBeNull();
    expect(row).not.toHaveProperty("is_nap"); // omitted, not guessed — see mapping.ts comment
  });

  it("every stage total is NULL, not 0, when the record reports no stage breakdown at all", () => {
    const row = mapSleepSession("user-1", "com.fitbit.FitbitMobile", BASE_SLEEP);

    expect(row.total_awake_ms).toBeNull();
    expect(row.total_light_ms).toBeNull();
    expect(row.total_deep_ms).toBeNull();
    expect(row.total_rem_ms).toBeNull();
    expect(row.total_sleep_ms).toBeNull();
    // total_in_bed_ms is NOT stage-derived — it's the session span, always computable.
    expect(row.total_in_bed_ms).toBe(8 * 60 * 60 * 1000);
  });

  it("a stage type present in the array with zero matching duration is a real 0, not null", () => {
    const row = mapSleepSession("user-1", "com.fitbit.FitbitMobile", {
      ...BASE_SLEEP,
      // Only LIGHT reported — DEEP genuinely measured as zero for this session, not absent.
      stages: [
        { stage: 4, startTime: "2026-08-28T22:00:00.000Z", endTime: "2026-08-29T06:00:00.000Z" },
      ],
    });

    expect(row.total_light_ms).toBe(8 * 60 * 60 * 1000);
    expect(row.total_deep_ms).toBe(0);
    expect(row.total_rem_ms).toBe(0);
  });

  it("ignores a client-supplied ingest_transport on the raw record — always health_connect", () => {
    const row = mapSleepSession("user-1", "com.fitbit.FitbitMobile", {
      ...BASE_SLEEP,
      ingest_transport: "whoop", // a malicious or buggy client trying to inject this
    } as never);

    expect(row.ingest_transport).toBe("health_connect");
  });
});

const BASE_HRV = {
  time: "2026-08-29T03:00:00.000Z",
  metadata: { id: "hc-hrv-1" },
};

describe("mapHrv", () => {
  it("maps a full record, hrv_method/hrv_unit always explicit", () => {
    const row = mapHrv("user-1", "com.oura.ring", {
      ...BASE_HRV,
      heartRateVariabilityMillis: 45.2,
    });

    expect(row.measured_at).toBe(BASE_HRV.time);
    expect(row.hrv_value).toBe(45.2);
    expect(row.hrv_method).toBe("rmssd");
    expect(row.hrv_unit).toBe("ms");
    expect(row.hrv_window).toBe("instantaneous");
  });

  it("hrv_value is NULL, not 0, when the record omits the reading", () => {
    const row = mapHrv("user-1", "com.oura.ring", BASE_HRV);
    expect(row.hrv_value).toBeNull();
    // hrv_method/hrv_unit are written regardless — never defaulted, never skipped.
    expect(row.hrv_method).toBe("rmssd");
    expect(row.hrv_unit).toBe("ms");
  });
});

const BASE_RHR = {
  time: "2026-08-29T05:00:00.000Z",
  metadata: { id: "hc-rhr-1" },
};

describe("mapRestingHr", () => {
  it("maps a full record with measurement_scope = 'period'", () => {
    const row = mapRestingHr("user-1", "com.garmin.android.apps.connectmobile", {
      ...BASE_RHR,
      beatsPerMinute: 52,
    });

    expect(row.resting_heart_rate).toBe(52);
    expect(row.measurement_scope).toBe("period");
  });

  it("resting_heart_rate is NULL, not 0, when the record omits it", () => {
    const row = mapRestingHr(
      "user-1",
      "com.garmin.android.apps.connectmobile",
      BASE_RHR,
    );
    expect(row.resting_heart_rate).toBeNull();
    expect(row.measurement_scope).toBe("period");
  });
});

const BASE_EXERCISE = {
  startTime: "2026-08-29T07:00:00.000Z",
  endTime: "2026-08-29T07:45:00.000Z",
  metadata: { id: "hc-exercise-1" },
};

describe("mapExerciseSession", () => {
  it("maps a known exerciseType to its name", () => {
    const row = mapExerciseSession("user-1", "com.strava", {
      ...BASE_EXERCISE,
      exerciseType: 56, // RUNNING
    });

    expect(row.activity_type).toBe("RUNNING");
    expect(row.period_start).toBe(BASE_EXERCISE.startTime);
    expect(row.period_end).toBe(BASE_EXERCISE.endTime);
  });

  it("activity_type is NULL, not a raw number or a guess, when exerciseType is absent", () => {
    const row = mapExerciseSession("user-1", "com.strava", BASE_EXERCISE);
    expect(row.activity_type).toBeNull();
  });

  it("activity_type is NULL for an unrecognised exerciseType code", () => {
    const row = mapExerciseSession("user-1", "com.strava", {
      ...BASE_EXERCISE,
      exerciseType: 9999,
    });
    expect(row.activity_type).toBeNull();
  });

  it("heart-rate, calorie, distance, and altitude fields are ALWAYS null — never requested, never guessed", () => {
    const row = mapExerciseSession("user-1", "com.strava", {
      ...BASE_EXERCISE,
      exerciseType: 56,
      // Even if a provider's raw payload happened to carry these (it won't,
      // per Health Connect's own data model — see mapping.ts), the mapper
      // must not read them.
      averageHeartRate: 150,
      calories: 400,
    } as never);

    expect(row.average_heart_rate).toBeNull();
    expect(row.max_heart_rate).toBeNull();
    expect(row.energy_kilojoule).toBeNull();
    expect(row.distance_meter).toBeNull();
    expect(row.altitude_gain_meter).toBeNull();
  });
});
