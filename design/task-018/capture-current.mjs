// Read-only production UI inspection in a fresh browser with the repository's recording Firebase fixture.
// All external requests are intercepted. No live account, production API or existing browser profile is used.
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'playwright-report/task-018-design/current');
await fs.mkdir(out, { recursive: true });
const spec = await fs.readFile(path.join(root, 'tests/unfinished-ux.spec.js'), 'utf8');
const declaration = spec.slice(spec.indexOf('const firebaseStub = '), spec.indexOf('test.beforeAll('));
const firebaseStub = vm.runInNewContext(`${declaration}; firebaseStub;`);
const server = http.createServer(async (req, res) => {
  try {
    const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (requested === '/' ? '/index.html' : requested));
    if (path.relative(root, file).startsWith('..')) { res.writeHead(403).end(); return; }
    const body = await fs.readFile(file);
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const metrics = [];
try {
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 } });
    let liveRequests = 0;
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(origin)) return route.continue();
      if (url.startsWith('https://www.gstatic.com/firebasejs/')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: firebaseStub });
      liveRequests++;
      return route.abort();
    });
    await page.addInitScript(() => {
      const now = Date.parse('2026-10-15T11:00:00+08:00');
      const RealDate = Date;
      window.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
      localStorage.clear(); sessionStorage.clear();
      localStorage.setItem('ta3-onboarded', '1'); sessionStorage.setItem('ta3-session-started', '1');
      localStorage.setItem('ta3-tz:uid_account-a', 'Asia/Manila');
      localStorage.setItem('ta3-device-id', 'design-only-inspection');
      localStorage.setItem('ta3-settings:uid_account-a', JSON.stringify({ timezone: 'Asia/Manila', intervalMin: 30, deepGoal: 20, sleepSetupDone: true, templates: [], presets: [] }));
      const titles = ['Open play', 'Start AI automation project', 'Review the onboarding research and send the revised automation proposal to the client', 'Tara AI community — 1 hr', 'Fix business dashboard', 'Client follow-up', 'Book dentist appointment', 'Renew home insurance', 'Review the monthly household budget', 'Submit the expense claim', 'Outline workshop exercises', 'Read the project brief', 'Confirm the venue booking', 'Organize interview notes', 'Prepare the grocery list', 'Send the revised contract', 'Plan next week’s training sessions', 'Replace the air filter', 'Check the volunteer roster', 'Back up the family photos', 'Return the library books', 'Schedule the car service'];
      const items = titles.map((task, n) => ({ id: `design-${String(n).padStart(2, '0')}`, task, kind: 'task', done: false, when: '', doneAt: null, updatedAt: 1000, updatedBy: 'design-fixture' }));
      const plans = { '2026-10-11': { items, updatedAt: 1000, updatedBy: 'design-fixture' }, '2026-10-15': { items: [
        { id: 'today-a', task: 'Review client feedback', when: '11:30', durationMinutes: 30, kind: 'priority', done: false },
        { id: 'today-b', task: 'Prepare workshop outline', when: '14:00', durationMinutes: 60, kind: 'task', done: false },
      ], updatedAt: 1000 } };
      localStorage.setItem('ta3-plans:uid_account-a', JSON.stringify(plans));
      localStorage.setItem('ta3-entries:uid_account-a', '[]'); localStorage.setItem('ta3-reviews', '{}');
    });
    await page.goto(origin + '/index.html');
    await page.waitForFunction(() => globalThis.getChronaSenseRoomCode?.() === 'uid_account-a' && !!window.PlanAuthority);
    await page.locator('#signin-overlay').waitFor({ state: 'hidden' });
    const unfinished = page.locator('#unfinished-recovery-section');
    await unfinished.getByRole('button', { name: 'Unfinished · 22', exact: true }).click();
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(out, `my-day-full-${width}.png`), fullPage: true });
    const measured = await unfinished.evaluate(section => ({
      sectionHeight: section.getBoundingClientRect().height,
      rowHeights: [...section.querySelectorAll('.pc-stale-row')].map(row => row.getBoundingClientRect().height),
      topInDocument: section.getBoundingClientRect().top + scrollY,
    }));
    await unfinished.screenshot({ path: path.join(out, `unfinished-${width}.png`) });
    await unfinished.locator('summary').first().click();
    const openHeight = await unfinished.evaluate(section => section.getBoundingClientRect().height);
    await page.screenshot({ path: path.join(out, `my-day-more-${width}.png`), fullPage: true });
    metrics.push({ width, ...measured, menuOpenHeight: openHeight, blockedExternalRequests: liveRequests, liveDataConnections: 0 });
    await page.close();
  }
  await fs.writeFile(path.join(out, 'measurements.json'), JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics, null, 2));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
