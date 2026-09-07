// node --test scripts/runtime-mirror.test.js
//
// Contract tests for the root <-> www runtime mirror. Negative/destructive
// cases run against throwaway temp fixtures — the real runtime tree is never
// mutated here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, cpSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeClosure,
  checkParity,
  mirror,
  parseIndexEntrypoints,
  parseModuleDeps,
  isDevOnlyFile,
} from './runtime-mirror.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── fixture helpers ────────────────────────────────────────────────────────

function makeFixture(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'runtime-mirror-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function snapshotTree(dir) {
  const out = {};
  const walk = (abs) => {
    for (const name of readdirSync(abs)) {
      const childAbs = path.join(abs, name);
      const rel = path.relative(dir, childAbs);
      if (statSync(childAbs).isDirectory()) walk(childAbs);
      else out[rel] = readFileSync(childAbs, 'utf8');
    }
  };
  walk(dir);
  return out;
}

// A minimal but representative runtime tree.
function baseFiles() {
  return {
    'index.html': [
      '<!doctype html>',
      '<link rel="stylesheet" href="style.css?v=1">',
      '<script src="https://cdn.example.com/lib.js"></script>',
      '<script src="classic.js?v=2"></script>',
      '<script type="module" src="./entry.js"></script>',
      '<script>navigator.serviceWorker.register("./sw.js");</script>',
    ].join('\n'),
    'style.css': 'body{color:red}',
    'classic.js': '// classic, no imports\nwindow.x = 1;',
    'entry.js': "import { a } from './mod-a.js';\nimport './side-effect.js';\na();",
    'mod-a.js': "export { b } from './mod-b.js';\nexport const a = () => {};",
    'mod-b.js': 'export const b = 1;',
    'side-effect.js': 'globalThis.loaded = true;',
    'sw.js': "self.addEventListener('install', () => {});",
  };
}

