# ChronaSense Windows Ambient Focus HUD (Phase 6B.1)

A small always-on-top Windows window that mirrors the ONE authoritative Focus
session already running in the ChronaSense web app. It never runs its own
timer, and it cannot change Focus state in any way — it only ever displays
the last state ChronaSense pushed to it.

## Run it manually

```
pwsh -File .\windows-hud\ChronaSenseHud.ps1
```

To run without a visible console window:

```
pwsh -WindowStyle Hidden -File .\windows-hud\ChronaSenseHud.ps1
```

Manual launch needs no install step, build, or dependency fetch — it only uses
.NET components that ship in every Windows 10/11 install (WPF, HttpListener,
WinForms' `NotifyIcon`/`Screen`). Requires PowerShell 7+ (`pwsh`), which this
repo's own tooling already assumes (`run-claude.ps1`, the `setup-*.ps1`
scheduler scripts).

## Optional auto-start at Windows login

From the repository root, opt in once:

```
pwsh -File .\windows-hud\Install-HudStartup.ps1
```

This creates one per-user Startup-folder shortcut to the current HUD script.
It needs no administrator rights, launches PowerShell hidden at the next
login, and is safe to run again. It does not start the HUD immediately.

To remove only that installer-owned shortcut:

```
pwsh -File .\windows-hud\Remove-HudStartup.ps1
```

Install from the checkout you intend to keep, because the shortcut records
the HUD script's current absolute path. Auto-start never passes `-DevOrigin`;
normal login launches accept only the production ChronaSense origin.

`-DevOrigin <exact origin>`: for local testing only. ChronaSense's real local
dev/test workflow loads `index.html` via `file://` (see `tests/smoke.spec.js`,
which uses `pathToFileURL`) — a `file://` page's `Origin` header is the
literal string `"null"`. Pass `-DevOrigin 'null'` to test against a page
opened that way, or `-DevOrigin 'http://localhost:PORT'` for a specific local
static server. This is an exact, single additional allowed origin — never a
wildcard or a port range.

## Architecture: one-way only

```
ChronaSense Focus state
        ↓ (fetch POST, loopback only)
local snapshot in the companion
        ↓ (wall-clock formatting only)
Windows HUD display
```

**There is no channel back.** The HUD cannot end Focus, cannot pause/resume
it, cannot change its title, and cannot touch scheduling. It has no button
that mutates Focus state at all. This was a deliberate correction from an
earlier draft that let the HUD's "End Focus" button relay a command back to
the browser — that added session-binding risk, depended on browser heartbeat
latency, and widened the loopback trust boundary for a capability the
product doesn't need (the HUD's job is passive goal salience, not remote
control). It was removed entirely rather than hardened. Use ChronaSense's own
controls (or the HUD's "Open ChronaSense" button, which just does
`Start-Process` on the app URL) to actually change anything.

## How it stays in sync (and why it can't drift into a second timer)

1. ChronaSense's existing Focus code (`focus-mode.js`) is the only place that
   decides start / phase-change / end. At each of those points it now also
   calls a tiny helper (`pushHudFocusState()` / `pushHudFocusEnded()`) that
   was added at five specific call sites — it does not create any new state.
2. That helper hands off to `windows-hud-bridge.js`, which `fetch()`-POSTs a
   snapshot (`{title, phase, startedAt, plannedEndAt, linkType, deviceOwned,
   pageVisibility}`) to `http://127.0.0.1:51739/focus-bridge/state` —
   loopback only. The companion's HTTP response carries no body and no
   command; the browser doesn't even read it.
