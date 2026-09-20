// ============================================================
// src/lib/copyDestination.ts — where a friend-copy ends up.
//
// Friends used to be a tab, so CopyConfirm's popToTop() landed on
// whichever tab was active — the Friends tab. Friends is now pushed from
// Settings, so the same call would land on SETTINGS, which is nonsense
// after copying food into your own log.
//
// It goes to Today, on the day the copy landed: the same "show, don't
// tell" move TodayScreen's own copy flows make (setViewedDate(dayKey),
// see TodayScreen's onCopySharedTarget), and what CopyConfirm's comment
// claimed it did long before it did.
//
// ── WHY popTo, NOT navigate ─────────────────────────────────────────────
//
// React Navigation 7 changed navigate: it only reuses an existing route
// when that route is already focused (or when the action carries
// pop: true, which is what popTo sets) — confirmed in the installed
// source, @react-navigation/routers 7.5.5, StackRouter's NAVIGATE case.
// From CopyConfirm, three screens deep, navigate("MainTabs") would PUSH A
// SECOND MainTabs on top of Friends → ConnectedUserLog → CopyConfirm,
// leaving the whole copy flow underneath it: back from Today would walk
// straight into CopyConfirm again. popTo unwinds to the MainTabs already
// at the bottom, leaving exactly one route.
//
// The nested { screen: "Today" } reaches the tab navigator because POP_TO
// writes a FRESH params object onto the route, and useNavigationBuilder
// treats params it has not already consumed as an instruction to navigate
// the child (core 7.17.5, useNavigationBuilder.js:169 and :353).
//
// Both halves are pinned in copyDestination.test.ts against the real
// routers, including the navigate-instead-of-popTo variant.
// ============================================================

/**
 * The slice of a stack navigation object this needs. Narrow on purpose:
 * it keeps the rule testable without a navigator, and makes the one call
 * this module is allowed to make obvious.
 */
export type CopyDestinationNav = {
  // Method syntax, not a function property: the real navigation object's
  // popTo is generic over every route name, and only a method's
  // bivariant parameter check lets it satisfy this one-route narrowing.
  popTo(name: "MainTabs", params: { screen: "Today" }): void;
};

/**
 * Call after the copy has actually been written — never on failure.
 *
 * Order matters: the store is set FIRST, so TodayScreen (already mounted,
 * subscribed to viewedDate) has re-rendered onto the target day before the
 * tab is even shown. Same reasoning as HistoryScreen's day tap.
 */
export function goToCopiedDay(
  navigation: CopyDestinationNav,
  setViewedDate: (dayKey: string) => void,
  dayKey: string,
): void {
  setViewedDate(dayKey);
  navigation.popTo("MainTabs", { screen: "Today" });
}