function mirrorIntoWww(dir, closureFiles) {
  for (const rel of closureFiles) {
    const dest = path.join(dir, 'www', rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(path.join(dir, rel), dest);
  }
}

// ── 1 + 2: entrypoints and transitive imports resolve (real tree) ──────────

test('real index.html: every runtime entrypoint and transitive import resolves', () => {
  const c = computeClosure({ rootDir: REPO_ROOT });
  assert.deepEqual(c.missing, [], `unresolved runtime dependencies: ${c.missing.join(', ')}`);
  assert.deepEqual(c.devLeaks, [], `dev-only files leaked into closure: ${c.devLeaks.join(', ')}`);
  assert.ok(c.files.includes('index.html'));
  assert.ok(c.files.length > 20, `expected a non-trivial closure, got ${c.files.length}`);
});

// ── 3 + 4: www has every required file, byte-identical (real tree) ─────────

test('real tree: www/ is a byte-identical mirror of the runtime closure', () => {
  const r = checkParity({ rootDir: REPO_ROOT });
  assert.ok(r.ok, `runtime parity drift:\n  ${r.problems.join('\n  ')}`);
});

// ── 5: a newly-added root import is discovered automatically ───────────────

test('a new import added to a module is discovered without touching the mirror config', () => {
  const dir = makeFixture(baseFiles());
  try {
    let c = computeClosure({ rootDir: dir });
    assert.ok(!c.files.includes('mod-c.js'), 'mod-c.js should not be in closure yet');

    writeFileSync(path.join(dir, 'mod-c.js'), 'export const c = 3;');
    writeFileSync(
      path.join(dir, 'mod-a.js'),
      "export { b } from './mod-b.js';\nimport { c } from './mod-c.js';\nexport const a = () => c;",
    );

    c = computeClosure({ rootDir: dir });
    assert.ok(c.files.includes('mod-c.js'), 'newly-imported mod-c.js must be discovered');
  } finally {
    cleanup(dir);
  }
});

// ── 6: a missing www runtime module causes failure ───────────────────────

test('check fails when a required runtime module is missing from www/', () => {
  const dir = makeFixture(baseFiles());
  try {
    const c = computeClosure({ rootDir: dir });
    mirrorIntoWww(dir, c.files);
    assert.ok(checkParity({ rootDir: dir }).ok, 'freshly mirrored tree should pass');

    rmSync(path.join(dir, 'www', 'mod-b.js'));
    const r = checkParity({ rootDir: dir });
    assert.ok(!r.ok);
    assert.ok(r.problems.some((p) => p.includes('missing in www/') && p.includes('mod-b.js')));
  } finally {
    cleanup(dir);
  }
});

// ── 7: a changed www copy causes failure ─────────────────────────────────

test('check fails when a www/ copy has drifted from root', () => {
  const dir = makeFixture(baseFiles());
  try {
    const c = computeClosure({ rootDir: dir });
    mirrorIntoWww(dir, c.files);
    writeFileSync(path.join(dir, 'www', 'style.css'), 'body{color:blue}');

    const r = checkParity({ rootDir: dir });
    assert.ok(!r.ok);
    assert.ok(r.problems.some((p) => p.includes('drifted') && p.includes('style.css')));
  } finally {
    cleanup(dir);
  }
});

// ── 8: dev/test files are not runtime just because they are .js ───────────

test('dev/test/tooling files are excluded from the runtime closure', () => {
  const files = baseFiles();
  files['entry.test.js'] = "import './entry.js';";
  files['eslint.config.js'] = 'export default [];';
  files['scripts/tool.mjs'] = 'export const t = 1;';
  const dir = makeFixture(files);
  try {
    const c = computeClosure({ rootDir: dir });
    for (const bad of ['entry.test.js', 'eslint.config.js', 'scripts/tool.mjs']) {
      assert.ok(!c.files.includes(bad), `${bad} must not be in the runtime closure`);
    }
  } finally {
    cleanup(dir);
  }

  assert.ok(isDevOnlyFile('foo.test.js'));
  assert.ok(isDevOnlyFile('bar.spec.js'));
  assert.ok(isDevOnlyFile('test.js'));
  assert.ok(isDevOnlyFile('eslint.config.js'));
  assert.ok(isDevOnlyFile('playwright.config.js'));
  assert.ok(isDevOnlyFile('scripts/anything.mjs'));
  assert.ok(isDevOnlyFile('tests/x.spec.js'));
  assert.ok(isDevOnlyFile('sync.bat'));
  assert.ok(isDevOnlyFile('sync.sh'));
  assert.ok(!isDevOnlyFile('storage.js'));
  assert.ok(!isDevOnlyFile('style.css'));
});

test('a dev-only file referenced as an index.html script is reported as a leak, not silently mirrored', () => {
  const files = baseFiles();
  files['index.html'] += '\n<script type="module" src="./entry.test.js"></script>';
  files['entry.test.js'] = 'export const t = 1;';
  const dir = makeFixture(files);
  try {
    const c = computeClosure({ rootDir: dir });
    assert.ok(c.devLeaks.includes('entry.test.js'));
    const r = checkParity({ rootDir: dir });
    assert.ok(!r.ok);
    assert.ok(r.problems.some((p) => p.includes('dev-only file present in runtime closure')));
    assert.throws(() => mirror({ rootDir: dir }), /dev-only files in closure/);
  } finally {
    cleanup(dir);
  }
});

// ── 9: check mode performs zero writes ───────────────────────────────────

test('check mode performs no writes', () => {
  const dir = makeFixture(baseFiles());
  try {
    const c = computeClosure({ rootDir: dir });
    mirrorIntoWww(dir, c.files);
    // introduce drift so the check has something to report
    rmSync(path.join(dir, 'www', 'mod-b.js'));

    const before = snapshotTree(dir);
    const r = checkParity({ rootDir: dir });
    assert.ok(!r.ok);
    const after = snapshotTree(dir);
    assert.deepEqual(after, before, 'check mode must not modify any file');
  } finally {
    cleanup(dir);
  }
});

// ── 10: sync wrappers contain no publish / cap-sync path ─────────────────

// Strip comment lines so a "must not push" doc comment isn't mistaken for a
// publish path, while any real executable git/cap invocation is still caught.
function executableLines(src, commentPrefixes) {
  return src
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      return !commentPrefixes.some((p) => t.toLowerCase().startsWith(p));
    })
    .join('\n');
}