3. The companion stores only the *last* snapshot it received. It computes
   "Ends ~10:30 AM" from `plannedEndAt` using wall-clock math at render time —
   the same kind of computation ChronaSense itself already does for its own
   multi-device Focus mirror (`storage.js`'s `rooms/{roomCode}/timer` sync).
   There is exactly one source of truth; the HUD only ever formats it.
4. While a session is active, the browser also re-sends the same snapshot
   every 4 seconds nominally (a bounded, local-only heartbeat — never polls
   Firebase or any network endpoint), plus immediately on every
   `visibilitychange` event, so a transition to/from a backgrounded tab is
   learned right away rather than waiting for the next throttled tick.
5. The companion itself re-renders every 20 seconds purely to refresh its own
   displayed text from already-known values (no per-second ticking anywhere —
   the HUD is calm by design).

## Visibility-aware staleness (fix round 1)

`pageVisibility` (`"visible"` or `"hidden"`, read from the page's own
`document.visibilityState`) is stamped on every push as **bridge-health
metadata only** — it is never displayed as Focus truth, and it never changes
what the HUD claims about the session itself. It only selects which
staleness threshold applies:

- **Foreground / visible tab**: stale after **15 seconds** of silence (~3-4
  missed heartbeats).
- **Backgrounded / hidden tab**: stale after **90 seconds** of silence.

The longer background threshold exists because Chromium throttles
`setInterval` timers in backgrounded tabs, so the nominal 4-second heartbeat
fires far less often once genuinely minimized — treating that as "lost sync"
after only 15 seconds would mean the HUD spends most of a normal backgrounded
session saying "Syncing…", which defeats the point of a passive ambient cue.
"Syncing…" now means "we have not heard from ChronaSense for longer than
expected for its *current* visibility state" — not "ChronaSense is behaving
normally in a background tab."

**Real background test (required verification for this fix round) — result:
NOT achieved; reported honestly rather than claimed.** Three separate live
attempts were made to genuinely background a real Chromium tab for several
minutes and observe actual throttled heartbeat intervals:

1. A real (non-headless) Playwright-driven Chromium window, real
   `enterFocusMode()`/`startPomodoro()`, minimized via Chrome DevTools
   Protocol (`Browser.setWindowBounds({windowState:'minimized'})`), left
   running for 6 continuous minutes before an unrelated process-cleanup
   collision in this session ended it early.
2. A second, shorter CDP-minimize attempt.
3. A real OS-level minimize via `user32.dll`'s `ShowWindow(hwnd,
   SW_MINIMIZE)` on the actual browser window handle (found via
   `EnumWindows`), attempted in isolation.

In **all three**, `document.visibilityState` stayed `"visible"` throughout —
it never flipped to `"hidden"`, and the heartbeat kept firing at a steady,
un-throttled 4.0s in the one run long enough to show a pattern (73 requests
over 6 minutes, each exactly 4.0-4.1s apart, confirmed from the companion's
own request log). This environment did not reproduce genuine Chromium
background-tab occlusion/throttling from a minimize — most likely because
this session runs against a remote/virtualized display rather than a real
physical desktop session, where the compositor-level occlusion signal
Chromium's Page Visibility implementation relies on may not be generated the
same way.

**What this means concretely:** the code-level correction — reading
`document.visibilityState`, stamping it on every push, applying a longer
stale threshold when it says `"hidden"`, and pushing immediately on
`visibilitychange` — is implemented and unit-tested (`windows-hud-bridge.test.js`
mocks `document.visibilityState` directly and asserts the snapshot and the
immediate re-push both behave correctly for `visible`/`hidden`/absent). What
is **not** verified is the real-world behavior of an actually-throttled
Chrome tab feeding this logic over many real minutes. The **90-second**
background threshold is therefore a *reasoned* default, not a *measured*
one: Chromium's publicly documented throttling tiers slow ordinary
`setInterval` timers to roughly once per minute after about a minute
backgrounded, escalating further only after several more minutes — 90
seconds comfortably absorbs one missed/delayed ~60s-tier heartbeat with
margin, without being so long that a genuinely lost connection goes
unflagged for a long time. **This should be re-checked on a real physical
Windows desktop during actual dogfooding**, and the threshold adjusted if
real observed intervals differ meaningfully from this estimate.

When stale: the dot goes gray, the last known title stays visible but the end
time is replaced with "Syncing…", and the connection line explains why. It
never fabricates completion, and it never keeps claiming a session is
current indefinitely.

## Pause / resume

Not implemented, on purpose. ChronaSense's Pomodoro Focus feature has no
native pause action today (only Start → work → break → next-session / Skip
break / Exit). Adding one would be new Focus-domain behavior, not a HUD
concern — the HUD doesn't offer a control that doesn't exist underneath it.

## Security boundary

The bridge is bound to `127.0.0.1` only (never `0.0.0.0`) and only answers
POST/OPTIONS requests whose `Origin` header **exactly** matches
`https://shinyamadasan.github.io`, or the single additional origin passed via
`-DevOrigin` (unset by default — production origin only). No wildcard, no
prefix, no "any port on localhost" acceptance — an earlier draft did accept
any `http://localhost:*` / `http://127.0.0.1:*` origin; that was narrowed
after review, since it was never actually needed (see the `-DevOrigin` note
above for what ChronaSense's real local workflow uses).

Chrome/Edge additionally gate loopback access behind their own native
**Local Network Access** permission prompt — the first time ChronaSense's
page tries to reach the companion, the browser asks the user once, the same
way it would for camera or location access.

Every request is also bounded and validated before it can touch the
companion's state:
- Body capped at **8 KB** (checked against `Content-Length` before reading,
  and again against the actual bytes read) — rejected with `413`.
- The parsed JSON must match one of exactly two shapes
  (`{type:'focus-ended'}` or the full active-snapshot shape with `title`
  bounded to 200 chars, `phase` in `{work, break}`, numeric timestamps,
  `linkType` in `{daily-routine, learning-plan, none}`, `pageVisibility` in
  `{visible, hidden}`) — anything else is rejected with `400`, never
  partially applied.

Only five fields ever cross the bridge (plus the visibility hint above) — no
Life Ledger data, no Firebase collections, no secrets.

Known residual risk (documented, not hidden): any other local page the user
has also allow-listed for local-network access, running in the same browser
profile and origin, could in principle POST a spoofed Focus snapshot, since
there is no per-request auth token beyond the Origin check. Because the HUD
is one-way and cannot mutate real Focus state, the worst a spoofed snapshot
can do is make the *display* say something untrue for a while — it cannot
end, pause, or otherwise affect the real session. For a single-user personal
dogfood tool this residual is acceptable; a shared-secret token would be the
next step before this pattern suited anyone but the app's own author.

## What "browser closed" means today

- **Minimized ChronaSense tab/window**: fully supported. The tab keeps
  running in the background, the heartbeat keeps firing (throttled by
  Chromium while hidden — see the visibility-aware staleness section above),
  and the HUD stays in sync.
- **Tab/window fully closed**: NOT supported as a live sync path. JS
  execution stops, so no more pushes arrive. The HUD keeps showing the last
  known state for the visibility-appropriate grace period, then switches to
  "Syncing…" and stays there (it will not fabricate a fresh "ended" state it
  was never told about, and it will not silently keep claiming a stale title
  is current). Reopening ChronaSense and starting/continuing Focus resumes
  normal sync. ChronaSense today has no server-side or serverless Focus
  authority to hand off to, so faking full-close support would mean
  inventing a second, competing timer inside the HUD — explicitly ruled out.

## Resource cost (measured on this machine)

| | |
|---|---|
| Install footprint | One small optional per-user `.lnk`; no package or download |
| Idle memory (no Focus active) | ~137 MB working set |
| Memory with a session active | ~170–175 MB working set |
| Idle CPU | ~0.5% average (one 20s render tick; effectively 0 between ticks) |
| Threads / handles | ~29–31 threads, ~650–700 handles |
| Startup time | <2s to first paint-ready (window stays hidden until Focus is active) |

Memory was also watched across the combined ~30 minutes of live testing for
this fix round (multiple launches, hundreds of pushes, sustained 4s-interval
traffic for 6+ continuous minutes at one point): working set settled around
190-195 MB after heavy sustained use, up modestly from the ~170-175 MB
active-session baseline and not climbing further with additional load —
consistent with normal .NET GC headroom, not a leak. This was not a clean
single 9-10 minute isolated measurement (see the background-test note above
for why), so treat it as reassuring rather than conclusive.

This is heavier than a bare native Win32/WinForms exe would be (PowerShell's
own hosting overhead — loading the engine plus WPF — accounts for most of
it), but it is a small fraction of an Electron-based alternative (which would
mean bundling an entire Chromium instance, typically 150–300+ MB *before*
any content, just to show three lines of text). No GPU, no network calls
beyond the local loopback heartbeat, no background wakeups when idle.

## Files

- `ChronaSenseHud.ps1` — the whole companion: WPF window, local HTTP bridge,
  tray icon, position/privacy persistence.
- `Install-HudStartup.ps1` / `Remove-HudStartup.ps1` — optional, reversible
  per-user Windows login startup.
- Settings persisted to `%LOCALAPPDATA%\ChronaSenseHud\settings.json`
  (window position, privacy-mode toggle only — no Focus data is ever
  written to disk by this process).
- Optional diagnostics: set `CHRONASENSE_HUD_DEBUG=<path>` before launch to
  log render errors and (for every accepted request) its type and
  `pageVisibility` to that file. Off by default, zero cost when unset.

## HUD controls (final, after fix round 1)

Collapsed:
```
● FOCUS
GHL — Client booking workflow
Ends ~10:30 AM
```

Expanded (click the collapsed card):
```
GHL — Client booking workflow

Started 9:45 AM
Ends ~10:30 AM
Scheduled routine        (or "Learning plan", or nothing — see below)
Synced                   (or "Not confirmed — ...")

[Open ChronaSense]
[Privacy] [Hide until Focus ends] [Collapse]
```

No End Focus, no Pause, no Resume — see above. "Open ChronaSense",
"Privacy", "Hide until Focus ends", and "Collapse" are the only controls, and none of them
touch Focus state:
- **Open ChronaSense** opens the real app in the default browser so the user
  can use its authoritative controls.
- **Privacy** blanks the title (phase + time only) — for screen-share safety.
- **Hide until Focus ends** hides the HUD window until Focus ends; does not pause or end
  anything. This is a true "until Focus ends," not "until you find the tray
  icon": the hide automatically clears the moment a `focus-ended` snapshot
  arrives (same code path as "no active Focus" on companion startup), so the
  *next* Focus session shows the HUD normally rather than inheriting the old
  hide. Fixed in the pre-commit polish pass — an earlier draft left
  `$hiddenUntilEnd` set indefinitely across a `focus-ended`, so a later
  session could stay hidden until the user found "Show HUD" in the tray.
- **Collapse** returns to the small collapsed card.

After Hide, right-click the green tray icon and choose **Show HUD** to restore
the current Focus immediately. This cancels the current session's hide
suppression. With no active Focus, Show HUD keeps the window hidden and does
not invent a session; the next real Focus still appears normally.

Position and the Privacy toggle persist across restarts; Hide does not
(a fresh companion process always starts visible if a session is active, and
in any case a hide never survives past the Focus session it was set during).

## Truthful link labeling (fix round 1)

The HUD shows a small badge only when it's actually true:
- Focus started from a Phase 6 scheduled daily routine → **"Scheduled
  routine"**.
- Focus started from a Learning Plan step (but not via a scheduled routine)
  → **"Learning plan"**.
- Neither → no badge at all.

An earlier draft collapsed both cases into one generic "scheduled" boolean,
which mislabeled Learning-Plan-only sessions as coming from a scheduled
routine. `focus-mode.js` now tracks the real source (`_hudFocusLinkType`,
set at the exact point `startPomodoro()` knows which one applies) and the
bridge carries it through as `linkType` — never a fabricated calendar/cadence
claim.

## Known gaps / deferred

- Cross-device mirroring (e.g., a phone starts Focus, this PC's HUD shows
  it) is not wired up. Today the HUD only reflects a session started or
  taken-over on the same machine it's running on — the product's described
  primary flow.
- A first click on the collapsed card, when the HUD window has never held
  input focus/activation, was observed in testing to sometimes only activate
  the window rather than also expanding it — a second click then works. This
  looked like standard Windows click-to-activate behavior interacting with
  `ShowActivated="False"` (set so the HUD doesn't steal focus when it first
  appears), but it was tested via synthetic `SendInput`-style clicks, not a
  real mouse, so it may or may not reproduce for an actual user. Flagged,
  not fixed — outside this fix round's 5 requested findings.
- `hud_shown` / `hud_hidden` bounded event logging was not added — no
  existing local event infrastructure to hook into cheaply in this repo.
- **Chunked-transfer body buffering**: the 8KB body cap is checked against
  `Content-Length` before reading, and again against the actual bytes read —
  but a request sent with `Transfer-Encoding: chunked` and no
  `Content-Length` header would skip the first check and still be fully
  buffered into memory by `StreamReader.ReadToEnd()` before the second check
  catches it. `fetch()` with a plain JSON string body (what
  `windows-hud-bridge.js` sends) does not do this, so it isn't reachable
  from the real client — flagged as a defense-in-depth gap for anyone else
  who might POST to this endpoint, not a live exploit path today.
- **`takeOverSyncedFocusTimer()` linkType edge case**: when this device takes
  over a Focus session mirrored from another device (an existing multi-device
  feature unrelated to this HUD), `pushHudFocusState()` is called but
  `_hudFocusLinkType` reflects whatever this device last had it set to
  (typically `'none'`), not the *other* device's actual link source — Firebase's
  synced-timer payload doesn't carry that information today. Cosmetic: the
  HUD would omit a "Scheduled routine"/"Learning plan" badge it should show
  in this one cross-device-takeover case, never fabricate a wrong one.
- **`deviceOwned` bridge field is unused**: `windows-hud-bridge.js` sends it
  and the companion's payload validator accepts it, but nothing in
  `ChronaSenseHud.ps1`'s rendering currently reads it. Harmless — reserved
  for a possible future cross-device-mirroring indicator (see the first item
  above) rather than removed, since the field is cheap and already
  plumbed through.
- **Expanded/collapsed position drift**: dragging while expanded and then
  collapsing (or vice versa) does not preserve the exact on-screen point the
  user dragged to — only the window's top-left `Left`/`Top` is persisted, so
  a subsequent size change (collapse ↔ expand) can shift which screen
  position the *visible content* appears at by the size delta, especially
  near a screen edge where `Clamp-WindowToScreen` may re-anchor it. Not
  disorienting in practice (the HUD stays in the same general corner) but
  not pixel-exact either.
