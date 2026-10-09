// functions/test/packaging.test.js
//
// A1-01: the Functions deployment package (functions/ only) must be self-contained, and its packaged shared
// domain modules must be exactly the repository-root authority (scripts/functions-shared.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import { builtinModules } from 'node:module';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as rootModel from '../../brain-dump-model.js';
import * as packagedModel from '../shared/brain-dump-model.js';
import * as rootOrigin from '../../plan-item-origin.js';
import * as packagedOrigin from '../shared/plan-item-origin.js';
import { SHARED_FILES, sharedProblems } from '../../scripts/functions-shared.mjs';
import { specifiersOf } from './authority-scan.js';

const FUNCTIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(FUNCTIONS, '..');
const tempDir = () => mkdtempSync(path.join(os.tmpdir(), 'chronasense-fn-'));

/** What a deploy uploads: functions/ minus node_modules (firebase-tools' default ignore) and, for a strict
 *  proof, minus the tests too. */
function cleanPackage() {
  const dir = tempDir();
  cpSync(FUNCTIONS, dir, { recursive: true, filter: source => !['node_modules', 'test'].includes(path.relative(FUNCTIONS, source).split(path.sep)[0]) });
  return dir;
}

function runtimeModules(dir) {
  const list = ['index.js'];
  for (const sub of ['src', 'shared']) for (const name of readdirSync(path.join(dir, sub))) if (name.endsWith('.js')) list.push(`${sub}/${name}`);
  return list;
}

test('the committed package is exactly the authoritative root sources', () => {
  assert.deepEqual(sharedProblems(), []);
  assert.deepEqual(readdirSync(path.join(FUNCTIONS, 'shared')).sort(), [...SHARED_FILES].sort());
});

test('parity check fails on modified, missing, stale-extra or under-packaged shared content (and tolerates only CRLF)', () => {
  const made = [];
  const tracked = () => { const dir = tempDir(); made.push(dir); return dir; };
  const copyShared = () => { const dir = tracked(); cpSync(path.join(FUNCTIONS, 'shared'), dir, { recursive: true }); return dir; };
  try {
    let dir = copyShared();
    const target = path.join(dir, 'brain-dump-model.js');
    writeFileSync(target, readFileSync(target, 'utf8').replace("const MAX_TEXT = 1000;", "const MAX_TEXT = 1001;"));
    assert.deepEqual(sharedProblems({ sharedDir: dir }), ['functions/shared/brain-dump-model.js differs from brain-dump-model.js']);
    dir = copyShared();
    writeFileSync(path.join(dir, 'plan-item-origin.js'), `${readFileSync(path.join(dir, 'plan-item-origin.js'), 'utf8')}\n`);
    assert.equal(sharedProblems({ sharedDir: dir }).length, 1, 'a single trailing byte is drift');
    dir = copyShared();
    rmSync(path.join(dir, 'plan-item-origin.js'));
    assert.deepEqual(sharedProblems({ sharedDir: dir }), ['missing functions/shared/plan-item-origin.js']);
    dir = copyShared();
    writeFileSync(path.join(dir, 'old-model.js'), 'export {};');
    assert.deepEqual(sharedProblems({ sharedDir: dir }), ['unexpected file functions/shared/old-model.js']);
    dir = copyShared();
    for (const name of SHARED_FILES) writeFileSync(path.join(dir, name), readFileSync(path.join(dir, name), 'utf8').replace(/\r?\n/g, '\r\n'));
    assert.deepEqual(sharedProblems({ sharedDir: dir }), [], 'CRLF vs LF is the only tolerated difference');
    // An authoritative module that starts importing an unpackaged file is caught too (the closure is complete).
    const root = tracked();
    for (const name of SHARED_FILES) cpSync(path.join(REPO, name), path.join(root, name));
    writeFileSync(path.join(root, 'brain-dump-model.js'), `import { x } from './unpackaged-model.js';\n${readFileSync(path.join(root, 'brain-dump-model.js'), 'utf8')}`);
    assert.ok(sharedProblems({ repoRoot: root, sharedDir: path.join(FUNCTIONS, 'shared') }).includes('brain-dump-model.js imports ./unpackaged-model.js, which is not packaged'));
  } finally { for (const dir of made) rmSync(dir, { recursive: true, force: true }); }
});

