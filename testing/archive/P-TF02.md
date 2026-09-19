# P-TF02 — Food search fails repeatedly with an error and a Try again button

_plated. tester feedback · Food search · Major · Logged_

## As submitted

_Transcribed verbatim from the tester feedback form on platedapp.uk. Do not tidy the wording._

| Field | Detail |
|---|---|
| **Name** | Ian |
| **What were you doing** | Searching for food items that I had in my curry. |
| **What did you expect** | Be able to easily search and select |
| **What happened** | Kept coming up with an error and a try again button. After numerous clicks it searched. Also sometimes seems to need a space after the item name, maybe coincidence. |
| **Phone** | Google Pixel 10, Android 17 |
| **Submitted** | 25 Aug 2026, 19:10 |
| **Source** | Website form (platedapp.uk) → Formspree → Test Reports |

## Triage

| Field | Detail |
|---|---|
| **Area** | Food search |
| **Severity** | Major |
| **Status** | Logged |
| **Build / version** | _Not recorded — ask the tester which build they were on_ |
| **Reproduced?** | _not yet attempted_ |
| **Related reports** | _none_ |

## Investigation

### Lines of enquiry

_Hypotheses only — none of these are confirmed._

- Is the error a failed request (timeout, cold start, rate limit) or a client-side failure on an empty or unexpected response? Check what the Try again button is actually reacting to.
- Does it fail specifically on the first search after opening the app — i.e. an unwarmed backend or an expired token being refreshed on demand?
- Trailing space: check whether search fires on a debounce or per keystroke, and whether an exact-match lookup runs before any fuzzy fallback.

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
