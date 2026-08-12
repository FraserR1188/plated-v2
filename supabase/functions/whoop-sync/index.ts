// ============================================================
// supabase/functions/whoop-sync/index.ts
//
// Pulls a rolling window of WHOOP data and upserts it.
//
// ── THE WINDOW: 7 DAYS, NOT 400 ─────────────────────────────────────────
//
// The binding constraint on correlation quality was never WHOOP history — it
// is MEAL history. plated only knows what you ate for as long as plated has
// existed. Backfilling 400 days of cycles against three weeks of meals gives
// you 380 rows joined to nothing.
//
// So: seven days. Which turns the whole "resumable chunked backfill with
// cursor state across invocations" design into four HTTP requests. No
// whoop_sync_state table, no progress bar, no 150s budget problem.
//
// The window is NOT a constant, though. A user who doesn't open the app for a
// month would get a permanent 23-day hole that nothing ever goes back for:
//
//     from = min(now - 7d, last_sync_at - 1d)     reach back if we've been away
//     clamped to now - MAX_WINDOW_DAYS            bound the worst case
//
// The `- 1d` overlap is not paranoia: WHOOP RE-SCORES records retroactively,
// so every sync must re-pull ground it has already covered. The 7-day default
// does double duty as the re-score sweep.
//
// ── THROTTLE: ATTEMPTS, NOT SUCCESSES ───────────────────────────────────
//
// last_sync_at only moves on success — it anchors the window, so moving it on
// a failure would punch a hole in the data. Which means it cannot be the
// throttle key. Throttling on it would mean: WHOOP goes down, last_sync_at
// stops moving, the throttle never engages, and every app foreground fires
// another attempt. Forever. For every user. And because WHOOP rate-limits per
// APP (100/min, 10,000/day shared across the entire user base, not per user),
// that retry storm burns the daily budget for everyone at once.
//
// So last_sync_attempt_at is written FIRST, before any work, and it is what
// the throttle reads.
// ============================================================

import { preflight, json, fail } from "../_shared/cors.ts";
import { getCallerId, adminClient } from "../_shared/auth.ts";
import { getValidToken } from "../_shared/whoopToken.ts";
import { whoopGet, sleep, WHOOP_PAGE_LIMIT } from "../_shared/whoop.ts";

const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 30;
const OVERLAP_DAYS = 1;

/** Automatic (app-foreground) syncs. */
const THROTTLE_MS = 15 * 60 * 1000;
/** "Sync now" bypasses the throttle — but not entirely. */
const FORCE_THROTTLE_MS = 60 * 1000;

/** Bound a runaway cursor. 7 days should never need more than 2. */
const MAX_PAGES = 10;

/** Stop and report partial rather than being killed at 150s by the gateway. */
const TIME_BUDGET_MS = 45_000;

/** Pre-emptive pause when the app-wide minute budget is nearly spent. */
const RATE_FLOOR = 10;

// ─── WHOOP wire types (only the bits we promote) ─────────────

type Scored = { score_state?: string; updated_at?: string };

type WhoopCycle = Scored & {
  id: number;
  start: string;
  end: string | null;
  timezone_offset?: string;
  score?: {
    strain?: number;
    kilojoule?: number;
    average_heart_rate?: number;
    max_heart_rate?: number;
  };
};

type WhoopSleep = Scored & {
  id: string;
  start: string;
  end: string;
  timezone_offset?: string;
  nap?: boolean;
  score?: {
    stage_summary?: {
      total_in_bed_time_milli?: number;
      total_awake_time_milli?: number;
      total_light_sleep_time_milli?: number;
      total_slow_wave_sleep_time_milli?: number;
      total_rem_sleep_time_milli?: number;
      sleep_cycle_count?: number;
      disturbance_count?: number;
    };
    sleep_performance_percentage?: number;
    sleep_efficiency_percentage?: number;
    sleep_consistency_percentage?: number;
    respiratory_rate?: number;
  };
};

type WhoopRecovery = Scored & {
  cycle_id: number;
  sleep_id: string;
  score?: {
    user_calibrating?: boolean;
    recovery_score?: number;
    resting_heart_rate?: number;
    hrv_rmssd_milli?: number;
    spo2_percentage?: number;
    skin_temp_celsius?: number;
  };
};

type WhoopWorkout = Scored & {
  id: string;
  start: string;
  end: string;
  timezone_offset?: string;
  sport_name?: string;
  score?: {
    strain?: number;
    average_heart_rate?: number;
    max_heart_rate?: number;
    kilojoule?: number;
    distance_meter?: number;
    altitude_gain_meter?: number;
    altitude_change_meter?: number;
  };
};

