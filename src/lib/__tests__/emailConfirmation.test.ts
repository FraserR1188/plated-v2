import { describe, it, expect } from "vitest";
import { parseConfirmLink } from "../emailConfirmation";

describe("parseConfirmLink", () => {
  it("ignores a URL that isn't the confirm-email deep link", () => {
    expect(
      parseConfirmLink("plated://whoop-callback?code=abc&state=xyz"),
    ).toEqual({ kind: "not_a_confirm_link" });
  });

  it("extracts access_token/refresh_token from the fragment on a valid confirm link", () => {
    const result = parseConfirmLink(
      "plated://confirm-email#access_token=AT123&refresh_token=RT456&type=signup",
    );
    expect(result).toEqual({
      kind: "tokens",
      access_token: "AT123",
      refresh_token: "RT456",
    });
  });

  it("does NOT read tokens out of the query string — only the fragment", () => {
    const result = parseConfirmLink(
      "plated://confirm-email?access_token=AT123&refresh_token=RT456&type=signup",
    );
    expect(result).toEqual({ kind: "dead", reason: "invalid" });
  });

  it("treats an expired-otp error fragment as reason 'expired'", () => {
    const result = parseConfirmLink(
      "plated://confirm-email#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    );
    expect(result).toEqual({ kind: "dead", reason: "expired" });
  });

  it("treats any other error fragment as reason 'invalid'", () => {
    const result = parseConfirmLink(
      "plated://confirm-email#error=access_denied&error_code=something_else",
    );
    expect(result).toEqual({ kind: "dead", reason: "invalid" });
  });

  it("treats a confirm link missing a token as 'invalid' rather than throwing", () => {
    const result = parseConfirmLink(
      "plated://confirm-email#access_token=AT123&type=signup",
    );
    expect(result).toEqual({ kind: "dead", reason: "invalid" });
  });

  it("treats a non-signup type as 'invalid' even with both tokens present", () => {
    const result = parseConfirmLink(
      "plated://confirm-email#access_token=AT123&refresh_token=RT456&type=recovery",
    );
    expect(result).toEqual({ kind: "dead", reason: "invalid" });
  });

  it("treats a bare host with no fragment at all as 'invalid'", () => {
    expect(parseConfirmLink("plated://confirm-email")).toEqual({
      kind: "dead",
      reason: "invalid",
    });
  });
});
