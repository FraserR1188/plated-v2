import { describe, it, expect, beforeAll } from "vitest";

// supabase/functions/_shared/whoop.ts is written for the Deno runtime and
// reads Deno.env.get(...) at module load (API host override, in
// whoopCredentials()). Vitest runs under Node, and ES imports are hoisted
// ahead of any top-level statement in this file, so `Deno` has to exist
// before the module is even imported — hence the dynamic import in
// beforeAll rather than a static `import` at the top.
let isFatalTokenFailure: (status: number, body: string) => boolean;

beforeAll(async () => {
  (globalThis as unknown as { Deno: { env: { get: () => undefined } } }).Deno = {
    env: { get: () => undefined },
  };
  ({ isFatalTokenFailure } = await import("../whoop.ts"));
});

describe("isFatalTokenFailure", () => {
  it("400 invalid_grant is fatal", () => {
    expect(isFatalTokenFailure(400, JSON.stringify({ error: "invalid_grant" }))).toBe(
      true,
    );
  });

  it("403 invalid_grant is fatal (WHOOP doesn't always use 400 for a dead credential)", () => {
    expect(isFatalTokenFailure(403, JSON.stringify({ error: "invalid_grant" }))).toBe(
      true,
    );
  });

  it("401 is unconditionally fatal regardless of body", () => {
    expect(isFatalTokenFailure(401, "")).toBe(true);
    expect(isFatalTokenFailure(401, JSON.stringify({ error: "temporarily_unavailable" }))).toBe(
      true,
    );
  });

  it("400 temporarily_unavailable is not fatal", () => {
    expect(
      isFatalTokenFailure(400, JSON.stringify({ error: "temporarily_unavailable" })),
    ).toBe(false);
  });

  it.each([429, 500, 503])("%d is not fatal", (status) => {
    expect(isFatalTokenFailure(status, JSON.stringify({ error: "invalid_grant" }))).toBe(
      false,
    );
  });

  it("malformed non-JSON body falls back to a substring check", () => {
    expect(isFatalTokenFailure(400, "not json at all: invalid_grant happened")).toBe(
      true,
    );
  });

  it("chosen behaviour: invalid_grant appearing outside the error field does not count", () => {
    // The structured `error` field says this is transient
    // (temporarily_unavailable). "invalid_grant" only shows up in a
    // description string, which is exactly the case the structured check
    // exists to ignore — a WHOOP support message that happens to mention
    // invalid_grant must not trip a revoke on its own.
    const body = JSON.stringify({
      error: "temporarily_unavailable",
      error_description: "see invalid_grant docs for details",
    });
    expect(isFatalTokenFailure(400, body)).toBe(false);
  });

  it("invalid_client is fatal on both 400 and 403", () => {
    const body = JSON.stringify({ error: "invalid_client" });
    expect(isFatalTokenFailure(400, body)).toBe(true);
    expect(isFatalTokenFailure(403, body)).toBe(true);
  });

  it("403 with an unrecognised structured error is not fatal", () => {
    expect(isFatalTokenFailure(403, JSON.stringify({ error: "access_denied" }))).toBe(
      false,
    );
  });
});
