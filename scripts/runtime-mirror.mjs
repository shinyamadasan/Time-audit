#!/usr/bin/env node
// scripts/runtime-mirror.mjs
//
// Deterministic root <-> www/ runtime mirror for the Capacitor Android bundle.
//
// The Capacitor webDir is "www" (capacitor.config.json). A real Android build
// ships exactly the files under www/ — so www/ must be a byte-identical mirror
// of the browser-runtime files the root app actually loads, and nothing else.
//
// "What the root app actually loads" is computed as the dependency closure
// rooted at the live root index.html:
//
//   <script src>            (classic + type="module")   -> local files
//   <link rel="stylesheet">                              -> local files
//   navigator.serviceWorker.register('...')              -> local file
//   + every transitive local ES-module import / re-export / literal import()
//
// It is NOT "all root *.js files" and NOT a hand-maintained list. Dev/test/
// tooling files are never part of the runtime closure even though their
// extension is .js.
//
// MODES
//   --check  (default)  compute closure, verify every required file exists in
//                       www/ and is byte-identical to root, verify no dev-only
//                       file leaked into the closure, verify no stale mirror
//                       file remains in www/. ZERO writes. Non-zero exit on
//                       any drift.
//   --write             copy the closure root -> www/, remove stale tracked
//                       mirror copies that are outside the closure, report
//                       exactly what changed.
//
// This tool never runs git and never runs `cap sync`. Native/release sync is
// scripts/deploy-release.ps1 and is an explicit, separate user action.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WWW_DIRNAME = 'www';

// Subtrees of www/ that are intentionally NOT mirrored from root and must be
// left alone by both modes.
const WWW_KEEP_PREFIXES = ['Sounds/'];

// A path (root-relative, POSIX) that must never appear in the runtime closure.
// If closure computation ever yields one of these, that is a hard error: the
// graph parser or an index.html edit is wrong.
export function isDevOnlyFile(relPosix) {
  const base = relPosix.split('/').pop();
  if (/\.test\.js$/.test(base)) return true;
  if (/\.spec\.js$/.test(base)) return true;
  if (base === 'test.js') return true;
  if (base === 'eslint.config.js') return true;
  if (base === 'playwright.config.js') return true;
  if (base === 'sync.bat' || base === 'sync.sh') return true;
  if (/^setup-.*\.ps1$/.test(base)) return true;
  if (/\.ps1$/.test(base)) return true;
  const topDir = relPosix.includes('/') ? relPosix.split('/')[0] : '';
  if (['tests', 'scripts', 'contracts', 'fixtures', 'android', 'planning', 'docs', 'browser-extension', 'captures', 'tools', '.github', '.devcontainer'].includes(topDir)) return true;
  return false;
}

const toPosix = (p) => p.split(path.sep).join('/');

// ── index.html entrypoint extraction ────────────────────────────────────────

function isExternal(spec) {
  return /^(?:[a-z]+:)?\/\//i.test(spec) || /^data:/i.test(spec) || /^blob:/i.test(spec);
}

