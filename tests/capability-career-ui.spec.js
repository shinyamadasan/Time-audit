import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addCareerTarget,
  addEvidence,
  addProject,
  addSkill,
  addTool,
  createEmptyCapabilityProfile
} from '../capability-career-model.js';
import { CAPABILITY_CAREER_REPOSITORY_KEY } from '../capability-career-repository.js';
import { LIFE_LEDGER_RUNTIME_KEY } from '../life-ledger-runtime.js';
import { deriveLifeLedgerKey, fingerprintLifeLedgerEvent } from '../life-ledger-core.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(ROOT, '..');
let appServer = null;
let appUrl = '';

test.beforeAll(async () => {
  appServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePath = path.resolve(APP_ROOT, `.${decodeURIComponent(pathname)}`);
      if (!filePath.startsWith(APP_ROOT)) {
        res.writeHead(403).end();
        return;
      }
      const body = await fs.readFile(filePath);
      const ext = path.extname(filePath);
      const contentType = ext === '.html' ? 'text/html'
        : ext === '.js' ? 'application/javascript'
          : ext === '.css' ? 'text/css'
            : 'application/octet-stream';
      res.writeHead(200, { 'content-type': contentType });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise(resolve => appServer.listen(0, '127.0.0.1', resolve));
  const address = appServer.address();
  appUrl = `http://127.0.0.1:${address.port}/index.html`;
});

test.afterAll(async () => {
  if (!appServer) return;
  await new Promise(resolve => appServer.close(resolve));
});

const firebaseStub = `
(() => {
  if (window.firebase) return;
  const snapshot = value => ({ val: () => value, ref: { remove: () => Promise.resolve() } });
  const makeRef = refPath => ({
    path: refPath,
    child(childPath) { return makeRef(refPath + '/' + childPath); },
    on(eventName, cb) {
      if (eventName === 'value') setTimeout(() => cb(snapshot(null)), 0);
      return cb;
    },
    off() {},
    once() { return Promise.resolve(snapshot(null)); },
    update() { return Promise.resolve(); },
    set() { return Promise.resolve(); },
    remove() { return Promise.resolve(); },
    push(value) {
      const pushed = makeRef(refPath + '/pushed');
      pushed.key = 'pushed';
      if (value !== undefined) pushed.set(value);
      return pushed;
    },
    onDisconnect() {
      return { set: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() };
    }
  });
  const auth = () => ({
    onAuthStateChanged(cb) {
      setTimeout(() => cb({ uid: 'career-user', displayName: 'Career User', email: 'career@example.test', photoURL: '' }), 0);
      return () => {};
    },
    signInWithPopup() { return Promise.resolve(); },
    signInWithCredential() { return Promise.resolve(); },
    signOut() { return Promise.resolve(); }
  });
  auth.GoogleAuthProvider = function GoogleAuthProvider() {};
  auth.GoogleAuthProvider.credential = () => ({});
  window.firebase = {
    apps: [],
    initializeApp(config) { const app = { config }; this.apps.push(app); return app; },
    app() { return this.apps[0] || this.initializeApp({}); },
    database() { return { ref: makeRef }; },
    auth
  };
})();
`;

function fixedClock(value = '2026-08-30T12:00:00.000Z') {
  return () => value;
}

function sequencedIds(...ids) {
  let index = 0;
  return () => ids[Math.min(index++, ids.length - 1)];
}

function baseSettings() {
  return {
    hardMode: true,
    intervalMin: 30,
    targetRate: 250,
    deepGoal: 20,
    exitDelay: 10,
    presets: [],
    timezone: 'UTC',
    activityColors: {},
    coachTone: 'analyst',
    reviewHour: 22,
    reviewTime: '22:00',
    sleepTime: '23:00',
    wakeTime: '07:00',
    sleepReminderMin: 30,
    sleepSetupDone: true,
    templates: []
  };
}

function profileEnvelope(profile) {
  return JSON.stringify({ schemaVersion: 1, profile });
}

