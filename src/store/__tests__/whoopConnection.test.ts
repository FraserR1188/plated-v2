// ============================================================
// PR 4 — the WHOOP connection state, and the cache that lets Today's
// first frame be laid out correctly on a cold start.
//
// The property under test throughout is LAYOUT STABILITY, not data
// freshness: the scores panel occupies an 82dp column beside the calorie
// ring, so `whoopConnected` decides where the ring sits. Anything that
// can flip it after the first frame is a visible jump.
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Sentry from "@sentry/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useStore } from "../useStore";
import { getWhoopConnection } from "../../lib/whoop";
import { WhoopConnection } from "../../lib/whoop";

vi.mock("../../lib/whoop", () => ({ getWhoopConnection: vi.fn() }));

const KEY = "plated.whoopConnection.v1";
const USER = "test-user-id";
const OTHER = "someone-else";

const mem = (AsyncStorage as unknown as { __store: Map<string, string> })
  .__store;

function seedCache(userId: string, connected: boolean) {
  mem.set(KEY, JSON.stringify({ userId, connected }));
}

function connection(over: Partial<WhoopConnection> = {}): WhoopConnection {
  return {
    user_id: USER,
    whoop_user_id: 1,
    scopes: "read:recovery",
    status: "connected",
    connected_at: "2026-09-01T00:00:00.000Z",
    last_sync_at: "2026-09-20T09:00:00.000Z",
    last_sync_attempt_at: "2026-09-20T09:00:00.000Z",
    last_sync_error: null,
    ...over,
  };
}

function deferred<T>() {
  let settle: (v: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    settle = res;
  });
  return { promise, settle };
}

/** Lets the cache read (one await) land while the fetch is still
 *  outstanding — i.e. exactly the window Today's first frame renders in. */
async function afterCacheSeed() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  useStore.getState().reset();
  mem.clear();
  vi.mocked(getWhoopConnection).mockReset();
  vi.mocked(Sentry.captureException).mockClear();
});

describe("loadWhoopConnection — seeding from the cache", () => {
  it("a cache saying 'connected' for THIS user is visible before any fetch resolves", async () => {
    // The whole point. If this only became true after the round trip, the
    // first frame would be the no-column layout and the ring would jump.
    seedCache(USER, true);
    useStore.getState().setUserId(USER);
    const fetch = deferred<WhoopConnection | null>();
    vi.mocked(getWhoopConnection).mockReturnValue(fetch.promise);

    const pending = useStore.getState().loadWhoopConnection();
    await afterCacheSeed();

    // Asserted WHILE the fetch is still outstanding.
    expect(useStore.getState().whoopConnected).toBe(true);

    fetch.settle(connection());
    await pending;
  });

  it("a cache belonging to a DIFFERENT user is treated as missing", async () => {
    // Two accounts on one device is how this app is tested and how a
    // shared phone works. Account A's layout must not decide account B's.
    //
    // Asserted DURING the seed window, not after: a later reconcile would
    // set the right answer anyway, so an end-state assertion here passes
    // even when the user-id check is deleted. A sabotage run caught that.
    seedCache(OTHER, true);
    useStore.getState().setUserId(USER);
    const fetch = deferred<WhoopConnection | null>();
    vi.mocked(getWhoopConnection).mockReturnValue(fetch.promise);

    const pending = useStore.getState().loadWhoopConnection();
    await afterCacheSeed();

    expect(useStore.getState().whoopConnected).toBe(false);

    fetch.settle(null);
    await pending;
    expect(useStore.getState().whoopConnected).toBe(false);
  });

  it("no cache at all means not connected", async () => {
    useStore.getState().setUserId(USER);
    vi.mocked(getWhoopConnection).mockResolvedValue(null);

    await useStore.getState().loadWhoopConnection();

    expect(useStore.getState().whoopConnected).toBe(false);
  });

  it("junk in the cache is treated as missing, not as a crash", async () => {
    mem.set(KEY, "{not json");
    useStore.getState().setUserId(USER);
    vi.mocked(getWhoopConnection).mockResolvedValue(null);

    await expect(
      useStore.getState().loadWhoopConnection(),
    ).resolves.toBeUndefined();
    expect(useStore.getState().whoopConnected).toBe(false);
  });
});

