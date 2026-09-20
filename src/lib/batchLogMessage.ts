// ============================================================
// src/lib/batchLogMessage.ts — what the batch eat-time sheet says it did.
//
// PL-020: the sheet lets you pick any day, but the alert branched on
// willBePlanned() alone, so every non-future pick fell through to "added
// to today's log" — including yesterday, or last Tuesday. The day has to
// come from the picked instant, via dateKey()'s LOCAL day, never from
// "not in the future, therefore today".
//
// Pure and separate from the screen so the wording is testable without a
// React Native runtime; BatchesScreen just renders what this returns.
// ============================================================

import { dateKey, formatDayLabel, formatTime, willBePlanned } from "./time";

export type BatchLogAlert = { title: string; body: string };

/**
 * `chosenAt` is the instant the eat-time sheet confirmed. `now` is
 * injectable for tests and defaults to the live clock — pass a freshly
 * read Date, never one captured at mount (same rule as dayHeaderInfo).
 *
 * The planned/logged split mirrors the DB trigger's own rule through
 * willBePlanned(), including its 30-minute grace, so the alert can't
 * contradict what was stored.
 */
export function batchLogAlert(
  name: string,
  chosenAt: Date,
  now: Date = new Date(),
): BatchLogAlert {
  const iso = chosenAt.toISOString();
  const dayLabel = formatDayLabel(dateKey(chosenAt), now);

  if (willBePlanned(iso, now)) {
    return {
      title: "Planned",
      body: `${name} planned for ${formatTime(iso)}, ${dayLabel.toLowerCase()}.`,
    };
  }

  // formatDayLabel gives "Today"/"Yesterday" for the two days this reads
  // naturally as a possessive, and a dated "Sat 12 Sep" otherwise — which
  // needs the longer form rather than "Sat 12 Sep's log".
  const isRelative = dayLabel === "Today" || dayLabel === "Yesterday";

  return {
    title: "Logged",
    body: isRelative
      ? `${name} added to ${dayLabel.toLowerCase()}'s log.`
      : `${name} added to the log for ${dayLabel}.`,
  };
}
