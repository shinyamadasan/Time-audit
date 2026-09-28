# Calendar-Native Plan Identity V1

**NEW:** the calendar date is the primary identity of a NEW plan. Once an account has cut over,
Sunday's plan is Sunday's — `cal1:2026-09-27` — whatever a Personal Day boundary says, and it can
continue past midnight (Monday 01:00, 04:00, 09:00) without becoming a Monday-owned duplicate.

**LEGACY:** Personal Day / operational-day plans (`operationalPlans/<odv1 id>`) and the calendar-keyed
`plans[dateKey]` store are **compatibility inputs**. After the cutover nothing new is written to them.
They stay readable, and their unfinished work can be moved into a calendar plan.

**Legacy data is NOT migrated.** No record is rewritten, copied or deleted by the cutover. "Older
plans" is a read-only projection; moving a task is an explicit, deterministic, idempotent action.

---

## 1. Authority / data map (before → after the cutover)

| Concept | Authoritative source BEFORE the cutover | Authoritative source AFTER the cutover |
|---|---|---|
| Current plan | `resolvePlanAuthority(ref)` → `plans[dateKey]` (no boundary) or `operationalPlans[odv1:…]` (boundary) | `calendarPlans[cal1:<today>]` |
| Plan Tomorrow / prepared plans | `upcoming()` = next boundary window / next date; `preparedPlans()` (operational only) | `calendarPlans[cal1:<today+1>]`; any future date through the future-day browser (`dayAhead`) |
| Plan items | `items[]` on the record; time = `when` interpreted against the day's interval | same record shape; time = `when` + `whenDayOffset` + `whenTz` (see §3) |
| Completion / undo | `updateItem` on the target | same, on the calendar target; a Monday-dated item of Sunday's plan through `completeCarryoverItem` (writes Sunday's record only) |
| Cross-midnight scheduling | the operational interval (18:00 → 18:00) | `whenDayOffset` 0/1 and ranges that cross midnight, inside the plan's two dates |
| `operationalDayId` | identity of every operational plan | not used for new plans; still parsed for legacy records |
| `plans[dateKey]` | authority for accounts with no boundary | compatibility input (superseded) |
| Personal Day boundary revisions | decide day identity, My Day window, Plan Tomorrow, streak day | describe legacy records only; changing one changes nothing about a calendar plan |
| My Day timeline | the operational window | the calendar day; the previous date's plan reaching into it is a *carryover projection* |
| Carryover | items of an overlapping personal day (WIP) | `calendarCarryoverFor(date)` over Sunday's own record — never cloned |
| Review (planned vs actual) | per target, judged in the target's window | per calendar plan: home window = its date; work linked by exact `planItemId` counts across the plan's second date; actuals keep their factual timestamps |
| Planning streak | boundary habit streak (`streak()`) | `calendarStreak()` — same rule over calendar plans, handing over to the legacy chain at the cutover date |
| Plan-by deadline qualification | `effectiveDeadlineDateKey` compatibility shift for operational targets | the plan's own date (no shift) |
| Account sync | `operationalPlans/*`, `plans/*` | `calendarPlans/<id>` (per-record transaction, per-item merge), `calendarPlanAuthority/<factId>` |
| Partner / shared | `currentPlanTarget()` / `upcomingPlanTarget()` | unchanged calls; a calendar target carries `dateKey` |
| Offline | local room-scoped caches, `pushAllLocal` on reconnect | same; every stored plan is re-pushed, not just today/tomorrow |

## 2. Schema

```
CalendarPlan (record, key = cal1:<YYYY-MM-DD>)
  items[]      plan items (same shape as every plan store, plus the time fields below)
  updatedAt, updatedBy
  createdAt, timezone      frozen by the FIRST writer (earliest createdAt wins on merge)
  preparation?             the legacy date-keyed contract verbatim (targetDate = the plan's date)

Plan item time fields (timed items only)
  when           'HH:MM'                 civil clock reading (unchanged meaning)
  whenDayOffset  0 | 1  (absent = 0)     civil days after the plan's own date
  whenTz         IANA zone               owned BY THE ITEM, frozen when the reading is set
  durationMinutes 1..720                 a range may cross midnight inside the plan

ActivationFact (key = fact id, in calendarPlanAuthority/)
  schemaVersion, id, activatedAtMs, timezone, activationDate, deviceId
```

