/**
 * Error fingerprinting.
 *
 * Different students hit the "same mistake" with different variable names, file
 * paths, line numbers and values. We normalize those away so the same mistake
 * lands in one group, while keeping the parts that distinguish mistakes
 * (exception type, built-in type names, keywords, punctuation in syntax errors).
 *
 * Normalization is idempotent: normalize(normalize(x)) === normalize(x). The
 * client normalizes before sending (so raw values never leave the laptop) and
 * the server normalizes again before fingerprinting (so it never trusts the
 * client's hash).
 */

import type { RunResult } from './types.js';

/** Python built-in type names that make a TypeError meaningful ("'int' and 'str'"). */
const PY_TYPE_NAMES = new Set([
  'int', 'float', 'complex', 'str', 'bytes', 'bytearray', 'bool', 'list', 'tuple',
  'dict', 'set', 'frozenset', 'NoneType', 'None', 'object', 'type', 'function',
  'builtin_function_or_method', 'method', 'module', 'range', 'generator', 'map',
  'filter', 'zip', 'enumerate', 'slice', 'property', 'classmethod', 'staticmethod',
  'dict_keys', 'dict_values', 'dict_items', 'list_iterator', 'coroutine',
]);

/** Python keywords keep their meaning in messages like "'return' outside function". */
const PY_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
  'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield', 'match', 'case',
]);

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PUNCT_RE = /^[^A-Za-z0-9\s]{1,3}$/;
const PLACEHOLDER_RE = /^<(name|value|n|path|addr)>$/;

function normalizeQuoted(inner: string): string {
  if (PLACEHOLDER_RE.test(inner)) return inner;
  if (PY_TYPE_NAMES.has(inner) || PY_KEYWORDS.has(inner)) return inner;
  if (PUNCT_RE.test(inner)) return inner;
  if (IDENT_RE.test(inner)) return '<name>';
  return '<value>';
}

const MAX_MESSAGE_LENGTH = 200;

/**
 * Normalize a Python error message so the same mistake looks the same for everyone.
 * Removes file paths, line/column numbers, memory addresses, identifiers and literal values.
 */
export function normalizeMessage(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = String(raw);

  // Only the first line carries the message; the rest is traceback noise.
  s = s.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';

  // File paths (unix, windows, and Python's "<string>"/"<exec>" pseudo-files).
  s = s.replace(/File\s+"[^"]*"/g, 'File <path>');
  s = s.replace(/(?:[A-Za-z]:)?(?:[\\/][\w.\-~]+){2,}/g, '<path>');
  s = s.replace(/<(?:string|exec|stdin|module)>/g, '<path>');

  // Memory addresses before numbers, so 0x7f.. is not split.
  s = s.replace(/0x[0-9a-fA-F]+/g, '<addr>');

  // Quoted tokens: keep types/keywords/punctuation, hide identifiers and values.
  s = s.replace(/'([^'\n]*)'/g, (_m, inner: string) => `'${normalizeQuoted(inner)}'`);
  s = s.replace(/"([^"\n]*)"/g, (_m, inner: string) => `"${normalizeQuoted(inner)}"`);

  // Numbers (ints, floats, negatives, scientific) — but not ones inside placeholders/identifiers.
  // Numbers glued to letters (15th, x2, utf8) are words, not values, and stay as they are.
  s = s.replace(/(?<![A-Za-z_<\d.])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?![A-Za-z_\d])/g, '<n>');

  // Collapse runs like "<n>, <n>, <n>" into a single "<n>, …" so list length doesn't split groups.
  s = s.replace(/<n>(?:\s*,\s*<n>)+/g, '<n>, …');
  s = s.replace(/'<value>'(?:\s*,\s*'<value>')+/g, "'<value>', …");

  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > MAX_MESSAGE_LENGTH) s = s.slice(0, MAX_MESSAGE_LENGTH - 1) + '…';
  return s;
}

/** Normalize a Python exception class name: keep only a plain identifier (strip module prefixes). */
export function normalizeErrorType(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const last = String(raw).trim().split('.').pop() ?? '';
  return IDENT_RE.test(last) ? last.slice(0, 64) : null;
}

/** Test names are function names defined by the instructor; keep them if they look like one. */
export function normalizeTestName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  return IDENT_RE.test(s) ? s.slice(0, 80) : null;
}

/**
 * 53-bit string hash (cyrb53). Synchronous and identical in browsers and Node,
 * which matters because the dashboard, student client and server all compute it.
 */
export function hash53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, '0');
}

export interface FingerprintInput {
  exerciseId: string;
  result: RunResult;
  errorType: string | null;
  errorMessage: string | null;
  failingTest: string | null;
}

/**
 * Stable fingerprint for "the same mistake on the same exercise".
 * Returns null for a passing run.
 *
 * - error runs group by exception type + normalized message (the test name is
 *   ignored: the same TypeError hit from two tests is still one mistake).
 * - fail runs (assertions failed, no exception) group by the first failing test
 *   + normalized assertion message.
 */
export function fingerprint(input: FingerprintInput): string | null {
  if (input.result === 'pass') return null;
  const type = normalizeErrorType(input.errorType) ?? (input.result === 'fail' ? 'AssertionError' : 'Error');
  const msg = normalizeMessage(input.errorMessage);
  const key =
    input.result === 'fail'
      ? `${input.exerciseId}|fail|${normalizeTestName(input.failingTest) ?? ''}|${msg}`
      : `${input.exerciseId}|error|${type}|${msg}`;
  return hash53(key);
}
