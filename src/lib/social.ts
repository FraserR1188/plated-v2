// ============================================================
// src/lib/social.ts — Supabase queries for the social feature
// ============================================================

import { supabase } from "./supabase";
import {
  Profile,
  ProfileWithFollowState,
  MealEntry,
  MealType,
  CopyPayload,
} from "../types";

// ─── Profile CRUD ────────────────────────────────────────────

const todayKey = () => new Date().toISOString().split("T")[0];

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

/** Create or upsert the current user's profile (used during onboarding / settings). */
export async function upsertProfile(
  username: string,
  displayName?: string,
): Promise<Profile> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data, error } = await supabase
    .from("profiles")
    .upsert(
      {
        user_id: user.id,
        username: username.toLowerCase().trim(),
        display_name: displayName?.trim() ?? null,
      },
      { onConflict: "user_id" },
    )
    .select()
    .single();

  if (error) throw error;
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
 * Search profiles by username prefix.
 * Excludes the current user from results.
 * Returns up to 20 results with follow state enriched.
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

  // Fetch matching profiles (excluding self)
  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("*")
    .ilike("username", `%${q}%`)
    .neq("user_id", user.id)
    .limit(20);

  if (error) throw error;
  if (!profiles || profiles.length === 0) return [];

  // Fetch the viewer's own follow list in one query
  const { data: myFollows } = await supabase
    .from("follows")
    .select("following_id")
    .eq("follower_id", user.id);

  // Fetch who follows the viewer
  const { data: theirFollows } = await supabase
    .from("follows")
    .select("follower_id")
    .eq("following_id", user.id);

  const myFollowSet = new Set((myFollows ?? []).map((r) => r.following_id));
  const theirFollowSet = new Set(
    (theirFollows ?? []).map((r) => r.follower_id),
  );

  // Fetch follow counts from the view
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

export async function followUser(targetUserId: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { error } = await supabase
    .from("follows")
    .insert({ follower_id: user.id, following_id: targetUserId });

  if (error) throw error;
}

export async function unfollowUser(targetUserId: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { error } = await supabase
    .from("follows")
    .delete()
    .eq("follower_id", user.id)
    .eq("following_id", targetUserId);

  if (error) throw error;
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

  // Get the list of people the current user follows
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

  // Check who among them follows the viewer back
  const { data: theirFollows } = await supabase
    .from("follows")
    .select("follower_id")
    .in("follower_id", followingIds)
    .eq("following_id", user.id);

  const theirFollowSet = new Set(
    (theirFollows ?? []).map((r) => r.follower_id),
  );

  // Fetch follow counts
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
    // NOT created_at — that column does not exist on meal_entries (see the note
    // at the top of src/types/index.ts). eaten_at is nullable on old rows, so
    // nullsFirst: false pushes them to the end rather than the front.
    .order("eaten_at", { ascending: true, nullsFirst: false });

  if (error) throw error;
  return data ?? [];
}

/**
 * Copy a set of MealEntry rows into the current user's log.
 *
 * - ingredient / meal_section copies: targetMeal overrides meal_type.
 * - full_day copies: each entry keeps its original meal_type.
 *
 * Serving sizes and all macros are copied verbatim; the user can adjust a single
 * copied ingredient afterwards via ProductScreen.
 *
 * IMAGES — the rule falls out of the storage model, not out of taste:
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
 * Net effect: copying a friend's branded food keeps the picture. Copying their
 * homemade food doesn't. The alternatives (duplicate the bytes into your own
 * folder; or loosen the bucket RLS so followers can sign your photos) are both
 * real work, and the second weakens a privacy claim we've already published.
 */
export async function copyEntriesToMyLog(payload: CopyPayload): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const today = todayKey();
  const now = new Date().toISOString();

  const rows = payload.entries.map((entry) => ({
    // New row, new owner, new day. Source ids are deliberately not carried over.
    user_id: user.id,
    date: today,
    meal_type: payload.targetMeal ?? entry.meal_type,
    logged_at: now,

    // You are eating this NOW, not when they ate it. eaten_at is what the WHOOP
    // correlation will key on, so it must be the time it went in YOUR mouth.
    eaten_at: now,

    name: entry.name,
    brand: entry.brand ?? null,

    serving_g: entry.serving_g,
    calories: entry.calories,
    protein: entry.protein,
    carbs: entry.carbs,
    fat: entry.fat,
    sat_fat: entry.sat_fat ?? 0, // ← WAS MISSING. Silently zeroed every copy.
    salt: entry.salt ?? 0,
    fibre: entry.fibre ?? 0,
    sugar: entry.sugar ?? 0,

    // Provenance. Also missing before — copied entries knew nothing about
    // where they came from.
    source: "copied",
    barcode: entry.barcode ?? null,
    off_id: entry.off_id ?? null,

    // See the comment above for why image_path and custom_food_id are absent
    // rather than forgotten.
    image_url: entry.image_url ?? null,
  }));

  const { error } = await supabase.from("meal_entries").insert(rows);
  if (error) {
    console.warn("copyEntriesToMyLog:", error.message);
    throw error;
  }
}

// ─── Utility: today's calorie total for a user ───────────────

export async function getTodayCaloriesForUser(userId: string): Promise<number> {
  const { data, error } = await supabase
    .from("meal_entries")
    .select("calories")
    .eq("user_id", userId)
    .eq("date", todayKey());

  if (error || !data) return 0;
  return data.reduce((sum, r) => sum + (r.calories ?? 0), 0);
}