## 3. Time representation (and its invariant)

The instant of a timed item is a **pure function** of `(plan date, when, whenDayOffset, whenTz)`
(`calendarItemInstants`). It never reads the account's current timezone, the Personal Day boundary or
"today". Therefore:

* Sunday 11:00 is one instant forever; the account moving to another zone later cannot reinterpret it
  (`stampCalendarItemTimes` only restamps an item whose *own* reading changed).
* Monday 01:00 of Sunday's plan is `{when:'01:00', whenDayOffset:1}` in Sunday's record: no clone, no
  Monday-owned duplicate, and the Monday timestamp is never rewritten to Sunday.

A plan spans **two** calendar dates: every item must start *and end* before the start of date+2, which is
what lets carryover be answered by looking at exactly one previous plan. An ambiguous local reading (a
repeated DST hour) resolves to the earlier occurrence; a reading that does not exist is refused at write
time.

## 4. Identity

`cal1:<YYYY-MM-DD>` — deterministic, immutable, account-free in the id (the account is bound by the
room-scoped local cache and remote path, both owner-guarded, exactly like `operationalDayId`). Two
accounts may hold the same id and the same item ids without colliding.

## 5. Authority / cutover model

* **Which store is authoritative for a date** is decided only by the account's activation facts, never by
  which store holds data or by load order: dates on/after the effective activation date are
  calendar-authoritative; earlier dates stay legacy-routed.
* **Activation facts** are a grow-only set of immutable facts in `rooms/<room>/calendarPlanAuthority`.
  The effective activation is the one with the smallest `(activatedAtMs, id)` — a total order, so every
  device holding the same facts picks the same one, whatever order they arrived in. Two devices that
  activate independently keep both facts; the earlier one wins on both.
* **Activation is explicit, account-owned and one-way** (Settings → "Plan day", or the Today card for an
  account that has a Personal Day boundary; two-step confirmation). Reading never activates.
* **A calendar plan can only be written by an activated account** (`CalendarPlanLive.writePlanItems`
  refuses otherwise): there is no code path that writes a calendar plan before the cutover, so there
  are never two equal writable authorities for a date.
* **Offline / multi-device.** A device that has not yet heard the cutover is legitimately still on the
  legacy chain. When it hears the fact (authority listener, attached at room join) it starts routing to
  calendar plans and hydrates them. Whatever it wrote to the legacy stores in between is *not discarded
  and not merged*: it surfaces under "Older plans" and its unfinished tasks are recoverable through the
  ordinary Unfinished flow.
* **A stale legacy write after the cutover** (an old-model device) can never become the current plan and
  is never merged into a calendar plan. Same-date legacy + calendar data: the calendar plan is
  authoritative; the legacy record is surfaced, not chosen against.

## 6. Legacy compatibility model

The cutover *supersedes* every legacy day at the activation instant: it is treated as ended (read-only,
its unfinished tasks recoverable — `supersededAtMs` on the target, honoured by `collectStaleUnfinished`
and `assertDirectSchedulingTarget`). Moving a task into a calendar plan reuses the existing recovery
mechanism (deterministic carry id `ocarry1|<source>|<item>|<cal1:…>`, provenance fields, never offered or
moved twice). History before the cutover date is still read through the legacy chain; the planning streak
hands over at that date.

## 7. Decisions the owner may want to revisit

1. **Activation is owner-triggered, not automatic.** Auto-activating every account on first load would
   silently flip the meaning of "today" for existing data (today's plan lives in the legacy record) and
   would invalidate ~130 existing browser tests that encode the legacy model. The switch is one tap on the
   Today card. Making it automatic is a one-line policy change plus re-baselining those tests.
2. **A plan spans two dates.** Deliberately bounded; a three-date plan would need multi-source carryover.
3. **The streak day that straddles the cutover** is judged by its legacy successor: honest, not generous.

## 8. Not in this phase

Timer/Away remote cross-room leak, Life Ledger local cross-account visibility, Intention likely remote
cross-room leak, and the known CI flakes are carried forward untouched. Reviews were not rebuilt: a
minimal window/linkage adapter (`planTrackedMinFor`, the unplanned-activity exclusion) is all Review
needed.
