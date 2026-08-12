import { describe, it, expect } from "vitest";
import { kjToKcal } from "../energy";

describe("kjToKcal", () => {
  it("converts a known kJ value to the expected rounded kcal", () => {
    expect(kjToKcal(1569.34)).toBe(375);
  });

  it("preserves null (unscored workout) rather than coercing to 0", () => {
    expect(kjToKcal(null)).toBeNull();
  });

  it("converts 0 kJ to 0 kcal, distinct from null", () => {
    expect(kjToKcal(0)).toBe(0);
  });

  it("rounds a .5-boundary kcal value consistently with Math.round", () => {
    // 2.092 kJ / 4.184 = 0.5 kcal exactly — Math.round rounds half-up.
    expect(kjToKcal(2.092)).toBe(1);
  });
});
