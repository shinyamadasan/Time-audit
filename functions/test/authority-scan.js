// functions/test/authority-scan.js
//
// Test-only, deliberately small source scan for the §3 authority boundary. Not a general parser: it catches the
// OBVIOUS ways privileged Firebase access could be loaded outside the approved entry point.
//   - every module specifier, whether a static import/export or a literal dynamic import('...'), is collected;
//   - a Firebase / Google Cloud specifier is allowed only in index.js and only from APPROVED (app, auth,
//     functions) — never the Admin Database/Firestore SDK, the bare Admin namespace or the client SDK;
//   - a dynamic import whose specifier is not a plain string literal, any require( and any createRequire are
//     refused outright, because the specifier they load cannot be checked.
//
// All checks run on EXECUTABLE code only. lex() is a small comment/string/template/regex-aware pass, so a comment
// can neither hide a call (`import /* x */ ('firebase-admin')`) nor fake one (`// require('firebase-admin')`).

export const APPROVED_ENTRY = 'index.js';
export const APPROVED_SPECIFIERS = Object.freeze(['firebase-admin/app', 'firebase-admin/auth', 'firebase-functions/params', 'firebase-functions/v2/https']);
const PRIVILEGED = /^(@?firebase|@google-cloud\/|googleapis)/;
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'await', 'yield']);
const CONTROL_KEYWORDS = new Set(['if', 'while', 'for', 'with']);

/**
 * Two same-length views of `text` (so indices line up):
 *   code     — comments and regex-literal bodies blanked; string/template text kept (specifiers are read here);
 *   codeOnly — additionally every string/template text blanked, leaving only executable tokens.
 * Blanking keeps newlines. Template `${...}` expressions are code. A `/` starts a regex literal where an operand
 * is expected (after punctuation/operators, a keyword, a control-flow header's `)`, or at the start), otherwise it
 * is division.
 */
export function lex(text) {
  // UTF-16 units, NOT [...text] (code points): text[i] indexes UTF-16, so an astral character would misalign.
  const code = text.split('');
  const only = text.split('');
  const blank = (i, both) => { if (text[i] !== '\n') { only[i] = ' '; if (both) code[i] = ' '; } };
  const stack = []; // 'brace' | 'template-expr'
  // `)` normally ends an operand (`(a) / b` is division), but the `)` closing an if/while/for/with header ends a
  // statement head, so a `/` after it starts a regex literal: `if (x) /re/.test(y)`.
  const parens = []; // per open '(': does it open a control-flow header?
  const controlCloses = new Set();
  const previousSignificant = i => { let j = i - 1; while (j >= 0 && /\s/.test(only[j])) j--; return j; };
  const wordEndingAt = j => { let k = j; while (k >= 0 && /[\w$]/.test(only[k])) k--; return only.slice(k + 1, j + 1).join(''); };
  const regexAllowedAt = i => {
    const j = previousSignificant(i);
    if (j < 0) return true;
    if (only[j] === ')') return controlCloses.has(j);
    if (/[(,=:[!&|?{};+\-*%<>~^}]/.test(only[j])) return true;
    if (!/[\w$]/.test(only[j])) return false;
    return REGEX_KEYWORDS.has(wordEndingAt(j));
  };
  let i = 0;
  const template = () => { // at the opening backtick or just after a closing `}` of ${...}
    while (i < text.length) {
      if (text[i] === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (text[i] === '`') { i++; return; }
      if (text[i] === '$' && text[i + 1] === '{') { stack.push('template-expr'); i += 2; return; }
      blank(i); i++;
    }
  };
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') blank(i++, true); continue; }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      while (i < stop) blank(i++, true);
      continue;
    }
    if (ch === '"' || ch === "'") {
      i++;
      while (i < text.length && text[i] !== ch && text[i] !== '\n') {
        if (text[i] === '\\') { blank(i); i++; }
        blank(i); i++;
      }
      i++;
      continue;
    }
    if (ch === '`') { i++; template(); continue; }
    if (ch === '/' && regexAllowedAt(i)) {
      i++;
      let inClass = false;
      while (i < text.length && text[i] !== '\n' && (inClass || text[i] !== '/')) {
        if (text[i] === '\\') { blank(i, true); i++; }
        else if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        blank(i, true); i++;
      }
      i++;
      continue;
    }
    if (ch === '(') { const j = previousSignificant(i); parens.push(j >= 0 && CONTROL_KEYWORDS.has(wordEndingAt(j))); }
    if (ch === ')' && parens.pop()) controlCloses.add(i);
    if (ch === '{') stack.push('brace');
    if (ch === '}' && stack.pop() === 'template-expr') { i++; template(); continue; }
    i++;
  }
  return { code: code.join(''), codeOnly: only.join('') };
}

const STATIC = /^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
const DYNAMIC = /\bimport\s*\(/g;
const LITERAL_ARGUMENT = /^\s*(['"])([^'"\n]*)\1\s*\)/;

/** @returns {{specifiers: string[], nonLiteralDynamic: number}} module loads in executable code */
function loadsOf(text) {
  const { code, codeOnly } = lex(text);
  const specifiers = [];
  for (const m of code.matchAll(STATIC)) {
    const keyword = m.index + m[0].search(/import|export/);
    if (codeOnly.startsWith('import', keyword) || codeOnly.startsWith('export', keyword)) specifiers.push(m[1] ?? m[2]);
  }
  let nonLiteralDynamic = 0;
  for (const m of codeOnly.matchAll(DYNAMIC)) {
    const literal = LITERAL_ARGUMENT.exec(code.slice(m.index + m[0].length));
    if (literal) specifiers.push(literal[2]); else nonLiteralDynamic++;
  }
  return { specifiers, nonLiteralDynamic, codeOnly };
}

export function specifiersOf(text) {
  return loadsOf(text).specifiers;
}

/** @param {{name:string, text:string}[]} files  name is relative to functions/ (e.g. 'src/x.js')
 *  @returns {string[]} violations; empty means the boundary holds */
export function authorityViolations(files) {
  const violations = [];
  for (const { name, text } of files) {
    const { specifiers, nonLiteralDynamic, codeOnly } = loadsOf(text);
    for (const specifier of specifiers) {
      if (!PRIVILEGED.test(specifier)) continue;
      if (name !== APPROVED_ENTRY || !APPROVED_SPECIFIERS.includes(specifier)) violations.push(`${name}: loads ${specifier}`);
    }
    if (nonLiteralDynamic) violations.push(`${name}: dynamic import() with a non-literal specifier`);
    if (/\brequire\s*\(/.test(codeOnly)) violations.push(`${name}: require()`);
    if (/\bcreateRequire\b/.test(codeOnly)) violations.push(`${name}: createRequire`);
  }
  return violations;
}
