// Focused DESIGN artifact checks only. Not a production regression suite or persistence proof.
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(dir, '../../playwright-report/task-018-design');
await fs.mkdir(out, { recursive: true });
const files = { A: 'A-minimal.html', B: 'B-manager.html', C: 'C-triage.html' };
const browser = await chromium.launch({ headless: true });
const measurements = [], checks = [];
let assertions = 0;
function verify(condition, label) { assertions++; if (!condition) throw new Error(label); }
async function state(page) { return page.evaluate(() => designSnapshot()); }
async function undo(page) { await page.getByRole('button', { name: 'Undo', exact: true }).click(); verify((await state(page)).activeIds.length === 22, 'Undo restores task count'); }
async function settled(page, count = 21) { await page.waitForFunction(n => !designSnapshot().pending && designSnapshot().activeIds.length === n, count); }
try {
  for (const [option, file] of Object.entries(files)) {
    for (const [width, height] of [[390, 844], [1440, 900]]) {
      const label = width === 390 ? 'mobile' : 'desktop';
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      const errors = [], requests = [];
      page.on('pageerror', e => errors.push(e.message)); page.on('request', req => requests.push(req.url()));
      await page.addInitScript(() => { Storage.prototype.setItem = () => { throw new Error('Design must not persist'); }; });
      const url = pathToFileURL(path.join(dir, file)).href;
      await page.goto(url);
      await page.locator('[data-complete]').first().waitFor();
      await page.evaluate(() => scrollTo(0, 0));
      verify((await state(page)).source.length === 22, '22 source tasks');
      const original = (await state(page)).source;
      const metric = await page.evaluate(() => {
        const panel = document.querySelector('.study'), rows = [...document.querySelectorAll('.task-row')];
        return { section: panel.getBoundingClientRect().height, rows: rows.map(row => row.getBoundingClientRect().height),
          rowSpan: rows.at(-1).getBoundingClientRect().bottom - rows[0].getBoundingClientRect().top,
          overflow: document.documentElement.scrollWidth > innerWidth,
          targets: [...document.querySelectorAll('.complete-target,.icon-button,.date-button,.title-button')].map(el => ({ w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height })) };
      });
      verify(!metric.overflow, 'No initial horizontal overflow');
      verify(metric.targets.every(t => t.w >= 44 && t.h >= 44), '44px row tap targets');
      await page.screenshot({ path: path.join(out, `${option}-${label}-default.png`) });
      await page.locator('.study').screenshot({ path: path.join(out, `${option}-${label}-component.png`) });
      await page.evaluate(() => scrollTo(0, 0));
      await page.locator('.more-button').first().click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      const menuBox = await menu.boundingBox();
      verify(menuBox.width < width && menuBox.x >= 0 && menuBox.x + menuBox.width <= width && menuBox.y >= 0 && menuBox.y + menuBox.height <= height, 'Anchored menu geometry');
      verify((await page.locator('.study').boundingBox()).height === metric.section, 'Menu does not stretch section');
      await page.screenshot({ path: path.join(out, `${option}-${label}-menu.png`) });
      await page.keyboard.press('ArrowDown');
      verify(await page.evaluate(() => document.activeElement?.textContent.includes('Move to today')), 'Menu arrow navigation');
      await page.keyboard.press('Escape');
      verify(await menu.count() === 0, 'Escape closes More');
      verify(await page.locator('.more-button').first().evaluate(button => button === document.activeElement), 'Focus restored');
      await page.locator('.more-button').first().click();
      await page.getByRole('menuitem', { name: 'Completed on another date…' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      verify(await page.locator('#action-date').inputValue() === '2026-10-15', 'Completion defaults today');
      await page.locator('#action-date').fill('2026-10-16');
      await page.getByRole('button', { name: 'Save completion', exact: true }).click();
      verify(await page.getByRole('dialog').isVisible() && (await state(page)).activeIds.length === 22, 'Future completion date rejected');
      await page.getByRole('button', { name: 'Yesterday', exact: true }).click();
      await page.screenshot({ path: path.join(out, `${option}-${label}-date.png`) });
      const dateBox = await page.getByRole('dialog').boundingBox();
      verify(dateBox.x >= 0 && dateBox.x + dateBox.width <= width && dateBox.y >= 0 && dateBox.y + dateBox.height <= height, 'Date popover geometry');
      await page.getByRole('button', { name: 'Save completion', exact: true }).click();
      await settled(page);
      verify((await state(page)).outcomes[0][1].date === '2026-10-14', 'Reported actual date');
      verify(JSON.stringify((await state(page)).source) === JSON.stringify(original), 'Original source history unchanged');
      await page.screenshot({ path: path.join(out, `${option}-${label}-success.png`) });
      await undo(page);
      const firstId = Number(await page.locator('[data-complete]').first().getAttribute('data-complete'));
      await page.locator('[data-complete]').first().check();
      await settled(page);
      verify((await state(page)).outcomes[0][0] === firstId && (await state(page)).outcomes[0][1].date === '2026-10-15', 'One check completes intended task today');
      await undo(page);
      await page.getByRole('button', { name: 'Fail next action: off', exact: true }).click();
      await page.locator('[data-complete]').first().check();
      await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
      verify((await state(page)).activeIds.length === 22, 'Failed completion retains task');
      await page.screenshot({ path: path.join(out, `${option}-${label}-error.png`) });
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await settled(page); await undo(page);
      for (const [menuName, kind] of [['Move to today', 'move'], ['Not doing this', 'dismiss']]) {
        await page.locator('.more-button').first().click();
        await page.getByRole('menuitem', { name: menuName, exact: true }).click();
        await settled(page);
        verify((await state(page)).outcomes[0][1].kind === kind, menuName);
        await undo(page);
      }
      await page.locator('.more-button').first().click();
      await page.getByRole('menuitem', { name: 'Reschedule…', exact: true }).click();
      await page.getByRole('button', { name: 'Tomorrow', exact: true }).click();
      await page.getByRole('button', { name: 'Reschedule', exact: true }).click();
      await settled(page);
      verify((await state(page)).outcomes[0][1].date === '2026-10-16', 'Reschedule date');
      await undo(page);
      const seen = [];
      do {
        seen.push(...await page.locator('.task-row').evaluateAll(rows => rows.map(row => Number(row.dataset.id))));
        const next = page.getByRole('button', { name: 'Next five tasks', exact: true });
        if (await next.isDisabled()) break;
        await next.click();
      } while (seen.length < 25);
      verify(seen.length === 22 && new Set(seen).size === 22, 'All mock tasks reachable');
      await page.getByRole('button', { name: 'Reset 22 tasks', exact: true }).click();
      const longTitle = page.locator('.title-button').filter({ hasText: option === 'C' ? 'supporting documents' : 'onboarding research' }).first();
      const beforeTitle = await longTitle.boundingBox();
      await longTitle.click();
      verify(await longTitle.getAttribute('aria-expanded') === 'true' && (await longTitle.boundingBox()).height >= beforeTitle.height, 'Full long title available without duplication');
      await page.screenshot({ path: path.join(out, `${option}-${label}-long-title.png`) });
      await page.getByRole('button', { name: 'Reset 22 tasks', exact: true }).click();
      if (option !== 'A') {
        if (option === 'C') await page.getByRole('button', { name: 'Find a task', exact: true }).click();
        await page.getByRole('searchbox', { name: 'Find a task', exact: true }).fill('volunteer');
        verify(await page.locator('.task-row').count() === 1 && await page.locator('.task-title').textContent() === 'Check the volunteer roster', 'Search all records beyond page one');
        await page.getByRole('button', { name: 'Reset 22 tasks', exact: true }).click();
      }
      if (option === 'C') {
        await page.getByRole('button', { name: 'Select', exact: true }).click();
        await page.locator('[data-select]').nth(0).check(); await page.locator('[data-select]').nth(1).check();
        verify(await page.locator('[data-complete]').count() === 5, 'Selection separate from completion');
        await page.screenshot({ path: path.join(out, `C-${label}-selection.png`) });
        await page.getByRole('button', { name: 'Complete 2 today', exact: true }).click();
        await settled(page, 20); await undo(page);
        await page.getByRole('button', { name: 'Reset 22 tasks', exact: true }).click();
      }
      await page.getByRole('button', { name: 'Empty state', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Nothing unfinished', exact: true })).toBeVisible();
      await page.screenshot({ path: path.join(out, `${option}-${label}-empty.png`) });
      verify(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'No end-state horizontal overflow');
      verify(errors.length === 0, 'No browser exceptions: ' + errors.join(';'));
      verify(requests.every(url => url.startsWith('file:')), 'No external requests');
      measurements.push({ option, viewport: { width, height }, fiveRowsHeight: metric.rows.reduce((a, b) => a + b, 0), fiveRowsSpan: metric.rowSpan, rowHeights: metric.rows, sectionHeight: metric.section, viewportFraction: metric.section / height, menuWidth: menuBox.width, dateFormWidth: dateBox.width, horizontalOverflow: false });
      checks.push({ option, viewport: width, assertions, errors, externalRequests: requests.filter(url => !url.startsWith('file:')).length });
      await page.goto(url + '?context=day');
      await page.locator('.study').waitFor();
      await page.screenshot({ path: path.join(out, `${option}-${label}-my-day-full.png`), fullPage: true });
      await page.evaluate(() => { const panel = document.querySelector('.study').getBoundingClientRect(); scrollTo(0, Math.max(0, panel.top + scrollY - 120)); });
      await page.screenshot({ path: path.join(out, `${option}-${label}-my-day-focus.png`) });
      await page.close();
    }
  }
  await fs.writeFile(path.join(out, 'measurements.json'), JSON.stringify(measurements, null, 2) + '\n');
  await fs.writeFile(path.join(out, 'verification.json'), JSON.stringify({ assertions, checks, scope: 'Standalone mocks only; no real persistence or production regression proof' }, null, 2) + '\n');
  console.log(JSON.stringify({ assertions, measurements }, null, 2));
} finally { await browser.close(); }
