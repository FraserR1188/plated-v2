// ============================================================
// src/lib/social.ts — Supabase queries for the social feature
//
// D4: copyEntriesToMyLog no longer does its own insert. It builds EntryDrafts
// and hands them to applyEntries() in src/lib/entries.ts, which is now the ONE
// bulk insert path into meal_entries. This file keeps the part that is
// genuinely social — the rule for turning a FRIEND'S entry into YOUR draft —
// and nothing else.
// ============================================================

import { supabase } from "./supabase";
import {
  Profile,
  ProfileWithFriendState,
  FriendshipState,
  MealEntry,
  MealType,
  EntryDraft,
  CopyPayload,
} from "../types";

import { dateKey, localHM, sameTimeOnDay, TimeOfDay } from "./time";
import { applyEntries } from "./entries";
import { reportError } from "./reportError";
import type { WriteResult } from "../store/useStore";

// ─── Profile CRUD ────────────────────────────────────────────

/** Fetch the current user's own profile. Returns null if not yet created. */
export async function getMyProfile(): Promise<Profile | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

// profiles.username is NOT NULL UNIQUE, CHECK (username ~ '^[a-z0-9_]{3,30}$')
// (20260819100000_capture_social_schema.sql). Validate against the exact same
// pattern client-side so a rejected write comes back as a hint, not a raw
// constraint-violation message.
const USERNAME_FORMAT_RE = /^[a-z0-9_]{3,30}$/;
const USERNAME_FORMAT_HINT =
  "Usernames use lowercase letters, numbers and underscores, 3-30 characters.";

/**
 * Create or upsert the current user's profile (used during onboarding / settings).
 *
 * Every account gets a profile row at signup now
 * (20260819101000_profile_on_signup.sql), so in practice this is always an
 * UPDATE — the upsert/onConflict is defence in depth, not the primary path.
 */
export async function upsertProfile(
  username: string,
  displayName?: string,
): Promise<Profile> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const normalized = username.toLowerCase().trim();
  if (!USERNAME_FORMAT_RE.test(normalized)) {
    throw new Error(USERNAME_FORMAT_HINT);
  }

  const { data, error } = await supabase
    .from("profiles")
    .upsert(
      {
        user_id: user.id,
        username: normalized,
        display_name: displayName?.trim() ?? null,
      },
      { onConflict: "user_id" },
    )
    .select()
    .single();

  if (error) {
    // 23505 = unique_violation. Distinct from every other failure: it's not
    // a bug to report, it's someone else's handle.
    if (error.code === "23505") {
      throw new Error("That handle is taken. Try another one.");
    }
    reportError("upsertProfile", error);
    throw new Error("Couldn't save your username. Please try again.");
  }
  return data;
}

/**
 * Flip the current user's own share_planned flag — see
 * 20260823150000_share_planned.sql. profiles_update_own already permits
 * this (own row, no new policy needed).
 *
 * Copies acceptFriend's shape, not upsertProfile's: a plain UPDATE against
 * the caller's own row can, in principle, match zero rows (no profile
 * created yet), and without .select() PostgREST can't distinguish that from
 * a successful 1-row update. So this selects the updated row back and
 * treats zero rows as a failure, same as acceptFriend — not upsertProfile's
 * upsert-and-.single() shape, which is the username path and carries its
 * own 23505 handling that doesn't apply here.
 */
export async function setSharePlanned(value: boolean): Promise<WriteResult> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { data, error } = await supabase
    .from("profiles")
    .update({ share_planned: value })
    .eq("user_id", user.id)
    .select();

  if (error) {
    reportError("setSharePlanned", error);
    return { error: "Couldn't save that setting. Please try again." };
  }
  if (!data || data.length === 0) {
    return { error: "Couldn't find your profile. Please try again." };
  }
  return { error: null };
}

/** Check if a username is available (case-insensitive). */
export async function isUsernameAvailable(username: string): Promise<boolean> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data } = await supabase
    .from("profiles")
    .select("user_id")
    .eq("username", username.toLowerCase().trim())
    .maybeSingle();

  // Available if no row found, or the only row is the current user
  if (!data) return true;
  return data.user_id === user?.id;
}

