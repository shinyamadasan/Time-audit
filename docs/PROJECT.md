# ChronaSense — Project

> North star. What this is and why. Read on first/onboarding sessions. Changes rarely.

## What it is
A **personal time-audit system** built for radical honesty about where your time actually goes.
A configurable timer pings you (default 30 min) and asks one question — *what were you just doing?*
You log it and move on. Gaps get filled automatically from phone and browser activity, and the
record turns into behavioural insight.

## Who it's for
People who suspect their time is leaking and want **evidence, not vibes**. Mobile-first, used across
phone (Android), desktop browser, and a browser extension — the same day's record, everywhere.

## Core value loop
1. Timer runs → pings at the interval.
2. You log what you were doing (quick log · voice · preset · recent chip).
3. Gaps are filled — Android UsageStats, the browser extension, or retroactive logging.
4. Entries sync in real time across every device (timer, away state, break state included).
5. Insight turns the record into behaviour change (awareness signals, escalation, weekly review).

## North-star goals (for triage scoring)
Ranked. Triage scores each captured idea against these — an item that serves a higher goal outranks
a cosmetic one **regardless of how appealing it sounds**. Update this list as priorities shift.

1. **Make logging frictionless.**
   The ping → log → move-on loop must take *seconds*. Every extra tap is a reason to stop logging,
   and a skipped log is a hole in the truth. (Why voice input, presets, recent chips, and the quick-log
   modal exist.)

2. **Capture the truth — no silent gaps.**
   A time audit with holes *lies to you*. Auto-tracking (Android UsageStats + browser extension), gap
   detection, and retroactive logging exist so the record is complete, not flattering.

3. **Never lose logged time.**
   Real-time RTDB sync across devices, plus crash recovery. **A lost log cannot be reconstructed** —
   nobody remembers what they were doing at 2:15pm last Tuesday. Gone is gone.

4. **Insight must change behaviour.**
   The point isn't the log, it's the awareness. Feedback (`insights.js` — awareness signals,
   escalation, weekly insight) must be honest, timely and actionable — not vanity dashboards.

5. **Stay simple & maintainable.**
   Vanilla JS, no framework, no build step. Respect `CODEMAP.md` and the fragile sections
   (see `CLAUDE.md` Hard Rules).

## What makes it different
- **Interval ping, not a stopwatch** — you don't have to remember to start anything.
- **Gaps get filled for you** — phone + browser tracking means the record survives your forgetfulness.
- **Cross-device real time** — timer, away and break state are live on every device at once.
- **Behavioural feedback, not dashboards** — the app pushes awareness at you, it doesn't wait to be read.

## Non-goals (deliberately not building)
- No framework / no build step — vanilla JS stays.
- **Not a team or manager tool.** This is private, personal time. No surveillance features.
- Not a billing / invoicing / client-hours tracker.

## Stack
Vanilla JS SPA — `index.html` plus extracted modules (`storage.js`, `insights.js`, `focus-mode.js`,
`focus-wallet.js`) · **Firebase Realtime Database** + Auth · Capacitor (Android) · Chrome/Edge browser
extension · service worker (`sw.js`) · tests via `npm test` (`node test.js`) and Playwright.

**Navigation rule:** `index.html` is very large. Always read `CODEMAP.md` first and open only the
section you need — never read `index.html` in full.