// ─── Coercion. WHOOP omits score fields entirely on unscored records. ──

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const int = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};

// ─── Row mappers ─────────────────────────────────────────────
//
// EXPLICIT snake_case, every column listed, no spreads. A spread into a
// Supabase write has silently no-opped new columns on this project before.

function mapCycle(userId: string, c: WhoopCycle) {
  return {
    user_id: userId,
    id: c.id,
    start: c.start,
    end: c.end ?? null, // null = IN PROGRESS. Store it: today's meals need it.
    timezone_offset: c.timezone_offset ?? null,
    score_state: c.score_state ?? null,
    strain: num(c.score?.strain),
    kilojoule: num(c.score?.kilojoule),
    average_heart_rate: int(c.score?.average_heart_rate),
    max_heart_rate: int(c.score?.max_heart_rate),
    raw: c,
    whoop_updated_at: c.updated_at ?? null,
    synced_at: new Date().toISOString(),
  };
}

function mapSleep(userId: string, s: WhoopSleep) {
  const stages = s.score?.stage_summary;
  return {
    user_id: userId,
    id: s.id,
    start: s.start,
    end: s.end,
    timezone_offset: s.timezone_offset ?? null,
    nap: s.nap ?? false,
    score_state: s.score_state ?? null,
    total_in_bed_time_milli: int(stages?.total_in_bed_time_milli),
    total_awake_time_milli: int(stages?.total_awake_time_milli),
    total_light_sleep_time_milli: int(stages?.total_light_sleep_time_milli),
    total_slow_wave_sleep_time_milli: int(
      stages?.total_slow_wave_sleep_time_milli,
    ),
    total_rem_sleep_time_milli: int(stages?.total_rem_sleep_time_milli),
    sleep_cycle_count: int(stages?.sleep_cycle_count),
    disturbance_count: int(stages?.disturbance_count),
    sleep_performance_percentage: num(s.score?.sleep_performance_percentage),
    sleep_efficiency_percentage: num(s.score?.sleep_efficiency_percentage),
    sleep_consistency_percentage: num(s.score?.sleep_consistency_percentage),
    respiratory_rate: num(s.score?.respiratory_rate),
    raw: s,
    whoop_updated_at: s.updated_at ?? null,
    synced_at: new Date().toISOString(),
  };
}

function mapRecovery(userId: string, r: WhoopRecovery) {
  return {
    user_id: userId,
    cycle_id: r.cycle_id,
    // The whole correlation hangs off this column. It is how sleep(N) is
    // defined — "the sleep recovery(N) points at" — rather than by an interval
    // join that would be off by one cycle at exactly the wrong boundary.
    sleep_id: r.sleep_id ?? null,
    score_state: r.score_state ?? null,
    user_calibrating: r.score?.user_calibrating ?? null,
    recovery_score: num(r.score?.recovery_score),
    resting_heart_rate: num(r.score?.resting_heart_rate),
    hrv_rmssd_milli: num(r.score?.hrv_rmssd_milli),
    spo2_percentage: num(r.score?.spo2_percentage),
    skin_temp_celsius: num(r.score?.skin_temp_celsius),
    raw: r,
    whoop_updated_at: r.updated_at ?? null,
    synced_at: new Date().toISOString(),
  };
}

function mapWorkout(userId: string, w: WhoopWorkout) {
  return {
    user_id: userId,
    id: w.id,
    start: w.start,
    end: w.end,
    timezone_offset: w.timezone_offset ?? null,
    sport_name: w.sport_name ?? null,
    score_state: w.score_state ?? null,
    strain: num(w.score?.strain),
    average_heart_rate: int(w.score?.average_heart_rate),
    max_heart_rate: int(w.score?.max_heart_rate),
    kilojoule: num(w.score?.kilojoule),
    distance_meter: num(w.score?.distance_meter),
    altitude_gain_meter: num(w.score?.altitude_gain_meter),
    altitude_change_meter: num(w.score?.altitude_change_meter),
    raw: w,
    whoop_updated_at: w.updated_at ?? null,
    synced_at: new Date().toISOString(),
  };
}

// ─── The paginated pull ──────────────────────────────────────

type Collection = {
  name: string;
  path: string;
  table: string;
  conflict: string;
  // deno-lint-ignore no-explicit-any
  map: (userId: string, record: any) => Record<string, unknown>;
};

