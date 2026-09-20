// ============================================================
// src/lib/whoopConnectionCache.ts — the last-known answer to "does this
// user have WHOOP connected?", cached locally so Today's first frame can
// be laid out correctly.
//
// WHY THIS EXISTS. The WHOOP scores panel sits in an 82dp column beside
// the calorie ring, so whether the user is connected changes the LAYOUT,
// not just the content. The connection row can't be read before the
// Supabase session is restored (getSession() awaits initializePromise,
// and the token is resolved per request), so a cold start that waits for
// the network renders the centred, no-column layout first and then jumps
// the ring sideways when the row lands — on every launch, for exactly the
// users the feature is for.
//
// A local cache removes the jump for everyone who has launched before.
// A first-ever launch has no cache and falls back to "not connected",
// which is correct: they haven't connected anything yet.
//
// WHAT IT DELIBERATELY DOES NOT HOLD. One boolean and a user id. No
// tokens (those are server-side only, in whoop_tokens, which the client
// cannot read at all), no scores, and no fields from the connection row.
// A cache of biometric values would be a health-data store on the device
// with no expiry and no RLS behind it; this is a layout hint.
//
// STALENESS IS ACCEPTED, ONCE. A user who revoked on WHOOP's site since
// the last launch sees the panel with "–" for one round trip before it
// disappears. That was weighed against the jump and chosen deliberately.
// ============================================================

import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "plated.whoopConnection.v1";

export type WhoopConnectionCache = {
  userId: string;
  connected: boolean;
};

/**
 * The cached state, but ONLY if it belongs to `userId`.
 *
 * The user-id check is the whole safety property. Two accounts on one
 * device — which is how this app gets tested, and how a shared phone
 * works — would otherwise let account A's layout decide account B's
 * first frame. A mismatch is treated exactly like no cache at all, not
 * as a reason to guess.
 *
 * Never throws: AsyncStorage can be unavailable or return junk, and a
 * layout hint is not worth failing a launch over.
 */
export async function readWhoopConnectionCache(
  userId: string,
): Promise<boolean | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WhoopConnectionCache>;
    if (typeof parsed?.userId !== "string") return null;
    if (typeof parsed?.connected !== "boolean") return null;
    if (parsed.userId !== userId) return null;
    return parsed.connected;
  } catch {
    return null;
  }
}

/** Writes the cache. Always paired with the store update, never alone. */
export async function writeWhoopConnectionCache(
  userId: string,
  connected: boolean,
): Promise<void> {
  try {
    const value: WhoopConnectionCache = { userId, connected };
    await AsyncStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // A cache that can't be written costs a layout jump next launch,
    // which is the behaviour we had before it existed.
  }
}

/** Removes it. Called on sign-out, via the store's reset(). */
export async function clearWhoopConnectionCache(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // Same reasoning as above.
  }
}
