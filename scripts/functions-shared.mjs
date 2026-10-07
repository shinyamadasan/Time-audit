// scripts/functions-shared.mjs
//
// Packages the shared domain modules the Action API backend needs INTO the Functions source (functions/shared/),
// because a Firebase deploy uploads only functions/. Test/tooling only (never shipped to the browser).
//
// The repository-root files stay the ONLY authority. functions/shared/ holds byte-identical generated copies:
//   --write  copies each authoritative file verbatim and removes anything else from functions/shared/;
//   (none)   checks parity and exits 1 on any drift: a missing copy, a copy that differs from its root source,
//            an unexpected (stale) file, or a shared module importing a file outside the packaged set.
// The ONLY representation difference tolerated is CRLF vs LF (a core.autocrlf=true checkout), exactly like the
// firebase.rules.json builder check. Run by `npm test`, by the functions package's own test script, and by the
// firebase.json functions predeploy hook, so a stale package can never be tested or deployed silently.
//
// Usage: node scripts/functions-shared.mjs [--write]

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(HERE, '..');
export const SHARED_DIR = path.join(REPO_ROOT, 'functions', 'shared');
/** The closure of root modules the backend imports (brain-dump-model.js -> plan-item-origin.js). */
export const SHARED_FILES = Object.freeze(['brain-dump-model.js', 'plan-item-origin.js']);

const toLf = text => text.replace(/\r\n/g, '\n');
const relativeImports = text => [...text.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"](\.[^'"]+)['"]|^\s*import\s*['"](\.[^'"]+)['"]/gm)].map(m => m[1] ?? m[2]);

/** @returns {string[]} every parity problem; empty means the package is exactly the authoritative sources. */
export function sharedProblems({ repoRoot = REPO_ROOT, sharedDir = SHARED_DIR } = {}) {
  const problems = [];
  let present = [];
  try { present = readdirSync(sharedDir); } catch { return ['functions/shared/ is missing']; }
  for (const name of present) if (!SHARED_FILES.includes(name)) problems.push(`unexpected file functions/shared/${name}`);
  for (const name of SHARED_FILES) {
    const authority = readFileSync(path.join(repoRoot, name), 'utf8');
    let copy;
    try { copy = readFileSync(path.join(sharedDir, name), 'utf8'); } catch { problems.push(`missing functions/shared/${name}`); continue; }
    if (toLf(copy) !== toLf(authority)) problems.push(`functions/shared/${name} differs from ${name}`);
    for (const specifier of relativeImports(authority)) {
      const target = path.posix.normalize(specifier);
      if (path.posix.dirname(target) !== '.' || !SHARED_FILES.includes(path.posix.basename(target))) problems.push(`${name} imports ${specifier}, which is not packaged`);
    }
  }
  return problems;
}

export function writeShared({ repoRoot = REPO_ROOT, sharedDir = SHARED_DIR } = {}) {
  mkdirSync(sharedDir, { recursive: true });
  for (const name of readdirSync(sharedDir)) if (!SHARED_FILES.includes(name)) rmSync(path.join(sharedDir, name), { recursive: true, force: true });
  for (const name of SHARED_FILES) writeFileSync(path.join(sharedDir, name), readFileSync(path.join(repoRoot, name)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--write')) { writeShared(); console.log(`functions/shared written: ${SHARED_FILES.join(', ')}`); }
  const problems = sharedProblems();
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    console.error('functions/shared is NOT the authoritative source. Run: node scripts/functions-shared.mjs --write');
    process.exit(1);
  }
  console.log('functions/shared matches the authoritative root sources');
}
