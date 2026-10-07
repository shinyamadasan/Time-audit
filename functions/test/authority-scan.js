// functions/test/authority-scan.js
//
// Test-only, deliberately small source scan for the §3 authority boundary. Not a general static analyser: it
// catches the OBVIOUS ways privileged Firebase access could be loaded outside the approved entry point.
//   - every module specifier, whether a static import/export or a literal dynamic import('...'), is collected;
//   - a Firebase / Google Cloud specifier is allowed only in index.js and only from APPROVED (app, auth,
//     functions) — never the Admin Database/Firestore SDK, the bare Admin namespace or the client SDK;
//   - a dynamic import whose specifier is not a plain string literal, any require( and any createRequire are
//     refused outright, because the specifier they load cannot be checked.

export const APPROVED_ENTRY = 'index.js';
export const APPROVED_SPECIFIERS = Object.freeze(['firebase-admin/app', 'firebase-admin/auth', 'firebase-functions/params', 'firebase-functions/v2/https']);
const PRIVILEGED = /^(@?firebase|@google-cloud\/|googleapis)/;

const STATIC = /^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
const DYNAMIC_LITERAL = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_ANY = /\bimport\s*\(/g;

export function specifiersOf(text) {
  return [...text.matchAll(STATIC)].map(m => m[1] ?? m[2]).concat([...text.matchAll(DYNAMIC_LITERAL)].map(m => m[1]));
}

/** @param {{name:string, text:string}[]} files  name is relative to functions/ (e.g. 'src/x.js')
 *  @returns {string[]} violations; empty means the boundary holds */
export function authorityViolations(files) {
  const violations = [];
  for (const { name, text } of files) {
    for (const specifier of specifiersOf(text)) {
      if (!PRIVILEGED.test(specifier)) continue;
      if (name !== APPROVED_ENTRY || !APPROVED_SPECIFIERS.includes(specifier)) violations.push(`${name}: loads ${specifier}`);
    }
    const literalDynamic = [...text.matchAll(DYNAMIC_LITERAL)].length;
    if ([...text.matchAll(DYNAMIC_ANY)].length > literalDynamic) violations.push(`${name}: dynamic import() with a non-literal specifier`);
    if (/\brequire\s*\(/.test(text)) violations.push(`${name}: require()`);
    if (/\bcreateRequire\b/.test(text)) violations.push(`${name}: createRequire`);
  }
  return violations;
}
