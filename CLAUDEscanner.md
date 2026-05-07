# ChronaSense — Project Context

## Read First
Before every session, read CODEMAP.md to understand the codebase structure.
Do not read index.html in full — use CODEMAP.md to find the relevant section,
then read only that section.

## Stack
- Frontend: Vanilla JS, single-file SPA (index.html)
- Backend: Firebase Realtime Database + Auth
- Mobile: Capacitor (Android)
- Extension: Chrome/Edge browser extension
- Extracted modules: storage.js, insights.js, focus-mode.js

## Rules
- One change at a time
- Never modify working functionality unless explicitly asked
- Always explain your plan before editing
- Scope every change to the smallest possible section
- After changes: confirm what was modified and what was not touched

## Key Files
- index.html — main app (use CODEMAP.md to navigate, do not read in full)
- storage.js — Firebase sync and persistence
- insights.js — per-entry behavioral feedback (`analyzeBehavior`, `renderAwarenessSignal`, `renderFeedbackFlash`, `checkEscalation`) + weekly insight computation (`computeInsights`, `generateInsights`) + daily summary HTML (`buildDailySummaryHTML`, `getDailySummaryInsight`)
- focus-mode.js — Pomodoro / focus session logic
- sw.js — service worker (cache-first strategy; also registered inline via swCode string in PWA Installation section ~line 7198)
- CODEMAP.md — architecture map (read this first every session)