// Strip ?query and #hash, drop a leading ./
function normalizeSpec(spec) {
  return spec.replace(/[?#].*$/, '').replace(/^\.\//, '');
}

export function parseIndexEntrypoints(html) {
  const scripts = new Set();
  const styles = new Set();

  const scriptRe = /<script\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi;
  let m;
  while ((m = scriptRe.exec(html))) {
    const spec = m[2] ?? m[3] ?? '';
    if (spec && !isExternal(spec)) scripts.add(normalizeSpec(spec));
  }

  const linkRe = /<link\b[^>]*>/gi;
  while ((m = linkRe.exec(html))) {
    const tag = m[0];
    const relM = /\brel\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    const rel = (relM ? (relM[2] ?? relM[3] ?? '') : '').toLowerCase();
    if (!rel.split(/\s+/).includes('stylesheet')) continue;
    const hrefM = /\bhref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    const spec = hrefM ? (hrefM[2] ?? hrefM[3] ?? '') : '';
    if (spec && !isExternal(spec)) styles.add(normalizeSpec(spec));
  }

  // Service worker registration — a genuine runtime file loaded by the app.
  const swRe = /navigator\s*\.\s*serviceWorker\s*\.\s*register\s*\(\s*("([^"]*)"|'([^']*)')/g;
  while ((m = swRe.exec(html))) {
    const spec = m[2] ?? m[3] ?? '';
    if (spec && !isExternal(spec)) scripts.add(normalizeSpec(spec));
  }

  return { scripts: [...scripts], styles: [...styles] };
}

// ── ES module dependency extraction ─────────────────────────────────────────

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// Local, followable specifiers only: ./x or ../x. Bare specifiers (npm, node:)
// and absolute URLs are runtime-external and never mirrored.
export function parseModuleDeps(src) {
  const code = stripComments(src);
  const deps = new Set();

  // import ... from 'x'  |  import 'x'  |  import * as y from 'x'  |  import {a,b} from 'x'
  const importRe = /(?:^|[;\s])import\s+(?:[\w*${}\s,]+\s+from\s+)?('([^']+)'|"([^"]+)")/gm;
  // export * from 'x'  |  export { a, b } from 'x'
  const exportRe = /(?:^|[;\s])export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+('([^']+)'|"([^"]+)")/gm;
  // import('x')
  const dynRe = /\bimport\s*\(\s*('([^']+)'|"([^"]+)")\s*\)/g;

  for (const re of [importRe, exportRe, dynRe]) {
    let m;
    while ((m = re.exec(code))) {
      const spec = m[2] ?? m[3] ?? '';
      if (spec.startsWith('./') || spec.startsWith('../')) deps.add(spec);
    }
  }
  return [...deps];
}

// ── closure ────────────────────────────────────────────────────────────────

const isJsLike = (rel) => /\.(?:js|mjs)$/.test(rel);

/**
 * Compute the browser-runtime dependency closure rooted at index.html.
 * Returns { files: string[] (sorted, root-relative POSIX, includes index.html),
 *           entrypoints: {scripts,styles}, devLeaks: string[] }.
 */
export function computeClosure({ rootDir = ROOT_DIR } = {}) {
  const indexRel = 'index.html';
  const indexPath = path.join(rootDir, indexRel);
  if (!existsSync(indexPath)) throw new Error(`root ${indexRel} not found at ${indexPath}`);

  const html = readFileSync(indexPath, 'utf8');
  const entrypoints = parseIndexEntrypoints(html);

  const closure = new Set([indexRel]);
  const missing = [];
  const queue = [];

  for (const rel of [...entrypoints.scripts, ...entrypoints.styles]) {
    const norm = toPosix(path.normalize(rel));
    if (!closure.has(norm)) { closure.add(norm); queue.push(norm); }
  }

  while (queue.length) {
    const rel = queue.shift();
    const abs = path.join(rootDir, rel);
    if (!existsSync(abs)) { missing.push(rel); continue; }
    if (!isJsLike(rel)) continue; // css / other assets: leaf (no @import graph in this codebase)

    const deps = parseModuleDeps(readFileSync(abs, 'utf8'));
    const dir = path.dirname(rel);
    for (const spec of deps) {
      const resolved = toPosix(path.normalize(path.join(dir, spec)));
      if (resolved.startsWith('..')) {
        throw new Error(`runtime import escapes repo root: ${rel} -> ${spec}`);
      }
      if (!closure.has(resolved)) { closure.add(resolved); queue.push(resolved); }
    }
  }

  const files = [...closure].sort();
  const devLeaks = files.filter(isDevOnlyFile);
  return { files, entrypoints, missing, devLeaks };
}

// ── www/ mirror inventory ──────────────────────────────────────────────────

function listWwwFiles(rootDir) {
  const wwwDir = path.join(rootDir, WWW_DIRNAME);
  if (!existsSync(wwwDir)) return [];
  const out = [];
  const walk = (abs) => {
    for (const name of readdirSync(abs)) {
      const childAbs = path.join(abs, name);
      const rel = toPosix(path.relative(wwwDir, childAbs));
      if (WWW_KEEP_PREFIXES.some((p) => rel === p.replace(/\/$/, '') || rel.startsWith(p))) continue;
      if (statSync(childAbs).isDirectory()) walk(childAbs);
      else out.push(rel); // rel is relative to www/, i.e. the root-relative counterpart
    }
  };
  walk(wwwDir);
  return out;
}

// ── check mode ─────────────────────────────────────────────────────────────

