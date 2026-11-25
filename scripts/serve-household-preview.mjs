// Local Household My Day preview: authenticated emulators, synthetic people and food. Loopback only.
import {chromium} from '@playwright/test';
import {startHouseholdEnv} from '../tests/household-env.mjs';

const env = await startHouseholdEnv({port: Number(process.env.HOUSEHOLD_PREVIEW_PORT || 8770)});

// Prime both synthetic people once through their own app sessions, so each person's tasks are
// created by the app and each shared day is published by that person's own client.
const browser = await chromium.launch({args: ['--host-resolver-rules=MAP *.firebasedatabase.app ~NOTFOUND, MAP *.firebaseio.com ~NOTFOUND, MAP *.googleapis.com ~NOTFOUND']});
for (const who of ['alyssa', 'me']) {
  const page = await browser.newPage();
  await page.goto(env.url(who));
  await page.waitForFunction(() => localStorage.getItem('household-preview-seeded:' + globalThis.__householdTest?.person.uid) === '1', null, {timeout: 60000});
  await page.waitForTimeout(1500); // let the publish reach the emulator
  await page.close();
}
await browser.close();

console.log(`ChronaSense Household My Day (you):  ${env.url('me')}`);
console.log(`Same household as Alyssa:            ${env.url('alyssa')}`);
console.log('Meal Prep sign-in (synthetic): shin@household.test / alyssa@household.test, password ourlife-local-1');
console.log('All data is synthetic; ChronaSense RTDB and Meal Prep Auth/Firestore are local emulators with their real rules.');
process.on('SIGINT', async () => { await env.stop(); process.exit(0); });
