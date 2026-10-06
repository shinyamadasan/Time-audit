// node --test scripts/firebase-rules-builder.test.js
//
// The `npm run check:firebase-rules` parity gate must accept ONLY a CRLF-vs-LF difference between the
// checked-in firebase.rules.json and the builder's output (a Windows checkout with core.autocrlf=true
// holds the file as CRLF; the builder emits LF) -- and must still fail on any real drift.
//
// The real firebase.rules.json is only ever READ here. The CLI is exercised against fixture copies:
// a copy of the builder is placed in a temp dir, where it resolves ../firebase.rules.json to a fixture.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES_PATH, buildRules, serializeRules, artifactMatchesBuilder } from './firebase-rules-builder.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WANTED = serializeRules(buildRules());
const toCrlf = text => text.replace(/\n/g, '\r\n');

test('the generated artifact ends in exactly one newline and has no CR (the canonical form)', () => {
  assert.ok(WANTED.endsWith('}\n'));
  assert.ok(!WANTED.endsWith('\n\n'));
  assert.ok(!WANTED.includes('\r'));
});

// ------------------------------------------------------------------ the comparison itself

test('A: exact LF artifact passes', () => {
  assert.equal(artifactMatchesBuilder(WANTED, WANTED), true);
});

test('B: the same artifact converted only to CRLF passes', () => {
  assert.equal(artifactMatchesBuilder(toCrlf(WANTED), WANTED), true);
});

test('C: a substantive rule change fails (LF and CRLF forms)', () => {
  const drifted = buildRules();
  const room = JSON.stringify(drifted);
  assert.ok(room.includes('".write"'));
  const mutated = JSON.parse(room.replace('"auth != null', '"true || auth != null'));   // weaken the first auth rule found
  const text = serializeRules(mutated);
  assert.notEqual(text, WANTED);
  assert.equal(artifactMatchesBuilder(text, WANTED), false);
  assert.equal(artifactMatchesBuilder(toCrlf(text), WANTED), false);
  // a real builder-level mutation (one predicate disabled) is also drift
  assert.equal(artifactMatchesBuilder(serializeRules(buildRules({ without: ['targetBinding'] })), WANTED), false);
});

test('D: the final newline is still significant (removed or added), in LF and CRLF', () => {
  const noFinal = WANTED.slice(0, -1);
  assert.equal(artifactMatchesBuilder(noFinal, WANTED), false);
  assert.equal(artifactMatchesBuilder(toCrlf(noFinal), WANTED), false);
  assert.equal(artifactMatchesBuilder(`${WANTED}\n`, WANTED), false);
  assert.equal(artifactMatchesBuilder(toCrlf(`${WANTED}\n`), WANTED), false);
});

test('E: any other text drift fails -- whitespace, indentation, tabs, lone CR, compact JSON', () => {
  const lines = WANTED.split('\n');
  const variants = {
    'trailing space': WANTED.replace('{\n', '{ \n'),
    'trailing tab': WANTED.replace('{\n', '{\t\n'),
    'indentation changed': WANTED.replace('\n  "', '\n   "'),
    'tab indentation': WANTED.replace('\n  "', '\n\t"'),
    'blank line inserted': [lines[0], '', ...lines.slice(1)].join('\n'),
    'lone CR': WANTED.replace('{\n', '{\r'),
    'compact but semantically identical JSON': `${JSON.stringify(buildRules())}\n`,
    'leading BOM': `﻿${WANTED}`,
  };
  for (const [name, text] of Object.entries(variants)) {
    assert.notEqual(text, WANTED, `${name}: variant must actually differ`);
    assert.equal(artifactMatchesBuilder(text, WANTED), false, name);
    assert.equal(artifactMatchesBuilder(toCrlf(text), WANTED), false, `${name} (CRLF)`);
  }
});

// ------------------------------------------------------------- the real artifact, read-only

test('the checked-in firebase.rules.json matches the builder up to line endings, and is semantically identical', () => {
  const committed = readFileSync(RULES_PATH, 'utf8');
  assert.equal(artifactMatchesBuilder(committed, WANTED), true);
  assert.deepEqual(JSON.parse(committed), buildRules());
});

// ----------------------------------------------- the production CLI against fixture artifacts

const dirs = [];
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function runCli(artifactText, args = []) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rules-builder-'));
  dirs.push(root);
  mkdirSync(path.join(root, 'scripts'));
  copyFileSync(path.join(HERE, 'firebase-rules-builder.mjs'), path.join(root, 'scripts', 'firebase-rules-builder.mjs'));
  if (artifactText !== null) writeFileSync(path.join(root, 'firebase.rules.json'), artifactText);
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'firebase-rules-builder.mjs'), ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, artifact: () => readFileSync(path.join(root, 'firebase.rules.json'), 'utf8') };
}

test('CLI check: LF fixture passes', () => {
  const r = runCli(WANTED);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /matches the builder/);
});

test('CLI check: CRLF fixture passes (the Windows autocrlf checkout)', () => {
  const r = runCli(toCrlf(WANTED));
  assert.equal(r.code, 0, r.out);
});

test('CLI check: substantive drift, missing final newline and whitespace drift all fail with exit 1', () => {
  const cases = {
    'rule change': serializeRules(buildRules({ without: ['targetBinding'] })),
    'missing final newline': WANTED.slice(0, -1),
    'whitespace': WANTED.replace('{\n', '{ \n'),
    'CRLF + missing final newline': toCrlf(WANTED.slice(0, -1)),
  };
  for (const [name, text] of Object.entries(cases)) {
    const r = runCli(text);
    assert.equal(r.code, 1, `${name}: ${r.out}`);
    assert.match(r.out, /NOT the builder output/, name);
  }
});

test('CLI --write is unchanged: it emits the canonical LF form (replacing a drifted or CRLF artifact)', () => {
  for (const before of [toCrlf(WANTED), 'stale\n']) {
    const r = runCli(before, ['--write']);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.artifact(), WANTED);
  }
});
