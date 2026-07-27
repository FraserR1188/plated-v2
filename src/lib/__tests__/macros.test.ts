import { describe, it, expect } from "vitest";
import { roundSalt } from "../macros";

describe("roundSalt", () => {
  it("keeps small sub-gram values visible instead of collapsing them to 0", () => {
    // Math.round(0.04 * 100) / 100 would also survive, but Math.round(0.004)
    // would not — floor is the one that never rounds a real trace amount away.
    expect(roundSalt(0.04)).toBe(0.04);
  });

  it("trims floating-point noise from a summed total", () => {
    // 0.1 + 0.1 + 0.27 is 0.47000000000000003 in IEEE754 — without the
    // +1e-9 nudge, floor(46.99999999999999...) would wrongly floor to 0.46.
    const sum = 0.1 + 0.1 + 0.27;
    expect(roundSalt(sum)).toBe(0.47);
  });

  it("does not let the +1e-9 nudge round a genuine .xx6 value up a cent", () => {
    // 0.469 floored to 2dp is 0.46, not 0.47 — the nudge only exists to undo
    // FP noise, not to change which cent a real value floors to.
    expect(roundSalt(0.469)).toBe(0.46);
  });

  it("floors rather than rounds to nearest", () => {
    expect(roundSalt(0.478)).toBe(0.47);
  });

  it("handles zero", () => {
    expect(roundSalt(0)).toBe(0);
  });
});