test('a clean package (functions/ only, no node_modules, no tests) contains every runtime dependency', () => {
  const dir = cleanPackage();
  try {
    const deps = Object.keys(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).dependencies);
    const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);
    for (const file of runtimeModules(dir)) {
      for (const specifier of specifiersOf(readFileSync(path.join(dir, file), 'utf8'))) {
        if (specifier.startsWith('.')) {
          const resolved = path.resolve(path.dirname(path.join(dir, file)), specifier);
          assert.ok(resolved.startsWith(dir + path.sep), `${file}: ${specifier} escapes the package`);
          assert.ok(existsSync(resolved), `${file}: ${specifier} is not in the package`);
        } else {
          assert.ok(builtins.has(specifier) || deps.some(dep => specifier === dep || specifier.startsWith(`${dep}/`)), `${file}: ${specifier} is neither built in nor a declared dependency`);
        }
      }
    }
    assert.ok(!existsSync(path.join(dir, 'node_modules')) && !existsSync(path.join(dir, 'test')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('package-local imports resolve and run from the clean package, with no repository root present', async () => {
  const dir = cleanPackage();
  try {
    const query = await import(pathToFileURL(path.join(dir, 'src', 'brain-dump-query.js')).href);
    await import(pathToFileURL(path.join(dir, 'src', 'action-api.js')).href);
    const T = 1_789_000_000_000;
    const domain = { async readRoomCollection() { return { bdc_one: { schemaVersion: 1, id: 'bdc_one', text: 'x', createdAt: T, updatedAt: T, updatedBy: 'd', status: 'untriaged' } }; } };
    const { result } = await query.getBrainDump({ firebaseUid: 'u1', roomId: 'uid_u1' }, { domain, nowMs: T });
    assert.deepEqual(result.captures.map(c => c.captureId), ['bdc_one']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('authoritative model behavior is unchanged: the packaged modules behave exactly like the root ones', () => {
  assert.deepEqual(Object.keys(packagedModel).sort(), Object.keys(rootModel).sort());
  assert.deepEqual(Object.keys(packagedOrigin).sort(), Object.keys(rootOrigin).sort());
  const T = 1_789_000_000_000;
  const base = { schemaVersion: 1, id: 'bdc_same', text: '  spaced  ', createdAt: T, updatedAt: T + 1, updatedBy: 'd', status: 'triaged', important: true, urgent: false, triagedAt: T + 1 };
  const records = [
    base, { ...base, status: 'archived', disposedAt: T + 2 }, { ...base, important: 'yes' }, { ...base, schemaVersion: 2, reopenCount: 1 },
    { ...base, promotionClaim: { type: 'do-today', store: 'calendar', targetId: 'cal1:2026-10-07', planItemId: 'bdp1|bdc_same', claimedAt: T + 3, claimedBy: 'd' } },
    null, 'x', { ...base, text: 'é'.repeat(1200) },
  ];
  for (const record of records) {
    assert.deepEqual(packagedModel.normalizeCapture(record), rootModel.normalizeCapture(record));
    assert.equal(packagedModel.quadrantOf(record), rootModel.quadrantOf(record));
    assert.deepEqual(packagedModel.archiveCapture(record, { now: T + 9, updatedBy: 'd' }), rootModel.archiveCapture(record, { now: T + 9, updatedBy: 'd' }));
  }
  assert.deepEqual(packagedModel.mergeCaptureRecords(records[0], records[1]), rootModel.mergeCaptureRecords(records[0], records[1]));
  assert.equal(packagedOrigin.physicalTargetKey('operational', 'day/1'), rootOrigin.physicalTargetKey('operational', 'day/1'));
});
