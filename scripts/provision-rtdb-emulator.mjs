#!/usr/bin/env node
// scripts/provision-rtdb-emulator.mjs
//
// Deterministically provisions the Firebase Realtime Database emulator jar the fence suites run against
// (rtdb-emulator-support.js looks for it at ~/.cache/firebase/emulators, firebase-tools' own cache path).
// The jar is pinned by version AND sha256: a cached or downloaded file that does not match is never used.
// A cache hit only skips the download; a miss, a corrupt file or a failed download FAILS (non-zero exit),
// never skips. Nothing is committed to the repo. No credentials involved.
//
// Usage: node scripts/provision-rtdb-emulator.mjs

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const EMULATOR_VERSION = '4.11.2';
export const EMULATOR_SHA256 = 'b70d99344caf17c98b6f910fa8f6edf32a7c016cb1035e8915f70d38901eb97f';
export const EMULATOR_URL = `https://storage.googleapis.com/firebase-preview-drop/emulator/firebase-database-emulator-v${EMULATOR_VERSION}.jar`;
export const EMULATOR_PATH = process.env.FIREBASE_DATABASE_EMULATOR_JAR
  || path.join(os.homedir(), '.cache', 'firebase', 'emulators', `firebase-database-emulator-v${EMULATOR_VERSION}.jar`);

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

export async function provision() {
  if (existsSync(EMULATOR_PATH) && sha256(readFileSync(EMULATOR_PATH)) === EMULATOR_SHA256) return { path: EMULATOR_PATH, downloaded: false };
  const response = await fetch(EMULATOR_URL);
  if (!response.ok) throw new Error(`emulator download failed: HTTP ${response.status} ${EMULATOR_URL}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const actual = sha256(buffer);
  if (actual !== EMULATOR_SHA256) throw new Error(`emulator checksum mismatch: expected ${EMULATOR_SHA256}, got ${actual}`);
  mkdirSync(path.dirname(EMULATOR_PATH), { recursive: true });
  const temp = `${EMULATOR_PATH}.part`;
  writeFileSync(temp, buffer);
  renameSync(temp, EMULATOR_PATH);
  return { path: EMULATOR_PATH, downloaded: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  provision().then(
    result => console.log(`RTDB emulator v${EMULATOR_VERSION} ready at ${result.path} (${result.downloaded ? 'downloaded' : 'cache hit, checksum verified'})`),
    error => { console.error(error.message); process.exit(1); },
  );
}