// ─── User Search ─────────────────────────────────────────────

/**
 * Search profiles by username.
 *
 * ⚠ KNOWN BUG, CARRIED FORWARD FROM AN EARLIER SESSION: the docstring used to
 * say "prefix", and the implementation is `ilike('%q%')` — an infix search.
 * Not fixed here because changing it changes what users can find, which is a
 * product decision, not a cleanup. The comment now matches the code.
 *
 * Excludes the current user. Returns up to 20 results with friendship state.
 */
export async function searchUsers(
  query: string,
): Promise<ProfileWithFriendState[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const q = query.toLowerCase().trim();
  if (!q || q.length < 2) return [];

  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("*")
    .ilike("username", `%${q}%`)
    .neq("user_id", user.id)
    .limit(20);

  if (error) throw error;
  if (!profiles || profiles.length === 0) return [];

  // Both directions of MY relationships, with status — this is what turns into
  // "none" / "outgoing_pending" / "incoming_pending" / "accepted" below.
  //
  // follow_counts is deliberately NOT queried here any more: follows_select_party
  // (20260819110000_friendship_accept_gate.sql) narrowed SELECT on follows to
  // rows the caller is party to, so the view — security_invoker = on — now only
  // sees the caller's own relationships. It would return a correct count for
  // the caller's own profile and a near-zero one for every OTHER profile in
  // this result list, which is wrong, not stale. Not worked around with a
  // security definer function; see that migration's note.
  const { data: outgoing } = await supabase
    .from("follows")
    .select("following_id, status")
    .eq("follower_id", user.id);

  const { data: incoming } = await supabase
    .from("follows")
    .select("follower_id, status")
    .eq("following_id", user.id);

  const outgoingStatus = new Map(
    (outgoing ?? []).map((r) => [r.following_id, r.status]),
  );
  const incomingStatus = new Map(
    (incoming ?? []).map((r) => [r.follower_id, r.status]),
  );

  return profiles.map((p) => ({
    ...p,
    friendship: friendshipStateFor(p.user_id, outgoingStatus, incomingStatus),
  }));
}

/**
 * Since follows_no_reciprocal (20260819120000_*.sql) forbids both A→B and B→A
 * existing for the same pair, `out` and `inc` can never both be set for the
 * same userId — only one directional row can exist between any two users at
 * a time. That makes the outgoing-before-incoming ordering below DEAD LOGIC:
 * there is no longer a genuine conflict for it to resolve, because the two
 * conditions are now mutually exclusive rather than merely checked in an
 * order that happened to prefer one. Left as-is rather than collapsed,
 * since removing it wasn't asked for and the order is still correct — it's
 * just no longer doing any work.
 */
function friendshipStateFor(
  userId: string,
  outgoingStatus: Map<string, string>,
  incomingStatus: Map<string, string>,
): FriendshipState {
  const out = outgoingStatus.get(userId);
  const inc = incomingStatus.get(userId);
  if (out === "accepted" || inc === "accepted") return "accepted";
  if (out === "pending") return "outgoing_pending";
  if (inc === "pending") return "incoming_pending";
  return "none";
}

// ─── Friend requests ─────────────────────────────────────────

/**
 * The message returned by requestFriend() when the OTHER person already sent
 * YOU a request first. Exported as a constant, not duplicated as a literal at
 * the call site, because callers need to recognise this specific case (to
 * refresh the row into the Accept/Decline state) and a string comparison
 * against a copy-pasted literal is exactly the kind of thing that silently
 * drifts when either side is edited later.
 */
export const RECIPROCAL_REQUEST_ERROR =
  "This person already sent you a request — check your requests.";

/**
 * Send a friend request. Status is never sent on the insert — the column
 * default supplies 'pending', and follows_insert_own's WITH CHECK rejects
 * anything else anyway (20260819110000_friendship_accept_gate.sql).
 */
