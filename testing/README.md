# plated. — user testing log

Every round of testing on plated. gets a record here: what the tester said, and what was changed in response. Nothing gets fixed silently.

## What's in this folder

| File | What it's for |
|---|---|
| `testing/README.md` | This index — the master list of sessions and open issues |
| `testing/feedback-form-template.md` | Blank form to hand a tester (or fill in while watching them) |
| `testing/session-template.md` | The record format — raw feedback plus the rectification log |
| `testing/YYYY-MM-DD-<tester>.md` | One per session |
| `testing/YYYY-MM-DD-internal.md` | Issues found by the developer rather than a tester (Tester = "self (dev pass)") |

## The loop

1. **Before the session** — note the build/version being tested and what you want to learn from this round.
2. **During** — capture raw feedback in the blank form. Tester's words, not your interpretation.
3. **After** — copy `session-template.md` to `testing/YYYY-MM-DD-<tester>.md`, paste the raw feedback in, and split it into numbered issues (`PL-001`, `PL-002`, … sequential across *all* sessions, never reused).
4. **As you fix** — update the issue's row in that session doc: what you changed, which commit/build, and how you confirmed it.
5. **Update the tables below** so the current state is readable without opening every session doc.

Issues you find yourself go in a dated `-internal.md` doc using the same template, so they share the PL- sequence and a later tester session can move them to `Verified`.

## Conventions

**Severity**

- `Blocker` — can't complete the task at all, or data loss
- `Major` — completes the task but with real friction, wrong numbers, or a workaround
- `Minor` — annoying, doesn't stop anything
- `Polish` — cosmetic, copy, spacing

**Status**

- `Logged` — captured, not started
- `In progress` — being worked on
- `Fixed` — change is in, not yet re-tested with a user
- `Verified` — a tester hit the same flow afterwards and it held up
- `Deferred` — real, not now (say why)
- `Won't fix` — deliberate decision (say why)

An issue only reaches `Verified` when a person exercises the flow again — your own re-test counts as `Fixed`, not `Verified`.

## Sessions

| Date | Tester | Build / version | Device | Issues raised | Still open | Doc |
|---|---|---|---|---|---|---|
| 2026-09-19 | self (dev pass) | production OTA, master @ `48d09e1` | Pixel (Android) | 14 | 13 | `testing/2026-09-19-internal.md` |

## Open issues across all sessions

| ID | Severity | Summary | Status | Raised in | Fix / note |
|---|---|---|---|---|---|
| PL-003 | Blocker | addEntry swallows insert errors; log silently lost | Fixed | 2026-09-19-internal | Master @ 5abcbcb; OTA Android 6219ac78 + iOS 939f4f9d. Device pass OK. Needs a tester log |
| PL-001 | Major | Friend copy drops sat_fat to NULL | Fixed | 2026-09-19-internal | Rerouted via CopyConfirm → applyEntries; guards A + C. Now on master. Needs a tester copy |
| PL-002 | Major | saved_ingredients coerces unknown small four to 0 | Fixed | 2026-09-19-internal | Migration 20260919120000 + guard B+. Existing zeros not backfilled |
| PL-004 | Major | Android keyboard covers inputs on 13 surfaces | Fixed | 2026-09-19-internal | KeyboardScreen wrapper on `fix/keyboard-screen-wrapper`. Device pass OK (Pixel, all 13 surfaces; iOS ProductScreen). Pending OTA; fingerprint unchanged. Needs a tester |
| PL-005 | Major | BundleApplyReview applies last-blurred grams | Fixed | 2026-09-19-internal | Commit-on-change (live text) on `fix/keyboard-screen-wrapper`. Device pass OK (150 g applied, twice). Pending OTA with PL-004. Needs a tester |
| PL-006 | Major | BatchEditor Save can miss an uncommitted qty | Fixed | 2026-09-19-internal | Commit-on-change (live text) on `fix/keyboard-screen-wrapper`. Device pass OK; yield/portion clearing while typing accepted. Pending OTA with PL-004. Needs a tester |
| PL-007 | Major | CSV export and last30Days use UTC dates | Logged | 2026-09-19-internal | Use dateKey |
| PL-008 | Major | CSV exports NULL small four as 0.0 | Logged | 2026-09-19-internal | Empty cell for NULL |
| PL-011 | Major | meal_entries big four can't represent unknown | Deferred | 2026-09-19-internal | Riskier schema change; separate decision |
| PL-010 | Minor | buildEditPatch snaps edits to the rounding grid | Deferred | 2026-09-19-internal | Bounded drift, not urgent |
| PL-014 | Minor | Copy-a-day failures double-report to Sentry | Logged | 2026-09-19-internal | Audit applyEntries callers |
| PL-012 | Minor | Tesco Gold Coffee library row saved all-zero | Deferred | 2026-09-19-internal | Check the OFF source first |
| PL-013 | Polish | RecipeConfirm doubles the bottom inset | Fixed | 2026-09-19-internal | SafeAreaView edge kept, footer inset dropped, on `fix/keyboard-screen-wrapper`. Device pass OK. Pending OTA with PL-004. Needs a tester |

## Closed issues

| ID | Severity | Summary | Status | Raised in | What changed |
|---|---|---|---|---|---|
| PL-009 | Polish | Float noise in stored small four | Won't fix | 2026-09-19-internal | Round-at-display-only is deliberate; never visible, can't move stats. Don't compare small four as text in SQL |
