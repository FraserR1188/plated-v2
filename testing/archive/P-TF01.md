# P-TF01 — Nothing happens after account creation — no email, no calorie or macro setup

_plated. tester feedback · Onboarding / account creation · Major · Logged_

## As submitted

_Transcribed verbatim from the tester feedback form on platedapp.uk. Do not tidy the wording._

| Field | Detail |
|---|---|
| **Name** | Ian |
| **What were you doing** | Opening screen |
| **What did you expect** | Receive an email after creating account and be asked to fill in macros and calorie targets |
| **What happened** | Nothing happened so going to move onto next stage and scan something |
| **Phone** | Google Pixel 10, Android 17 |
| **Submitted** | 25 Aug 2026, 19:04 |
| **Source** | Website form (platedapp.uk) → Formspree → Test Reports |

## Triage

| Field | Detail |
|---|---|
| **Area** | Onboarding / account creation |
| **Severity** | Major |
| **Status** | Logged |
| **Build / version** | _Not recorded — ask the tester which build they were on_ |
| **Reproduced?** | _not yet attempted_ |
| **Related reports** | _none_ |

## Investigation

### Lines of enquiry

_Hypotheses only — none of these are confirmed._

- Does account creation actually trigger a confirmation or welcome email — is the mail provider configured for production, and is it landing in spam?
- Is the goal-setting step (calorie and macro targets) built and routed immediately after signup, or only reachable later from settings?
- If targets are never set, what does the home screen fall back to — a default, a zero, or a silent blank?

### Root cause

_What was actually wrong, once you looked._

-
-
-

## Rectification

| Field | Detail |
|---|---|
| **What changed** | __ |
| **Where** | _file(s) / commit / PR_ |
| **Shipped in** | _build or version_ |
| **Date fixed** | __ |

## Verification

| Field | Detail |
|---|---|
| **How confirmed** | _your own re-test = Fixed; the tester exercising the flow again = Verified_ |
| **By whom** | __ |
| **Date** | __ |
| **Outcome** | __ |

## Notes and decisions

_Anything deliberately not changed, and why. Saves re-litigating it next round._

-
-
-

_Remember: update this report’s row in the register when the status changes._
