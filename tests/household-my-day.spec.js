// Household My Day V1 — integration against the real ChronaSense RTDB rules and the real Meal Prep
// Auth/Firestore rules (emulators). Synthetic identities only; every non-loopback request fails the test.
import {test, expect} from '@playwright/test';
import {startHouseholdEnv, mealPut, mealReadAs, FOOD, PEOPLE, MEAL} from './household-env.mjs';
import {token} from '../rtdb-emulator-support.js';

test.describe.configure({mode: 'serial'});
test.setTimeout(90000);
let env;
test.beforeAll(async ({browser}) => {
  env = await startHouseholdEnv();
  // Each person's own client publishes their day once (Alyssa first, so mine sees hers).
  for (const who of ['alyssa', 'me']) {
    const {context, page} = await open(browser, who);
    await page.waitForTimeout(1500);
    await context.close();
  }
});
test.afterAll(async () => { await env?.stop(); });

async function open(browser, who = 'me', {viewport, clock} = {}) {
  const context = await browser.newContext(viewport ? {viewport} : {});
  const page = await context.newPage();
  if (clock) await page.clock.install();
  const outside = [];
  page.on('request', request => {
    const url = new URL(request.url());
    // Static fonts are the only expected outside asset (blocked anyway); any data/auth host is a failure.
    if (/firebase|firestore|identitytoolkit|securetoken|cloudfunctions|run\.app|workers\.dev/.test(url.hostname)
      || (url.hostname.endsWith('googleapis.com') && url.hostname !== 'fonts.googleapis.com')) outside.push(request.url());
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, route => route.abort());
  await page.goto(env.url(who));
  await page.waitForFunction(uid => localStorage.getItem('household-preview-seeded:' + uid) === '1', PEOPLE[who].uid, {timeout: 30000});
  await expect(page.locator('#household-mine li')).toHaveCount(5, {timeout: 15000});
  return {context, page, outside};
}
async function connectMeal(page, email, password = MEAL.password) {
  const form = page.getByRole('form', {name: 'Connect Meal Prep'});
  await form.getByLabel('Meal Prep email').fill(email);
  await form.getByLabel('Meal Prep password').fill(password);
  await form.getByRole('button', {name: 'Connect Meal Prep'}).click();
}
const partnerCard = page => page.locator('#household-partner');
const foodCard = page => page.locator('#household-food');

test('three sections: all own tasks, Alyssa’s full shared list, and Meal Prep food after sign-in', async ({browser}) => {
  const {context, page, outside} = await open(browser);
  await expect(page.locator('#household-mine li')).toHaveCount(5);
  await expect(partnerCard(page).getByRole('heading')).toHaveText('Alyssa (demo)’s daily tasks');
  await expect(partnerCard(page).locator('li')).toHaveCount(5);
  await expect(partnerCard(page).locator('li', {hasText: 'Book the vet'})).toContainText('Done');
  await expect(partnerCard(page).locator('li', {hasText: 'Pick up groceries'})).toContainText('17:00');
  await expect(partnerCard(page).locator('button,input,select,textarea,a[href],[tabindex]')).toHaveCount(0); // strictly read only
  await expect(foodCard(page)).toContainText('Sign in with your Meal Prep account');
  await connectMeal(page, PEOPLE.me.email);
  const meals = foodCard(page).locator('ul').nth(0).locator('li');
  await expect(meals).toHaveText([/Lentil curry1 day left1 portion · fridge/, /Chicken and rice4 days left4 portions · fridge/, /Vegetable soup58 days left2 portions · freezer/]);
  await expect(foodCard(page).locator('ul').nth(1).locator('li')).toHaveText([/Eggs6 pieces/, /Rice2 kg/, /Spinach1 bag/]);
  await expect(foodCard(page)).not.toContainText('Old pasta bake');
  await expect(foodCard(page)).not.toContainText('Finished stew');
  await expect(foodCard(page)).not.toContainText('Used-up flour');
  expect(outside).toEqual([]);
  await context.close();
});

test('own Start, Stop and Mark done use the existing handlers; one entry is logged and state survives reload', async ({browser}) => {
  const {context, page} = await open(browser, 'me', {clock: true});
  const row = page.locator('#household-mine li', {hasText: 'Review the budget'});
  await row.getByRole('button', {name: 'Start: Review the budget'}).click();
  await expect(row).toContainText('Tracking now');
  await expect.poll(() => page.evaluate(() => running && typeof currentTaskPlanItemId === 'string')).toBe(true);
  await page.clock.fastForward('02:05'); // sessions under a minute are intentionally not logged
  await row.getByRole('button', {name: 'Stop: Review the budget'}).click();
  await expect.poll(() => page.evaluate(() => running)).toBe(false);
  await expect(row.getByRole('button', {name: 'Start: Review the budget'})).toBeVisible();
  await expect.poll(() => page.evaluate(() => entries.filter(e => !e.deleted && e.activity === 'Review the budget')
    .map(e => [e.blockIntervalMin, typeof e.planItemId]))).toEqual([[2, 'string']]);
  await row.getByRole('button', {name: 'Mark done: Review the budget'}).click();
  await expect(row).toContainText('Done');
  await page.reload();
  await expect(page.locator('#household-mine li', {hasText: 'Review the budget'})).toContainText('Done', {timeout: 15000});
  await page.locator('#household-mine li', {hasText: 'Review the budget'}).getByRole('button', {name: 'Reopen: Review the budget'}).click();
  await context.close();
});

test('Alyssa’s changes reach my dashboard live; her Settings › Partner consent removes and restores the full list', async ({browser}) => {
  const me = await open(browser, 'me');
  const her = await open(browser, 'alyssa');
  await her.page.locator('#household-mine li', {hasText: 'Pick up groceries'}).getByRole('button', {name: 'Mark done: Pick up groceries'}).click();
  await expect(partnerCard(me.page).locator('li', {hasText: 'Pick up groceries'})).toContainText('Done', {timeout: 15000});
  await her.page.evaluate(() => { const t = PlanAuthority.current(); PlanAuthority.addItem({destination: t, item: createPlanItem('Call mum', '19:00', 'task')}); refreshAuthoritativePlanSurfaces(); });
  await expect(partnerCard(me.page).locator('li')).toHaveCount(6, {timeout: 15000});
  await expect(partnerCard(me.page).locator('li', {hasText: 'Call mum'})).toContainText('19:00');
  // Revoke: her own consent control, which lives only in her Settings › Partner.
  await expect(her.page.locator('#household-dashboard input[type=checkbox]')).toHaveCount(0);
  await her.page.evaluate(() => showView('settings'));
  const share = her.page.locator('#partner-share-daily-tasks');
  await expect(share).toBeChecked();
  await share.uncheck();
  await expect(partnerCard(me.page)).toContainText('isn’t sharing their full daily list', {timeout: 15000});
  await expect(partnerCard(me.page).locator('li')).toHaveCount(0);
  await expect(partnerCard(me.page).locator('button,input,select,textarea,a[href],[tabindex]')).toHaveCount(0);
  await share.check();
  await expect(partnerCard(me.page).locator('li')).toHaveCount(6, {timeout: 15000});
  await her.page.evaluate(() => showView('today'));
  // Tidy for later tests.
  await her.page.locator('#household-mine li', {hasText: 'Pick up groceries'}).getByRole('button', {name: 'Reopen: Pick up groceries'}).click();
  await her.context.close(); await me.context.close();
});

test('rules: only the reciprocal partner can read the shared day; unlinking removes Alyssa’s tasks', async ({browser}) => {
  const shared = uid => `http://127.0.0.1:${env.emulatorPort}/uid_${PEOPLE.alyssa.uid}/shared.json?ns=${env.rtdb.name}&auth=${token(uid)}`;
  expect((await fetch(shared(PEOPLE.me.uid))).status).toBe(200);
  expect((await fetch(shared('mallory'))).status).toBe(401);
  const privatePlans = `http://127.0.0.1:${env.emulatorPort}/rooms/uid_${PEOPLE.alyssa.uid}/plans.json?ns=${env.rtdb.name}&auth=${token(PEOPLE.me.uid)}`;
  expect((await fetch(privatePlans)).status).toBe(401); // the partner never reads her private plan store

  const {context, page} = await open(browser);
  await expect(partnerCard(page).locator('li')).toHaveCount(6);
  await env.rtdb.seed(`uid_${PEOPLE.alyssa.uid}/partnerUid`, null); // Alyssa disconnects on her side
  await expect(partnerCard(page).locator('li')).toHaveCount(0, {timeout: 15000});
  await expect(partnerCard(page)).toContainText(/unavailable|Connect a partner/);
  expect((await fetch(shared(PEOPLE.me.uid))).status).toBe(401);
  await env.rtdb.seed(`uid_${PEOPLE.alyssa.uid}/partnerUid`, PEOPLE.me.uid);
  await context.close();
});

test('Meal Prep: live inventory updates, own-account-only rules, mismatched account and sign-out never show food', async ({browser}) => {
  // Meal Prep's own rules: one member cannot read the other's food document.
  expect(await mealReadAs(env.meal.me.idToken, env.meal.alyssa.uid)).toBe(403);
  expect(await mealReadAs(env.meal.me.idToken, env.meal.me.uid)).toBe(200);

  const {context, page} = await open(browser);
  await connectMeal(page, PEOPLE.me.email);
  await expect(foodCard(page)).toContainText('Chicken and rice');
  const food = FOOD.me();
  food.cookedMeals.push({id: 'm9', name: 'Fish tacos', cookedDate: food.cookedMeals[0].cookedDate, storage: 'fridge', fridgeLife: 2, freezerLife: 30, initialPortions: 3, portionsRemaining: 3});
  food.cookedMeals[0].portionsRemaining = 0; // chicken and rice eaten
  await mealPut(env.meal.me.uid, food);
  await expect(foodCard(page)).toContainText('Fish tacos2 days left3 portions · fridge', {timeout: 15000});
  await expect(foodCard(page)).not.toContainText('Chicken and rice');
  await mealPut(env.meal.me.uid, FOOD.me());

  await foodCard(page).getByRole('button', {name: 'Disconnect Meal Prep'}).click();
  await expect(foodCard(page).locator('li')).toHaveCount(0);
  // A different person's Meal Prep account is refused (identity is bound by email across projects).
  await connectMeal(page, PEOPLE.alyssa.email);
  await expect(foodCard(page)).toContainText('does not match this ChronaSense account');
  await expect(foodCard(page).locator('li')).toHaveCount(0);
  await connectMeal(page, PEOPLE.me.email, 'wrong-password');
  await expect(foodCard(page).locator('li')).toHaveCount(0);
  await connectMeal(page, PEOPLE.me.email);
  await expect(foodCard(page)).toContainText('Lentil curry');
  // ChronaSense sign-out ends the Meal Prep session too.
  await page.evaluate(() => __householdTest.auth.signOut());
  await expect(foodCard(page).locator('li')).toHaveCount(0, {timeout: 10000});
  await expect(partnerCard(page).locator('li')).toHaveCount(0);
  await context.close();
});

test('loading and failure states: Meal Prep unreachable shows a message, never an empty kitchen', async ({browser}) => {
  const {context, page} = await open(browser);
  await page.route(`http://127.0.0.1:${MEAL.firestorePort}/**`, route => route.abort());
  await connectMeal(page, PEOPLE.me.email);
  await expect(foodCard(page)).toContainText(/Loading food from Meal Prep|Offline|could not be read/);
  await page.waitForTimeout(3000);
  await expect(foodCard(page).locator('li')).toHaveCount(0);
  await expect(foodCard(page)).not.toContainText('No prepared meals');
  await context.close();
});

test('secondary tools stay reachable and the layout holds at 360px', async ({browser}) => {
  const {context, page} = await open(browser, 'me', {viewport: {width: 360, height: 800}});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const id of ['household-mine', 'household-partner', 'household-food']) await expect(page.locator(`#${id}`)).toBeVisible();
  const tools = page.getByRole('navigation', {name: 'My Day tools'});
  await tools.getByRole('button', {name: 'Time tracking'}).click();
  await expect(page.locator('#household-secondary')).toHaveAttribute('open', '');
  await tools.getByRole('button', {name: 'Plan Tomorrow'}).click();
  await expect(page.locator('#plan-tomorrow-overlay')).toHaveClass(/open/);
  await context.close();
});

