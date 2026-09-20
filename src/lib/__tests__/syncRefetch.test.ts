// ============================================================
// PL-018 — Today must re-read what a foreground sync just wrote.
//
// These tests are the contract for src/lib/syncRefetch.ts: WHEN a refetch
// fires, and — just as load-bearing — when it must NOT. A refetch on every
// foreground would be a wasted query on the overwhelmingly common path
// (WHOOP throttled, Health Connect finds nothing new), so "wrote nothing"
// has to be detected, not assumed.
// ============================================================

import { describe, it, expect, vi } from "vitest";
import {
  whoopSyncWroteData,
  healthConnectSyncWroteData,
  refetchIfSyncWroteData,
} from "../syncRefetch";
import type { SyncResponse } from "../whoop";
import type { HealthConnectSyncResult } from "../healthConnectSync";

// ─── WHOOP ───────────────────────────────────────────────────

const whoopOk = (over: Partial<Extract<SyncResponse, { ok: true }>> = {}) =>
  ({
    ok: true,
    skipped: null,
    partial: false,
    lastSyncAt: "2026-09-20T10:00:00.000Z",
    counts: { workouts: 0, cycles: 0, sleeps: 0, recoveries: 0 },
    ...over,
  }) as SyncResponse;

// A skipped sync carries NO counts: whoop-sync's throttled and revoked
// branches answer { ok, skipped, lastSyncAt } with no counts key, and
// syncWhoop maps the absent field to null (whoop.ts:356-359). So these two
// fixtures must set counts: null — an earlier version of this test used
// all-zero counts, which made both cases pass through the "every
// collection was empty" rule and left the skipped check untested. The
// sabotage run caught it: deleting the skipped check kept them green.
const whoopSkipped = (skipped: "throttled" | "revoked") =>
  whoopOk({ skipped, counts: null });

describe("whoopSyncWroteData", () => {
  it("is false when the server throttled the call — the 15-minute floor means nothing ran", () => {
    expect(whoopSyncWroteData(whoopSkipped("throttled"))).toBe(false);
  });

  it("is false when the connection is revoked — the function returns before any pull", () => {
    expect(whoopSyncWroteData(whoopSkipped("revoked"))).toBe(false);
  });

  it("is false when every collection came back empty", () => {
    expect(whoopSyncWroteData(whoopOk())).toBe(false);
  });

  it("is true when any collection returned rows", () => {
    expect(
      whoopSyncWroteData(
        whoopOk({ counts: { workouts: 0, cycles: 2, sleeps: 0, recoveries: 0 } }),
      ),
    ).toBe(true);
  });

  it("is true on a partial sync that still landed rows", () => {
    expect(
      whoopSyncWroteData(
        whoopOk({ partial: true, counts: { workouts: 5, cycles: 0 } }),
      ),
    ).toBe(true);
  });

  it("is true when a success carries no counts at all — unknown is not the same as nothing", () => {
    expect(whoopSyncWroteData(whoopOk({ counts: null }))).toBe(true);
  });

  // syncCollection upserts each PAGE as it arrives (whoop-sync/index.ts:355-360),
  // so a collection that fails on page 3 has already written pages 1 and 2.
  it("is true for a transient failure — pages may already have landed before it failed", () => {
    expect(
      whoopSyncWroteData({ ok: false, error: "transient", message: "x" }),
    ).toBe(true);
  });

  it("is false when the call never reached the function", () => {
    expect(
      whoopSyncWroteData({ ok: false, error: "network_error", message: "x" }),
    ).toBe(false);
  });

  it("is false for failures that are decided before any pull", () => {
    for (const error of ["unauthorized", "not_connected", "revoked"] as const) {
      expect(whoopSyncWroteData({ ok: false, error, message: "x" })).toBe(false);
    }
  });
});

// ─── Health Connect ──────────────────────────────────────────

const hc = (over: Partial<HealthConnectSyncResult> = {}): HealthConnectSyncResult => ({
  ok: true,
  counts: {},
  deletions: {},
  errors: {},
  ...over,
});

describe("healthConnectSyncWroteData", () => {
  it("is false when nothing was granted, so nothing ran", () => {
    expect(healthConnectSyncWroteData(hc())).toBe(false);
  });

  it("is false when every granted domain found nothing new", () => {
    expect(
      healthConnectSyncWroteData(hc({ counts: { sleep: 0, workouts: 0 } })),
    ).toBe(false);
  });

  it("is true when a domain upserted records", () => {
    expect(
      healthConnectSyncWroteData(hc({ counts: { sleep: 0, workouts: 3 } })),
    ).toBe(true);
  });

  // The case an upserts-only count misses: a workout deleted in another app
  // propagates as a deletion with zero upserts. Today would keep showing a
  // workout the database no longer has.
  it("is true when a sync only propagated DELETIONS", () => {
    expect(
      healthConnectSyncWroteData(
        hc({ counts: { workouts: 0 }, deletions: { workouts: 1 } }),
      ),
    ).toBe(true);
  });

  // A domain that throws mid-pass has no count recorded, but postBatch may
  // already have succeeded for earlier pages.
  it("is true when a domain failed — batches may have landed before the throw", () => {
    expect(
      healthConnectSyncWroteData(
        hc({ ok: false, counts: {}, errors: { sleep: "boom" } }),
      ),
    ).toBe(true);
  });
});

// ─── The trigger ─────────────────────────────────────────────

describe("refetchIfSyncWroteData", () => {
  const deps = () => ({
    refetch: vi.fn().mockResolvedValue(undefined),
    report: vi.fn(),
  });

  it("refetches once when the sync wrote something", async () => {
    const d = deps();
    const outcome = await refetchIfSyncWroteData(
      Promise.resolve(whoopOk({ counts: { cycles: 1 } })),
      whoopSyncWroteData,
      d,
    );
    expect(outcome).toBe("refetched");
    expect(d.refetch).toHaveBeenCalledTimes(1);
    expect(d.report).not.toHaveBeenCalled();
  });

  it("does not refetch when the sync was throttled", async () => {
    const d = deps();
    const outcome = await refetchIfSyncWroteData(
      Promise.resolve(whoopSkipped("throttled")),
      whoopSyncWroteData,
      d,
    );
    expect(outcome).toBe("skipped");
    expect(d.refetch).not.toHaveBeenCalled();
  });

  // App.tsx already reports a rejected sync (App.tsx:316-325). Reporting it
  // here too would be the PL-014 double-report all over again.
  it("stays silent when the sync itself rejects — its own catch owns that report", async () => {
    const d = deps();
    const outcome = await refetchIfSyncWroteData(
      Promise.reject(new Error("sync blew up")),
      whoopSyncWroteData,
      d,
    );
    expect(outcome).toBe("sync-failed");
    expect(d.refetch).not.toHaveBeenCalled();
    expect(d.report).not.toHaveBeenCalled();
  });

  it("reports a refetch that throws exactly once, and never rethrows", async () => {
    const d = deps();
    d.refetch.mockRejectedValue(new Error("network down"));
    const outcome = await refetchIfSyncWroteData(
      Promise.resolve(whoopOk({ counts: { cycles: 1 } })),
      whoopSyncWroteData,
      d,
    );
    expect(outcome).toBe("refetch-failed");
    expect(d.report).toHaveBeenCalledTimes(1);
    expect(d.report.mock.calls[0][0]).toBe("todayRefetchAfterSync");
  });
});
