"""LabPulse local test runner.

Runs inside Pyodide in a Web Worker on the student's machine. It executes the
student's code and the exercise tests, and returns a summary. The student's code
and output stay on the machine: only result, test counts, exception type, a
normalized message and the failing test name are sent to the instructor.
"""

import builtins
import contextlib
import io
import json
import sys
import traceback
import types

STUDENT_FILE = "solution.py"
TESTS_FILE = "tests.py"
MAX_OUTPUT = 10_000


class _CappedIO(io.StringIO):
    def write(self, s):
        if self.tell() < MAX_OUTPUT:
            return super().write(s[: MAX_OUTPUT - self.tell()])
        return len(s)


def _no_input(*_args, **_kwargs):
    raise RuntimeError("input() isn't available here: the tests call your functions directly")


def _student_line(tb):
    """Line number of the deepest frame inside the student's file, if any."""
    line = None
    for frame, lineno in traceback.walk_tb(tb):
        if frame.f_code.co_filename == STUDENT_FILE:
            line = lineno
    return line


def _student_traceback(exc):
    """Traceback text limited to the student's own file (what they need to see)."""
    frames = [
        f for f in traceback.extract_tb(exc.__traceback__) if f.filename == STUDENT_FILE
    ]
    lines = traceback.format_list(frames)
    lines += traceback.format_exception_only(type(exc), exc)
    return "".join(lines).strip()


def _message(exc):
    if isinstance(exc, SyntaxError):
        return exc.msg or "invalid syntax"
    text = str(exc)
    if isinstance(exc, KeyError) and exc.args:
        text = "key " + repr(exc.args[0])
    return text or type(exc).__name__


def run(student_src, tests_src):
    out = _CappedIO()
    summary = {
        "result": "pass",
        "testsPassed": 0,
        "testsTotal": 0,
        "errorType": None,
        "errorMessage": None,
        "failingTest": None,
        "line": None,
        "traceback": None,
        "tests": [],
        "stdout": "",
    }

    def fail_whole(exc, line=None):
        summary["result"] = "error"
        summary["errorType"] = type(exc).__name__
        summary["errorMessage"] = _message(exc)
        summary["line"] = line
        summary["traceback"] = _student_traceback(exc) if not isinstance(exc, SyntaxError) else (
            "".join(traceback.format_exception_only(type(exc), exc)).strip()
        )

    module = types.ModuleType("solution")
    module.__file__ = STUDENT_FILE
    saved_input = builtins.input
    builtins.input = _no_input
    sys.modules["solution"] = module
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            # 1. Compile the student's code.
            try:
                code = compile(student_src, STUDENT_FILE, "exec")
            except SyntaxError as exc:
                fail_whole(exc, exc.lineno)
                return summary

            # 2. Run it (module level: definitions and any top-level calls).
            try:
                exec(code, module.__dict__)
            except BaseException as exc:  # noqa: BLE001 - report everything, incl. SystemExit
                fail_whole(exc, _student_line(exc.__traceback__))
                return summary

            # 3. Load the tests. An ImportError here means a function is missing or misnamed.
            namespace = {"__name__": "tests"}
            try:
                exec(compile(tests_src, TESTS_FILE, "exec"), namespace)
            except BaseException as exc:  # noqa: BLE001
                fail_whole(exc, _student_line(exc.__traceback__))
                return summary

            tests = [
                (name, fn)
                for name, fn in namespace.items()
                if name.startswith("test_") and callable(fn)
            ]
            summary["testsTotal"] = len(tests)

            first_fail = None
            first_error = None
            for name, fn in tests:
                record = {"name": name, "status": "pass", "message": None, "errorType": None, "line": None}
                try:
                    fn()
                    summary["testsPassed"] += 1
                except AssertionError as exc:
                    record["status"] = "fail"
                    record["errorType"] = "AssertionError"
                    record["message"] = str(exc) or "assertion failed"
                    first_fail = first_fail or (name, exc)
                except BaseException as exc:  # noqa: BLE001
                    if _student_line(exc.__traceback__) is None and not isinstance(exc, (RecursionError, MemoryError)):
                        # Raised by the test itself (e.g. indexing a too-short result):
                        # the student's code ran fine but returned the wrong thing.
                        record["status"] = "fail"
                        record["errorType"] = "AssertionError"
                        record["message"] = f"{type(exc).__name__} while checking the result: {_message(exc)}"
                        first_fail = first_fail or (name, AssertionError(record["message"]))
                        summary["tests"].append(record)
                        continue
                    record["status"] = "error"
                    record["errorType"] = type(exc).__name__
                    record["message"] = _message(exc)
                    record["line"] = _student_line(exc.__traceback__)
                    record["traceback"] = _student_traceback(exc)
                    first_error = first_error or (name, exc)
                summary["tests"].append(record)

            if first_error:
                name, exc = first_error
                summary["result"] = "error"
                summary["errorType"] = type(exc).__name__
                summary["errorMessage"] = _message(exc)
                summary["failingTest"] = name
                summary["line"] = _student_line(exc.__traceback__)
                summary["traceback"] = _student_traceback(exc)
            elif first_fail:
                name, exc = first_fail
                summary["result"] = "fail"
                summary["errorType"] = "AssertionError"
                summary["errorMessage"] = str(exc) or "assertion failed"
                summary["failingTest"] = name
            elif not tests:
                summary["result"] = "error"
                summary["errorType"] = "RuntimeError"
                summary["errorMessage"] = "This exercise has no tests"
            return summary
    finally:
        builtins.input = saved_input
        sys.modules.pop("solution", None)
        summary["stdout"] = out.getvalue()


def run_json(student_src, tests_src):
    return json.dumps(run(student_src, tests_src))
