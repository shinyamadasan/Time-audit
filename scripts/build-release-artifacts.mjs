#!/usr/bin/env node
// scripts/build-release-artifacts.mjs
//
// Builds the exact bytes a release would ship from one commit, for verification only.
//   web      the commit's runtime closure, as GitHub Pages serves it (blobs, not this checkout's CRLF)
//   android  a debug APK built from the commit's www/, then re-extracted from the APK itself
//
// Output goes to .release-artifacts/<commit>/ (Playwright wipes test-results/) with release-manifest.json. It never
// deploys, pushes, signs, installs or touches a device. android/ is gitignored, so the native
// project is pinned by hash in the manifest. Run `npx cap sync` in this checkout only.

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeClosure } from './runtime-mirror.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = name => { const at = process.argv.indexOf(name); return at < 0 ? null : process.argv[at + 1]; };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: root, maxBuffer: 1 << 30 });
// Capacitor adds these beside the mirrored bundle; every other file must equal www/ exactly.
const CAPACITOR_FILES = new Set(['cordova.js', 'cordova_plugins.js']);

function walk(dir, base = dir) {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  }).sort();
}

export function treeManifest(dir) {
  const files = Object.fromEntries(walk(dir).map(file => [file, sha256(readFileSync(path.join(dir, file)))]));
  return { files, tree: sha256(Object.entries(files).map(([file, hash]) => `${hash}  ${file}\n`).join('')) };
}

function exportCommit(commit, target, paths = []) {
  rmSync(target, { recursive: true, force: true }); mkdirSync(target, { recursive: true });
  execFileSync('tar', ['-xf', '-'], { cwd: target, input: git('archive', '--format=tar', commit, ...paths) });
}

function buildAndroid(wwwExport, out) {
  const android = path.join(root, 'android');
  if (!existsSync(android)) throw Error('android/ is required; copy the native project into this checkout first');
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const sync = spawnSync(npx, ['cap', 'sync', 'android'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
  if (sync.status !== 0) throw Error(`cap sync failed: ${sync.stdout}${sync.stderr}`);
  // cap sync copied this checkout; the APK must carry the commit's bytes.
  const assets = path.join(android, 'app/src/main/assets/public');
  for (const file of walk(assets)) if (!CAPACITOR_FILES.has(file)) rmSync(path.join(assets, file));
  cpSync(wwwExport, assets, { recursive: true });
  const gradle = ['assembleDebug', '--offline', '--console=plain'];
  const built = process.platform === 'win32' ? spawnSync('cmd', ['/c', '.\\gradlew.bat', ...gradle], { cwd: android, encoding: 'utf8' })
    : spawnSync('./gradlew', gradle, { cwd: android, encoding: 'utf8' });
  writeFileSync(path.join(out, 'gradle.log.txt'), `${built.stdout}${built.stderr}`);
  if (built.status !== 0) throw Error(`gradle failed; see ${path.join(out, 'gradle.log.txt')}`);
  const apk = path.join(out, 'chronasense-debug.apk');
  cpSync(path.join(android, 'app/build/outputs/apk/debug/app-debug.apk'), apk);

  const extracted = path.join(out, 'apk-extract');
  rmSync(extracted, { recursive: true, force: true }); mkdirSync(extracted);
  const zip = path.join(out, 'apk-copy.zip'); cpSync(apk, zip);
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${extracted}' -Force`]);
  rmSync(zip);
  const publicDir = path.join(out, 'android');
  rmSync(publicDir, { recursive: true, force: true });
  cpSync(path.join(extracted, 'assets/public'), publicDir, { recursive: true });
  const config = JSON.parse(readFileSync(path.join(extracted, 'assets/capacitor.config.json'), 'utf8'));
  rmSync(extracted, { recursive: true, force: true });

  const www = treeManifest(wwwExport), bundle = treeManifest(publicDir);
  const differs = Object.keys({ ...www.files, ...bundle.files })
    .filter(file => !CAPACITOR_FILES.has(file) && www.files[file] !== bundle.files[file]);
  if (differs.length) throw Error(`APK bundle differs from the commit's www/: ${differs.join(', ')}`);
  if (config.server?.url) throw Error('APK must load its bundled writer, not a remote server.url');

  const native = Object.fromEntries(walk(android)
    .filter(file => !/(^|\/)(build|\.gradle|\.idea)\//.test(file) && !file.startsWith('app/src/main/assets/')
      && file !== 'local.properties')
    .map(file => [file, sha256(readFileSync(path.join(android, file)))]));
  return { apkSha256: sha256(readFileSync(apk)), apkBytes: statSync(apk).size, signing: 'debug', bundleTree: bundle.tree,
    capacitorFiles: [...CAPACITOR_FILES], packageLockSha256: sha256(readFileSync(path.join(root, 'package-lock.json'))),
    nativeProjectTree: sha256(Object.entries(native).map(([file, hash]) => `${hash}  ${file}\n`).join('')), nativeProjectFiles: Object.keys(native).length };
}

function main() {
  const commit = git('rev-parse', option('--commit') || 'HEAD').toString().trim();
  const out = path.resolve(option('--out') || path.join(root, '.release-artifacts', commit.slice(0, 12)));
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });

  const source = path.join(out, 'source');
  exportCommit(commit, source, ['index.html', 'www']);
  // Closure is computed from the commit's own index and www so a dirty checkout cannot widen it.
  const web = path.join(out, 'web');
  const www = path.join(source, 'www');
  const closure = computeClosure({ rootDir: www });
  if (closure.missing.length || closure.devLeaks.length) throw Error(`closure: ${JSON.stringify(closure)}`);
  // Pages serves root and Android serves www/; a release needs both to be the same bytes.
  const drifted = [...closure.files].filter(file => !git('show', `${commit}:${file}`).equals(readFileSync(path.join(www, file))));
  if (drifted.length) throw Error(`root and www differ at ${commit}: ${drifted.join(', ')}`);
  mkdirSync(web);
  for (const file of new Set([...closure.files, 'sw.js'])) {
    mkdirSync(path.dirname(path.join(web, file)), { recursive: true });
    cpSync(path.join(www, file), path.join(web, file));
  }
  const webTree = treeManifest(web);
  const rules = git('show', `${commit}:firebase.rules.json`);
  const manifest = { commit, rulesSha256: sha256(rules), web: { tree: webTree.tree, files: Object.keys(webTree.files).length, hashes: webTree.files } };
  writeFileSync(path.join(out, 'firebase.rules.json'), rules);

  if (process.argv.includes('--skip-android')) manifest.android = { built: false };
  else manifest.android = { built: true, ...buildAndroid(www, out) };
  rmSync(source, { recursive: true, force: true });
  writeFileSync(path.join(out, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ out, commit, webTree: manifest.web.tree, android: { ...manifest.android } }, null, 2));
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main();