// Workouts FIRST: it is the correlation-critical collection (the product's
// differentiator), so it gets first claim on the shared deadline/time budget
// below rather than whatever's left after cycles/sleeps/recoveries. Safe to
// reorder — no FK ties these tables together, see the schema comment on
// whoop_workouts in 20260712120000_whoop_data.sql.
const COLLECTIONS: Collection[] = [
  {
    name: "workouts",
    path: "/activity/workout",
    table: "whoop_workouts",
    conflict: "user_id,id",
    map: mapWorkout,
  },
  {
    name: "cycles",
    path: "/cycle",
    table: "whoop_cycles",
    conflict: "user_id,id",
    map: mapCycle,
  },
  {
    name: "sleeps",
    path: "/activity/sleep",
    table: "whoop_sleeps",
    conflict: "user_id,id",
    map: mapSleep,
  },
  {
    name: "recoveries",
    path: "/recovery",
    table: "whoop_recoveries",
    conflict: "user_id,cycle_id",
    map: mapRecovery,
  },
];

type SyncFailure = { kind: "transient" | "fatal" | "revoked"; message: string };

/**
 * Pull one collection, page by page, and upsert each page as it arrives.
 *
 * Upserts are BLIND — no read-then-compare against whoop_updated_at. WHOOP is
 * the source of truth for its own records, so overwriting is always correct,
 * and at ~30 rows per collection the read round-trip that a gate would need
 * costs more than the writes it saves. whoop_updated_at is still STORED: it is
 * what makes a 400-day backfill gateable if you ever want one.
 */
async function syncCollection(
  // deno-lint-ignore no-explicit-any
  admin: any,
  userId: string,
  accessToken: string,
  col: Collection,
  start: string,
  end: string,
  deadline: number,
): Promise<
  { ok: true; count: number; partial: boolean } | (SyncFailure & { ok: false })
> {
  let nextToken: string | null = null;
  let count = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (Date.now() > deadline) {
      return { ok: true, count, partial: true };
    }

    const params: Record<string, string> = {
      start,
      end,
      limit: String(WHOOP_PAGE_LIMIT),
    };
    if (nextToken) params.nextToken = nextToken;

    const result = await whoopGet<unknown>(col.path, accessToken, params);

    if ("kind" in result) {
      if (result.kind === "rate_limited") {
        // Shared, app-wide budget. Backing off is not politeness, it is the
        // only thing standing between one user's retry loop and every other
        // user's sync.
        console.error(`${col.name}: ${result.error}`);
        return {
          ok: false,
          kind: "transient",
          message: "WHOOP is rate limiting us. Try again in a minute.",
        };
      }
      console.error(`${col.name}: ${result.error}`);
      return {
        ok: false,
        kind: result.kind === "unauthorized" ? "transient" : result.kind,
        message: "Couldn't read your WHOOP data.",
      };
    }

    const {
      records,
      nextToken: next,
      rateRemaining,
      rateResetSeconds,
    } = result.page;

    if (records.length > 0) {
      const rows = records.map((r) => col.map(userId, r));
      const { error } = await admin
        .from(col.table)
        .upsert(rows, { onConflict: col.conflict });

      if (error) {
        console.error(`${col.table} upsert:`, error.message);
        return {
          ok: false,
          kind: "transient",
          message: "Couldn't save your WHOOP data.",
        };
      }
      count += rows.length;
    }

    if (!next) return { ok: true, count, partial: false };
    nextToken = next;

    // Pre-emptive backoff. The 429 we are avoiding would hit every user of the
    // app, not just this one.
    if (
      rateRemaining !== null &&
      rateRemaining < RATE_FLOOR &&
      rateResetSeconds !== null
    ) {
      const waitMs = Math.min((rateResetSeconds + 1) * 1000, 15_000);
      console.log(
        `${col.name}: ${rateRemaining} requests left, pausing ${waitMs}ms`,
      );
      await sleep(waitMs);
    }
  }

  // Hit MAX_PAGES with a cursor still live. Seven days should never do this —
  // if it does, something is wrong with the window, not the pagination.
  console.error(`${col.name}: hit MAX_PAGES with nextToken still set`);
  return { ok: true, count, partial: true };
}

