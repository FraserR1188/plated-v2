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
  ProfileWithFollowState,
  MealEntry,
  EntryDraft,
  CopyPayload,
} from "../types";

import { dateKey } from "./time";
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
 * Excludes the current user. Returns up to 20 results with follow state.
 */
export async function searchUsers(
  query: string,
): Promise<ProfileWithFollowState[]> {
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

  const { data: myFollows } = await supabase
    .from("follows")
    .select("following_id")
    .eq("follower_id", user.id);

  const { data: theirFollows } = await supabase
    .from("follows")
    .select("follower_id")
    .eq("following_id", user.id);

  const myFollowSet = new Set((myFollows ?? []).map((r) => r.following_id));
  const theirFollowSet = new Set(
    (theirFollows ?? []).map((r) => r.follower_id),
  );

  const userIds = profiles.map((p) => p.user_id);
  const { data: counts } = await supabase
    .from("follow_counts")
    .select("user_id, follower_count, following_count")
    .in("user_id", userIds);

  const countMap = new Map((counts ?? []).map((c) => [c.user_id, c]));

  return profiles.map((p) => ({
    ...p,
    is_following: myFollowSet.has(p.user_id),
    follows_you: theirFollowSet.has(p.user_id),
    follower_count: countMap.get(p.user_id)?.follower_count ?? 0,
    following_count: countMap.get(p.user_id)?.following_count ?? 0,
  }));
}

// ─── Follow / Unfollow ───────────────────────────────────────

export async function followUser(targetUserId: string): Promise<WriteResult> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { error } = await supabase
    .from("follows")
    .insert({ follower_id: user.id, following_id: targetUserId });

  if (error) {
    reportError("followUser", error);
    return { error: "Couldn't follow this user." };
  }
  return { error: null };
}

export async function unfollowUser(targetUserId: string): Promise<WriteResult> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { error } = await supabase
    .from("follows")
    .delete()
    .eq("follower_id", user.id)
    .eq("following_id", targetUserId);

  if (error) {
    reportError("unfollowUser", error);
    return { error: "Couldn't unfollow this user." };
  }
  return { error: null };
}

// ─── Friends List ────────────────────────────────────────────

/**
 * Returns everyone the current user follows, enriched with
 * today's calorie total for each person.
 */
export async function getFollowing(): Promise<ProfileWithFollowState[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data: follows, error: followErr } = await supabase
    .from("follows")
    .select(
      `
      following_id,
      profiles!follows_following_id_fkey (
        user_id, username, display_name, avatar_url, created_at
      )
    `,
    )
    .eq("follower_id", user.id);

  if (followErr) throw followErr;
  if (!follows || follows.length === 0) return [];

  const followingIds = follows.map((f) => f.following_id);

  const { data: theirFollows } = await supabase
    .from("follows")
    .select("follower_id")
    .in("follower_id", followingIds)
    .eq("following_id", user.id);

  const theirFollowSet = new Set(
    (theirFollows ?? []).map((r) => r.follower_id),
  );

  const { data: counts } = await supabase
    .from("follow_counts")
    .select("user_id, follower_count, following_count")
    .in("user_id", followingIds);

  const countMap = new Map((counts ?? []).map((c) => [c.user_id, c]));

  return follows
    .map((f) => {
      const profile = f.profiles as unknown as Profile;
      if (!profile) return null;
      return {
        ...profile,
        is_following: true as boolean,
        follows_you: theirFollowSet.has(profile.user_id),
        follower_count: countMap.get(profile.user_id)?.follower_count ?? 0,
        following_count: countMap.get(profile.user_id)?.following_count ?? 0,
      } satisfies ProfileWithFollowState;
    })
    .filter((x): x is ProfileWithFollowState => x !== null);
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

// ─── Copying a friend's food into your own log ───────────────

/**
 * Turn a FRIEND'S entry into a draft for YOUR log.
 *
 * This is the only genuinely social part of the copy. Everything after it —
 * the insert, the date derivation, the trigger — is shared with bundles and
 * copy-a-day, and lives in src/lib/entries.ts.
 *
 * ─── TIME: now(), NOT theirs ───
 *
 * You are eating this NOW, not when they ate it. eaten_at is what the WHOOP
 * correlation keys on, so it must be the time it went in YOUR mouth. Note that
 * copy-a-day does the OPPOSITE (it preserves the wall clock), and a bundle does
 * a third thing (it uses the item's stored time). Three rules, three builders.
 * A strategy flag on the insert would have to encode all three, and the social
 * rule can't even see a target day.
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
 */
export function draftsFromFeedEntry(payload: CopyPayload): EntryDraft[] {
  const now = new Date().toISOString();

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

    // targetMeal is resolved HERE and stops here. It never reaches the insert:
    //   - ingredient / meal_section copies → targetMeal overrides.
    //   - full_day copies (targetMeal null) → each entry keeps its own section.
    // A payload-level override cannot express copy-a-day's "each row keeps its
    // OWN meal", which is why applyEntries takes per-row meal_type instead.
    meal_type: payload.targetMeal ?? entry.meal_type,

    eaten_at: now,
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
 * Copy a set of a friend's entries into the current user's log, dated today.
 *
 * Kept as a named export so CopyConfirmScreen doesn't have to change. The insert
 * itself now lives in applyEntries().
 *
 * ⚠ RootStackParamList.CopyConfirm carries a `date`, and this function ignores
 * it — it always lands on now(). That is correct for a social copy (see above),
 * but if that route param was ever meant to CHOOSE the day, the screen has been
 * offering a choice and dropping it. Flagged, not changed: it needs a look at
 * CopyConfirmScreen, which isn't in scope for D4.
 */
export async function copyEntriesToMyLog(
  payload: CopyPayload,
): Promise<MealEntry[]> {
  return applyEntries(draftsFromFeedEntry(payload));
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
