import { describe, it, expect } from "vitest";
import { getProviderLabel, getActivityLabel } from "../workoutLabels";

describe("getProviderLabel", () => {
  it("maps a direct WHOOP row to a plain label", () => {
    expect(getProviderLabel("whoop.direct", "whoop")).toBe("WHOOP");
  });

  it("keeps a Health-Connect-routed WHOOP row distinguishable from the direct row", () => {
    const direct = getProviderLabel("whoop.direct", "whoop");
    const viaHealthConnect = getProviderLabel("com.whoop.android", "health_connect");
    expect(viaHealthConnect).not.toBe(direct);
    expect(viaHealthConnect).toMatch(/WHOOP/);
    expect(viaHealthConnect).toMatch(/Health Connect/);
  });

  it("maps every known vendor package to a readable name", () => {
    expect(getProviderLabel("com.garmin.android.apps.connectmobile", "health_connect")).toBe("Garmin");
    expect(getProviderLabel("com.fitbit.FitbitMobile", "health_connect")).toBe("Fitbit");
    expect(getProviderLabel("com.sec.android.app.shealth", "health_connect")).toBe("Samsung Health");
    expect(getProviderLabel("com.ouraring.oura", "health_connect")).toBe("Oura");
    expect(getProviderLabel("com.alltrails.alltrails", "health_connect")).toBe("AllTrails");
    expect(getProviderLabel("com.google.android.apps.fitness", "health_connect")).toBe("Google Fit");
  });

  it("does not derive a name from the package string — a lowercase variant of a mixed-case package falls to the fallback, not a mangled guess", () => {
    // com.fitbit.FitbitMobile is the real, case-sensitive package. A
    // differently-cased lookup must not silently match it.
    expect(getProviderLabel("com.fitbit.fitbitmobile", "health_connect")).not.toBe("Fitbit");
  });

  // ── Fallback paths — the ones sabotage actually needs to catch ──────

  it("falls back to 'Health Connect' for an unrecognised Health-Connect-routed package, not a derived or generic placeholder", () => {
    const result = getProviderLabel("com.some.new.vendor", "health_connect");
    expect(result).toBe("Health Connect");
    // Specifically not the "last dotted segment" derivation the task
    // warned against (e.g. "Vendor" from com.some.new.vendor).
    expect(result).not.toBe("Vendor");
    expect(result).not.toMatch(/vendor/i);
  });

  it("falls back to 'Connected' for an unrecognised package on a non-Health-Connect transport", () => {
    expect(getProviderLabel("some.unknown.direct", "some_future_transport")).toBe("Connected");
  });
});

describe("getActivityLabel", () => {
  it("falls back to 'Workout' when sportName is null, regardless of transport", () => {
    expect(getActivityLabel(null, "whoop")).toBe("Workout");
    expect(getActivityLabel(null, "health_connect")).toBe("Workout");
  });

  it("applies the WHOOP override for the one confirmed opaque value", () => {
    expect(getActivityLabel("weightlifting_msk", "whoop")).toBe("Weightlifting");
  });

  it("renders a WHOOP value with no override via the mechanical fallback", () => {
    expect(getActivityLabel("running", "whoop")).toBe("Running");
  });

  it("renders known Health Connect ExerciseType names as readable text", () => {
    expect(getActivityLabel("WALKING", "health_connect")).toBe("Walking");
    expect(getActivityLabel("STAIR_CLIMBING_MACHINE", "health_connect")).toBe(
      "Stair Climbing Machine",
    );
    expect(getActivityLabel("OTHER_WORKOUT", "health_connect")).toBe("Other Workout");
  });

  it("does not cross-apply the WHOOP override when the same string arrives under a different transport — the override is scoped by vocabulary, not by value", () => {
    // Same raw string, but if it ever arrived tagged as health_connect it
    // must NOT get WHOOP's special-cased "Weightlifting" — vocabularies
    // are not interchangeable, per the task's own hard requirement.
    expect(getActivityLabel("weightlifting_msk", "health_connect")).toBe(
      "Weightlifting Msk",
    );
  });

  // ── Fallback paths — an unrecognised value for EACH vocabulary ──────

  it("degrades an unrecognised WHOOP value to readable text, never a placeholder that hides it", () => {
    const result = getActivityLabel("some_future_sport_msk", "whoop");
    expect(result).toBe("Some Future Sport Msk");
    expect(result).not.toBe("Workout");
    expect(result).not.toMatch(/unknown/i);
  });

  it("degrades an unrecognised Health Connect value to readable text, never a placeholder that hides it", () => {
    // Not in EXERCISE_TYPE_NAMES today (hypothetical future addition to
    // the library) — must still read as real text, not disappear.
    const result = getActivityLabel("ROCK_CLIMBING_INDOOR", "health_connect");
    expect(result).toBe("Rock Climbing Indoor");
    expect(result).not.toBe("Workout");
    expect(result).not.toMatch(/unknown/i);
  });
});