// ─── Handler ─────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== "POST") {
    return fail("bad_request", "Method not allowed.", 405);
  }

  const userId = await getCallerId(req);
  if (!userId) {
    return fail("unauthorized", "Please sign in and try again.", 401);
  }

  let force = false;
  let requestedDays: number | null = null;
  try {
    const body = await req.json().catch(() => ({}));
    force = body?.force === true;
    const d = Number(body?.days);
    if (Number.isFinite(d) && d > 0) {
      requestedDays = Math.min(Math.round(d), MAX_WINDOW_DAYS);
    }
  } catch {
    // An empty body is a perfectly good sync request.
  }

  const admin = adminClient();

  // ─── 1. The connection ─────────────────────────────────────
  const { data: conn, error: connErr } = await admin
    .from("whoop_connections")
    .select("status, last_sync_at, last_sync_attempt_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (connErr) {
    console.error("connection read:", connErr.message);
    return fail("server_error", "Couldn't read your WHOOP connection.", 500);
  }

  if (!conn) {
    return fail("not_connected", "WHOOP isn't connected.", 400);
  }

  if (conn.status !== "connected") {
    // Settings already renders the Reconnect state for this. Not an error the
    // user needs shouting at them.
    return json({
      ok: true,
      skipped: "revoked",
      lastSyncAt: conn.last_sync_at,
    });
  }

  // ─── 2. Throttle — on ATTEMPTS, not successes ──────────────
  const now = Date.now();
  const lastAttempt = conn.last_sync_attempt_at
    ? new Date(conn.last_sync_attempt_at).getTime()
    : 0;
  const floor = force ? FORCE_THROTTLE_MS : THROTTLE_MS;

  if (now - lastAttempt < floor) {
    return json({
      ok: true,
      skipped: "throttled",
      lastSyncAt: conn.last_sync_at,
      retryInMs: floor - (now - lastAttempt),
    });
  }

  // Written BEFORE the work. If this function times out, 500s, or WHOOP is
  // down, the throttle key has still moved — which is the whole point.
  await admin
    .from("whoop_connections")
    .update({ last_sync_attempt_at: new Date().toISOString() })
    .eq("user_id", userId);

  // ─── 3. Token ──────────────────────────────────────────────
  const token = await getValidToken(admin, userId);

  if (!token.ok) {
    // getValidToken has already set status = 'revoked' if that's what happened.
    // Do not double-handle it here.
    if (token.kind !== "revoked") {
      await admin
        .from("whoop_connections")
        .update({ last_sync_error: token.kind })
        .eq("user_id", userId);
    }
    return json(
      { ok: false, error: token.kind, message: token.message },
      token.kind === "revoked" ? 200 : 503,
    );
  }

  // ─── 4. The window ─────────────────────────────────────────
  const days = requestedDays ?? DEFAULT_WINDOW_DAYS;
  const defaultFrom = now - days * 86_400_000;

  // Reach further back if we have been away — otherwise a user who ignores the
  // app for a month gets a permanent hole nothing ever fills.
  const anchoredFrom = conn.last_sync_at
    ? new Date(conn.last_sync_at).getTime() - OVERLAP_DAYS * 86_400_000
    : defaultFrom;

  const clampFloor = now - MAX_WINDOW_DAYS * 86_400_000;
  const from = Math.max(Math.min(defaultFrom, anchoredFrom), clampFloor);

  const start = new Date(from).toISOString();
  // No `end`: WHOOP defaults to now, and an explicit end risks excluding the
  // in-progress cycle, which is exactly the one today's meals need to join to.
  const end = new Date(now).toISOString();

  const deadline = now + TIME_BUDGET_MS;

  // ─── 5. Pull ───────────────────────────────────────────────
  const counts: Record<string, number> = {};
  let partial = false;

  for (const col of COLLECTIONS) {
    const result = await syncCollection(
      admin,
      userId,
      token.accessToken,
      col,
      start,
      end,
      deadline,
    );

    if (!result.ok) {
      // last_sync_at is NOT touched. The window stays anchored where it was, so
      // the next sync re-covers this ground rather than skipping it.
      await admin
        .from("whoop_connections")
        .update({ last_sync_error: `${col.name}:${result.kind}` })
        .eq("user_id", userId);

      return json(
        { ok: false, error: result.kind, message: result.message },
        503,
      );
    }

    counts[col.name] = result.count;
    if (result.partial) partial = true;
  }

  // ─── 6. Success ────────────────────────────────────────────
  //
  // Reaching this line means every collection returned ok:true — a hard
  // failure short-circuits to a 503 above (step 5) and correctly leaves
  // last_sync_at untouched. A PARTIAL result no longer withholds it: an OR'd
  // partial flag across all four collections meant one collection running
  // long — e.g. a big recoveries page near the deadline — could freeze the
  // cursor even though an earlier collection in the loop, workouts above,
  // had already completed and upserted in full. The unfetched tail of a
  // partial pull is bounded by MAX_WINDOW_DAYS and re-covered on the next
  // sync by design; it was never being backfilled by freezing the cursor
  // either. last_sync_error still records "partial" for observability.
  const syncedAt = new Date().toISOString();

  const { error: doneErr } = await admin
    .from("whoop_connections")
    .update({
      last_sync_at: syncedAt,
      last_sync_error: partial ? "partial" : null,
    })
    .eq("user_id", userId);

  if (doneErr) console.error("connection update:", doneErr.message);

  return json({
    ok: true,
    partial,
    lastSyncAt: syncedAt,
    window: { start, end },
    counts,
  });
});
