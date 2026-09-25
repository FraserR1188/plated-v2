// ============================================================
// src/lib/passwordRules.ts — the one password rule (PL-038)
//
// RED-COMMIT STUB: reproduces sign-up's CURRENT rule (non-empty only), so the
// tests in __tests__/passwordRules.test.ts fail on behaviour. Nothing imports
// it yet. The next commit replaces the body and wires both screens to it.
// ============================================================

export const MIN_PASSWORD_LENGTH = 6;

/** Returns an error message, or null when the password is acceptable. */
export function validateSignUpPassword(password: string): string | null {
  return password ? null : "Enter a password.";
}