describe("loadWhoopConnection — reconciling", () => {
  it("a successful read of 'not connected' clears both the state and the cache", async () => {
    seedCache(USER, true);
    useStore.getState().setUserId(USER);
    vi.mocked(getWhoopConnection).mockResolvedValue(null);

    await useStore.getState().loadWhoopConnection();

    expect(useStore.getState().whoopConnected).toBe(false);
    expect(JSON.parse(mem.get(KEY)!).connected).toBe(false);
  });

  it("a revoked connection counts as not connected", async () => {
    // It existed and died. Settings still distinguishes revoked from
    // absent (Reconnect vs Connect); for the panel there is nothing to show.
    seedCache(USER, true);
    useStore.getState().setUserId(USER);
    vi.mocked(getWhoopConnection).mockResolvedValue(
      connection({ status: "revoked" }),
    );

    await useStore.getState().loadWhoopConnection();

    expect(useStore.getState().whoopConnected).toBe(false);
  });

  it("a successful read of 'connected' writes the cache for next launch", async () => {
    useStore.getState().setUserId(USER);
    vi.mocked(getWhoopConnection).mockResolvedValue(connection());

    await useStore.getState().loadWhoopConnection();

    expect(useStore.getState().whoopConnected).toBe(true);
    expect(JSON.parse(mem.get(KEY)!)).toEqual({
      userId: USER,
      connected: true,
    });
  });

  it("a FAILED read keeps the cached state and reports exactly once", async () => {
    // Treating a failed read as "not connected" would collapse the column
    // on every flaky launch — the jump this mechanism exists to prevent.
    seedCache(USER, true);
    useStore.getState().setUserId(USER);
    vi.mocked(getWhoopConnection).mockRejectedValue(
      new Error("Network request failed"),
    );

    await useStore.getState().loadWhoopConnection();

    expect(useStore.getState().whoopConnected).toBe(true);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [, ctx] = vi.mocked(Sentry.captureException).mock.calls[0] as [
      unknown,
      { tags: { operation: string } },
    ];
    expect(ctx.tags.operation).toBe("loadWhoopConnection");
  });

  it("a failed read leaves the cache untouched, so the next launch still has it", async () => {
    seedCache(USER, true);
    useStore.getState().setUserId(USER);
    vi.mocked(getWhoopConnection).mockRejectedValue(new Error("boom"));

    await useStore.getState().loadWhoopConnection();

    expect(JSON.parse(mem.get(KEY)!).connected).toBe(true);
  });

  it("does nothing at all without a signed-in user", async () => {
    useStore.getState().setUserId(null);

    await useStore.getState().loadWhoopConnection();

    expect(getWhoopConnection).not.toHaveBeenCalled();
  });

  it("a sign-out mid-flight does not write a cache entry for the old user", async () => {
    // The round trip outlives the session it belongs to. Writing here
    // would hand the NEXT account a cache entry it never earned.
    useStore.getState().setUserId(USER);
    let settle: (c: WhoopConnection | null) => void = () => {};
    vi.mocked(getWhoopConnection).mockReturnValue(
      new Promise((res) => {
        settle = res;
      }),
    );

    const pending = useStore.getState().loadWhoopConnection();
    useStore.getState().reset(); // sign-out
    settle(connection());
    await pending;

    expect(mem.has(KEY)).toBe(false);
  });
});

describe("setWhoopConnected — Settings' connect and disconnect", () => {
  it("disconnecting updates the store and the cache together", async () => {
    seedCache(USER, true);
    useStore.getState().setUserId(USER);
    useStore.setState({ whoopConnected: true });

    await useStore.getState().setWhoopConnected(false);

    expect(useStore.getState().whoopConnected).toBe(false);
    expect(JSON.parse(mem.get(KEY)!).connected).toBe(false);
  });

  it("connecting updates the store and the cache together", async () => {
    useStore.getState().setUserId(USER);

    await useStore.getState().setWhoopConnected(true);

    expect(useStore.getState().whoopConnected).toBe(true);
    expect(JSON.parse(mem.get(KEY)!)).toEqual({
      userId: USER,
      connected: true,
    });
  });
});

describe("reset", () => {
  it("clears the state and removes the cache", async () => {
    seedCache(USER, true);
    useStore.getState().setUserId(USER);
    useStore.setState({ whoopConnected: true });

    useStore.getState().reset();
    await Promise.resolve(); // the cache clear is fire-and-forget

    expect(useStore.getState().whoopConnected).toBe(false);
    expect(mem.has(KEY)).toBe(false);
  });
});

describe("what the cache is allowed to hold", () => {
  it("stores a user id and a boolean, and nothing else", async () => {
    // No tokens, no scores, no connection-row fields. A cache of
    // biometric values would be a health-data store on the device with
    // no expiry and no RLS behind it; this is a layout hint.
    useStore.getState().setUserId(USER);
    vi.mocked(getWhoopConnection).mockResolvedValue(connection());

    await useStore.getState().loadWhoopConnection();

    expect(Object.keys(JSON.parse(mem.get(KEY)!)).sort()).toEqual([
      "connected",
      "userId",
    ]);
    expect(mem.get(KEY)).not.toMatch(/token|scope|sync|whoop_user_id/i);
  });
});
