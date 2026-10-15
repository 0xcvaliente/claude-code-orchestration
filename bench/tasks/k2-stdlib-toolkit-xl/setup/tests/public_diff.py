"""Public examples for toolkit.diff, checked against the standard library.

The hidden tests use the same kind of comparison on many more inputs.
Run all public tests with run_public.py, or this file directly:
    python3 tests/public_diff.py
"""

import os
import sys

EXAMPLES = [
    {"op": "sm", "a": "kitten sat", "b": "sitting sat", "isjunk": "space"},
    {"op": "sm", "a": ["a\n", "b\n", "c\n", "d\n"], "b": ["a\n", "x\n", "c\n", "d\n", "e\n"]},
    {"op": "sm", "a": "q" + "xy" * 3, "b": ("xy" * 110) + "q", "autojunk": True},
    {"op": "unified", "a": ["red\n", "green\n", "blue\n"], "b": ["red\n", "teal\n", "blue\n", "pink\n"],
     "kwargs": {"fromfile": "old.txt", "tofile": "new.txt", "n": 1}},
    {"op": "context", "a": ["1\n", "2\n", "3\n", "4\n"], "b": ["1\n", "3\n", "4\n", "5\n"],
     "kwargs": {"fromfiledate": "mon", "lineterm": "\n"}},
    {"op": "ndiff", "a": ["the cat sat\n", "on a mat\n"], "b": ["the bat sat\n", "on the mat\n"]},
    {"op": "restore", "delta": ["- a\n", "+ b\n", "?  ^\n", "  c\n"], "which": 2},
    {"op": "close", "word": "lamp", "poss": ["lump", "lamb", "camp", "ample", "dog"], "kwargs": {"n": 2}},
    {"op": "close", "word": "lamp", "poss": ["lump"], "kwargs": {"cutoff": 2}},
]

_PREDS = {"space": lambda x: x == " "}


def _norm(mod, ex):
    try:
        op = ex["op"]
        if op == "sm":
            kw = {"autojunk": ex["autojunk"]} if "autojunk" in ex else {}
            sm = mod.SequenceMatcher(_PREDS.get(ex.get("isjunk")), ex["a"], ex["b"], **kw)
            return [list(sm.find_longest_match()),
                    [list(m) for m in sm.get_matching_blocks()],
                    [list(o) for o in sm.get_opcodes()],
                    sm.ratio(), sm.quick_ratio(), sm.real_quick_ratio(),
                    [[list(o) for o in g] for g in sm.get_grouped_opcodes(1)]]
        if op == "unified":
            return list(mod.unified_diff(ex["a"], ex["b"], **ex["kwargs"]))
        if op == "context":
            return list(mod.context_diff(ex["a"], ex["b"], **ex["kwargs"]))
        if op == "ndiff":
            return list(mod.ndiff(ex["a"], ex["b"]))
        if op == "restore":
            return list(mod.restore(ex["delta"], ex["which"]))
        if op == "close":
            return mod.get_close_matches(ex["word"], ex["poss"], **ex["kwargs"])
    except Exception as e:  # noqa: BLE001
        return "exception:" + type(e).__name__
    raise ValueError(ex["op"])


def check(ex, mod=None):
    if mod is None:
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        import toolkit.diff as mod
    import difflib
    got = _norm(mod, ex)
    want = _norm(difflib, ex)
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
    print("diff public: %d/%d" % (ok, len(EXAMPLES)))
    sys.exit(0 if ok == len(EXAMPLES) else 1)
