"""Public examples for toolkit.regex, checked against the standard library.

The hidden tests use the same kind of comparison on many more inputs.
Run all public tests with run_public.py, or this file directly:
    python3 tests/public_regex.py
"""

import os
import sys

EXAMPLES = [
    {"op": "findall", "pattern": r"(\w+)=(\d+)", "string": "x=1, yy=22, z=q"},
    {"op": "search", "pattern": r"(?P<year>\d{4})-(?P<mon>\d\d)?", "string": "on 2024-, 2025-06"},
    {"op": "sub", "pattern": r"(\w+) (\w+)", "repl": r"\2 \1", "string": "hello world foo bar"},
    {"op": "split", "pattern": r"(,)|;", "string": "a,b;c"},
    {"op": "findall", "pattern": r"^\s*#.*$", "string": "x\n # c1\n#c2\ny", "flags": 8},
    {"op": "fullmatch", "pattern": r"[a-f\d]+", "string": "BEEF42", "flags": 2},
    {"op": "finditer", "pattern": r"b*", "string": "abbc"},
    {"op": "compile", "pattern": r"(a)(?<=b"},
    {"op": "search", "pattern": r"(?<=@)\w+(?!\.)", "string": "me@host.org you@lan"},
]


def _norm(mod, ex):
    err = getattr(mod, "error", ())
    try:
        op = ex["op"]
        flags = ex.get("flags", 0)
        p = mod.compile(ex["pattern"], flags)
        if op == "compile":
            return [p.groups, dict(p.groupindex), p.flags]
        s = ex["string"]

        def m2(m):
            if m is None:
                return None
            n = len(m.groups())
            return [m.group(0), list(m.span()), list(m.groups()), m.groupdict(),
                    [list(m.span(i)) for i in range(n + 1)], m.lastindex, m.lastgroup]

        if op in ("search", "match", "fullmatch"):
            return m2(getattr(p, op)(s))
        if op == "findall":
            return [list(x) if isinstance(x, tuple) else x for x in p.findall(s)]
        if op == "finditer":
            return [m2(m) for m in p.finditer(s)]
        if op == "sub":
            return p.subn(ex["repl"], s)
        if op == "split":
            return p.split(s)
    except Exception as e:  # noqa: BLE001
        if err and isinstance(e, err):
            return "error"
        return "exception:" + type(e).__name__
    raise ValueError(ex["op"])


def check(ex, mod=None):
    if mod is None:
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        import toolkit.regex as mod
    import re
    got = _norm(mod, ex)
    want = _norm(re, ex)
    return got == want


if __name__ == "__main__":
    ok = 0
    for ex in EXAMPLES:
        try:
            r = check(ex)
        except Exception as e:  # noqa: BLE001
            r = False
            print("crash:", ex, repr(e))
        print("PASS" if r else "FAIL", ex)
        ok += bool(r)
    print("regex public: %d/%d" % (ok, len(EXAMPLES)))
    sys.exit(0 if ok == len(EXAMPLES) else 1)
