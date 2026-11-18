import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

// PL-064 — a WHOOP connection whose refresh keeps failing non-fatally used to
// stay 'connected' forever, so Settings never offered Reconnect. The rule:
// once the stored access token has been expired for more than seven days
// (expires_at only moves on a SUCCESSFUL refresh), a non-fatal REFRESH failure
// is treated as fatal. Only the refresh call failing counts — a lease error,
// the busy wait, or a failed commit after a successful rotation are database
// or concurrency problems and must never revoke.
//
// whoop.ts reads Deno.env at call time, so a global Deno stub is enough.

type GetValidToken = (admin: unknown, userId: string) => Promise<{ ok: boolean; kind?: string }>;
type RefreshGivenUp = (
  expiresAt: string | null | undefined,
  nowMs: number,
  err: { error: string; status?: number; fatal: boolean; misconfigured?: boolean },
) => boolean;

let getValidToken: GetValidToken;
let refreshGivenUp: RefreshGivenUp;
let GIVE_UP_AFTER_MS: number;

let env: Record<string, string | undefined> = {};

beforeAll(async () => {
  (globalThis as unknown as { Deno: { env: { get: (k: string) => string | undefined } } }).Deno = {
    env: { get: (k: string) => env[k] },
  };
  ({ getValidToken, refreshGivenUp, GIVE_UP_AFTER_MS } = await import("../whoopToken.ts"));
});

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-18T18:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const EXPIRED_30_DAYS = iso(NOW - 30 * DAY);
const EXPIRED_1_DAY = iso(NOW - 1 * DAY);

// ─── fake admin client ───────────────────────────────────────

type LeaseReply = { data: unknown; error: { message: string } | null };

function fakeAdmin(opts: {
  lease: () => LeaseReply;
  commitError?: { message: string } | null;
}) {
  const calls = {
    rpc: [] as string[],
    deletes: [] as string[],
    updates: [] as { table: string; values: Record<string, unknown> }[],
  };
  const admin = {
    rpc(name: string) {
      calls.rpc.push(name);
      if (name === "whoop_token_lease") {
        const reply = opts.lease();
        return { maybeSingle: () => Promise.resolve(reply) };
      }
      if (name === "whoop_token_commit") {
        return Promise.resolve({ error: opts.commitError ?? null });
      }
      return Promise.resolve({ error: null }); // whoop_token_release
    },
    from(table: string) {
      return {
        delete() {
          return { eq: () => { calls.deletes.push(table); return Promise.resolve({ error: null }); } };
        },
        update(values: Record<string, unknown>) {
          return { eq: () => { calls.updates.push({ table, values }); return Promise.resolve({ error: null }); } };
        },
      };
    },
  };
  return { admin, calls };
}

const revoked = (calls: ReturnType<typeof fakeAdmin>["calls"]) =>
  calls.deletes.includes("whoop_tokens") ||
  calls.updates.some((u) => u.values.status === "revoked");

const leased = (expiresAt: string): LeaseReply => ({
  data: { outcome: "leased", access_token: "old-access", refresh_token: "old-refresh", expires_at: expiresAt },
  error: null,
});

