// ============================================================
// src/lib/passwordRules.ts — the one password rule (PL-038)
//
// Sign-up used to check only that a password was non-empty, leaving the
// minimum to the server's error text; ResetPasswordScreen checked 6 with its
// own literal. Two rules for one thing. Both screens now call this.
//
// MIN_PASSWORD_LENGTH mirrors the Supabase project's minimum_password_length
// (6, the default; supabase/config.toml has the same for the local stack).
// The server stays the authority — this only lets the form say so first.
// If the dashboard setting ever changes, change this with it.
// ============================================================

export const MIN_PASSWORD_LENGTH = 6;

/** The inline hint under a new-password field. */
export const PASSWORD_HINT = `At least ${MIN_PASSWORD_LENGTH} characters`;

/**
 * Returns an error message, or null when the password is acceptable. Used by
 * sign-up and by the reset screen: any password the user is choosing.
 */
export function validateSignUpPassword(password: string): string | null {
  if (password.trim().length === 0) {
    return "Enter a password — spaces alone don't count.";
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}
