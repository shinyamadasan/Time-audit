import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(dir, '../../playwright-report/task-018-design');
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(path.join(dir, 'comparison.html')).href);
  const imagesReady = () => page.waitForFunction(() => [...document.querySelectorAll('img')].every(img => img.complete && img.naturalWidth > 0));
  await imagesReady();
  await page.locator('#visual-comparison').screenshot({ path: path.join(out, 'contact-sheet.png') });
  for (const [state, label] of [['menu', 'More menu'], ['date', 'Completion date'], ['my-day-focus', 'Within My Day'], ['my-day-full', 'Full My Day'], ['error', 'Error'], ['empty', 'Empty']]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await imagesReady();
    await page.locator('#visual-comparison').screenshot({ path: path.join(out, `comparison-${state}.png`) });
    checks.push({ state, images: await page.locator('img').count() });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Mobile rows', exact: true }).click();
  await imagesReady();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Comparison mobile overflow');
  if (errors.length) throw new Error(errors.join(';'));
  await fs.writeFile(path.join(out, 'comparison-verification.json'), JSON.stringify({ screenshotsLoaded: true, states: checks, mobileOverflow: false, errors }, null, 2));
  console.log(JSON.stringify({ screenshotsLoaded: true, stateCount: checks.length + 1, mobileOverflow: false, browserErrors: errors.length }));
} finally { await browser.close(); }
