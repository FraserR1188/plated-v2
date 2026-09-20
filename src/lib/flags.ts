// ============================================================
// src/lib/flags.ts — build-time feature flags.
//
// Lives here rather than in a component so more than one surface can read
// the same switch: SOCIAL_ENABLED started life inside TabBar.tsx, which
// was fine while it hid a tab, and stopped being fine the moment Settings
// needed to hide a row on the same condition.
// ============================================================

/**
 * The accept gate is live: migration 20260819110000_friendship_accept_gate.sql
 * converted follows into a mutual friendship (pending/accepted), and
 * meal_entries_select_follower now requires status = 'accepted' in both
 * directions — verified a pending row grants 0 cross-user meal_entries rows.
 * The client (social.ts, FriendsScreen) is written against that policy set.
 *
 * Flip back to false, rather than deleting this flag, if a regression needs
 * the feature hidden again without a redeploy. What that hides is now the
 * Friends ROW IN SETTINGS (and its badge), not a tab — so the tab bar keeps
 * five tabs either way and Insights stays centred.
 */
export const SOCIAL_ENABLED = true;