function seededProfile({ withKnowledgeOnly = false, withProjectEvidence = false } = {}) {
  let profile = createEmptyCapabilityProfile({ clock: fixedClock() });
  profile = addSkill(profile, { name: 'JavaScript' }, { idGenerator: sequencedIds('skill-js'), clock: fixedClock() });
  profile = addSkill(profile, { name: 'API integration' }, { idGenerator: sequencedIds('skill-api'), clock: fixedClock() });
  profile = addTool(profile, { name: 'GitHub', skillIds: ['skill-js'] }, { idGenerator: sequencedIds('tool-github'), clock: fixedClock() });
  profile = addCareerTarget(profile, { title: 'Automation developer', skillIds: ['skill-js'], objective: 'Ship useful automations' }, { idGenerator: sequencedIds('target-auto'), clock: fixedClock() });
  profile = addProject(profile, {
    title: 'Adapter project',
    summary: 'A local adapter',
    skillIds: ['skill-js'],
    toolIds: ['tool-github'],
    careerTargetIds: ['target-auto'],
    portfolioStatus: 'candidate'
  }, { idGenerator: sequencedIds('project-adapter'), clock: fixedClock() });
  if (withKnowledgeOnly) {
    profile = addEvidence(profile, { skillId: 'skill-js', dimension: 'knowledge', source: 'manual', summary: 'Studied promises', observedAt: '2026-08-29T12:00:00.000Z' }, { idGenerator: sequencedIds('e-knowledge'), clock: fixedClock() });
    profile = addEvidence(profile, { skillId: 'skill-js', dimension: 'practice', source: 'manual', summary: 'Practiced async code', observedAt: '2026-08-29T12:00:00.000Z' }, { idGenerator: sequencedIds('e-practice'), clock: fixedClock() });
  }
  if (withProjectEvidence) {
    profile = addEvidence(profile, { skillId: 'skill-js', dimension: 'execution', source: 'project', projectId: 'project-adapter', summary: 'Built the adapter', observedAt: '2026-08-29T12:00:00.000Z' }, { idGenerator: sequencedIds('e-project'), clock: fixedClock() });
  }
  return profile;
}

function profileWithLifeLedgerEvidence() {
  let profile = seededProfile();
  profile = addEvidence(profile, {
    skillId: 'skill-js',
    dimension: 'execution',
    source: 'life-ledger',
    summary: 'Linked browser focus as execution proof',
    observedAt: '2026-08-30T16:25:00.000Z',
    lifeLedgerEventId: '50505050-5050-4050-8050-505050505050',
    lifeLedgerKey: 'chronasense:browser-focus-1:focus_session_completed'
  }, { idGenerator: sequencedIds('e-ledger'), clock: fixedClock() });
  return profile;
}

function browserFocusEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: '50505050-5050-4050-8050-505050505050',
    sourceApp: 'chronasense',
    sourceEntityId: 'browser-focus-1',
    type: 'focus_session_completed',
    occurredAt: '2026-08-30T16:25:00.000Z',
    recordedAt: '2026-08-30T16:26:00.000Z',
    revisedAt: null,
    sourceTimezone: 'Etc/UTC',
    payload: {
      activity: 'Browser synthetic focus',
      startedAt: '2026-08-30T16:00:00.000Z',
      endedAt: '2026-08-30T16:25:00.000Z',
      durationMinutes: 25,
      additiveForTimeTotals: false,
      source: { focusEntryId: 'browser-focus-1' }
    },
    provenance: {
      source: 'chronasense',
      sourceRecordKind: 'chronasense.focus_outcome',
      adapterVersion: 'test-v1',
      observedAt: '2026-08-30T16:26:00.000Z',
      captureMethod: 'pomodoro',
      evidence: ['browser.synthetic.focus:1']
    },
    confidence: { score: 1, basis: 'source-recorded' },
    revision: 1,
    tombstone: { active: false, deletedAt: null, reason: null, provenance: null },
    ...overrides
  };
}

