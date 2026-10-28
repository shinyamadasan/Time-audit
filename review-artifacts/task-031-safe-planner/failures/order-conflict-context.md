Evidence copy: trailing whitespace normalized for repository hygiene; diagnostic values unchanged.

# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tomorrow-view.spec.js >> Prepared vs draft truth >> a confirmed plan shows Prepared with timed and untimed priorities in chronological order
- Location: tests\tomorrow-view.spec.js:145:3

# Error details

```
Error: {"checkpoint":{"v":1,"owner":"uid_plan-user","targetId":"2026-09-09","targetHeading":"Wednesday, September 9","timezone":"Etc/UTC","items":[{"id":"pmtsz5mo0k9ck","task":"Workout","when":"11:00","done":false,"doneAt":null,"updatedAt":1788890400000,"updatedBy":"device-test"},{"id":"pmtsz5mo0gog2","task":"Call Alyssa","when":"","done":false,"doneAt":null,"updatedAt":1788890400000,"updatedBy":"device-test"}],"mode":"normal","blank":false,"forms":{},"base":"{\"items\":[{\"id\":\"pmtsz5mo0k9ck\",\"task\":\"Workout\",\"when\":\"11:00\",\"done\":false,\"doneAt\":null,\"updatedAt\":1788890400000,\"updatedBy\":\"device-test\"},{\"id\":\"pmtsz5mo0gog2\",\"task\":\"Call Alyssa\",\"when\":\"\",\"done\":false,\"doneAt\":null,\"updatedAt\":1788890400000,\"updatedBy\":\"device-test\"}],\"preparation\":{\"schemaVersion\":1,\"targetDate\":\"2026-09-09\",\"timezone\":\"Etc/UTC\",\"firstPreparedAt\":1788890400000,\"firstPreparedMode\":\"normal\",\"lastPreparedAt\":1788890400000,\"lastPreparedMode\":\"normal\",\"updatedBy\":\"device-test\",\"intentionalBlank\":false,\"routineInstanceIds\":[\"[\\\"routine-1\\\",\\\"2026-09-09\\\"]\"],\"oneOffItemIds\":[\"pmtsz5mo0gog2\",\"pmtsz5mo0k9ck\"],\"firstPreparedBy\":\"device-test\"}}","initial":"{\"items\":[{\"id\":\"pmtsz5mo0k9ck\",\"task\":\"Workout\",\"when\":\"11:00\",\"done\":false,\"doneAt\":null,\"updatedAt\":1788890400000,\"updatedBy\":\"device-test\"},{\"id\":\"pmtsz5mo0gog2\",\"task\":\"Call Alyssa\",\"when\":\"\",\"done\":false,\"doneAt\":null,\"updatedAt\":1788890400000,\"updatedBy\":\"device-test\"}],\"mode\":\"normal\",\"blank\":false,\"forms\":{}}","explicitDay":false,"receipt":{"signature":"{\"items\":[{\"id\":\"pmtsz5mo0k9ck\",\"task\":\"Workout\",\"when\":\"11:00\",\"done\":false,\"doneAt\":null,\"updatedAt\":1788890400000,\"updatedBy\":\"device-test\"},{\"id\":\"pmtsz5mo0gog2\",\"task\":\"Call Alyssa\",\"when\":\"\",\"done\":false,\"doneAt\":null,\"updatedAt\":1788890400000,\"updatedBy\":\"device-test\"}],\"mode\":\"normal\",\"blank\":false,\"forms\":{}}","message":"Saved locally; current plan needs review. This plan changed at source or on another device. Keep your draft and review the latest plan before saving."}},"current":{"items":[{"id":"pmtsz5mo0gog2","task":"Call Alyssa","when":"","done":false,"doneAt":null,"updatedAt":1788890400000,"updatedBy":"device-test"},{"id":"pmtsz5mo0k9ck","task":"Workout","when":"11:00","done":false,"doneAt":null,"updatedAt":1788890400000,"updatedBy":"device-test"}],"preparation":{"schemaVersion":1,"targetDate":"2026-09-09","timezone":"Etc/UTC","firstPreparedAt":1788890400000,"firstPreparedMode":"normal","lastPreparedAt":1788890400000,"lastPreparedMode":"normal","updatedBy":"device-test","intentionalBlank":false,"routineInstanceIds":["[\"routine-1\",\"2026-09-09\"]"],"oneOffItemIds":["pmtsz5mo0gog2","pmtsz5mo0k9ck"],"firstPreparedBy":"device-test"}}}

expect(locator).not.toHaveClass(expected) failed

Locator: locator('#plan-tomorrow-overlay')
Expected pattern: not /open/
Received string: "review-overlay open"
Timeout: 5000ms

Call log:
  - {"checkpoint":{"v":1,"owner":"uid_plan-user","targetId":"2026-09-09","targetHeading":"Wednesday, September 9","timezone":"Etc/UTC","items":[{"id":"pmtsz5mo0k9ck","task":"Workout","when":"11:00","done":false,"doneAt":null,"updatedAt":1788890400000,"updatedBy":"device-test"},{"id":"pmtsz5mo0gog2","task":"Call Alyssa","when":"","done":false,"doneAt":null,"updatedAt":1788890400000,"updatedBy":"device-test"}],"mode":"normal","blank":false,"forms":{},"base":"{\"items\":[{\"id\":\"pmtsz5mo0k9ck\",\"task\":\"Workout\",\"when\":\"11:00\",\"done\":false,\"doneAt\":null,\"updatedAt\":1788890400000,\"updatedBy\":\"device-test\"},{\"id\":\"pmtsz5mo0gog2\",\"task\":\"Call Alyssa\",\"when\":\"\",\"done\":false,\"doneAt\":null,\"updatedAt\":1788890400000,\"updatedBy\":\"device-test\"}],\"preparation\":{\"schemaVersion\":1,\"targetDate\":\"2026-09-09\",\"timezone\":\"Etc/UTC\",\"firstPreparedAt\":1788890400000,\"firstPreparedMode\":\"normal\",\"lastPreparedAt\":1788890400000,\"lastPreparedMode\":\"normal\",\"updatedBy\":\"device-test\",\"intentionalBlank\":false,\"routineInstanceIds\":[\"[\\\"routine-1\\\",\\\"2026-09-09\\\"]\"],\"oneOffItemIds\":[\"pmtsz5mo0gog2\",\"pmtsz5mo0k9ck\"],\"firstPreparedBy\":\"device-test\"}}","initial":"{\"items\":[{\"id\":\"pmtsz5mo0k9ck\",\"task\":\"Workout\",\"when\":\"11:00\",\"done\":false,\"doneAt\":null,\"updatedAt\":1788890400000,\"updatedBy\":\"device-test\"},{\"id\":\"pmtsz5mo0gog2\",\"task\":\"Call Alyssa\",\"when\":\"\",\"done\":false,\"doneAt\":null,\"updatedAt\":1788890400000,\"updatedBy\":\"device-test\"}],\"mode\":\"normal\",\"blank\":false,\"forms\":{}}","explicitDay":false,"receipt":{"signature":"{\"items\":[{\"id\":\"pmtsz5mo0k9ck\",\"task\":\"Workout\",\"when\":\"11:00\",\"done\":false,\"doneAt\":null,\"updatedAt\":1788890400000,\"updatedBy\":\"device-test\"},{\"id\":\"pmtsz5mo0gog2\",\"task\":\"Call Alyssa\",\"when\":\"\",\"done\":false,\"doneAt\":null,\"updatedAt\":1788890400000,\"updatedBy\":\"device-test\"}],\"mode\":\"normal\",\"blank\":false,\"forms\":{}}","message":"Saved locally; current plan needs review. This plan changed at source or on another device. Keep your draft and review the latest plan before saving."}},"current":{"items":[{"id":"pmtsz5mo0gog2","task":"Call Alyssa","when":"","done":false,"doneAt":null,"updatedAt":1788890400000,"updatedBy":"device-test"},{"id":"pmtsz5mo0k9ck","task":"Workout","when":"11:00","done":false,"doneAt":null,"updatedAt":1788890400000,"updatedBy":"device-test"}],"preparation":{"schemaVersion":1,"targetDate":"2026-09-09","timezone":"Etc/UTC","firstPreparedAt":1788890400000,"firstPreparedMode":"normal","lastPreparedAt":1788890400000,"lastPreparedMode":"normal","updatedBy":"device-test","intentionalBlank":false,"routineInstanceIds":["[\"routine-1\",\"2026-09-09\"]"],"oneOffItemIds":["pmtsz5mo0gog2","pmtsz5mo0k9ck"],"firstPreparedBy":"device-test"}}} with timeout 5000ms
  - waiting for locator('#plan-tomorrow-overlay')
    14 × locator resolved to <div id="plan-tomorrow-overlay" class="review-overlay open">…</div>
       - unexpected value "review-overlay open"

```