export function checkParity({ rootDir = ROOT_DIR } = {}) {
  const { files, missing, devLeaks } = computeClosure({ rootDir });
  const problems = [];

  if (missing.length) {
    for (const rel of missing) problems.push(`unresolved runtime dependency: ${rel} referenced but not found in root`);
  }
  if (devLeaks.length) {
    for (const rel of devLeaks) problems.push(`dev-only file present in runtime closure: ${rel}`);
  }

  const required = files; // includes index.html
  const missingInWww = [];
  const drifted = [];
  for (const rel of required) {
    const rootAbs = path.join(rootDir, rel);
    const wwwAbs = path.join(rootDir, WWW_DIRNAME, rel);
    if (!existsSync(wwwAbs)) { missingInWww.push(rel); continue; }
    if (!readFileSync(rootAbs).equals(readFileSync(wwwAbs))) drifted.push(rel);
  }
  for (const rel of missingInWww) problems.push(`missing in www/: ${rel}`);
  for (const rel of drifted) problems.push(`www/${rel} has drifted from root ${rel}`);

  const requiredSet = new Set(required);
  const stale = listWwwFiles(rootDir).filter((rel) => !requiredSet.has(rel));
  for (const rel of stale) {
    const reason = isDevOnlyFile(rel) ? 'dev-only file' : 'not in runtime closure';
    problems.push(`stale mirror file in www/: ${rel} (${reason})`);
  }

  return {
    ok: problems.length === 0,
    problems,
    closureSize: required.length,
    missingInWww,
    drifted,
    stale,
    devLeaks,
  };
}

// ── write mode ─────────────────────────────────────────────────────────────

export function mirror({ rootDir = ROOT_DIR } = {}) {
  const { files, missing, devLeaks } = computeClosure({ rootDir });
  if (missing.length) throw new Error(`cannot mirror: unresolved runtime dependencies:\n  ${missing.join('\n  ')}`);
  if (devLeaks.length) throw new Error(`cannot mirror: dev-only files in closure:\n  ${devLeaks.join('\n  ')}`);

  const added = [];
  const updated = [];
  const unchanged = [];
  const removed = [];

  for (const rel of files) {
    if (rel === 'index.html') { /* mirrored below with the rest */ }
    const rootAbs = path.join(rootDir, rel);
    const wwwAbs = path.join(rootDir, WWW_DIRNAME, rel);
    const rootBuf = readFileSync(rootAbs);
    if (!existsSync(wwwAbs)) {
      mkdirSync(path.dirname(wwwAbs), { recursive: true });
      writeFileSync(wwwAbs, rootBuf);
      added.push(rel);
    } else if (!readFileSync(wwwAbs).equals(rootBuf)) {
      writeFileSync(wwwAbs, rootBuf);
      updated.push(rel);
    } else {
      unchanged.push(rel);
    }
  }

  const requiredSet = new Set(files);
  for (const rel of listWwwFiles(rootDir)) {
    if (!requiredSet.has(rel)) {
      rmSync(path.join(rootDir, WWW_DIRNAME, rel));
      removed.push(rel);
    }
  }

  return { added: added.sort(), updated: updated.sort(), removed: removed.sort(), unchanged: unchanged.sort() };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function main(argv) {
  const write = argv.includes('--write');

  if (write && argv.includes('--check')) {
    console.error('runtime-mirror: pass either --write or --check, not both');
    process.exit(2);
  }

  if (write) {
    const r = mirror();
    const line = (label, arr) => arr.length ? console.log(`  ${label} (${arr.length}):\n${arr.map((f) => `    ${f}`).join('\n')}`) : console.log(`  ${label}: none`);
    console.log('runtime-mirror --write');
    line('added', r.added);
    line('updated', r.updated);
    line('removed', r.removed);
    console.log(`  unchanged: ${r.unchanged.length}`);
    console.log('\nwww/ now mirrors the index.html runtime closure. Review the diff before committing.');
    return 0;
  }

  const r = checkParity();
  console.log(`runtime-mirror --check  (closure: ${r.closureSize} files)`);
  if (r.ok) {
    console.log('  OK — www/ is a byte-identical mirror of the runtime closure.');
    return 0;
  }
  console.error('  DRIFT:');
  for (const p of r.problems) console.error(`    - ${p}`);
  console.error('\nRun `node scripts/runtime-mirror.mjs --write` to resync, then review the diff.');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
