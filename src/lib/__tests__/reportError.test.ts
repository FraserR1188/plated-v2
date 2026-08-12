import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Sentry from "@sentry/react-native";
import { reportError } from "../reportError";

const UUID = "9f1c2e3a-4b5d-4c6e-8f7a-1b2c3d4e5f60";

describe("reportError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures once, with level defaulting to warning and fingerprint defaulting to [operation]", () => {
    reportError("updateEntry", new Error("boom"));

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [, ctx] = vi.mocked(Sentry.captureException).mock.calls[0] as [
      unknown,
      { level?: string; tags?: Record<string, unknown>; fingerprint?: string[]; extra?: Record<string, unknown> },
    ];
    expect(ctx?.level).toBe("warning");
    expect(ctx?.tags).toMatchObject({ operation: "updateEntry" });
    expect(ctx?.fingerprint).toEqual(["updateEntry"]);
  });

  it("the captured error's message carries no details/hint/uuid from the input", () => {
    const pgError = {
      code: "23505",
      message: "duplicate key value violates unique constraint",
      details: `Key (user_id)=(${UUID}) already exists.`,
      hint: `See row ${UUID}.`,
    };

    reportError("saveIngredient", pgError);

    const [captured] = vi.mocked(Sentry.captureException).mock.calls[0];
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).not.toContain(UUID);
    expect((captured as Error).message).not.toContain("Key (user_id)");
    expect((captured as Error).message).not.toContain("See row");
    expect((captured as Error).message).toBe("23505");
  });

  it("an explicit fingerprint/level in opts overrides the defaults", () => {
    reportError("lookupStapleFromDb", new Error("not found"), {
      level: "error",
      fingerprint: ["lookupStapleFromDb"],
      extra: { table: "core_ingredients" },
    });

    const [, ctx] = vi.mocked(Sentry.captureException).mock.calls[0] as [
      unknown,
      { level?: string; tags?: Record<string, unknown>; fingerprint?: string[]; extra?: Record<string, unknown> },
    ];
    expect(ctx?.level).toBe("error");
    expect(ctx?.fingerprint).toEqual(["lookupStapleFromDb"]);
    expect(ctx?.extra).toEqual({ table: "core_ingredients" });
  });
});
