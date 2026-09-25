// ============================================================
// src/lib/__tests__/passwordRules.test.ts — PL-038
//
// Sign-up enforced nothing but "non-empty"; ResetPasswordScreen enforced 6
// characters with its own literal. One rule, one constant, both screens.
// ============================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  MIN_PASSWORD_LENGTH,
  validateSignUpPassword,
} from "../passwordRules";

const ROOT = process.cwd();
const read = (rel: string) =>
  fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

describe("validateSignUpPassword — PL-038", () => {
  it("rejects 5 characters, in the hint's wording", () => {
    const error = validateSignUpPassword("abcde");
    expect(error).not.toBeNull();
    expect(error).toMatch(/at least 6 characters/i);
  });

  it("accepts 6 characters", () => {
    expect(validateSignUpPassword("abcdef")).toBeNull();
  });

  it("rejects a whitespace-only password, however long", () => {
    expect(validateSignUpPassword("        ")).not.toBeNull();
  });

  it("the minimum is 6, matching the Supabase project's minimum_password_length", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(6);
  });
});

describe("both password screens read the same rule — PL-038", () => {
  // The defect was two rules: sign-up enforced nothing, reset enforced its own
  // literal 6. Both must go through passwordRules, and neither may restate it.
  const SCREENS = ["App.tsx", "src/screens/ResetPasswordScreen.tsx"];

  for (const file of SCREENS) {
    it(`${file} uses passwordRules and restates no length of its own`, () => {
      const src = read(file);
      expect(src).toMatch(/from "[./]*(src\/)?lib\/passwordRules"/);
      expect(src).toMatch(/validateSignUpPassword\(/);
      expect(src).not.toMatch(/password\.length\s*[<>]=?\s*\d/);
      expect(src).not.toMatch(/at least \d+ characters/i);
    });
  }
});