```yaml
- dialog "Plan tomorrow":
  - text: Preparation, not execution Plan tomorrow Wednesday, September 9 · Etc/UTC Not ready · not prepared
  - button "Close"
  - button "Plan"
  - button "Rescue / minimum"
  - paragraph: This plan changed at source or on another device. Keep your draft and review the latest plan before saving.
  - button "Review latest plan"
  - heading "Tomorrow's Plan 2/3" [level=3]
  - paragraph: Top priorities · choose up to three clear outcomes.
  - text: Workout 11:00 AM
  - button "Change time for Workout": Change
  - button "Remove time for Workout": Remove time
  - group: Edit headline & notes
  - button "Make task"
  - button "✕"
  - text: Call Alyssa
  - button "Set time for Call Alyssa": + Add time
  - group: Edit headline & notes
  - button "Make task"
  - button "✕"
  - textbox "when (optional)"
  - textbox "one priority"
  - button "Add"
  - group: Other planned tasks 0
  - group: Routines already included 1
  - group: Unfinished work and today's review
  - group
  - alert
  - status: Saved locally; current plan needs review. This plan changed at source or on another device. Keep your draft and review the latest plan before saving.
  - button "Cancel"
  - button "Tomorrow is ready" [disabled]
```

# Test source

```ts
  55  |   appUrl = `http://127.0.0.1:${appServer.address().port}/index.html`;
  56  | });
  57  |
  58  | test.afterAll(async () => {
  59  |   if (appServer) await new Promise(resolve => appServer.close(resolve));
  60  | });
  61  |
  62  | async function openApp(page, { plans = {}, routines = routineState([]), entries = [], deviceId = 'device-test', viewport = null, commitmentsView = null } = {}) {
  63  |   if (viewport) await page.setViewportSize(viewport);
  64  |   await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub }));
  65  |   await page.addInitScript(({ plans, routines, entries, now, deviceId, commitmentsView }) => {
  66  |     const RealDate = Date;
  67  |     window.Date = class MockDate extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
  68  |     localStorage.clear(); sessionStorage.clear();
  69  |     localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
  70  |     localStorage.setItem('ta3-tz:uid_plan-user', 'Etc/UTC');
  71  |     localStorage.setItem('ta3-device-id', deviceId);
  72  |     localStorage.setItem('ta3-settings:uid_plan-user', JSON.stringify({ timezone: 'Etc/UTC', hardMode: true, intervalMin: 30, targetRate: 250, deepGoal: 20, exitDelay: 10, presets: [], activityColors: {}, coachTone: 'analyst', reviewHour: 22, reviewTime: '22:00', sleepTime: '23:00', wakeTime: '07:00', sleepReminderMin: 30, sleepSetupDone: true, templates: [] }));
  73  |     localStorage.setItem('ta3-entries:uid_plan-user', JSON.stringify(entries)); localStorage.setItem('ta3-focus-redemptions', '[]'); localStorage.setItem('ta3-reviews:uid_plan-user', '{}');
  74  |     localStorage.setItem('ta3-plans:uid_plan-user', JSON.stringify(plans));
  75  |     localStorage.setItem('ta3-daily-routines-v1:uid_plan-user', JSON.stringify(routines));
  76  |     if (commitmentsView) localStorage.setItem('ta3-commitments-view', commitmentsView);
  77  |   }, { plans, routines, entries, now: NOW, deviceId, commitmentsView });
  78  |   await page.goto(appUrl);
  79  |   await page.waitForFunction(() => typeof openPlanTomorrow === 'function' && typeof getPlanTomorrowAppContext === 'function');
  80  |   await page.evaluate(() => { document.getElementById('today-commitments').hidden = false; });
  81  |   await expect(page.locator('#signin-overlay')).toBeHidden();
  82  | }
  83  |
  84  | test.describe('Navigation', () => {
  85  |   test('defaults to Today, toggles to Tomorrow and back, and never mutates plan truth', async ({ page }) => {
  86  |     await openApp(page, { plans: { [TODAY]: { items: [planItem('t1', 'Existing today task')] } } });
  87  |     await expect(page.locator('#today-commitments-today')).toBeVisible();
  88  |     await expect(page.locator('#tomorrow-view')).toBeHidden();
  89  |     await expect(page.locator('#tmr-tab-today')).toHaveAttribute('aria-pressed', 'true');
  90  |     await expect(page.locator('#tmr-tab-tomorrow')).toHaveAttribute('aria-pressed', 'false');
  91  |
  92  |     const before = await page.evaluate(() => localStorage.getItem('ta3-plans:uid_plan-user'));
  93  |     await page.locator('#tmr-tab-tomorrow').click();
  94  |     await expect(page.locator('#tomorrow-view')).toBeVisible();
  95  |     await expect(page.locator('#today-commitments-today')).toBeHidden();
  96  |     await expect(page.locator('#tmr-tab-tomorrow')).toHaveAttribute('aria-pressed', 'true');
  97  |     await expect(page.locator('#tmr-tab-today')).toHaveAttribute('aria-pressed', 'false');
  98  |
  99  |     await page.locator('#tmr-tab-today').click();
  100 |     await expect(page.locator('#today-commitments-today')).toBeVisible();
  101 |     await expect(page.locator('#tomorrow-view')).toBeHidden();
  102 |     await page.locator('#tmr-tab-tomorrow').click();
  103 |     await page.locator('#tmr-tab-today').click();
  104 |
  105 |     const after = await page.evaluate(() => localStorage.getItem('ta3-plans:uid_plan-user'));
  106 |     expect(after).toBe(before);
  107 |     await expect(page.locator('#plan-strip')).toContainText('Existing today task');
  108 |   });
  109 |
  110 |   test('an already-persisted Tomorrow preference cannot hide the primary My Day on load', async ({ page }) => {
  111 |     await openApp(page, { plans: { [TODAY]: { items: [planItem('t1', 'kept')] } }, commitmentsView: 'tomorrow' });
  112 |     const before = await page.evaluate(() => localStorage.getItem('ta3-plans:uid_plan-user'));
  113 |     await expect(page.locator('#tomorrow-view')).toBeHidden();
  114 |     await expect(page.locator('#today-commitments-today')).toBeVisible();
  115 |     await expect(page.locator('#tmr-tab-today')).toHaveAttribute('aria-pressed', 'true');
  116 |     const after = await page.evaluate(() => localStorage.getItem('ta3-plans:uid_plan-user'));
  117 |     expect(after).toBe(before);
  118 |   });
  119 |
  120 |   test('is keyboard operable', async ({ page }) => {
  121 |     await openApp(page);
  122 |     await page.locator('#tmr-tab-tomorrow').focus();
  123 |     await page.keyboard.press('Enter');
  124 |     await expect(page.locator('#tomorrow-view')).toBeVisible();
  125 |   });
  126 | });
  127 |
  128 | test.describe('Prepared vs draft truth', () => {
  129 |   test('no plan at all shows the honest not-prepared empty state', async ({ page }) => {
  130 |     await openApp(page);
  131 |     await page.locator('#tmr-tab-tomorrow').click();
  132 |     await expect(page.locator('.tmr-empty')).toHaveText('Tomorrow hasn’t been prepared yet.');
  133 |     await expect(page.locator('[data-tmr-action="open"]')).toHaveText('Plan tomorrow');
  134 |     await expect(page.locator('.tmr-status')).toHaveCount(0);
  135 |   });
  136 |
  137 |   test('content exists but preparation was never confirmed is labeled honestly, not "Prepared"', async ({ page }) => {
  138 |     await openApp(page, { plans: { [TARGET]: { items: [planItem('p1', 'Unconfirmed priority')], updatedAt: NOW } } });
  139 |     await page.locator('#tmr-tab-tomorrow').click();
  140 |     await expect(page.locator('.tmr-status')).toHaveText('Not yet prepared');
  141 |     await expect(page.locator('.tmr-row-title')).toContainText('Unconfirmed priority');
  142 |     await expect(page.locator('[data-tmr-action="open"]')).toHaveText('Edit tomorrow');
  143 |   });
  144 |
  145 |   test('a confirmed plan shows Prepared with timed and untimed priorities in chronological order', async ({ page }) => {
  146 |     await openApp(page, { routines: routineState([routine()]) });
  147 |     await page.evaluate(() => openPlanTomorrow());
  148 |     await page.locator('#plan-tomorrow-add input[name="when"]').fill('11:00');
  149 |     await page.locator('#plan-tomorrow-add input[name="task"]').fill('Workout');
  150 |     await page.locator('#plan-tomorrow-add').getByRole('button', { name: 'Add' }).click();
  151 |     await page.locator('#plan-tomorrow-add input[name="task"]').fill('Call Alyssa');
  152 |     await page.locator('#plan-tomorrow-add').getByRole('button', { name: 'Add' }).click();
  153 |     await page.getByRole('button', { name: 'Tomorrow is ready' }).click();
  154 |     const sourceEvidence = await page.evaluate(() => ({ checkpoint: JSON.parse(sessionStorage.getItem('ta3-plan-tomorrow-draft-v1:uid_plan-user') || 'null'), current: { items: PlanAuthority.rawItems(PlanAuthority.upcoming()), preparation: PlanAuthority.preparation(PlanAuthority.upcoming()) } }));
> 155 |     await expect(page.locator('#plan-tomorrow-overlay'), JSON.stringify(sourceEvidence)).not.toHaveClass(/open/);
      |                                                                                              ^ Error: {"checkpoint":{"v":1,"owner":"uid_plan-user","targetId":"2026-09-09","targetHeading":"Wednesday, September 9","timezone":"Etc/UTC","items":[{"id":"pmtsz5mo0k9ck","task":"Workout","when":"11:00","done":false,"doneAt":null,"updatedAt":1788890400000,"updatedBy":"device-test"},{"id":"pmtsz5mo0gog2","task":"Call Alyssa","when":"","done":false,"doneAt":null,"updatedAt":1788890400000,"updatedBy":"device-test"}],"mode":"normal","blank":false,"forms":{},"base":"{\"items\":[{\"id\":\"pmtsz5mo0k9ck\",\"task\":\"Workout\",\"when\":\"11:00\",\"done\":false,\"doneAt\":null,\"updatedAt\":1788890400000,\"updatedBy\":\"device-test\"},{\"id\":\"pmtsz5mo0gog2\",\"task\":\"Call Alyssa\",\"when\":\"\",\"done\":false,\"doneAt\":null,\"updatedAt\":1788890400000,\"updatedBy\":\"device-test\"}],\"preparation\":{\"schemaVersion\":1,\"targetDate\":\"2026-09-09\",\"timezone\":\"Etc/UTC\",\"firstPreparedAt\":1788890400000,\"firstPreparedMode\":\"normal\",\"lastPreparedAt\":1788890400000,\"lastPreparedMode\":\"normal\",\"updatedBy\":\"device-test\",\"intentionalBlank\":false,\"routineInstanceIds\":[\"[\\\"routine-1\\\",\\\"2026-09-09\\\"]\"],\"oneOffItemIds\":[\"pmtsz5mo0gog2\",\"pmtsz5mo0k9ck\"],\"firstPreparedBy\":\"device-test\"}}","initial":"{\"items\":[{\"id\":\"pmtsz5mo0k9ck\",\"task\":\"Workout\",\"when\":\"11:00\",\"done\":false,\"doneAt\":null,\"updatedAt\":1788890400000,\"updatedBy\":\"device-test\"},{\"id\":\"pmtsz5mo0gog2\",\"task\":\"Call Alyssa\",\"when\":\"\",\"done\":false,\"doneAt\":null,\"updatedAt\":1788890400000,\"updatedBy\":\"device-test\"}],\"mode\":\"normal\",\"blank\":false,\"forms\":{}}","explicitDay":false,"receipt":{"signature":"{\"items\":[{\"id\":\"pmtsz5mo0k9ck\",\"task\":\"Workout\",\"when\":\"11:00\",\"done\":false,\"doneAt\":null,\"updatedAt\":1788890400000,\"updatedBy\":\"device-test\"},{\"id\":\"pmtsz5mo0gog2\",\"task\":\"Call Alyssa\",\"when\":\"\",\"done\":false,\"doneAt\":null,\"updatedAt\":1788890400000,\"updatedBy\":\"device-test\"}],\"mode\":\"normal\",\"blank\":false,\"forms\":{}}","message":"Saved locally; current plan needs review. This plan changed at source or on another device. Keep your draft and review the latest plan before saving."}},"current":{"items":[{"id":"pmtsz5mo0gog2","task":"Call Alyssa","when":"","done":false,"doneAt":null,"updatedAt":1788890400000,"updatedBy":"device-test"},{"id":"pmtsz5mo0k9ck","task":"Workout","when":"11:00","done":false,"doneAt":null,"updatedAt":1788890400000,"updatedBy":"device-test"}],"preparation":{"schemaVersion":1,"targetDate":"2026-09-09","timezone":"Etc/UTC","firstPreparedAt":1788890400000,"firstPreparedMode":"normal","lastPreparedAt":1788890400000,"lastPreparedMode":"normal","updatedBy":"device-test","intentionalBlank":false,"routineInstanceIds":["[\"routine-1\",\"2026-09-09\"]"],"oneOffItemIds":["pmtsz5mo0gog2","pmtsz5mo0k9ck"],"firstPreparedBy":"device-test"}}}
  156 |
  157 |     await page.locator('#tmr-tab-tomorrow').click();
  158 |     await expect(page.locator('.tmr-status')).toHaveText('Prepared');
  159 |     await expect(page.locator('.tmr-date')).toContainText('Wednesday, September 9');
  160 |     const rows = page.locator('.tmr-row-title');
  161 |     await expect(rows.nth(0)).toHaveText('Deep work'); // 9:00 routine
  162 |     await expect(rows.nth(1)).toHaveText('Workout'); // 11:00 timed one-off
  163 |     await expect(rows.nth(2)).toHaveText('Call Alyssa'); // untimed, stable order
  164 |     await expect(page.locator('.tmr-row-time').nth(1)).toHaveText('11:00 AM');
  165 |     await expect(page.locator('.tmr-row-time').nth(2)).toHaveText('—');
  166 |     await expect(page.locator('[data-tmr-action="open"]')).toHaveText('Edit tomorrow');
  167 |   });
  168 |
  169 |   test('an explicit Open Day is shown distinctly, never inferred from zero items', async ({ page }) => {
  170 |     await openApp(page);
  171 |     await page.evaluate(() => openPlanTomorrow());
  172 |     await page.getByRole('button', { name: 'Rescue / minimum' }).click();
  173 |     await page.locator('#plan-tomorrow-overlay').getByRole('button', { name: 'Open day / no commitments' }).click();
  174 |     await page.getByRole('button', { name: 'Use this plan' }).click();
  175 |     await expect(page.locator('#plan-tomorrow-overlay')).not.toHaveClass(/open/);
  176 |
  177 |     await page.locator('#tmr-tab-tomorrow').click();
  178 |     await expect(page.locator('.tmr-open-day')).toHaveText('Tomorrow is an Open Day.');
  179 |     await expect(page.locator('.tmr-empty')).toHaveCount(0);
  180 |     await expect(page.locator('[data-tmr-action="open"]')).toHaveText('Edit tomorrow');
  181 |   });
  182 | });
  183 |
  184 | test.describe('Plan projection', () => {
  185 |   test('same-title carried and manual items both stay visible, never deduplicated', async ({ page }) => {
  186 |     await openApp(page, {
  187 |       plans: { [TARGET]: { items: [
  188 |         planItem('carry:2026-09-08:open-1', 'Write follow-up', { carriedFromId: 'open-1' }),
  189 |         planItem('manual-1', 'Write follow-up')
  190 |       ] } }
  191 |     });
  192 |     await page.locator('#tmr-tab-tomorrow').click();
  193 |     await expect(page.locator('.tmr-row-title')).toHaveCount(2);
  194 |     const texts = await page.locator('.tmr-row-title').allTextContents();
  195 |     expect(texts).toEqual(['Write follow-up', 'Write follow-up']);
  196 |   });
  197 |
  198 |   test('a deleted tomorrow item never appears, and a plan left with nothing active is the honest empty state', async ({ page }) => {
  199 |     await openApp(page, { plans: { [TARGET]: { items: [planItem('gone', 'Removed', { deleted: true })] } } });
  200 |     await page.locator('#tmr-tab-tomorrow').click();
  201 |     await expect(page.locator('.tmr-row-title')).toHaveCount(0);
  202 |     await expect(page.locator('.tmr-empty')).toHaveText('Tomorrow hasn’t been prepared yet.');
  203 |   });
  204 |
  205 |   test('a deleted tomorrow item never appears alongside real content', async ({ page }) => {
  206 |     await openApp(page, { plans: { [TARGET]: { items: [
  207 |       planItem('gone', 'Removed', { deleted: true }),
  208 |       planItem('kept', 'Kept priority')
  209 |     ] } } });
  210 |     await page.locator('#tmr-tab-tomorrow').click();
  211 |     await expect(page.locator('.tmr-row-title')).toHaveCount(1);
  212 |     await expect(page.locator('.tmr-row-title')).toHaveText('Kept priority');
  213 |   });
  214 |
  215 |   test('a routine not occurring tomorrow (wrong weekday) is excluded; one that does occur is shown', async ({ page }) => {
  216 |     // 2026-09-09 is a Wednesday (day 3). "selected" days [1] = Monday only, never fires tomorrow.
  217 |     await openApp(page, { routines: routineState([
  218 |       routine({ id: 'mon-only', title: 'Monday only', cadence: 'selected', days: [1] }),
  219 |       routine({ id: 'daily-one', title: 'Every day', cadence: 'daily' })
  220 |     ]) });
  221 |     await page.locator('#tmr-tab-tomorrow').click();
  222 |     await expect(page.locator('.tmr-row-title')).toHaveCount(1);
  223 |     await expect(page.locator('.tmr-row-title')).toHaveText('Every day');
  224 |   });
  225 |
  226 |   test('a skipped-tomorrow routine instance is excluded from the projection', async ({ page }) => {
  227 |     await openApp(page, {
  228 |       plans: { [TARGET]: { items: [planItem('p1', 'Keeps this state out of the empty branch')] } },
  229 |       routines: routineState([routine()], 'Etc/UTC', { skips: { '["routine-1","2026-09-09"]': { skippedAt: NOW, updatedAt: NOW } } })
  230 |     });
  231 |     await page.locator('#tmr-tab-tomorrow').click();
  232 |     await expect(page.locator('text=No routines occur on this date.')).toBeVisible();
  233 |     await expect(page.locator('.tmr-row-title')).toHaveText('Keeps this state out of the empty branch');
  234 |   });
  235 | });
  236 |
  237 | test.describe('Read-only guarantee', () => {
  238 |   test('opening, toggling, and reopening Tomorrow writes nothing to plan storage', async ({ page }) => {
  239 |     await openApp(page, {
  240 |       plans: { [TARGET]: { items: [planItem('p1', 'Untouched')], updatedAt: NOW } },
  241 |       routines: routineState([routine()])
  242 |     });
  243 |     const snapshot = () => page.evaluate(() => ({ plans: localStorage.getItem('ta3-plans:uid_plan-user'), routines: localStorage.getItem('ta3-daily-routines-v1:uid_plan-user') }));
  244 |     const before = await snapshot();
  245 |     for (let i = 0; i < 3; i++) {
  246 |       await page.locator('#tmr-tab-tomorrow').click();
  247 |       await page.locator('#tmr-tab-today').click();
  248 |     }
  249 |     const after = await snapshot();
  250 |     expect(after).toEqual(before);
  251 |   });
  252 | });
  253 |
  254 | test.describe('Edit handoff', () => {
  255 |   test('"Plan tomorrow" and "Edit tomorrow" both open the existing Plan Tomorrow flow, never a new editor', async ({ page }) => {
```
