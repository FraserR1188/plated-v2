// ============================================================
// Where a friend-copy ends up.
//
// Two separate things are pinned here, because they fail differently:
//
//   1. What our code does — setViewedDate first, then one popTo.
//   2. What React Navigation 7 DOES with that call, exercised against the
//      real StackRouter/TabRouter rather than a mock. v7 changed navigate
//      so it no longer unwinds to an existing route (popTo took that job),
//      and this flow sits three screens deep — so the difference between
//      the two calls is the difference between "one route left" and "a
//      second MainTabs pushed on top of the copy flow".
//
// @react-navigation/routers is pure JS with no React Native imports, so
// the real routers run under Vitest as-is. It arrives as a dependency of
// @react-navigation/core rather than a direct one — worth knowing if this
// import ever breaks.
// ============================================================

import { describe, it, expect, vi } from "vitest";
import {
  StackRouter,
  StackActions,
  TabRouter,
  CommonActions,
  type StackNavigationState,
  type ParamListBase,
} from "@react-navigation/routers";
import { goToCopiedDay } from "../copyDestination";

// ─── 1. What our code does ───────────────────────────────────

describe("goToCopiedDay", () => {
  it("sets the viewed date before navigating, so Today is already on the right day", () => {
    const order: string[] = [];
    const setViewedDate = vi.fn(() => void order.push("setViewedDate"));
    const popTo = vi.fn(() => void order.push("popTo"));

    goToCopiedDay({ popTo }, setViewedDate, "2026-09-14");

    expect(setViewedDate).toHaveBeenCalledWith("2026-09-14");
    expect(popTo).toHaveBeenCalledWith("MainTabs", { screen: "Today" });
    expect(order).toEqual(["setViewedDate", "popTo"]);
  });
});

// ─── 2. What React Navigation does with it ───────────────────

const ROOT_ROUTES = [
  "MainTabs",
  "Friends",
  "ConnectedUserLog",
  "CopyConfirm",
] as const;

/** The stack as it stands when Confirm is tapped: Settings → Friends → log → copy. */
function copyFlowState(): StackNavigationState<ParamListBase> {
  const router = StackRouter({});
  let state = router.getInitialState({
    routeNames: [...ROOT_ROUTES],
    routeParamList: {},
    routeGetIdList: {},
  });
  for (const name of ["Friends", "ConnectedUserLog", "CopyConfirm"]) {
    state = router.getStateForAction(
      state,
      CommonActions.navigate({ name }),
      { routeNames: [...ROOT_ROUTES], routeParamList: {}, routeGetIdList: {} },
    ) as StackNavigationState<ParamListBase>;
  }
  return state;
}

const applyRoot = (
  state: StackNavigationState<ParamListBase>,
  action: Parameters<ReturnType<typeof StackRouter>["getStateForAction"]>[1],
) =>
  StackRouter({}).getStateForAction(state, action, {
    routeNames: [...ROOT_ROUTES],
    routeParamList: {},
    routeGetIdList: {},
  }) as StackNavigationState<ParamListBase>;

describe("the stack after a successful copy", () => {
  it("starts four deep", () => {
    expect(copyFlowState().routes.map((r) => r.name)).toEqual([...ROOT_ROUTES]);
  });

  it("popTo leaves exactly one route, MainTabs, asking for the Today tab", () => {
    const after = applyRoot(
      copyFlowState(),
      StackActions.popTo("MainTabs", { screen: "Today" }),
    );

    expect(after.routes).toHaveLength(1);
    expect(after.routes[0].name).toBe("MainTabs");
    expect(after.index).toBe(0);
    // Fresh params object, which is what makes the tab navigator treat the
    // nested params as unconsumed and actually jump (useNavigationBuilder).
    expect(after.routes[0].params).toEqual({ screen: "Today" });
  });

  // The reason popTo is used instead. Under v7 semantics navigate only
  // reuses a route that is already focused, so from CopyConfirm it pushes
  // a SECOND MainTabs and leaves the whole copy flow underneath it —
  // back from Today would walk into CopyConfirm again.
  it("navigate would push a second MainTabs instead of unwinding", () => {
    const after = applyRoot(
      copyFlowState(),
      CommonActions.navigate({ name: "MainTabs", params: { screen: "Today" } }),
    );

    expect(after.routes.map((r) => r.name)).toEqual([
      ...ROOT_ROUTES,
      "MainTabs",
    ]);
    expect(after.routes).toHaveLength(5);
  });
});

// ─── 3. The nested hop, at the tab router ────────────────────

describe("the tab the copy lands on", () => {
  const TABS = ["Today", "History", "Insights", "Batches", "Settings"];

  it("switches from Settings to Today", () => {
    const router = TabRouter({});
    const options = {
      routeNames: TABS,
      routeParamList: {},
      routeGetIdList: {},
    };

    // getStateForAction's return widens to include PartialState; these
    // actions always produce a full state, hence the casts.
    let state = router.getInitialState(options);
    state = router.getStateForAction(
      state,
      CommonActions.navigate({ name: "Settings" }),
      options,
    ) as typeof state;
    expect(state.routes[state.index].name).toBe("Settings");

    // What useNavigationBuilder dispatches for it once it sees the
    // unconsumed { screen: "Today" } params on the MainTabs route.
    state = router.getStateForAction(
      state,
      CommonActions.navigate({ name: "Today" }),
      options,
    ) as typeof state;
    expect(state.routes[state.index].name).toBe("Today");
  });
});