function stubTokenEndpoint(status: number, body: string) {
  const fetchMock = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  env = { WHOOP_CLIENT_ID: "id", WHOOP_CLIENT_SECRET: "secret" };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ─── the pure rule ───────────────────────────────────────────

describe("refreshGivenUp (PL-064)", () => {
  const transient = { error: "whoop token 503: down", status: 503, fatal: false };

  it("is seven days", () => {
    expect(GIVE_UP_AFTER_MS).toBe(7 * DAY);
  });

  it("gives up once the token has been expired for more than seven days", () => {
    expect(refreshGivenUp(iso(NOW - 7 * DAY - 1), NOW, transient)).toBe(true);
    expect(refreshGivenUp(EXPIRED_30_DAYS, NOW, transient)).toBe(true);
  });

  it("does not give up at or under seven days", () => {
    expect(refreshGivenUp(iso(NOW - 7 * DAY), NOW, transient)).toBe(false);
    expect(refreshGivenUp(EXPIRED_1_DAY, NOW, transient)).toBe(false);
    expect(refreshGivenUp(iso(NOW + 60_000), NOW, transient)).toBe(false);
  });

  it("counts network failures and unrecognised 4xx — they are still the refresh failing", () => {
    expect(refreshGivenUp(EXPIRED_30_DAYS, NOW, { error: "TypeError: fetch failed", fatal: false })).toBe(true);
    expect(refreshGivenUp(EXPIRED_30_DAYS, NOW, { error: "whoop token 400: {}", status: 400, fatal: false })).toBe(true);
  });

  it("never gives up on our own misconfiguration, however old the token", () => {
    expect(
      refreshGivenUp(EXPIRED_30_DAYS, NOW, { error: "not set", fatal: false, misconfigured: true }),
    ).toBe(false);
  });

  it("never gives up without a readable expiry", () => {
    expect(refreshGivenUp(null, NOW, transient)).toBe(false);
    expect(refreshGivenUp(undefined, NOW, transient)).toBe(false);
    expect(refreshGivenUp("not a date", NOW, transient)).toBe(false);
  });
});

// ─── where the rule sits in getValidToken ────────────────────

describe("getValidToken give-up wiring (PL-064)", () => {
  it("revokes when the refresh fails non-fatally and the token expired over seven days ago", async () => {
    stubTokenEndpoint(503, "upstream unavailable");
    const { admin, calls } = fakeAdmin({ lease: () => leased(EXPIRED_30_DAYS) });

    const result = await getValidToken(admin, "u1");

    expect(result).toMatchObject({ ok: false, kind: "revoked" });
    expect(calls.deletes).toEqual(["whoop_tokens"]);
    expect(calls.updates).toContainEqual({
      table: "whoop_connections",
      values: { status: "revoked", last_sync_error: "token_revoked" },
    });
  });

  it("stays transient, and releases the lease, when the token expired under seven days ago", async () => {
    stubTokenEndpoint(503, "upstream unavailable");
    const { admin, calls } = fakeAdmin({ lease: () => leased(EXPIRED_1_DAY) });

    const result = await getValidToken(admin, "u1");

    expect(result).toMatchObject({ ok: false, kind: "transient" });
    expect(revoked(calls)).toBe(false);
    expect(calls.rpc).toContain("whoop_token_release");
  });

  it("never revokes on a lease RPC error", async () => {
    const fetchMock = stubTokenEndpoint(503, "should not be called");
    const { admin, calls } = fakeAdmin({
      lease: () => ({
        // Even if a broken RPC reply carried a stale expiry, an error here is
        // the database's problem, not the credential's.
        data: { outcome: "leased", refresh_token: "r", expires_at: EXPIRED_30_DAYS },
        error: { message: "connection reset" },
      }),
    });

    const result = await getValidToken(admin, "u1");

    expect(result).toMatchObject({ ok: false, kind: "transient" });
    expect(revoked(calls)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never revokes after the busy wait gives up, however stale the token", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fetchMock = stubTokenEndpoint(503, "should not be called");
    const { admin, calls } = fakeAdmin({
      lease: () => ({ data: { outcome: "busy", expires_at: EXPIRED_30_DAYS }, error: null }),
    });

    const pending = getValidToken(admin, "u1");
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({ ok: false, kind: "transient" });
    expect(revoked(calls)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never revokes when the commit fails after a successful rotation", async () => {
    stubTokenEndpoint(
      200,
      JSON.stringify({ access_token: "new-a", refresh_token: "new-r", expires_in: 3600, scope: "offline" }),
    );
    const { admin, calls } = fakeAdmin({
      lease: () => leased(EXPIRED_30_DAYS),
      commitError: { message: "write failed" },
    });

    const result = await getValidToken(admin, "u1");

    expect(result).toMatchObject({ ok: false, kind: "transient" });
    expect(revoked(calls)).toBe(false);
  });

  it("never revokes on our own missing WHOOP credentials, however stale the token", async () => {
    env = {};
    const fetchMock = stubTokenEndpoint(503, "should not be called");
    const { admin, calls } = fakeAdmin({ lease: () => leased(EXPIRED_30_DAYS) });

    const result = await getValidToken(admin, "u1");

    expect(result).toMatchObject({ ok: false, kind: "transient" });
    expect(revoked(calls)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
