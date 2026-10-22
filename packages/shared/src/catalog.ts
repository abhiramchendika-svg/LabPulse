/**
 * Plain-English labels for common Python errors. Deterministic (no AI): it gives the
 * instructor a readable headline for each group, and the dashboard a starting point
 * for a hint when the exercise doesn't define one.
 */

export interface ErrorExplanation {
  label: string;
  hint: string;
}

const CATALOG: Record<string, ErrorExplanation> = {
  SyntaxError: {
    label: "Python can't parse the code",
    hint: 'Check the line the editor marks: look for a missing colon after if/for/def, an unclosed bracket or quote, or a stray character.',
  },
  IndentationError: {
    label: 'Indentation is off',
    hint: 'Python uses indentation to group code. Make sure the body of every if/for/def is indented by the same amount (4 spaces).',
  },
  TabError: {
    label: 'Tabs and spaces are mixed',
    hint: 'Use spaces only for indentation. Re-indent the block so every line uses 4 spaces.',
  },
  NameError: {
    label: 'Using a name that was never defined',
    hint: "Check spelling and capitalisation, and make sure the variable is assigned before it's used.",
  },
  UnboundLocalError: {
    label: 'Variable used before it is assigned in the function',
    hint: 'Give the variable a starting value at the top of the function, before the loop that updates it.',
  },
  TypeError: {
    label: 'Mixing types that don’t go together',
    hint: "Print the type() of each value. You may be adding a number to a string, calling something that isn't a function, or passing the wrong number of arguments.",
  },
  ValueError: {
    label: 'Right type, wrong value',
    hint: 'A function received a value it can’t handle (for example int("abc")). Check what you pass in.',
  },
  IndexError: {
    label: 'Index past the end of a list',
    hint: 'Valid indexes run from 0 to len(items) - 1. Check loop bounds and empty lists.',
  },
  KeyError: {
    label: 'Dictionary key does not exist',
    hint: 'Check the key exists first (`if key in d`) or use d.get(key, default).',
  },
  AttributeError: {
    label: 'Using a method the value doesn’t have',
    hint: 'Check the type of the value. A common cause is a function returning None, or calling a list method on a string.',
  },
  ZeroDivisionError: {
    label: 'Dividing by zero',
    hint: 'Handle the empty case before dividing, for example return 0 when the list is empty.',
  },
  RecursionError: {
    label: 'Recursion never stops',
    hint: 'Make sure the recursive function has a base case and each call moves toward it.',
  },
  Timeout: {
    label: 'Code ran too long (likely an infinite loop)',
    hint: 'Check that every while loop changes the value its condition depends on.',
  },
  AssertionError: {
    label: 'Runs, but gives the wrong answer',
    hint: 'Compare your output with the expected value in the failing test. Try the example by hand.',
  },
  ImportError: {
    label: 'Import failed',
    hint: 'Only the Python standard library is available. Check the module name.',
  },
  ModuleNotFoundError: {
    label: 'Module not found',
    hint: 'Only the Python standard library is available. Check the module name.',
  },
  RuntimeError: {
    label: 'Runtime error',
    hint: 'Read the message carefully and check the line the editor marks.',
  },
};

export function explainError(errorType: string | null | undefined, result?: 'fail' | 'error'): ErrorExplanation {
  if (result === 'fail') return CATALOG.AssertionError!;
  return (errorType && CATALOG[errorType]) || { label: errorType ?? 'Error', hint: 'Read the error message and check the line the editor marks.' };
}
