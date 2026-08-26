import { describe, it, expect } from "vitest";
import { parseAuthFragment } from "../authLinks";

const PREFIX = "plated://test-link";

describe("parseAuthFragment", () => {
  it("extracts access_token/refresh_token/type from a valid fragment", () => {
    const result = parseAuthFragment(
      `${PREFIX}#access_token=AT123&refresh_token=RT456&type=recovery`,
      PREFIX,
    );
    expect(result).toEqual({
      kind: "tokens",
      access_token: "AT123",
      refresh_token: "RT456",
      type: "recovery",
    });
  });

  it("treats a fragment missing refresh_token as dead/invalid", () => {
    const result = parseAuthFragment(
      `${PREFIX}#access_token=AT123&type=recovery`,
      PREFIX,
    );
    expect(result).toEqual({ kind: "dead", reason: "invalid" });
  });

  it("treats error_code=otp_expired as dead/expired", () => {
    const result = parseAuthFragment(
      `${PREFIX}#error=access_denied&error_code=otp_expired`,
      PREFIX,
    );
    expect(result).toEqual({ kind: "dead", reason: "expired" });
  });

  it("returns no_match when the URL doesn't start with the given prefix", () => {
    const result = parseAuthFragment(
      "plated://something-else#access_token=AT123&refresh_token=RT456",
      PREFIX,
    );
    expect(result).toEqual({ kind: "no_match" });
  });

  it("treats a bare prefix with no fragment at all as dead/invalid", () => {
    const result = parseAuthFragment(PREFIX, PREFIX);
    expect(result).toEqual({ kind: "dead", reason: "invalid" });
  });

  it("reads tokens from the fragment even when a query string is also present", () => {
    const result = parseAuthFragment(
      `${PREFIX}?foo=bar#access_token=AT123&refresh_token=RT456&type=recovery`,
      PREFIX,
    );
    expect(result).toEqual({
      kind: "tokens",
      access_token: "AT123",
      refresh_token: "RT456",
      type: "recovery",
    });
  });
});
