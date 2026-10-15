"""Public examples for toolkit.wrap, checked against the standard library.

The hidden tests use the same kind of comparison on many more inputs.
Run all public tests with run_public.py, or this file directly:
    python3 tests/public_wrap.py
"""

import os
import sys

_TEXT = ("Nobody expects the Spanish Inquisition! Our chief weapon is surprise. "
         "Surprise and fear... fear and surprise.")

EXAMPLES = [
    {"op": "wrap", "text": _TEXT, "kwargs": {"width": 24}},
    {"op": "fill", "text": _TEXT, "kwargs": {"width": 30, "initial_indent": "- ",
                                             "subsequent_indent": "  ", "fix_sentence_endings": True}},
    {"op": "wrap", "text": "a user-friendly, ready-made solution--or not", "kwargs": {"width": 9}},
    {"op": "wrap", "text": "col1\tcol2\tcol3", "kwargs": {"width": 12, "tabsize": 6}},
    {"op": "wrap", "text": _TEXT, "kwargs": {"width": 20, "max_lines": 2, "placeholder": " (more)"}},
    {"op": "shorten", "text": "  The   quick brown\n fox  ", "width": 15, "kwargs": {}},
    {"op": "dedent", "text": "      def f():\n          return 1\n  \n      # end\n"},
    {"op": "indent", "text": "first\n\n  third\n", "prefix": "| "},
    {"op": "wrap", "text": "tiny", "kwargs": {"width": 3, "max_lines": 1}},
]


def _norm(mod, ex):
    try:
        op = ex["op"]
        if op == "wrap":
            return mod.wrap(ex["text"], **ex["kwargs"])
        if op == "fill":
            return mod.fill(ex["text"], **ex["kwargs"])
        if op == "shorten":
            return mod.shorten(ex["text"], ex["width"], **ex["kwargs"])
        if op == "dedent":
            return mod.dedent(ex["text"])
        if op == "indent":
            return mod.indent(ex["text"], ex["prefix"])
    except Exception as e:  # noqa: BLE001
        return "exception:" + type(e).__name__
    raise ValueError(ex["op"])


def check(ex, mod=None):
    if mod is None:
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        import toolkit.wrap as mod
    import textwrap
    got = _norm(mod, ex)
    want = _norm(textwrap, ex)
    if got == want:
        return True
    return False, "got %r, want %r" % (got, want)


if __name__ == "__main__":
    ok = 0
    for ex in EXAMPLES:
        try:
            r = check(ex)
        except Exception as e:  # noqa: BLE001
            r = False
            print("crash:", ex, repr(e))
        passed = r[0] if isinstance(r, tuple) else r
        print("PASS" if passed else "FAIL", ex)
        if isinstance(r, tuple):
            print("   ", r[1][:300])
        ok += bool(passed)
    print("wrap public: %d/%d" % (ok, len(EXAMPLES)))
    sys.exit(0 if ok == len(EXAMPLES) else 1)
