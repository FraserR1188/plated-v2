// ============================================================
// src/lib/energy.ts — kJ → kcal, in exactly one place
//
// WHOOP's workout/cycle energy is score.kilojoule; there is no kcal field
// on the wire, and the data model stores kJ end to end (whoop_workouts.kilojoule
// -> biometric_workouts.energy_kilojoule -> Workout.energyKilojoule). kcal is a
// render-time concern only — this is the single conversion point, mirroring
// extract-nutrition-label's KCAL_PER_KJ precedent.
// ============================================================

const KCAL_PER_KJ = 1 / 4.184;

/** NULL-faithful: a workout with no score has no kilojoule, and that must
 *  stay absent rather than becoming a fake 0 kcal. */
export function kjToKcal(kj: number | null): number | null {
  if (kj === null) return null;
  return Math.round(kj * KCAL_PER_KJ);
}
