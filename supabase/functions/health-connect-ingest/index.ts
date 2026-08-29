// ============================================================
// supabase/functions/health-connect-ingest/index.ts
//
// Normalises raw Health Connect records into the four provider-neutral
// biometric tables (20260829072742_biometric_provider_neutral_tables.sql).
// The client (src/lib/healthConnectSync.ts) does NOT normalise, map to
// columns, or decide ingest_transport/origin_package trustworthiness — it
// forwards whatever the platform gave it, batched by record type. This
// function is the only place that trust decision gets made, same posture
// as whoop-sync: writes happen with service_role, never the caller's own
// session — commit one revoked client INSERT/UPDATE/DELETE on all four
// tables deliberately, and that stays true here too.
//
// The actual mapping/validation logic lives in ./mapping.ts, deliberately
// kept free of any Deno-only import — that is what lets it be imported
// directly into a Vitest test (src/lib/__tests__/healthConnectIngest.
// test.ts). This file cannot be unit-tested the same way: it transitively
// pulls in `jsr:@supabase/supabase-js@2` via _shared/auth.ts, which
// Node/Vite cannot resolve, and calls Deno.serve() at module load.
//
// One request = one record type. The client calls this once per Health
// Connect record type per sync pass (SleepSession, HeartRateVariability
// Rmssd, RestingHeartRate, ExerciseSession), because each maps to exactly
// one table and each table's own upsert conflict target is table-specific.
//
// Body shape:
//   {
//     recordType: 'SleepSession' | 'HeartRateVariabilityRmssd' |
//                 'RestingHeartRate' | 'ExerciseSession',
//     upserts: <raw Health Connect record objects, each carrying metadata>[],
//     deletedRecordIds: <Health Connect's own metadata.id values>[],
//   }
//
// UNLIKE whoop-sync, a failure processing one domain (record type) does
// NOT abort the others — WHOOP's four collections share a cycle_id
// linkage that makes a partial pull genuinely confusing to reason about;
// these four Health Connect tables have no such cross-dependency (a
// failed sleep upsert has no bearing on whether HRV should also be
// skipped), so the client calls this function once per record type and
// each call's success or failure is independent by design.
// ============================================================

import { preflight, json, fail } from "../_shared/cors.ts";
import { getCallerId, adminClient } from "../_shared/auth.ts";
import {
  COLLECTIONS,
  validateOriginPackage,
  providerRecordId,
  type RawRecord,
} from "./mapping.ts";

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

  // deno-lint-ignore no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "Invalid JSON body.", 400);
  }

  const recordType = body?.recordType;
  const collection =
    typeof recordType === "string" ? COLLECTIONS[recordType] : undefined;
  if (!collection) {
    return fail(
      "bad_request",
      `Unknown or missing recordType "${String(recordType)}".`,
      400,
    );
  }

  const upserts: RawRecord[] = Array.isArray(body?.upserts) ? body.upserts : [];
  const deletedRecordIds: string[] = Array.isArray(body?.deletedRecordIds)
    ? body.deletedRecordIds.filter(
        (id: unknown) => typeof id === "string" && id.length > 0,
      )
    : [];

  const admin = adminClient();

  // ─── Validate + map every upsert BEFORE touching the database ─────────
  // origin_package shape/coherence is checked here, in code, with a clear
  // per-record reason — not left for the DB's CHECK constraints to reject
  // with an opaque constraint-violation error. A bad record is SKIPPED,
  // not fatal to the whole batch: one malformed row from a misbehaving
  // provider should not block every other record in the same sync pass.
  const rows: Record<string, unknown>[] = [];
  const skippedReasons: string[] = [];

  for (const record of upserts) {
    const originResult = validateOriginPackage(record?.metadata?.dataOrigin);
    if (!originResult.ok) {
      skippedReasons.push(originResult.error);
      continue;
    }

    if (!providerRecordId(record?.metadata)) {
      skippedReasons.push(
        "record has neither metadata.clientRecordId nor metadata.id — cannot be identified",
      );
      continue;
    }

    try {
      rows.push(collection.map(userId, originResult.value, record));
    } catch (e) {
      skippedReasons.push(e instanceof Error ? e.message : "mapping failed");
    }
  }

  if (rows.length > 0) {
    const { error } = await admin
      .from(collection.table)
      .upsert(rows, { onConflict: collection.conflict });

    if (error) {
      console.error(`${collection.table} upsert:`, error.message);
      return fail("server_error", "Couldn't save Health Connect data.", 503);
    }
  }

  // ─── Deletions, propagated from the client's changes-token diff ───────
  // Matched on raw->metadata->>id (Health Connect's own internal id,
  // which is what a deletion event reports), NOT on provider_record_id —
  // provider_record_id may be metadata.clientRecordId instead (preferred
  // for phone-switch stability), which a deletion event never carries.
  // raw always preserves the true Health Connect id regardless of which
  // one was chosen as provider_record_id, so this always resolves
  // correctly without needing a schema change.
  if (deletedRecordIds.length > 0) {
    const { error } = await admin
      .from(collection.table)
      .delete()
      .eq("user_id", userId)
      .in("raw->metadata->>id", deletedRecordIds);

    if (error) {
      // Best-effort: a failed deletion sweep does not fail the upserts
      // that already landed above. Logged for visibility; the next sync's
      // changes-token page will include the same deletion again if it is
      // still pending upstream (Health Connect resends unacknowledged
      // deletions on subsequent getChanges() calls until the token
      // advances past them, which only happens client-side after a
      // successful post).
      console.error(`${collection.table} delete:`, error.message);
    }
  }

  return json({
    ok: true,
    upserted: rows.length,
    deletionsRequested: deletedRecordIds.length,
    skipped: skippedReasons.length,
    skippedReasons: skippedReasons.slice(0, 10),
  });
});