export async function requestFriend(
  targetUserId: string,
): Promise<WriteResult> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { error } = await supabase
    .from("follows")
    .insert({ follower_id: user.id, following_id: targetUserId });

  if (error) {
    reportError("requestFriend", error);
    // 23P01 = exclusion_violation. follows_no_reciprocal
    // (20260819120000) forbids both A→B and B→A existing for the same pair —
    // this is the second of two crossed requests, sent before either party
    // saw the other's. Not a bug to bury under a generic message: the
    // request the user is looking for already exists, just addressed to them.
    if (error.code === "23P01") {
      return { error: RECIPROCAL_REQUEST_ERROR };
    }
    return { error: "Couldn't send that friend request." };
  }
  return { error: null };
}

/**
 * Accept an incoming request. follows_update_addressee only lets the
 * ADDRESSEE (following_id = me) move a row, and only to 'accepted'.
 *
 * A row that isn't mine to accept — wrong user, already handled, or never
 * existed — matches zero rows and comes back as an EMPTY result, not a
 * Postgres error. That is the standing invariant for a foreign auth.uid():
 * 0 rows affected, not an error. Without .select() PostgREST can't tell
 * "0 rows updated" from "1 row updated", so this MUST select the updated
 * rows back, and zero rows is treated as a failure with its own message.
 */
export async function acceptFriend(
  requesterId: string,
): Promise<WriteResult> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { data, error } = await supabase
    .from("follows")
    .update({ status: "accepted" })
    .eq("follower_id", requesterId)
    .eq("following_id", user.id)
    .eq("status", "pending")
    .select();

  if (error) {
    reportError("acceptFriend", error);
    return { error: "Couldn't accept that request." };
  }
  if (!data || data.length === 0) {
    return { error: "That request is no longer available." };
  }
  return { error: null };
}

/**
 * declineFriend and unfriend are the same DELETE: follows_delete_party lets
 * EITHER party remove the row regardless of status, and the row could have
 * either of us as follower_id depending on who originally sent the request —
 * the caller can't know which without a lookup, so the predicate covers both
 * directions in one query. One implementation, two named exports so Sentry
 * can tell a declined request from an unfriend.
 */
async function deleteFriendRow(
  otherUserId: string,
  operation: string,
  friendlyMessage: string,
): Promise<WriteResult> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { error } = await supabase
    .from("follows")
    .delete()
    .or(
      `and(follower_id.eq.${user.id},following_id.eq.${otherUserId}),` +
        `and(follower_id.eq.${otherUserId},following_id.eq.${user.id})`,
    );

  if (error) {
    reportError(operation, error);
    return { error: friendlyMessage };
  }
  return { error: null };
}

/** Decline an incoming request, or cancel one you sent — same delete either way. */
export function declineFriend(otherUserId: string): Promise<WriteResult> {
  return deleteFriendRow(
    otherUserId,
    "declineFriend",
    "Couldn't decline that request.",
  );
}

/** Remove an existing (accepted) friendship. */
export function unfriend(friendUserId: string): Promise<WriteResult> {
  return deleteFriendRow(
    friendUserId,
    "unfriend",
    "Couldn't remove this friend.",
  );
}

// ─── Friends list ────────────────────────────────────────────

/**
 * Everyone the current user has an ACCEPTED friendship with, enriched with
 * today's calorie total for each person.
 *
 * Two queries, not one join: a row's "other party" profile sits on whichever
 * FK column ISN'T the caller, and follows has two FKs into profiles (one per
 * column), so a single PostgREST embed can't pick the right one without
 * already knowing which side that is.
 */
