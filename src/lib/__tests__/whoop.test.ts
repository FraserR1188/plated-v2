import { describe, it, expect } from "vitest";
import { classifySyncStatus } from "../whoop";

describe("classifySyncStatus", () => {
  it("null is healthy", () => {
    expect(classifySyncStatus(null)).toBe("healthy");
  });

  it('"partial" is partial, not failing', () => {
    expect(classifySyncStatus("partial")).toBe("partial");
  });

  it('"token_revoked" is failing', () => {
    expect(classifySyncStatus("token_revoked")).toBe("failing");
  });

  it("an unrecognised code is failing, not healthy", () => {
    expect(classifySyncStatus("workouts:transient")).toBe("failing");
  });

  it("empty string is failing, not healthy", () => {
    // A naive truthiness check (`!!lastSyncError`) reads "" as healthy.
    // classifySyncStatus only special-cases null and "partial", so an
    // empty string falls through to failing along with everything else
    // unrecognised.
    expect(classifySyncStatus("")).toBe("failing");
  });
});
