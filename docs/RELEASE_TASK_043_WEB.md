# TASK-043 Household My Day V1 — controlled web release and rollback

Status: release candidate on branch `task-043`, held for owner approval. Nothing pushed, merged or deployed.
Scope: web (GitHub Pages) only, opt-in at `https://shinyamadasan.github.io/Time-audit/?household=1`.
Android is the next target and is not part of this release. TASK-042 is NOT bundled.

## What ships

| Item | Branch / commit | Needs approval |
|---|---|---|
| Household My Day V1 (tasks, partner full list opt-in, Food UI), hidden behind `?household=1` | `task-043` (base = production `main` b0bbc6f) | Merge to `main` + push (= deploy) |
| Meal Prep production connection (public web config + reCAPTCHA v3 site key, production origin + `?household=1` only) | `task-043-meal-prep-activation` (one commit on top of `task-043`) | Separate approval, after the Meal Prep checks below |

Without the activation commit the Food section reads "Meal Prep is not connected on this device yet."
Tasks and partner sections work fully.

No Firebase rules, Cloud Functions, CI workflow, service worker or production data change in either branch.

## Compatibility (verified locally)

- Old client reading a new partner payload: accepted; `dailyTasks` is stripped by the old allowlist (top 3 only).
- New client reading an old payload: accepted; shows "isn't sharing their full daily list".
- Without `?household=1` the existing My Day is unchanged. The only always-visible addition is the
  Settings › Partner checkbox "Share my full daily task list" (default off; nothing extra is published until ticked).
- Service worker caches audio only; new assets use `?v=20261125-household-*` keys.

## Release steps (owner, after approval)

1. `git -C <repo> checkout main && git pull --ff-only` — confirm `main` is still `b0bbc6f`. If it moved, stop and re-qualify.
2. `git merge --no-ff task-043` then `npm run check:www-parity` and `git push origin main`.
3. Optional, only with the Meal Prep approval: `git merge --no-ff task-043-meal-prep-activation`, parity check, push.
4. Wait for GitHub Pages to publish (about 1–2 minutes), then run the real-device acceptance steps.

## Meal Prep production checks (Meal Prep Firebase project `meal-prep-f8907`, owner console, read-only)

1. Firestore rules deployed in production keep `users/{userId}` read/write limited to `request.auth.uid == userId`.
2. Authentication → Sign-in method: Email/Password enabled (Meal Prep's own app uses it).
3. Google Cloud → Credentials → the Meal Prep browser API key: if it has HTTP-referrer restrictions, add
   `https://shinyamadasan.github.io/*`. (No change needed if unrestricted.)
4. App Check: the reCAPTCHA v3 site key's domain list must include `shinyamadasan.github.io` if App Check is
   enforced for Firestore or Authentication. My Day attests with Meal Prep's own public site key.
5. Authorized domains are not required for email/password sign-in; do not add domains that are not needed.

## Rollback

- Fast, no deploy: stop using `?household=1`; the normal My Day is unchanged. To stop publishing the full list,
  untick Settings › Partner › "Share my full daily task list" (takes effect on the next publish, about 2 s).
- Full: `git revert --no-edit -m 1 <merge-commit>` (and the activation merge first, if shipped), parity check,
  `git push origin main`. Pages republishes in about 1–2 minutes.
- Data after rollback: logged time and plans are untouched (no schema change). A published `today.dailyTasks`
  list stays in `/shared/partnerView` until the next publish by the old client overwrites it; old clients never
  display it. `settings.partnerShareDailyTasks` remains as an unused setting. Meal Prep: nothing was written; a
  browser keeps a Meal Prep sign-in for the named app until it signs out or clears site data.
