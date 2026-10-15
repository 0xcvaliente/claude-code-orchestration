"""Public examples for toolkit.b64, checked against the standard library.

The hidden tests use the same kind of comparison on many more inputs.
Run all public tests with run_public.py, or this file directly:
    python3 tests/public_b64.py
"""

import os
import sys

EXAMPLES = [
    {"fn": "b64encode", "args": [b"\x00\x10\x83\xff"], "kwargs": {"altchars": b"*!"}},
    {"fn": "b64decode", "args": ["Zm9v YmE="]},
    {"fn": "b64decode", "args": ["Zm9v YmE="], "kwargs": {"validate": True}},
    {"fn": "urlsafe_b64decode", "args": [b"_-8A"]},
    {"fn": "b32decode", "args": ["mzxw6==="], "kwargs": {"casefold": True}},
    {"fn": "b16decode", "args": ["C0FFE"]},
    {"fn": "a85encode", "args": [b"\x00\x00\x00\x00Hi"], "kwargs": {"adobe": True}},
    {"fn": "a85decode", "args": ["9jqo^z"]},
    {"fn": "b85encode", "args": [b"Base85!"]},
    {"fn": "z85decode", "args": ["rr91j"]},
]


def _norm(mod, ex, errcls):
    try:
        return getattr(mod, ex["fn"])(*ex["args"], **ex.get("kwargs", {}))
    except Exception as e:  # noqa: BLE001
        if isinstance(e, errcls):
            return "Error"
        if isinstance(e, ValueError):
            return "ValueError"
        if isinstance(e, TypeError):
            return "TypeError"
        return "exception:" + type(e).__name__


def check(ex, mod=None):
    if mod is None:
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        import toolkit.b64 as mod
    import base64
    import binascii
    got = _norm(mod, ex, mod.Error)
    want = _norm(base64, ex, binascii.Error)
    return got == want, "got %r want %r" % (got, want)


if __name__ == "__main__":
    ok = 0
    for ex in EXAMPLES:
        try:
            r = check(ex)[0]
        except Exception as e:  # noqa: BLE001
            r = False
            print("crash:", ex, repr(e))
        print("PASS" if r else "FAIL", ex)
        ok += bool(r)
    print("b64 public: %d/%d" % (ok, len(EXAMPLES)))
    sys.exit(0 if ok == len(EXAMPLES) else 1)