function tombstonedBrowserFocusEvent(overrides = {}) {
  return browserFocusEvent({
    tombstone: {
      active: true,
      deletedAt: '2026-08-30T17:00:00.000Z',
      reason: 'user_delete',
      provenance: {
        sourceOperation: 'delete',
        sourceRecordKind: 'chronasense.focus_outcome',
        evidence: ['browser.synthetic.focus:deleted']
      }
    },
    ...overrides
  });
}

function runtimeLedgerEnvelope(events) {
  return JSON.stringify({
    schemaVersion: 1,
    records: events.map(event => ({
      key: deriveLifeLedgerKey(event),
      event,
      fingerprint: fingerprintLifeLedgerEvent(event)
    }))
  });
}

async function openApp(page, { capabilityRaw = null, lifeLedgerRaw = null } = {}) {
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: firebaseStub
  }));
  await page.addInitScript(({ capabilityRaw, lifeLedgerRaw, settings }) => {
    if (localStorage.getItem('ta3-career-ui-test-seeded')) return;
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('ta3-onboarded', '1');
    sessionStorage.setItem('ta3-session-started', '1');
    localStorage.setItem('ta3-tz', 'UTC');
    localStorage.setItem('ta3-settings', JSON.stringify(settings));
    localStorage.setItem('ta3-entries', '[]');
    localStorage.setItem('ta3-focus-redemptions', '[]');
    localStorage.setItem('ta3-plans', '{}');
    localStorage.setItem('ta3-reviews', '{}');
    if (capabilityRaw !== null) localStorage.setItem('ta3-capability-career-v1', capabilityRaw);
    if (lifeLedgerRaw !== null) localStorage.setItem('ta3-life-ledger-v1', lifeLedgerRaw);
    localStorage.setItem('ta3-career-ui-test-seeded', '1');
  }, { capabilityRaw, lifeLedgerRaw, settings: baseSettings() });
  await page.goto(appUrl);
  await page.waitForFunction(() => typeof window.renderCapabilityCareer === 'function');
  await expect(page.locator('#signin-overlay')).toBeHidden();
}

async function openCareer(page) {
  await page.locator('#nav-career').click();
  await expect(page.locator('#view-career')).toHaveClass(/active/);
}

async function storedProfile(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)).profile, CAPABILITY_CAREER_REPOSITORY_KEY);
}

test('manual setup persists target, skill, and evidence through reload', async ({ page }) => {
  await openApp(page);
  await openCareer(page);

  await expect(page.locator('#cap-career-dashboard')).toContainText('No active target yet');
  await page.locator('.cap-career-actions [data-cc-action="open-panel"][data-panel="skill"]').click();
  await page.locator('form[data-cc-form="skill"] input[name="name"]').fill('JavaScript');
  await page.locator('form[data-cc-form="skill"] input[name="category"]').fill('Engineering');
  await page.locator('form[data-cc-form="skill"]').getByRole('button', { name: 'Add skill' }).click();
  await page.locator('.cap-career-actions [data-cc-action="open-panel"][data-panel="target"]').click();
  await page.locator('form[data-cc-form="target"] input[name="title"]').fill('Automation developer');
  await page.locator('form[data-cc-form="target"] input[name="objective"]').fill('Build production automations');
  await page.locator('form[data-cc-form="target"] input[name="skillIds"]').check();
  await page.locator('form[data-cc-form="target"]').getByRole('button', { name: 'Save target' }).click();
  await page.locator('.cap-career-actions [data-cc-action="open-panel"][data-panel="evidence"]').click();
  await page.locator('form[data-cc-form="evidence"] input[name="summary"]').fill('Built a small API client');
  await page.locator('form[data-cc-form="evidence"] select[name="dimension"]').selectOption('execution');
  await page.locator('form[data-cc-form="evidence"]').getByRole('button', { name: 'Save evidence' }).click();

  await expect(page.locator('#cap-career-dashboard')).toContainText('Automation developer');
  await expect(page.locator('#cap-career-dashboard')).toContainText('Execution');
  await page.reload();
  await page.waitForFunction(() => typeof window.renderCapabilityCareer === 'function');
  await openCareer(page);
  await expect(page.locator('#cap-career-dashboard')).toContainText('Automation developer');
  expect((await storedProfile(page)).evidence[0].dimension).toBe('execution');
});

