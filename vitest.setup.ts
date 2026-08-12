import { vi } from "vitest";

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