export async function getFriends(): Promise<ProfileWithFriendState[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const [outgoing, incoming] = await Promise.all([
    supabase
      .from("follows")
      .select(
        `
        following_id,
        profiles!follows_following_id_fkey (
          user_id, username, display_name, avatar_url, created_at, share_planned
        )
      `,
      )
      .eq("follower_id", user.id)
      .eq("status", "accepted"),
    supabase
      .from("follows")
      .select(
        `
        follower_id,
        profiles!follows_follower_id_fkey (
          user_id, username, display_name, avatar_url, created_at, share_planned
        )
      `,
      )
      .eq("following_id", user.id)
      .eq("status", "accepted"),
  ]);

  if (outgoing.error) throw outgoing.error;
  if (incoming.error) throw incoming.error;

  const profiles = [
    ...(outgoing.data ?? []).map((r) => r.profiles as unknown as Profile),
    ...(incoming.data ?? []).map((r) => r.profiles as unknown as Profile),
  ].filter((p): p is Profile => !!p);

  return profiles.map((p) => ({
    ...p,
    friendship: "accepted" as const,
  }));
}

/** Pending requests where I'm the addressee — the ones I can Accept/Decline. */
export async function getIncomingRequests(): Promise<
  ProfileWithFriendState[]
> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from("follows")
    .select(
      `
      follower_id,
      profiles!follows_follower_id_fkey (
        user_id, username, display_name, avatar_url, created_at, share_planned
      )
    `,
    )
    .eq("following_id", user.id)
    .eq("status", "pending");

  if (error) throw error;
  if (!data) return [];

  return data
    .map((r) => r.profiles as unknown as Profile)
    .filter((p): p is Profile => !!p)
    .map((p) => ({ ...p, friendship: "incoming_pending" as const }));
}

// ─── Viewing another user's log ──────────────────────────────

/**
 * Fetch a connected user's meal entries for a given date.
 * RLS guarantees this only returns data if the viewer follows them.
 */