test('quick import previews before persistence and escapes hostile text', async ({ page }) => {
  await openApp(page);
  await openCareer(page);

  await page.getByRole('button', { name: 'Import starter profile' }).click();
  await page.locator('#cap-career-import-text').fill(JSON.stringify({
    skills: [{ name: '<script>alert(1)</script>' }],
    careerTargets: [{ title: 'Builder', skills: ['<script>alert(1)</script>'] }]
  }));
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByRole('region', { name: 'Capability import preview' })).toContainText('1 skills');
  expect(await page.evaluate(key => localStorage.getItem(key), CAPABILITY_CAREER_REPOSITORY_KEY)).toBeNull();

  await page.getByRole('button', { name: 'Save import' }).click();
  await expect(page.locator('#cap-career-dashboard')).toContainText('<script>alert(1)</script>');
  expect(await page.locator('script', { hasText: 'alert(1)' }).count()).toBe(0);
  expect((await storedProfile(page)).skills[0].name).toBe('<script>alert(1)</script>');
});

test('malformed import leaves existing profile unchanged', async ({ page }) => {
  await openApp(page, { capabilityRaw: profileEnvelope(seededProfile()) });
  await openCareer(page);
  const before = await page.evaluate(key => localStorage.getItem(key), CAPABILITY_CAREER_REPOSITORY_KEY);

  await page.getByRole('button', { name: 'Import starter profile' }).click();
  await page.locator('#cap-career-import-text').fill(JSON.stringify({ evidence: [{ skill: 'Missing', dimension: 'knowledge', summary: 'Bad' }] }));
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.locator('#cap-career-error')).toContainText('references missing skill');
  expect(await page.evaluate(key => localStorage.getItem(key), CAPABILITY_CAREER_REPOSITORY_KEY)).toBe(before);
});

test('Life Ledger evidence picker stores only an explicit live reference and does not mutate ledger', async ({ page }) => {
  const ledgerRaw = runtimeLedgerEnvelope([browserFocusEvent(), tombstonedBrowserFocusEvent({
    eventId: '60606060-6060-4060-8060-606060606060',
    sourceEntityId: 'browser-focus-deleted',
    payload: {
      ...browserFocusEvent().payload,
      activity: 'Deleted browser focus',
      source: { focusEntryId: 'browser-focus-deleted' }
    }
  })]);
  await openApp(page, { capabilityRaw: profileEnvelope(seededProfile()), lifeLedgerRaw: ledgerRaw });
  await openCareer(page);

  await page.locator('[data-cc-action="open-evidence"][data-skill-id="skill-js"]').click();
  await page.locator('form[data-cc-form="evidence"] select[name="source"]').selectOption('life-ledger');
  await expect(page.locator('.cap-career-ledger-item')).toContainText('Browser synthetic focus');
  await expect(page.locator('.cap-career-ledger-item')).toHaveCount(1);
  await page.locator('input[name="lifeLedgerEventId"]').check();
  await page.locator('form[data-cc-form="evidence"] select[name="dimension"]').selectOption('execution');
  await page.locator('form[data-cc-form="evidence"] input[name="summary"]').fill('Used focus session as API integration evidence');
  await page.locator('form[data-cc-form="evidence"]').getByRole('button', { name: 'Save evidence' }).click();

  const saved = await storedProfile(page);
  expect(saved.evidence[0]).toMatchObject({
    skillId: 'skill-js',
    source: 'life-ledger',
    dimension: 'execution',
    lifeLedgerEventId: '50505050-5050-4050-8050-505050505050'
  });
  expect(await page.evaluate(key => localStorage.getItem(key), LIFE_LEDGER_RUNTIME_KEY)).toBe(ledgerRaw);
});