test('QA regression: Start works for every own task, including ones the timeline does not render', async ({browser}) => {
  const {context, page} = await open(browser);
  await page.evaluate(() => {
    const t = PlanAuthority.current();
    for (let i = 1; i <= 12; i++) PlanAuthority.addItem({destination: t, item: createPlanItem(`Bulk ${i}`, '', 'task')});
    refreshAuthoritativePlanSurfaces();
  });
  await expect(page.locator('#household-mine li')).toHaveCount(17);
  const rendered = await page.evaluate(() => [...document.querySelectorAll('#timeline-section [data-plan-item-id]')]
    .some(row => PlanAuthority.items(PlanAuthority.current()).find(i => i.id === row.dataset.planItemId)?.task === 'Bulk 12'));
  const row = page.locator('#household-mine li', {hasText: 'Bulk 12'});
  await row.getByRole('button', {name: 'Start: Bulk 12'}).click();
  await expect(row).toContainText('Tracking now');
  expect(await page.evaluate(() => running && PlanAuthority.items(PlanAuthority.current()).find(i => i.id === currentTaskPlanItemId)?.task)).toBe('Bulk 12');
  test.info().annotations.push({type: 'timeline-rendered-bulk-12', description: String(rendered)});
  await row.getByRole('button', {name: 'Stop: Bulk 12'}).click();
  await expect.poll(() => page.evaluate(() => running)).toBe(false);
  await page.evaluate(() => {
    const t = PlanAuthority.current();
    PlanAuthority.saveItems(t, PlanAuthority.rawItems(t).map(i => /^Bulk /.test(i.task) ? stampPlanItemMutation({...i, deleted: true}) : i));
    refreshAuthoritativePlanSurfaces();
  });
  await expect(page.locator('#household-mine li')).toHaveCount(5);
  await context.close();
});

