# plated. — Tester Feedback Register

_Every P-TF report in one place, in the order received_

One row per report. Numbers run in the order reports arrive and are never reused, so a gap always means a report was withdrawn, not lost.

## Reports

| ID | Date | Tester | Area | What it is | Severity | Status |
|---|---|---|---|---|---|---|
| P-TF01 | 25 Aug 2026 | Ian | Onboarding / account creation | After creating an account, no confirmation email arrived and the app never asked for calorie or macro targets. | Major | Logged |
| P-TF02 | 25 Aug 2026 | Ian | Food search | Food search returned an error with a Try again button over numerous attempts before eventually working; tester also suspects a trailing space affects results. | Major | Logged |

## Where things stand

- Open: P-TF01, P-TF02
- Closed: none
- Next number to allocate: P-TF03

## Key

### Severity

- Blocker — can’t complete the task at all, or data loss
- Major — completes the task but with real friction, wrong numbers, or a workaround
- Minor — annoying, doesn’t stop anything
- Polish — cosmetic, copy, spacing

### Status

- Logged — captured, not started
- In progress — being worked on
- Fixed — change is in, not yet re-tested with a tester
- Verified — the tester hit the same flow afterwards and it held up
- Deferred — real, not now (say why)
- Won’t fix — deliberate decision (say why)

_An entry only reaches Verified when a tester exercises the flow again. Your own re-test counts as Fixed._
