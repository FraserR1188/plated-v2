# Account deletion — Play reviewer runbook

Google Play reviewers exercise in-app account deletion as a matter of
course when auditing an account-based app. **A reviewer deleting
`play-review@fraseranalytics.com` is the expected outcome of a review
round, not an incident.** This doc is the standing checklist for keeping
that account ready before every submission, and for recreating it after
one gets deleted.

## Why the account needs recreating, not just resetting

`delete-account` calls `admin.auth.admin.deleteUser(userId, false)` with
`shouldSoftDelete` explicitly `false` — the email address is freed
immediately, not retained against a soft-deleted row. That's deliberate:
a soft delete would permanently burn `play-review@fraseranalytics.com`
the first time a reviewer exercised the feature, and Google Play's own
requirement is that deletion actually frees the account for
re-registration. The tradeoff is that **the account genuinely stops
existing** after a review round, so it has to be recreated from scratch,
not just refilled.

## Before every submission

- [ ] Confirm `play-review@fraseranalytics.com` can sign in. If it can't
      (most likely: the previous round's reviewer deleted it), recreate
      it:
  - [ ] Sign up again with **the same email and the same password** the
        Play Console app-access instructions already reference, so those
        instructions never need editing between rounds.
  - [ ] Set daily goals (Settings → Daily goals) to any non-default
        values — a reviewer should see a populated goals screen, not the
        app defaults.
  - [ ] Log a handful of entries spread across a few days and across all
        four meal sections (Breakfast, Lunch, Dinner, Snacks) — enough
        that History and the correlation views aren't empty screens.
  - [ ] Create one custom food with a photo attached (Settings → your
        library, or via the scanner's "create custom food" path) — this
        is what exercises the Storage sweep leg of deletion, so the
        account needs at least one object under `custom-food-images/` for
        a review to be a meaningful test of it.
  - [ ] Create one meal composition (a saved bundle of items) — exercises
        the `meal_compositions` / `meal_composition_items` cascade.
- [ ] **Do not connect WHOOP for this account.** Reviewers will see
      "Connect Whoop" (not "Reconnect"), and that's correct — see below.

## WHOOP will show disconnected for reviewers, always

The reviewer account is not connected to a real WHOOP account, so
Settings will always show the "Connect Whoop" state, never "Connected."
This is expected and not a bug to chase — WHOOP correlation is a
supplementary feature, not part of the account-deletion flow reviewers
are auditing, and there's no test WHOOP account to attach here safely.

## After every review round

- [ ] **Standing check, every time, not just when something looks
      wrong:** confirm whether `play-review@fraseranalytics.com` still
      exists. If it's gone, that means deletion was exercised and worked
      — recreate the account using the steps above ahead of the *next*
      submission, rather than waiting for a failure to notice it's
      missing.
- [ ] If the account still exists (deletion wasn't exercised this round),
      leave it as-is — no need to reset or reseed until the next
      submission cycle.