test('QA regression: a Meal Prep sign-in resumes after reload, and keyboard focus survives re-renders', async ({browser}) => {
  const {context, page} = await open(browser);
  await connectMeal(page, PEOPLE.me.email);
  await expect(foodCard(page)).toContainText('Lentil curry');
  await page.reload();
  await expect(foodCard(page)).toContainText('Lentil curry', {timeout: 15000});
  await expect(foodCard(page).getByRole('form', {name: 'Connect Meal Prep'})).toHaveCount(0);

  const markDone = page.getByRole('button', {name: 'Mark done: Water the plants'});
  await markDone.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', {name: 'Reopen: Water the plants'})).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', {name: 'Mark done: Water the plants'})).toBeFocused();

  await context.close();
});

test('mobile: Up Next drives Start/Stop/Done with one hand, section links reach every column, no overflow', async ({browser}) => {
  for (const width of [360, 390, 820]) {
    const {context, page} = await open(browser, 'me', {viewport: {width, height: 800}});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const next = page.getByRole('region', {name: 'Up next'});
    await expect(next).toContainText('Write the project brief');
    const box = await next.getByRole('button', {name: /^Start .*\(Up next\)$/}).boundingBox();
    expect(box.y + box.height).toBeLessThan(800); // Start is on the first screen
    expect(box.height).toBeGreaterThanOrEqual(44);
    for (const [label, id] of [['My tasks', 'household-mine'], ['Alyssa', 'household-partner'], ['Food', 'household-food']]) {
      await page.getByRole('navigation', {name: 'Household sections'}).getByRole('button', {name: new RegExp(`^${label}`)}).click();
      await expect.poll(() => page.evaluate(i => { const t = document.getElementById(i).getBoundingClientRect().top; return t >= -1 && t < innerHeight - 150; }, id)).toBe(true);
    }
    // Every task control is a touch target of at least 44px.
    const small = await page.evaluate(() => [...document.querySelectorAll('#household-dashboard button')]
      .filter(b => b.offsetParent && (b.getBoundingClientRect().height < 44 || b.getBoundingClientRect().width < 44)).map(b => b.getAttribute('aria-label') || b.textContent));
    expect(small).toEqual([]);
    await context.close();
  }
  const {context, page} = await open(browser, 'me', {viewport: {width: 390, height: 844}, clock: true});
  const next = page.getByRole('region', {name: 'Up next'});
  await next.getByRole('button', {name: 'Start Write the project brief (Up next)'}).click();
  await expect(next).toContainText('Tracking now');
  await expect(page.locator('#household-mine li', {hasText: 'Write the project brief'})).toContainText('Tracking now');
  await page.clock.fastForward('02:05');
  await next.getByRole('button', {name: 'Stop Write the project brief (Up next)'}).click();
  await expect.poll(() => page.evaluate(() => running)).toBe(false);
  await next.getByRole('button', {name: 'Mark Write the project brief done (Up next)'}).click();
  await expect(page.locator('#household-mine li', {hasText: 'Write the project brief'})).toContainText('Done', {timeout: 15000});
  await expect(next).not.toContainText('Write the project brief');
  await page.locator('#household-mine li', {hasText: 'Write the project brief'}).getByRole('button', {name: 'Reopen: Write the project brief'}).click();
  await expect(next).toContainText('Write the project brief', {timeout: 15000});
  await context.close();
});

