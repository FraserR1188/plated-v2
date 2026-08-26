import { describe, it, expect } from "vitest";
import { parseRecoveryLink } from "../passwordReset";

describe("parseRecoveryLink", () => {
  it("ignores a URL that isn't the reset-password deep link", () => {
    expect(parseRecoveryLink("plated://whoop-callback?code=abc&state=xyz")).toEqual({
      kind: "not_a_recovery_link",
    });
  });

  it("extracts access_token/refresh_token from the fragment on a valid recovery link", () => {
    const result = parseRecoveryLink(
      "plated://reset-password#access_token=AT123&refresh_token=RT456&type=recovery",
    );
    expect(result).toEqual({
      kind: "tokens",
      access_token: "AT123",
      refresh_token: "RT456",
    });
  });

  it("does NOT read tokens out of the query string — only the fragment", () => {
    const result = parseRecoveryLink(
      "plated://reset-password?access_token=AT123&refresh_token=RT456&type=recovery",
    );
    expect(result).toEqual({ kind: "dead", reason: "invalid" });
  });

  it("treats an expired-otp error fragment as reason 'expired'", () => {
    const result = parseRecoveryLink(
      "plated://reset-password#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    );
    expect(result).toEqual({ kind: "dead", reason: "expired" });
  });

  it("treats any other error fragment as reason 'invalid'", () => {
    const result = parseRecoveryLink(
      "plated://reset-password#error=access_denied&error_code=something_else",
    );
    expect(result).toEqual({ kind: "dead", reason: "invalid" });
  });

  it("treats a recovery link missing a token as 'invalid' rather than throwing", () => {
    const result = parseRecoveryLink(
      "plated://reset-password#access_token=AT123&type=recovery",
    );
    expect(result).toEqual({ kind: "dead", reason: "invalid" });
  });

  it("treats a non-recovery type as 'invalid' even with both tokens present", () => {
    const result = parseRecoveryLink(
      "plated://reset-password#access_token=AT123&refresh_token=RT456&type=signup",
    );
    expect(result).toEqual({ kind: "dead", reason: "invalid" });
  });

  it("treats a bare host with no fragment at all as 'invalid'", () => {
    expect(parseRecoveryLink("plated://reset-password")).toEqual({
      kind: "dead",
      reason: "invalid",
    });
  });
});