export async function getEntriesForUser(
  userId: string,
  date: string,
): Promise<MealEntry[]> {
  const { data, error } = await supabase
    .from("meal_entries")
    .select("*")
    .eq("user_id", userId)
    .eq("date", date)
    // A plan is not food. Migration 4's follower policy already makes these rows
    // unreachable, so this is defence in depth — but it also says out loud what
    // this function returns, which the policy cannot do from over here.
    .or("planned.eq.false,confirmed_at.not.is.null")
    .is("skipped_at", null)
    // NOT created_at — that column does not exist on meal_entries.
    .order("eaten_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * Fetch a connected user's meal entries across an inclusive date range.
 *
 * Same select and the same two filters as getEntriesForUser (RLS's own
 * (planned = false or confirmed_at is not null) gate already makes them
 * redundant — same reasoning as that function's comment: defence in depth
 * on a cross-user read, and it says out loud what this returns). The only
 * difference is .gte/.lte in place of .eq("date", date), for
 * ConnectedUserLogScreen's chunked history fetch.
 */
export async function getEntriesForUserRange(
  userId: string,
  startDate: string,
  endDate: string,
): Promise<MealEntry[]> {
  // No client-side planned/confirmed filter here — RLS
  // (meal_entries_select_follower, 20260823150000_share_planned.sql) is now
  // the only gate on a friend's planned rows, via their own share_planned
  // opt-in. A client-side .or() re-adding that filter would silently
  // contradict the policy: it would hide rows the DB has already decided
  // this viewer is allowed to see. .is("skipped_at", null) stays — it's an
  // unrelated gate (a friend's "no, I didn't eat this" answer is never
  // shown, opted in or not), not part of the planned/confirmed decision.
  const { data, error } = await supabase
    .from("meal_entries")
    .select("*")
    .eq("user_id", userId)
    .gte("date", startDate)
    .lte("date", endDate)
    .is("skipped_at", null)
    .order("eaten_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

// ─── Copying a friend's food into your own log ───────────────

/**
 * Turn a FRIEND'S entry into a draft for YOUR log.
 *
 * This is the only genuinely social part of the copy. Everything after it —
 * the insert, the date derivation, the trigger — is shared with bundles and
 * copy-a-day, and lives in src/lib/entries.ts.
 *
 * ─── TIME: a target YOU choose, NOT theirs — but "each" preserves per-entry ───
 *
 * eaten_at comes from `target`, resolved by CopyConfirmScreen's own picker —
 * never the friend's original eaten_at, UNLESS target.time is null, in which
 * case it's each entry's OWN wall clock, moved onto target.dayKey. This
 * mirrors target.meal_type exactly: both null means "preserve this entry's
 * own value," and both are resolved per entry, not once for the whole
 * payload. CopyConfirmScreen passes time: null together with meal_type: null,
 * for the same scope (full_day, "each" mode) — a single chosen instant can no
 * more express "keep each item's own time" than a single chosen section can
 * express "keep each item's own meal."
 *
 * "Steal this meal idea" is not "mirror their day": in "shared" mode the
 * picker defaults to now (captured once when the screen opens), not to the
 * source entries' time and not to whichever day was being browsed in the
 * friend's log, but the user can move it, including into the future — a
 * forward day flows through untouched into the eaten_at -> planned DB trigger
 * like any other creation path. Note that copy-a-day (draftsFromDay) does the
 * per-entry-time-preserving thing UNCONDITIONALLY, and a bundle does a third
 * thing again (it uses the item's stored time). This builder is deliberately
 * NOT routed onto draftsFromDay for the null-time case: draftsFromDay carries
 * image_path/custom_food_id forward, which is correct for YOUR OWN food but
 * would leak a friend's private storage path and an FK into their
 * custom_foods — see the IMAGES section below. Same per-entry wall-clock
 * math, two different correct answers on images, so this stays its own
 * builder rather than delegating.
 *
 * ─── IMAGES: the rule falls out of storage RLS, not out of taste ───
 *
 *   image_url  (Open Food Facts — a public, directly renderable URL)
 *              → COPIED. Works immediately, nothing to sign.
 *
 *   image_path (custom food — an object path in the PRIVATE bucket, under the
 *              ORIGINAL OWNER's folder: {their_id}/{food_id}/front.jpg)
 *              → NOT copied. Storage RLS is keyed on that folder, so
 *              getSignedImageUrl() would refuse to sign it — we'd render a
 *              broken placeholder AND embed their user id in your row for
 *              nothing.
 *
 *   custom_food_id
 *              → NOT copied. It's a foreign key into THEIR custom_foods, which
 *              your RLS won't let you read.
 *
 * ⚠ BUNDLES AND COPY-A-DAY KEEP BOTH OF THESE. That is not an inconsistency to
 * tidy up. Those copy YOUR food within YOUR log, so the path is under YOUR
 * folder and getSignedImageUrl() WILL sign it. Same columns, two different
 * correct answers, and only one of them is a privacy question.
 *
 * (Verified: custom_foods.image_url stores a PATH, and
 * foodLookup.customFoodToProduct maps it to FoodProduct.image_PATH — so a
 * private path never reaches meal_entries.image_url, and this guarantee has no
 * hole in it. If someone ever "fixes" that mapping to match the column name,
 * this comment becomes a lie and friends' storage paths start leaking.)
 *
 * Net effect: copying a friend's branded food keeps the picture. Copying their
 * homemade food doesn't. The alternatives (duplicate the bytes into your own
 * folder; or loosen the bucket RLS so followers can sign your photos) are both
 * real work, and the second weakens a privacy claim we've already published.
 *
 * ─── TARGET: chosen in CopyConfirmScreen, resolved here ───
 *
 * `target` is CopyConfirmScreen's own CopyTargetPicker state, seeded from a
 * `now` captured when the screen opened — never the day being browsed in the
 * friend's log, and never the source entries' own eaten_at (except via the
 * null branch above). `target.time ?? localHM(entry.eaten_at)` and
 * `target.dayKey` go through sameTimeOnDay(), the same DST-safe day+time ->
 * instant chain draftsForTarget/draftsFromDay use, so a future day flows
 * through untouched into the eaten_at -> planned DB trigger exactly like any
 * other creation path — no clamping, no special-casing planned here.
 */
export function draftsFromFeedEntry(
  payload: CopyPayload,
  target: { dayKey: string; time: TimeOfDay | null; meal_type: MealType | null },
): EntryDraft[] {
  return payload.entries.map((entry) => ({
    name: entry.name,
    brand: entry.brand ?? null,
    serving_g: entry.serving_g,

    calories: entry.calories,
    protein: entry.protein,
    carbs: entry.carbs,
    fat: entry.fat,

    // ⚠ CHANGED IN D4: was `?? 0`.
    //
    // The old code coalesced these to zero on the way IN. Coalescing on a READ
    // (`e.salt ?? 0` when summing) protects a total from a NULL. Coalescing on
    // a WRITE destroys the NULL permanently: "we don't know how much fibre this
    // had" becomes the assertion "it had ZERO GRAMS of fibre", in your log,
    // feeding your goals and your WHOOP correlation, and propagating into every
    // further copy.
    //
    // Same three characters, opposite consequences. This is the same class of
    // loss as the sat_fat bug found in an earlier session — that fix restored
    // the COLUMN but not the DISTINCTION.
    sat_fat: entry.sat_fat ?? null,
    salt: entry.salt ?? null,
    fibre: entry.fibre ?? null,
    sugar: entry.sugar ?? null,

    // target.meal_type is resolved HERE and stops here. It never reaches the
    // insert:
    //   - ingredient / meal_section copies → target.meal_type overrides.
    //   - full_day copies (target.meal_type null) → each entry keeps its own
    //     section — CopyConfirmScreen only ever passes null here for that
    //     scope, since a single chosen section can't express "keep each
    //     entry's own".
    // A payload-level override cannot express copy-a-day's "each row keeps its
    // OWN meal", which is why applyEntries takes per-row meal_type instead.
    meal_type: target.meal_type ?? entry.meal_type,

    // target.time is resolved per entry, exactly paralleling meal_type above:
    // null means "keep THIS entry's own wall clock," moved onto
    // target.dayKey via sameTimeOnDay — not a single instant shared by every
    // row in the payload. See the TIME section above.
    eaten_at: sameTimeOnDay(
      target.time ?? localHM(entry.eaten_at),
      target.dayKey,
    ),
    // Unconditionally true, matching draftsForTarget/draftsFromDay (the
    // own-log copy builders) — a copy's timing stays a forecast even when the
    // user explicitly chose the day and wall-clock time in the picker. This
    // is NOT the same rule as confirmEntries'/ProductScreen's "they told us
    // the real time" (which applies to confirming an already-logged meal),
    // and the two must not be conflated: see the entries.test.ts tests named
    // "regardless of the source's certainty" for the own-log side of this
    // invariant.
    eaten_at_estimated: true,

    source: "copied",
    barcode: entry.barcode ?? null,
    off_id: entry.off_id ?? null,

    image_url: entry.image_url ?? null,

    // NOT forgotten. See the comment above.
    image_path: null,
    custom_food_id: null,
  }));
}

/**
 * Copy a set of a friend's entries into the current user's log, at a target
 * day/time/meal CopyConfirmScreen's CopyTargetPicker resolved.
 *
 * Kept as a named export so CopyConfirmScreen's call site stays a one-liner.
 * The insert itself lives in applyEntries().
 */
export async function copyEntriesToMyLog(
  payload: CopyPayload,
  target: { dayKey: string; time: TimeOfDay | null; meal_type: MealType | null },
): Promise<MealEntry[]> {
  return applyEntries(draftsFromFeedEntry(payload, target));
}

// ─── Utility: today's calorie total for a user ───────────────

export async function getTodayCaloriesForUser(userId: string): Promise<number> {
  const { data, error } = await supabase
    .from("meal_entries")
    .select("calories")
    .eq("user_id", userId)
    .eq("date", dateKey())
    // "2,400 kcal today" must mean EATEN. A plan they haven't touched and a meal
    // they told us they skipped are both zero, as far as anyone else is concerned.
    .or("planned.eq.false,confirmed_at.not.is.null")
    .is("skipped_at", null);

  if (error || !data) return 0;
  // Coalesce on the READ. This one is correct — see the note in the draft builder.
  return data.reduce((sum, r) => sum + (r.calories ?? 0), 0);
}
