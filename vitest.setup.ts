import { vi } from "vitest";

// __DEV__ is a React Native / Metro global, never defined under plain
// Node/Vite. Every existing __DEV__ reference in this codebase (App.tsx,
// SettingsScreen.tsx, instrument.ts) lives in a file no test actually
// executes, so the missing global was latent, not caught. Set to true
// (not merely defined) so any __DEV__-gated logging is actually exercised
// by tests that reach it — the alternative (false) would skip evaluating
// the logged expression entirely, which is exactly the kind of "looks
// covered, isn't" gap this repo has been bitten by with Health Connect.
(globalThis as { __DEV__?: boolean }).__DEV__ = true;

// The real client (src/lib/supabase.ts) calls createClient() at import time
// using EXPO_PUBLIC_SUPABASE_URL / _KEY, which aren't set in the test
// environment. Every logic module under test (entries.ts, useStore.ts,
// foodLookup.ts, bundles.ts, social.ts, labelExtraction.ts,
// mealRecognition.ts) imports it transitively, so it's mocked once, here,
// rather than per test file. Tests reconfigure the individual jest.fn()s
// (supabase.auth.getUser, supabase.from, supabase.functions.invoke, ...) as
// needed.
vi.mock("./src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: "test-user-id" } } })),
    },
    from: vi.fn(),
    rpc: vi.fn(async () => ({ data: null, error: null })),
    functions: {
      invoke: vi.fn(async () => ({ data: null, error: null })),
    },
  },
}));

// @sentry/react-native transitively imports the real react-native package,
// whose index.js is Flow syntax — Vite's transform can't parse it, so any
// test that imports reportError.ts (which imports @sentry/react-native)
// would fail at transform time, not just fail an assertion, without this.
vi.mock("@sentry/react-native", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  init: vi.fn(),
  wrap: (c: unknown) => c,
}));

// Same problem as @sentry/react-native above, via a different path:
// src/lib/whoop.ts uses expo-linking / expo-web-browser for the OAuth
// handoff, and both transitively pull in real react-native. Any test that
// imports whoop.ts (even just for a pure helper like classifySyncStatus)
// needs these stubbed before import or it fails at transform time.
vi.mock("expo-linking", () => ({
  parse: vi.fn(() => ({ queryParams: {} })),
}));
vi.mock("expo-web-browser", () => ({
  openAuthSessionAsync: vi.fn(async () => ({ type: "cancel" })),
}));