test('sync.bat and sync.sh contain no git add/commit/push/merge and no cap sync', () => {
  const cases = [
    ['sync.bat', ['::', 'rem ']],
    ['sync.sh', ['#']],
  ];
  for (const [name, prefixes] of cases) {
    const code = executableLines(readFileSync(path.join(REPO_ROOT, name), 'utf8'), prefixes);
    assert.doesNotMatch(code, /\bgit\s+(add|commit|push|merge|reset|rebase|checkout)\b/i, `${name} must not run git mutations`);
    assert.doesNotMatch(code, /\bcap\s+sync\b/i, `${name} must not run cap sync`);
    assert.doesNotMatch(code, /\bnpx\s+cap\b/i, `${name} must not invoke the Capacitor CLI`);
  }
});

test('deploy-release helper never pushes and never publishes main directly', () => {
  const code = executableLines(
    readFileSync(path.join(REPO_ROOT, 'scripts', 'deploy-release.ps1'), 'utf8'),
    ['#', '<#', '.', 'write-host', 'write-error'],
  );
  assert.doesNotMatch(code, /\bgit\s+push\b/i, 'deploy-release must not push');
  assert.doesNotMatch(code, /\bgit\s+(commit|merge|reset|rebase)\b/i, 'deploy-release must not commit/merge/reset behind the user');
  assert.doesNotMatch(code, /checkout\s+main|switch\s+main/i, 'deploy-release must not switch to main to publish');
});

// ── 11: dependency ordering does not change the closure ──────────────────

test('closure is independent of entrypoint and import ordering', () => {
  const a = baseFiles();
  const b = { ...baseFiles() };
  b['index.html'] = [
    '<!doctype html>',
    '<script>navigator.serviceWorker.register("./sw.js");</script>',
    '<script type="module" src="./entry.js"></script>',
    '<script src="classic.js?v=2"></script>',
    '<script src="https://cdn.example.com/lib.js"></script>',
    '<link rel="stylesheet" href="style.css?v=1">',
  ].join('\n');
  b['entry.js'] = "import './side-effect.js';\nimport { a } from './mod-a.js';\na();";

  const da = makeFixture(a);
  const db = makeFixture(b);
  try {
    const ca = computeClosure({ rootDir: da }).files;
    const cb = computeClosure({ rootDir: db }).files;
    assert.deepEqual(ca, cb);
  } finally {
    cleanup(da);
    cleanup(db);
  }
});

// ── 12: external / CDN URLs are ignored ─────────────────────────────────

test('external and CDN script/style URLs are not part of the closure', () => {
  const { scripts, styles } = parseIndexEntrypoints([
    '<script src="https://www.gstatic.com/firebasejs/x/firebase-app-compat.js"></script>',
    '<script src="//cdn.example.com/a.js"></script>',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">',
    '<script src="local.js"></script>',
    '<link rel="stylesheet" href="local.css">',
  ].join('\n'));
  assert.deepEqual(scripts, ['local.js']);
  assert.deepEqual(styles, ['local.css']);
});

test('parseModuleDeps only follows relative specifiers', () => {
  const deps = parseModuleDeps([
    "import a from './a.js';",
    "import { b } from '../lib/b.js';",
    "import 'node:fs';",
    "import x from '@scope/pkg';",
    "export * from './c.js';",
    "const y = import('./d.js');",
    "// import './commented-out.js';",
  ].join('\n'));
  assert.deepEqual(new Set(deps), new Set(['./a.js', '../lib/b.js', './c.js', './d.js']));
});

// ── write mode: converges and removes stale copies ─────────────────────

test('write mode adds missing files, updates drift, removes stale mirror copies', () => {
  const files = baseFiles();
  const dir = makeFixture(files);
  try {
    // pre-seed www with a stale dev file and a drifted copy
    mkdirSync(path.join(dir, 'www'), { recursive: true });
    writeFileSync(path.join(dir, 'www', 'eslint.config.js'), 'export default [];');
    writeFileSync(path.join(dir, 'www', 'style.css'), 'stale');

    const r = mirror({ rootDir: dir });
    assert.ok(r.removed.includes('eslint.config.js'));
    assert.ok(r.updated.includes('style.css'));
    assert.ok(r.added.includes('entry.js'));

    assert.ok(checkParity({ rootDir: dir }).ok, 'tree must be in parity after write');
    // idempotent
    const r2 = mirror({ rootDir: dir });
    assert.deepEqual([r2.added, r2.updated, r2.removed], [[], [], []]);
  } finally {
    cleanup(dir);
  }
});
