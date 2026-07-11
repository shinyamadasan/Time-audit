# SMOKETEST.md — ChronaSense Manual Test Checklist

Run this after any non-trivial change before pushing to GitHub.
Check each item. If something is broken, do not push.

---

## Automated Checks

Run these before pushing code changes:

```bash
npm test
npm run test:smoke
```

`npm test` runs the unit/regression suite. `npm run test:smoke` runs the Playwright browser smoke tests for the daily-driver flows: quick retro log + undo, delete + undo, Focus Wallet spend + undo, and crossing-day entries that should never display as one 28h block.

GitHub Actions runs both commands automatically on pushes and pull requests to `main`.

---

## 1. Page Load

- [ ] Page loads with no console errors (open DevTools → Console)
- [ ] Dark theme renders correctly (correct background, text colors)
- [ ] Bottom nav shows: Today · Week · Reflect · Settings
- [ ] Timer ring is visible and shows correct countdown

---

## 2. Timer — Core Flow

- [ ] Press **Start** → pre-commit modal appears asking for task name
- [ ] Type a task name and confirm → timer starts, ring animates
- [ ] Timer status bar shows "Pinging every X min"
- [ ] Press **Stop** → quick-log modal appears
- [ ] Log the entry → it appears in the Recent Entries list below timeline
- [ ] Timeline shows the logged block with correct color for the energy chosen

---

## 3. Quick-Log / Ping Modal

- [ ] Same-as-last chip appears if a previous entry exists
- [ ] Energy chips (Deep, Shallow, Distraction, Waste, Recovery) are all selectable
- [ ] Changing energy chip updates the modal color accent
- [ ] Save → entry appears in timeline and recent list
- [ ] Dismiss → no entry is saved

---

## 4. Timeline Navigation (Date Browsing)

- [ ] `‹` arrow appears in the timeline header
- [ ] Click `‹` → timeline shows yesterday's data, label changes to "Yesterday's timeline"
- [ ] Click `‹` again → label changes to day-of-week date format
- [ ] `›` arrow appears when viewing a past day
- [ ] Click `›` → navigates forward one day
- [ ] Click `›` when on yesterday → returns to today, `›` arrow hides
- [ ] "Back to Today" button appears when on a past day and hides when on today

---

## 5. Day Bar

- [ ] Color bars across the top reflect energy breakdown of the current day
- [ ] Switching to a past day updates the day bar to that day's entries
- [ ] Empty past day shows an empty (or gray) day bar without crashing

---

## 6. Desktop Side Panels (test in a wide browser window ≥1100px)

- [ ] Left panel is pinned to the left edge (streak calendar visible)
- [ ] Right panel is pinned to the right edge (goal/energy/heatmap visible)
- [ ] Center content is not hidden behind panels (has padding on both sides)
- [ ] Panels do not overlap center content at any viewport width 1100–1920px

---

## 7. Focus Mode

- [ ] Enter focus mode → focus overlay covers the screen
- [ ] Pomodoro countdown ticks down
- [ ] Music controls appear and a lo-fi track plays when selected
- [ ] Attempting to exit shows the focus-block overlay asking to confirm
- [ ] Confirming exit returns to normal timer state

---

## 8. Week View

- [ ] Switching to Week tab renders day columns without error
- [ ] Energy breakdown bars show for each day
- [ ] Clicking a day column shows entries for that day

---

## 9. Reflect View

- [ ] Switching to Reflect tab loads without error
- [ ] On mobile: streak calendar and heatmap render inline in the Reflect tab
- [ ] On desktop (≥1100px): streak calendar is in the left panel, heatmap in the right panel — NOT duplicated in the Reflect tab body

---

## 10. Settings

- [ ] Timezone selector loads the user's timezone
- [ ] Changing ping interval and saving persists on reload (open DevTools → Application → localStorage to verify)
- [ ] Deep goal field accepts a number and saves

---

## 11. Persistence (localStorage)

- [ ] Log an entry, reload the page → entry is still there
- [ ] Timer was running, reload the page → timer resumes from approximately where it left off (or a recovery prompt appears)
- [ ] No `ta3-heartbeat-ts` key left in localStorage after a normal page close (open DevTools → Application → localStorage after closing and reopening)

---

## 12. Firebase Sync (if signed in)

- [ ] Sign in → entries from other devices/sessions appear
- [ ] Log an entry → it appears on a second browser tab within a few seconds
- [ ] Sign out → app continues to work offline with local data

---

## 13. Console — Final Check

- [ ] Open DevTools → Console, scroll through — zero red errors
- [ ] No "Cannot read properties of undefined" or "null is not an object" warnings for the sections you changed

---

## After Passing All Checks

Run `sync.bat` to:
1. Copy files to `www/` for Android
2. Run `npx cap sync android`
3. Push to GitHub (web app)