test('QA regression: keyboard Start keeps focus on Stop; idle minutes do not rebuild live lists; no duplicate surfaces', async ({browser}) => {
  const {context, page} = await open(browser, 'me', {viewport: {width: 360, height: 780}, clock: true});
  await expect(page.locator('#household-secondary #accountability-details')).toHaveCount(1);
  const row = page.locator('#household-mine li', {hasText: 'Call the bank'});
  await row.getByRole('button', {name: 'Start: Call the bank'}).focus();
  await page.keyboard.press('Enter');
  await expect(row.getByRole('button', {name: 'Stop: Call the bank'})).toBeFocused();
  await expect(page.locator('#timer-current-task')).toBeHidden();
  await expect(page.locator('#switch-btn')).toBeHidden();
  await page.clock.fastForward('02:05');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => running)).toBe(false);
  await expect(row.getByRole('button', {name: 'Start: Call the bank'})).toBeFocused();

  await page.evaluate(() => {
    globalThis.__liveRebuilds = 0;
    for (const id of ['household-partner-body', 'household-mine-body', 'household-next'])
      new MutationObserver(list => { globalThis.__liveRebuilds += list.length; }).observe(document.getElementById(id), {childList: true});
  });
  await page.clock.fastForward('03:00');
  expect(await page.evaluate(() => globalThis.__liveRebuilds)).toBe(0);
  await expect(partnerCard(page).locator('.household-stamp')).toContainText(/updated \d+ min ago/);
  await context.close();
});
