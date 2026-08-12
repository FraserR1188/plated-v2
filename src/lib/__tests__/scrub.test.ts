import { describe, it, expect } from "vitest";
import { scrubString, scrubUrl, scrubErrorForReport } from "../scrub";

const UUID = "9f1c2e3a-4b5d-4c6e-8f7a-1b2c3d4e5f60";

describe("scrubString", () => {
  it("redacts a UUID inside a longer string", () => {
    const out = scrubString(`Key (user_id)=(${UUID}) already exists.`);
    expect(out).not.toContain(UUID);
    expect(out).toContain("<redacted>");
  });
});

describe("scrubUrl", () => {
  it("drops the query string and redacts a UUID left in the path", () => {
    const out = scrubUrl(
      `https://x.supabase.co/rest/v1/meal_entries/${UUID}?user_id=eq.${UUID}&select=*`,
    );
    expect(out).not.toContain("?");
    expect(out).not.toContain(UUID);
    expect(out).toContain("<redacted>");
  });
});

describe("scrubErrorForReport", () => {
  it("on a PostgrestError-shaped object, forwards only code — never message/details/hint", () => {
    const pgError = {
      code: "23505",
      message: `duplicate key value violates unique constraint "custom_foods_barcode_key"`,
      details: `Key (user_id, barcode)=(${UUID}, 5012345678900) already exists.`,
      hint: `Consider using barcode ${UUID} on the existing row.`,
    };

    const safe = scrubErrorForReport(pgError);

    expect(safe.code).toBe("23505");
    expect(safe).not.toHaveProperty("details");
    expect(safe).not.toHaveProperty("hint");
    expect(safe.message).not.toContain(UUID);
    expect(safe.message).not.toContain("custom_foods_barcode_key");
    expect(safe.message).not.toContain("Consider using barcode");
  });

  it("on a thrown Error whose .message embeds a uuid, never forwards the message text", () => {
    const err = new Error(`Not authenticated for user ${UUID}`);
    const safe = scrubErrorForReport(err);

    expect(safe.message).not.toContain(UUID);
    expect(safe.name).toBe("Error");
  });

  it("on a plain string containing a uuid, redacts it", () => {
    const safe = scrubErrorForReport(`failed for ${UUID}`);
    expect(safe.message).not.toContain(UUID);
    expect(safe.message).toContain("<redacted>");
  });

  it("on something with no usable shape, falls back to a fixed message", () => {
    expect(scrubErrorForReport(null).message).toBe("unknown_error");
    expect(scrubErrorForReport(undefined).message).toBe("unknown_error");
    expect(scrubErrorForReport(42).message).toBe("unknown_error");
  });
});
