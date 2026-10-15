"""Public examples for toolkit.jsonx, checked against the standard library.

The hidden tests use the same kind of comparison on many more inputs.
Run all public tests with run_public.py, or this file directly:
    python3 tests/public_jsonx.py
"""

import os
import sys

EXAMPLES = [
    {"name": "dumps-mixed", "op": "dumps",
     "obj": lambda: {"name": "caf\u00e9", "n": [1, 2.0, None, True], 3: (4, 5)}},
    {"name": "dumps-indent-sorted", "op": "dumps",
     "obj": lambda: {"b": [1, {}], "a": {"y": [], "x": "q\"t"}},
     "kw": {"indent": 2, "sort_keys": True}},
    {"name": "dumps-no-ascii-separators", "op": "dumps",
     "obj": lambda: ["\u00fc\n\x01", 1e-7, float("inf")],
     "kw": {"ensure_ascii": False, "separators": (",", ":")}},
    {"name": "dumps-nan-forbidden", "op": "dumps",
     "obj": lambda: [1, float("nan")], "kw": {"allow_nan": False}},
    {"name": "dumps-default", "op": "dumps",
     "obj": lambda: {"s": {5, 4}}, "kw": {"default": sorted}},
    {"name": "loads-nested", "op": "loads",
     "s": ' {"a": [1, -2.5e1, "x\\u00e9\\n"], "b": {"c": null}, "a": false} '},
    {"name": "loads-pairs-hook", "op": "loads",
     "s": '{"k": 1, "k": 2}', "kw": {"object_pairs_hook": list}},
    {"name": "loads-error-position", "op": "loads",
     "s": '[\n  1,\n  2\n  "x"\n]'},
    {"name": "loads-bad-escape", "op": "loads", "s": '["ok", "a\\qb"]'},
]


def _norm(v):
    if isinstance(v, float):
        return ("float", repr(v))
    if isinstance(v, (list, tuple)):
        return (type(v).__name__, [_norm(x) for x in v])
    if isinstance(v, dict):
        return ("dict", [(_norm(k), _norm(x)) for k, x in v.items()])
    return v


def _run(mod, ex):
    errcls = getattr(mod, "JSONDecodeError", ())
    try:
        if ex["op"] == "dumps":
            return mod.dumps(ex["obj"](), **ex.get("kw", {}))
        return _norm(mod.loads(ex["s"], **ex.get("kw", {})))
    except Exception as e:  # noqa: BLE001
        if errcls and isinstance(e, errcls):
            return ("JSONDecodeError", e.pos, e.lineno, e.colno)
        return ("exception", type(e).__name__)


def check(ex, mod=None):
    if mod is None:
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        import toolkit.jsonx as mod
    import json
    got = _run(mod, ex)
    want = _run(json, ex)
    return got == want, "got %r, want %r" % (got, want)


if __name__ == "__main__":
    ok = 0
    for ex in EXAMPLES:
        try:
            r = check(ex)[0]
        except Exception as e:  # noqa: BLE001
            r = False
            print("crash:", ex["name"], repr(e))
        print("PASS" if r else "FAIL", ex["name"])
        ok += bool(r)
    print("jsonx public: %d/%d" % (ok, len(EXAMPLES)))
    sys.exit(0 if ok == len(EXAMPLES) else 1)
