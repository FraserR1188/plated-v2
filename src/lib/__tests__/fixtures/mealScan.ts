// Fixtures for src/lib/mealRecognition.ts's response-parsing layer. These
// model what supabase.functions.invoke() hands back for scan-meal-photo —
// NOT the raw Anthropic tool_use payload, which never reaches the client.

import type { MealScanSuccess, MealScanFailure } from "../../mealRecognition";

/** A well-formed, medium-confidence success payload. */
export const VALID_SUCCESS: MealScanSuccess = {
  ok: true,
  dish: {
    name: "Chicken katsu curry with rice",
    alternatives: ["Chicken karaage curry", "Katsu curry with egg fried rice"],
  },
  portion: { grams: 450, description: "1 regular dinner plate, roughly 450g" },
  per100g: {
    cal: 178,
    protein: 8.2,
    carbs: 21.3,
    fat: 6.7,
    satFat: 1.8,
    salt: 0.6,
    fibre: 1.4,
    sugar: 3.1,
  },
  confidence: "medium",
  notes: [
    "AI estimate from a photo — not a measured value. Check the macros before logging.",
  ],
};

/** Same shape, but a hard-to-judge composite plate — confidence "low" and
 *  the extra low-confidence note the server always attaches in that case. */
export const LOW_CONFIDENCE_SUCCESS: MealScanSuccess = {
  ok: true,
  dish: {
    name: "Mixed buffet plate",
    alternatives: [],
  },
  portion: { grams: 380, description: "1 small plate, roughly 380g" },
  per100g: {
    cal: 145,
    protein: 6.1,
    carbs: 15.8,
    fat: 6.9,
    satFat: 2.2,
    salt: 0.5,
    fibre: 2.0,
    sugar: 2.4,
  },
  confidence: "low",
  notes: [
    "AI estimate from a photo — not a measured value. Check the macros before logging.",
    "Low confidence: this dish or portion was hard to judge from the photo.",
  ],
};

/** A clean { ok: false, error, message } failure envelope — what the Edge
 *  Function sends for a rejected request (rate limit, no food found, ...). */
export const NO_FOOD_FAILURE: MealScanFailure = {
  ok: false,
  error: "no_food",
  message:
    "I couldn't identify any food in that photo. Try again with the plate filling the frame, or add it by hand.",
};

/** Contract drift: `ok: true` but per100g is missing macro keys — as if a
 *  future server change forgot one. Must NOT be trusted as-is. */
export const MALFORMED_SUCCESS_SHAPE = {
  ok: true,
  dish: { name: "Soup", alternatives: [] },
  portion: { grams: 300, description: "1 bowl, roughly 300g" },
  per100g: { cal: 60, protein: 2 }, // missing carbs/fat/satFat/salt/fibre/sugar
  confidence: "medium",
  notes: [],
};

/** A response with no recognisable shape at all — e.g. a proxy error page,
 *  or a totally different JSON contract. */
export const GARBAGE_PAYLOAD = { unexpected: "shape" };