test('tombstoned Life Ledger evidence is preserved, excluded, and restored when the event is live again', async ({ page }) => {
  const liveLedgerRaw = runtimeLedgerEnvelope([browserFocusEvent()]);
  const tombstonedLedgerRaw = runtimeLedgerEnvelope([tombstonedBrowserFocusEvent()]);
  await openApp(page, { capabilityRaw: profileEnvelope(profileWithLifeLedgerEvidence()), lifeLedgerRaw: liveLedgerRaw });
  await openCareer(page);

  await expect(page.locator('#cap-career-dashboard')).toContainText('Add portfolio evidence for JavaScript');
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: LIFE_LEDGER_RUNTIME_KEY, raw: tombstonedLedgerRaw });
  await page.evaluate(() => window.renderCapabilityCareer());
  await expect(page.locator('#cap-career-dashboard')).toContainText('Historical evidence held aside');
  await expect(page.locator('#cap-career-dashboard')).toContainText('No current evidence supports the active skills');
  expect((await storedProfile(page)).evidence[0].lifeLedgerEventId).toBe('50505050-5050-4050-8050-505050505050');

  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: LIFE_LEDGER_RUNTIME_KEY, raw: liveLedgerRaw });
  await page.evaluate(() => window.renderCapabilityCareer());
  await expect(page.locator('#cap-career-dashboard')).not.toContainText('Historical evidence held aside');
  await expect(page.locator('#cap-career-dashboard')).toContainText('Add portfolio evidence for JavaScript');
});

test('learning without execution shows application stall and execution next action', async ({ page }) => {
  await openApp(page, { capabilityRaw: profileEnvelope(seededProfile({ withKnowledgeOnly: true })) });
  await openCareer(page);

  await expect(page.locator('#cap-career-dashboard')).toContainText('evidence is learning-focused');
  await expect(page.locator('#cap-career-dashboard')).toContainText('Use JavaScript in a real project block');
  await expect(page.locator('#cap-career-dashboard')).not.toContainText('excellent');
});

test('project execution without portfolio proof recommends documenting proof', async ({ page }) => {
  await openApp(page, { capabilityRaw: profileEnvelope(seededProfile({ withProjectEvidence: true })) });
  await openCareer(page);

  await expect(page.locator('#cap-career-dashboard')).toContainText('Adapter project has progress but is not portfolio-ready');
  await page.locator('[data-cc-action="open-artifact"][data-project-id="project-adapter"]').click();
  await page.locator('form[data-cc-form="artifact"] input[name="label"]').fill('Case study draft');
  await page.locator('form[data-cc-form="artifact"] input[name="reference"]').fill('https://example.test/case-study');
  await page.locator('form[data-cc-form="artifact"]').getByRole('button', { name: 'Add artifact' }).click();
  const saved = await storedProfile(page);
  expect(saved.artifacts[0]).toMatchObject({
    projectId: 'project-adapter',
    label: 'Case study draft',
    reference: 'https://example.test/case-study'
  });
  await expect(page.locator('#cap-career-dashboard')).toContainText('Turn Adapter project into presentable proof');
  await page.getByRole('button', { name: 'Mark portfolio ready' }).click();
  await expect(page.locator('#cap-career-dashboard')).not.toContainText('Turn Adapter project into presentable proof');
  expect((await storedProfile(page)).projects[0].portfolioStatus).toBe('ready');
});

test('Career view remains usable on mobile without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, { capabilityRaw: profileEnvelope(seededProfile({ withKnowledgeOnly: true, withProjectEvidence: true })) });
  await openCareer(page);

  await expect(page.locator('#cap-career-dashboard')).toContainText('Automation developer');
  await page.locator('.cap-career-actions [data-cc-action="open-panel"][data-panel="evidence"]').click();
  await expect(page.locator('form[data-cc-form="evidence"]')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
