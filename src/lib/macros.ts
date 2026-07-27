// ============================================================
// src/lib/macros.ts — pure macro-display helpers
//
// Split out of TodayScreen so the rounding logic is unit-testable without
// dragging React Native into the test environment (see roundSalt).
// ============================================================

/** Salt is sub-gram, so Math.round() would collapse it to 0 — and the raw float
 *  sum shows a "0.4660000000000001" tail. Floored to 2dp: trims the noise, keeps
 *  small values visible (0.04 stays 0.04, not "0.0"), and the +1e-9 nudge stops
 *  a value like 0.47 slipping to 0.46 on FP error. Swap Math.floor→Math.round if
 *  you'd rather round to nearest. */
export const roundSalt = (g: number): number => Math.floor(g * 100 + 1e-9) / 100;
