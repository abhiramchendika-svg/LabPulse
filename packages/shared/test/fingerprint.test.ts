import { describe, expect, it } from 'vitest';
import { fingerprint, hash53, normalizeErrorType, normalizeMessage, normalizeTestName } from '../src/fingerprint.js';

describe('normalizeMessage', () => {
  it('keeps built-in type names so different TypeErrors stay different', () => {
    expect(normalizeMessage("unsupported operand type(s) for +: 'int' and 'str'")).toBe(
      "unsupported operand type(s) for +: 'int' and 'str'",
    );
    expect(normalizeMessage('can only concatenate str (not "int") to str')).toBe('can only concatenate str (not "int") to str');
  });

  it('hides variable names', () => {
    const a = normalizeMessage("name 'totl' is not defined");
    const b = normalizeMessage("name 'totla' is not defined");
    expect(a).toBe("name '<name>' is not defined");
    expect(a).toBe(b);
  });

  it('hides function names in call-arity errors', () => {
    expect(normalizeMessage('average() takes 1 positional argument but 2 were given')).toBe(
      'average() takes <n> positional argument but <n> were given',
    );
    expect(normalizeMessage("'NoneType' object is not subscriptable")).toBe("'NoneType' object is not subscriptable");
    expect(normalizeMessage("'list' object has no attribute 'push'")).toBe("'list' object has no attribute '<name>'");
  });

  it('removes line numbers and file paths', () => {
    expect(normalizeMessage('File "/home/ana/lab/main.py", line 12, in average')).toBe('File <path>, line <n>, in average');
    expect(normalizeMessage('error in C:\\Users\\ana\\lab\\main.py at line 3')).toBe('error in <path> at line <n>');
    expect(normalizeMessage('unterminated string literal (detected at line 7)')).toBe(
      'unterminated string literal (detected at line <n>)',
    );
  });

  it('keeps punctuation and keywords in syntax errors', () => {
    expect(normalizeMessage("expected ':'")).toBe("expected ':'");
    expect(normalizeMessage("'(' was never closed")).toBe("'(' was never closed");
    expect(normalizeMessage("'return' outside function")).toBe("'return' outside function");
  });

  it('hides literal values so data never leaves the laptop', () => {
    expect(normalizeMessage("invalid literal for int() with base 10: 'hello world'")).toBe(
      "invalid literal for int() with base <n>: '<value>'",
    );
    expect(normalizeMessage("invalid literal for int() with base 10: 'abc'")).toBe(
      "invalid literal for int() with base <n>: '<name>'",
    );
  });

  it('collapses lists of numbers so list length does not split a group', () => {
    expect(normalizeMessage('average([1, 2, 3]) should be 2.0, got 3')).toBe('average([<n>, …]) should be <n>, got <n>');
    expect(normalizeMessage('average([10, 20]) should be 15.0, got -4.5e3')).toBe('average([<n>, …]) should be <n>, got <n>');
  });

  it('does not mistake division in a message for a file path', () => {
    expect(normalizeMessage('expected 10 / 2.5 to equal 4')).toBe('expected <n> / <n> to equal <n>');
    expect(normalizeMessage("unsupported operand type(s) for /: 'str' and 'int'")).toBe(
      "unsupported operand type(s) for /: 'str' and 'int'",
    );
  });

  it('leaves numbers that are part of a word alone', () => {
    expect(normalizeMessage("the 15th item should be 'FizzBuzz', got 'Fizz'")).toBe("the 15th item should be '<name>', got '<name>'");
    expect(normalizeMessage('codec utf8 failed at 12')).toBe('codec utf8 failed at <n>');
  });

  it('removes memory addresses', () => {
    expect(normalizeMessage('<function f at 0x7f3a2b1c> is not iterable')).toBe('<function f at <addr>> is not iterable');
  });

  it('uses only the first non-empty line and trims length', () => {
    expect(normalizeMessage('\n  boom\nTraceback...')).toBe('boom');
    expect(normalizeMessage('x'.repeat(500)).length).toBe(200);
    expect(normalizeMessage(null)).toBe('');
  });

  it('is idempotent', () => {
    const samples = [
      "unsupported operand type(s) for +: 'int' and 'str'",
      "name 'totl' is not defined",
      'average([1, 2, 3]) should be 2.0, got 3',
      'File "/home/ana/lab/main.py", line 12, in average',
      "invalid literal for int() with base 10: 'hello world'",
      '<function f at 0x7f3a2b1c> is not iterable',
      "'(' was never closed",
    ];
    for (const s of samples) {
      const once = normalizeMessage(s);
      expect(normalizeMessage(once)).toBe(once);
    }
  });
});

describe('normalizeErrorType / normalizeTestName', () => {
  it('strips module prefixes and rejects junk', () => {
    expect(normalizeErrorType('builtins.TypeError')).toBe('TypeError');
    expect(normalizeErrorType('TypeError')).toBe('TypeError');
    expect(normalizeErrorType('not a type!')).toBeNull();
    expect(normalizeErrorType(null)).toBeNull();
    expect(normalizeTestName('test_average_empty')).toBe('test_average_empty');
    expect(normalizeTestName('rm -rf')).toBeNull();
  });
});

describe('fingerprint', () => {
  const base = { exerciseId: 'ex2', result: 'error' as const, errorType: 'TypeError', failingTest: 'test_a' };

  it('is null for a pass', () => {
    expect(fingerprint({ ...base, result: 'pass', errorMessage: null })).toBeNull();
  });

  it('groups the same mistake from different students together', () => {
    const a = fingerprint({ ...base, errorMessage: "name 'totl' is not defined", errorType: 'NameError' });
    const b = fingerprint({ ...base, errorMessage: "name 'x' is not defined", errorType: 'NameError', failingTest: 'test_b' });
    expect(a).toBe(b);
  });

  it('separates different mistakes', () => {
    const a = fingerprint({ ...base, errorMessage: "unsupported operand type(s) for +: 'int' and 'str'" });
    const b = fingerprint({ ...base, errorMessage: "unsupported operand type(s) for +: 'int' and 'list'" });
    const c = fingerprint({ ...base, exerciseId: 'ex3', errorMessage: "unsupported operand type(s) for +: 'int' and 'str'" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('groups failed assertions by failing test', () => {
    const f = (test: string, msg: string) =>
      fingerprint({ exerciseId: 'ex1', result: 'fail', errorType: 'AssertionError', errorMessage: msg, failingTest: test });
    expect(f('test_basic', 'average([1, 2, 3]) should be 2.0, got 3')).toBe(f('test_basic', 'average([4, 5]) should be 4.5, got 9'));
    expect(f('test_basic', 'x')).not.toBe(f('test_empty', 'x'));
  });

  it('is a 14-char hex string and stable across calls', () => {
    const fp = fingerprint({ ...base, errorMessage: 'boom' });
    expect(fp).toMatch(/^[0-9a-f]{14}$/);
    expect(fingerprint({ ...base, errorMessage: 'boom' })).toBe(fp);
    expect(hash53('abc')).toBe(hash53('abc'));
    expect(hash53('abc')).not.toBe(hash53('abd'));
  });
});
