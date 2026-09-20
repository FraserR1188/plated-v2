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
| `testing/archive/` | Files from the retired P-TF system (`register.md`, `incident-form-template.md`, `P-TF01.md`, `P-TF02.md`), kept unchanged |

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

P-TF IDs predate the PL- scheme; they keep their IDs and are never reused. New issues use PL-.

## Sessions

| Date | Tester | Build / version | Device | Issues raised | Still open | Doc |
|---|---|---|---|---|---|---|
| 2026-09-20 | self (dev pass) | master @ `0f708a8`, no OTA | None — source investigation + read-only production queries | 5 | 5 | `testing/2026-09-20-internal.md` |
| 2026-09-19 | self (dev pass) | production OTA, master @ `48d09e1` | Pixel (Android) | 17 | 16 | `testing/2026-09-19-internal.md` |
| 2026-08-25 | Ian | Not recorded (newest Android store build then: v6, `f48184c`) | Google Pixel 10, Android 17 | 4 | 4 | `testing/2026-08-25-ian.md` |

## Open issues across all sessions

| ID | Severity | Summary | Status | Raised in | Fix / note |
|---|---|---|---|---|---|
| PL-003 | Blocker | addEntry swallows insert errors; log silently lost | Fixed | 2026-09-19-internal | Master @ 5abcbcb; OTA Android 6219ac78 + iOS 939f4f9d. Device pass OK. Needs a tester log |
| PL-001 | Major | Friend copy drops sat_fat to NULL | Fixed | 2026-09-19-internal | Rerouted via CopyConfirm → applyEntries; guards A + C. Now on master. Needs a tester copy |
| PL-002 | Major | saved_ingredients coerces unknown small four to 0 | Fixed | 2026-09-19-internal | Migration 20260919120000 + guard B+. Existing zeros not backfilled |
| PL-004 | Major | Android keyboard covers inputs on 13 surfaces | Fixed | 2026-09-19-internal | KeyboardScreen wrapper. Master @ 4c2d2f1; OTA Android ce5de6bb + iOS bf4b3ef8. Device pass OK (Pixel, all 13 surfaces; iOS ProductScreen). Needs a tester |
| PL-005 | Major | BundleApplyReview applies last-blurred grams | Fixed | 2026-09-19-internal | Commit-on-change (live text). Master @ 4c2d2f1; OTA Android ce5de6bb + iOS bf4b3ef8. Device pass OK (150 g applied, twice). Needs a tester |
| PL-006 | Major | BatchEditor Save can miss an uncommitted qty | Fixed | 2026-09-19-internal | Commit-on-change (live text). Master @ 4c2d2f1; OTA Android ce5de6bb + iOS bf4b3ef8. Device pass OK; yield/portion clearing while typing accepted. Needs a tester |
| PL-007 | Major | CSV export and last30Days use UTC dates | Logged | 2026-09-19-internal | Use dateKey |
| PL-008 | Major | CSV exports NULL small four as 0.0 | Logged | 2026-09-19-internal | Empty cell for NULL |
| PL-011 | Major | meal_entries big four can't represent unknown | Deferred | 2026-09-19-internal | Riskier schema change; separate decision |
| P-TF01b | Major | Never asked for calorie or macro targets | Logged | 2026-08-25-ian | No onboarding; new accounts run on DEFAULT_GOALS (2000 kcal) until set in Settings. No fix found |
| P-TF02a | Major | Food search kept erroring; worked after numerous retries | Logged | 2026-08-25-ian | Probable fix, unconfirmed: e958f4d (OFF User-Agent + timeout), Android v8+ and iOS build 3. Symptom not tied to it |
| PL-018 | Major | Today/workouts don't refetch when a foreground sync resolves | In progress | 2026-09-20-internal | syncRefetch.ts watches each sync; refetches only when it wrote. Awaiting device pass |
| PL-010 | Minor | buildEditPatch snaps edits to the rounding grid | Deferred | 2026-09-19-internal | Bounded drift, not urgent |
| PL-014 | Minor | Copy-a-day failures double-report to Sentry | Logged | 2026-09-19-internal | Audit applyEntries callers |
| PL-012 | Minor | Tesco Gold Coffee library row saved all-zero | Deferred | 2026-09-19-internal | Check the OFF source first |
| PL-015 | Minor | Clearing an AI macro cell on ProductScreen stores 0, not NULL | Logged | 2026-09-19-internal | Hard to reach: the AI fills all eight |
| PL-016 | Minor | Food search failures never reach Sentry | Logged | 2026-09-19-internal | No searchFood caller reports; P-TF02a can't be confirmed or ruled out if it recurs |
| PL-017 | Minor | Users without targets report fetchGoals errors to Sentry | Logged | 2026-09-19-internal | Predicted from code: no goals row at sign-up, .single() errors on no row. Search Sentry for operation:fetchGoals |
| P-TF01a | Minor | No confirmation email after sign-up | Logged | 2026-08-25-ian | None is sent: Confirm email is off (mailer_autoconfirm true, measured 2026-09-19). 87e16cf fixed the false copy; 8eb2e5e's "Check your email" screen may still show. A new-account sign-up check decides. Blocker if Confirm email is turned on and mail doesn't arrive |
| P-TF02b | Minor | Search "sometimes seems to need a space after the item name" | Logged | 2026-08-25-ian | Symptom of P-TF02a: queries are trimmed, so the space only re-fires the same search. Closes when P-TF02a does |
| PL-019 | Minor | whoop-sync never closes/deletes dropped cycles; orphan open cycle, is_current returns 2 rows | Logged | 2026-09-20-internal | Contained by the 36h guard. Constraint: never select "today's cycle" via is_current — readiness query included |
| PL-020 | Minor | Batches "Logged" alert says "today's log" when a past day was picked | Logged | 2026-09-20-internal | BatchesScreen.tsx:103-104; branch is on willBePlanned alone |
| PL-021 | Minor | Today header overflows at 360dp, off-today pages with the Bundles chip | Logged | 2026-09-20-internal | Predicted from font metrics: anchor 123.3dp vs 110dp available. Reflow lands with the nav work |
| PL-013 | Polish | RecipeConfirm doubles the bottom inset | Fixed | 2026-09-19-internal | SafeAreaView edge kept, footer inset dropped. Master @ 4c2d2f1; OTA Android ce5de6bb + iOS bf4b3ef8. Device pass OK. Needs a tester |
| PL-022 | Polish | whoop_data.sql:125-127 describes an upsert gate that doesn't exist | Logged | 2026-09-20-internal | Sync upserts blindly (whoop-sync/index.ts:290-297); comment-only drift |

## Closed issues

| ID | Severity | Summary | Status | Raised in | What changed |
|---|---|---|---|---|---|
| PL-009 | Polish | Float noise in stored small four | Won't fix | 2026-09-19-internal | Round-at-display-only is deliberate; never visible, can't move stats. Don't compare small four as text in SQL |
