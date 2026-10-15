"""Public examples for toolkit.fraction, checked against the standard library.

The hidden tests use the same kind of comparison on many more inputs.
Run all public tests with run_public.py, or this file directly:
    python3 tests/public_fraction.py
"""

import math
import os
import sys

EXAMPLES = [
    {"name": "parse-decimal-exponent", "expr": lambda F: F(" -3.5e-2 ")},
    {"name": "parse-underscore-fraction", "expr": lambda F: F("2_4/1_8")},
    {"name": "mixed-arith", "expr": lambda F: [F(5, 6) + 1, F(5, 6) - F(1, 4), F(5, 6) * 0.5,
                                               F(-11, 4) // F(2, 3), divmod(F(-11, 4), 2)]},
    {"name": "powers", "expr": lambda F: [F(-3, 2) ** -2, 3 ** F(2), 9 ** F(1, 2)]},
    {"name": "rounding", "expr": lambda F: [round(F(9, 2)), round(F(-13, 8), 2),
                                            math.floor(F(-1, 3)), math.ceil(F(-1, 3))]},
    {"name": "compare-float", "expr": lambda F: [F(1, 5) == 0.2, F(1, 5) < 0.2, F(3) >= 3]},
    {"name": "format", "expr": lambda F: [format(F(22, 7), ".4f"), format(F(-22, 7), "^10"),
                                          format(F(1, 3), ".2%"), format(F(10 ** 6, 3), ",.1e")]},
    {"name": "limit-hash-str", "expr": lambda F: [F(103993, 33102).limit_denominator(200),
                                                  hash(F(3, 4)), str(F(8, 2)), repr(F(-1, 6))]},
    {"name": "errors", "expr": lambda F: F(4, 0)},
]


def _norm(F, x):
    if type(x) is F:
        return ("F", x.numerator, x.denominator)
    if isinstance(x, float):
        return ("float", round(x, 12))
    if isinstance(x, (list, tuple)):
        return (type(x).__name__, [_norm(F, v) for v in x])
    return (type(x).__name__, x)


def _run(F, ex):
    try:
        return _norm(F, ex["expr"](F))
    except Exception as e:  # noqa: BLE001
        return ("error", type(e).__name__)


def check(ex, mod=None):
    if mod is None:
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        import toolkit.fraction as mod
    import fractions
    got = _run(mod.Fraction, ex)
    want = _run(fractions.Fraction, ex)
    return got == want, "got %r, want %r" % (got, want)


if __name__ == "__main__":
    ok = 0
    for ex in EXAMPLES:
        try:
            r, detail = check(ex)
        except Exception as e:  # noqa: BLE001
            r, detail = False, repr(e)
        print("PASS" if r else "FAIL", ex["name"], "" if r else detail)
        ok += bool(r)
    print("fraction public: %d/%d" % (ok, len(EXAMPLES)))
    sys.exit(0 if ok == len(EXAMPLES) else 1)
