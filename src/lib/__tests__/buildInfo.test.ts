// ============================================================
// src/lib/__tests__/buildInfo.test.ts — PL-043
//
// About must let a tester say exactly what they're running. The formatter is
// pure, so these run without expo-updates' native module.
// ============================================================

import { describe, it, expect } from "vitest";
import { formatBuildInfo, type BuildInfoInput } from "../buildInfo";

const RUNTIME = "c1907ba4619df4d22e128f15df609529906eae2a";
const UPDATE_ID = "dd7aa75a-a6b8-408d-bb14-39f7197c21e2";

const ota: BuildInfoInput = {
  runtimeVersion: RUNTIME,
  channel: "production",
  updateId: UPDATE_ID,
  isEmbeddedLaunch: false,
};

const text = (i: BuildInfoInput) => formatBuildInfo(i).lines.join("\n");

describe("formatBuildInfo — PL-043", () => {
  it("a real update id renders as its first 8 characters", () => {
    const shown = text(ota);
    expect(shown).toContain("dd7aa75a");
    expect(shown).not.toContain(UPDATE_ID);
  });

  it('a null update id (the dev client) renders as "embedded"', () => {
    const shown = text({ ...ota, updateId: null });
    expect(shown).toMatch(/embedded/);
    expect(shown).not.toMatch(/null/);
  });

  it('an embedded launch renders "embedded" even though the bundled JS has an id of its own', () => {
    // In a production build the embedded bundle carries an update id too;
    // showing it would make the binary's own JS look like an OTA.
    const shown = text({ ...ota, isEmbeddedLaunch: true });
    expect(shown).toMatch(/embedded/);
    expect(shown).not.toContain("dd7aa75a");
  });

  it("the runtime version and channel are both shown", () => {
    const shown = text(ota);
    expect(shown).toContain("c1907ba4");
    expect(shown).toContain("production");
  });

  it("missing runtime, channel and build number degrade to something readable — never undefined or null", () => {
    const dev: BuildInfoInput = {
      runtimeVersion: undefined,
      channel: null,
      updateId: null,
      isEmbeddedLaunch: true,
    };
    const shown = text(dev);
    expect(shown).not.toMatch(/undefined|null/);
    expect(shown).toMatch(/unknown/);
  });

  it("a build number is shown only when one is supplied", () => {
    expect(text({ ...ota, buildNumber: "11" })).toContain("11");
    expect(text(ota)).not.toMatch(/Build/);
  });

  it("the copy text carries the full values, and nothing else", () => {
    const { copyText } = formatBuildInfo(ota);
    expect(copyText).toContain(RUNTIME);
    expect(copyText).toContain(UPDATE_ID);
    expect(copyText).toContain("production");
    expect(copyText).not.toMatch(/undefined|null/);
  });
});
