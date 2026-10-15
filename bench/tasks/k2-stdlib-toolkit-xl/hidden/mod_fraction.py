"""Hidden differential cases for toolkit.fraction (graded against `fractions`).

Adapter interface: NAME, MODULE, ORACLES, WRAP, cases(), run_impl(mod, case),
run_oracle(case), same(a, b).  `python3 mod_fraction.py <package_root>` runs
the self-test against <package_root>/toolkit/fraction.py.

cases() imports neither `fractions` nor the solution.  Operands are encoded as
JSON lists:
  ["F", n, d]   Fraction(n, d) built from two ints
  ["i", n]      int
  ["f", "x"]    float("x")
  ["D", "x"]    decimal.Decimal("x")
  ["s", "x"]    the str "x"
  ["n"]         None
"""

import json
import math
import random
import sys
import time

NAME = "fraction"
MODULE = "toolkit.fraction"
ORACLES = ["fractions"]
WRAP = ["fractions.Fraction"]


# ----------------------------------------------------------- normalization

def _operand(F, spec):
    kind = spec[0]
    if kind == "F":
        return F(spec[1], spec[2])
    if kind == "i":
        return int(spec[1])
    if kind == "f":
        return float(spec[1])
    if kind == "D":
        import decimal
        return decimal.Decimal(spec[1])
    if kind == "s":
        return spec[1]
    if kind == "n":
        return None
    raise ValueError(kind)


def _norm(F, x):
    if type(x) is F:
        return {"F": [_norm(F, x.numerator), _norm(F, x.denominator)]}
    if isinstance(x, F):
        return {"subclass": [x.numerator, x.denominator]}
    if isinstance(x, bool):
        return {"bool": x}
    if isinstance(x, int):
        return {"int": int(x)} if type(x) is int else {"intsub": int(x)}
    if isinstance(x, float):
        return {"float": repr(x)}
    if isinstance(x, str):
        return {"str": x}
    if isinstance(x, tuple):
        return {"tuple": [_norm(F, v) for v in x]}
    if isinstance(x, complex):
        return {"complex": repr(x)}
    if x is None:
        return None
    return {"type": type(x).__name__}


def _err(e):
    return {"error": type(e).__name__}


_BIN = {
    "+": lambda a, b: a + b,
    "-": lambda a, b: a - b,
    "*": lambda a, b: a * b,
    "/": lambda a, b: a / b,
    "//": lambda a, b: a // b,
    "%": lambda a, b: a % b,
    "divmod": lambda a, b: divmod(a, b),
    "**": lambda a, b: a ** b,
    "<": lambda a, b: a < b,
    "<=": lambda a, b: a <= b,
    ">": lambda a, b: a > b,
    ">=": lambda a, b: a >= b,
    "==": lambda a, b: a == b,
    "!=": lambda a, b: a != b,
}

_UN = {
    "abs": abs,
    "neg": lambda x: -x,
    "pos": lambda x: +x,
    "trunc": math.trunc,
    "floor": math.floor,
    "ceil": math.ceil,
    "round": round,
    "int": int,
    "float": float,
    "bool": bool,
    "hash": hash,
    "str": str,
    "repr": repr,
    "is_integer": lambda x: x.is_integer(),
    "as_integer_ratio": lambda x: x.as_integer_ratio(),
    "numerator": lambda x: x.numerator,
    "denominator": lambda x: x.denominator,
}


def _dispatch(F, case):
    op = case["op"]
    if op == "new":
        args = [_operand(F, a) for a in case["args"]]
        return F(*args)
    if op == "bin":
        a = _operand(F, case["a"])
        b = _operand(F, case["b"])
        return _BIN[case["fn"]](a, b)
    if op == "un":
        return _UN[case["fn"]](_operand(F, case["a"]))
    if op == "round":
        return round(_operand(F, case["a"]), case["ndigits"])
    if op == "format":
        return format(_operand(F, case["a"]), case["spec"])
    if op == "limit":
        x = _operand(F, case["a"])
        if "max" in case:
            return x.limit_denominator(case["max"])
        return x.limit_denominator()
    if op == "from_float":
        return F.from_float(_operand(F, case["v"]))
    if op == "from_decimal":
        return F.from_decimal(_operand(F, case["v"]))
    if op == "parse":
        x = F(case["s"])
        return [x.numerator, x.denominator]
    raise ValueError(op)


def _run(F, case):
    if case["op"] == "multi":
        return [_run(F, item) for item in case["items"]]
    try:
        return _norm(F, _dispatch(F, case))
    except Exception as e:  # noqa: BLE001
        return _err(e)


def run_impl(mod, case):
    return _run(mod.Fraction, case)


def run_oracle(case):
    import fractions
    return _run(fractions.Fraction, case)


def _float_close(a, b):
    x, y = float(a), float(b)
    if x == y:
        return True
    if math.isnan(x) and math.isnan(y):
        return True
    if math.isinf(x) or math.isinf(y) or math.isnan(x) or math.isnan(y):
        return False
    return abs(x - y) <= 1e-12 * max(abs(x), abs(y))


def same(a, b):
    if isinstance(a, dict) and isinstance(b, dict):
        if set(a) == {"float"} and set(b) == {"float"}:
            return _float_close(a["float"], b["float"])
        if set(a) != set(b):
            return False
        return all(same(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    return a == b and type(a) is type(b)


# --------------------------------------------------------------- hand cases

def Fr(n, d=1):
    return ["F", n, d]


def I(n):
    return ["i", n]


def Fl(x):
    return ["f", x]


def _chunks(seq, n):
    return [seq[i:i + n] for i in range(0, len(seq), n)]


_UN_ALL = ["numerator", "denominator", "abs", "neg", "pos", "trunc", "floor",
           "ceil", "round", "int", "float", "bool", "hash", "str", "repr",
           "is_integer", "as_integer_ratio"]


def _hand():
    H = []

    def multi(items):
        H.append({"op": "multi", "items": items})

    def new(*args):
        return {"op": "new", "args": list(args)}

    def b(fn, x, y):
        return {"op": "bin", "fn": fn, "a": x, "b": y}

    def u(fn, x):
        return {"op": "un", "fn": fn, "a": x}

    # construction
    for item in [new(), new(I(7)), new(I(-12)), new(I(6), I(-4)), new(I(0), I(-5)),
                 new(I(-3), I(-9)), new(I(7), I(0)), new(I(10 ** 20), I(6)),
                 new(Fl("0.1")), new(Fl("-2.5")), new(Fl("-0.0")), new(Fl("1e300")),
                 new(Fl("nan")), new(Fl("inf")), new(["D", "1.47"]),
                 new(["D", "-0.001"]), new(["D", "1E+3"]), new(["D", "NaN"]),
                 new(["D", "-Infinity"]), new(Fr(3, 4)), new(Fr(1, 7), I(5)),
                 new(Fr(1, 7), Fr(2, 3)), new(I(5), Fr(2, 3)), new(Fr(1, 2), Fr(0, 1))]:
        H.append(item)
    multi([new(["n"]), new(Fl("1.5"), I(2)), new(["s", "1/2"], I(3))])
    multi([new(I(1), Fl("2.0")), new(["D", "1"], I(2))])
    # string forms
    strings = ["3/4", " -12/8 ", "+5", "1.25", "-.5", "5.", "1e3", "2.5E-3",
               "-1_000.000_1", "1_0/2_0", "  7 / 3\n", "1.e2", ".5e1", "5e+2",
               "\t-0.0", "1e-2_0", "007", "0/5", "-0", "123456789012345678901234567890/10",
               "1/0", "1.5/2", "abc", "", "  ", "1__0", "_1", "1_", "1e", ".e1",
               ".", "+-1", "1/-2", "0x10", "1 2", "inf", "nan", "1/2/3", "1._5",
               "1e1.5", "- 1", "1/ 2_", "3/4 x", "e5"]
    for grp in _chunks(strings, 2):
        multi([{"op": "parse", "s": s} for s in grp])
    # numerator / denominator / conversions / predicates, one case per value
    for x in [Fr(-7, 2), Fr(5, 2), Fr(7, 2), Fr(12, 4), Fr(0), Fr(1, 3), Fr(-5, 2)]:
        multi([u(fn, x) for fn in _UN_ALL])
    for x in [Fr(1, 2), Fr(3), Fr(-1), Fr(1, 2 ** 61 - 1), Fr(10 ** 30, 7)]:
        H.append(u("hash", x))
    # rounding with ndigits
    rounds = [(Fr(12345, 1000), 2), (Fr(-12345, 1000), 1), (Fr(25, 1000), 2),
              (Fr(35, 1000), 2), (Fr(1234567, 1), -2), (Fr(250, 1), -2),
              (Fr(-350, 1), -2), (Fr(7, 3), 0)]
    for grp in _chunks(rounds, 2):
        multi([{"op": "round", "a": x, "ndigits": nd} for x, nd in grp])
    # arithmetic: one case per operand pair, all operators
    arith = ["+", "-", "*", "/", "//", "%", "divmod"]
    for x, y in [(Fr(7, 3), Fr(-5, 4)), (Fr(7, 3), I(2)), (I(-3), Fr(5, 7)),
                 (Fr(1, 3), Fl("0.25")), (Fl("2.5"), Fr(-3, 8)), (Fr(-9, 4), Fr(3, 2))]:
        multi([b(fn, x, y) for fn in arith])
    for y in [Fr(0), I(0)]:
        multi([b(fn, Fr(1, 2), y) for fn in ["/", "//", "%", "divmod"]])
    H.append(b("/", Fr(1, 2), Fl("0.0")))
    multi([b("+", Fr(1, 2), ["s", "1"]), b("*", Fr(1, 2), ["n"])])
    multi([b("+", Fr(1, 2), ["D", "0.5"]), b("-", ["D", "0.5"], Fr(1, 2))])
    # powers
    pows = [b("**", Fr(2, 3), I(3)), b("**", Fr(2, 3), I(0)), b("**", Fr(2, 3), I(-2)),
            b("**", Fr(-2, 3), I(-3)), b("**", Fr(0), I(-1)), b("**", Fr(0), I(0)),
            b("**", Fr(-3, 5), Fr(2)), b("**", Fr(4, 9), Fr(-2)), b("**", Fr(4, 9), Fr(1, 2)),
            b("**", Fr(9, 4), Fl("0.5")), b("**", I(2), Fr(3)), b("**", I(2), Fr(-2)),
            b("**", I(4), Fr(1, 2)), b("**", I(-2), Fr(-3)), b("**", Fl("2.0"), Fr(2)),
            b("**", Fl("2.0"), Fr(-2)), b("**", Fl("2.0"), Fr(1, 2)),
            b("**", Fr(1, 2), ["s", "2"])]
    for grp in _chunks(pows, 3):
        multi(grp)
    # comparisons
    cmps = ["<", "<=", ">", ">=", "==", "!="]
    for x, y in [(Fr(1, 3), Fr(2, 6)), (Fr(1, 3), Fl("0.3333333333333333")),
                 (Fr(-7, 2), I(-3)), (I(2), Fr(5, 2))]:
        multi([b(fn, x, y) for fn in cmps])
    misc = [b("==", Fr(1, 2), Fl("0.5")), b("==", Fr(3), I(3)), b("==", I(3), Fr(3)),
            b("<", Fl("0.1"), Fr(1, 10)), b("<", Fr(10 ** 9), Fl("inf")),
            b(">", Fr(10 ** 9), Fl("-inf")), b("<", Fr(1), Fl("nan")),
            b("==", Fr(1), Fl("nan")), b("!=", Fr(1), Fl("nan")),
            b("==", Fr(1, 2), ["s", "1/2"]), b("<", Fr(1, 2), ["s", "1/2"]),
            b(">=", Fr(1, 2), ["n"])]
    for grp in _chunks(misc, 3):
        multi(grp)
    # format
    specs = ["", "10", "<12", "^+15", "=+10", "#", "_", ",", "*>20,", "x^9",
             "f", ".3f", "e", ".2e", "E", "g", ".10g", "G", "%", ".1%", "+.2f",
             " .3f", "z.1f", "#.0f", "#g", "010.2f", "0=10.2f", "=010.2f",
             ",.2f", "_.3e", "x^12.4g", "-10.5F", "05", ".2", "d", "s", "z",
             "010", ".05f", ">>8"]
    fmts = [{"op": "format", "a": Fr(-1234567, 1000), "spec": s} for s in specs]
    fmts += [{"op": "format", "a": x, "spec": s} for x, s in [
        (Fr(1, 3), ".20f"), (Fr(-1, 1000), "z.1f"), (Fr(-1, 1000), ".1f"),
        (Fr(5, 2), ".0f"), (Fr(7, 2), ".0f"), (Fr(0), "e"), (Fr(0), "g"),
        (Fr(123456, 1), ".3g"), (Fr(1, 100000), "g"), (Fr(1, 10000), "g"),
        (Fr(10 ** 16), "g"), (Fr(2, 3), "#.3g"), (Fr(1000000), ",d"),
        (Fr(1000000), "_"), (Fr(7, 3), "#10"), (Fr(5), "#"),
        (Fr(-5, 3), "^12"), (Fr(-5, 3), "=12"), (Fr(12345, 7), "015,.2f"),
        (Fr(1, 8), "%"), (Fr(-1, 2), "+")]]
    for grp in _chunks(fmts, 4):
        multi(grp)
    # limit_denominator
    pi = Fr(3141592653589793, 10 ** 15)
    lims = [{"op": "limit", "a": pi, "max": mx} for mx in [1, 10, 100, 1000, 113]]
    lims += [{"op": "limit", "a": pi}, {"op": "limit", "a": Fr(-7, 3), "max": 2},
             {"op": "limit", "a": Fr(1, 3), "max": 0}, {"op": "limit", "a": Fr(3, 4), "max": 10},
             {"op": "limit", "a": Fr(5, 14), "max": 3}]
    for grp in _chunks(lims, 2):
        multi(grp)
    # from_float / from_decimal
    for grp in _chunks([Fl("0.1"), Fl("-3.75"), I(5), ["s", "1.5"], Fl("nan"),
                        Fl("inf"), Fr(1, 2)], 2):
        multi([{"op": "from_float", "v": v} for v in grp])
    for grp in _chunks([["D", "1.5"], ["D", "-12.340"], I(-4), Fl("1.5"), ["D", "NaN"],
                        ["D", "Infinity"], ["D", "1E-5"]], 2):
        multi([{"op": "from_decimal", "v": v} for v in grp])
    return H


# ---------------------------------------------------------- generated cases

def _rand_operand(rng, allow_float=True):
    x = rng.random()
    if x < 0.55:
        d = rng.choice([1, 2, 3, 4, 6, 7, 10, 12, 25, 64, 99, 1000])
        return Fr(rng.randint(-60, 60), d)
    if x < 0.8 or not allow_float:
        return I(rng.randint(-9, 9))
    return Fl(repr(rng.choice([0.5, -1.25, 3.0, 0.1, 2.75, -0.2, 7.5])))


def _generated():
    rng = random.Random(16102026)
    out = []
    ops = ["+", "-", "*", "/", "//", "%", "divmod", "<", "<=", ">", ">=", "==", "!="]
    for _ in range(16):
        fn = rng.choice(ops)
        a = _rand_operand(rng)
        bb = _rand_operand(rng)
        if a[0] != "F" and bb[0] != "F":
            a = Fr(rng.randint(-30, 30), rng.randint(1, 20))
        out.append({"op": "bin", "fn": fn, "a": a, "b": bb})
    for _ in range(4):
        a = Fr(rng.randint(-12, 12), rng.randint(1, 9))
        out.append({"op": "bin", "fn": "**", "a": a, "b": I(rng.randint(-4, 5))})
    for _ in range(5):
        digits = "".join(rng.choice("0123456789") for _ in range(rng.randint(1, 5)))
        s = rng.choice(["", "-", "+", " "]) + digits
        r = rng.random()
        if r < 0.3:
            s += "/" + str(rng.randint(1, 999))
        elif r < 0.7:
            s += "." + "".join(rng.choice("0123456789") for _ in range(rng.randint(0, 4)))
            if rng.random() < 0.5:
                s += rng.choice("eE") + rng.choice(["", "-", "+"]) + str(rng.randint(0, 12))
        out.append({"op": "parse", "s": s})
    specs = ["", ".2f", ".3e", "g", ".4g", "%", ">12.3f", "<10", "+,.1f", "_.2e"]
    for _ in range(5):
        a = Fr(rng.randint(-10 ** 7, 10 ** 7), rng.choice([1, 3, 7, 100, 1024]))
        out.append({"op": "format", "a": a, "spec": rng.choice(specs)})
    for _ in range(3):
        a = Fr(rng.randint(-10 ** 9, 10 ** 9), rng.randint(1, 10 ** 9))
        out.append({"op": "limit", "a": a, "max": rng.randint(1, 500)})
    for _ in range(3):
        a = Fr(rng.randint(-10 ** 5, 10 ** 5), rng.randint(1, 1000))
        out.append({"op": "round", "a": a, "ndigits": rng.randint(-2, 3)})
    for _ in range(3):
        a = Fr(rng.randint(-10 ** 6, 10 ** 6), rng.randint(1, 10 ** 6))
        out.append({"op": "un", "fn": rng.choice(["hash", "float", "floor", "ceil",
                                                  "round", "trunc"]), "a": a})
    return out


def cases():
    all_cases = _hand() + _generated()
    for i, c in enumerate(all_cases):
        first = c["items"][0] if c["op"] == "multi" else c
        tag = first["op"] + ("-" + first["fn"] if "fn" in first else "")
        c["id"] = "%s-%03d-%s" % (NAME, i, tag)
    return all_cases


# ---------------------------------------------------------------- self-test

def _main(argv):
    if len(argv) != 2:
        print("usage: mod_fraction.py <package_root>")
        return 2
    sys.path.insert(0, argv[1])
    try:
        mod = __import__(MODULE, fromlist=["_"])
    except Exception as e:  # noqa: BLE001
        print("%s: import failed: %r" % (NAME, e))
        print("%s: 0/%d" % (NAME, len(cases())))
        return 1
    cs = cases()
    passed = 0
    bad = []
    slowest = (0.0, None)
    for c in cs:
        t0 = time.perf_counter()
        got = json.loads(json.dumps(run_impl(mod, c)))
        dt = time.perf_counter() - t0
        if dt > slowest[0]:
            slowest = (dt, c["id"])
        exp = json.loads(json.dumps(run_oracle(c)))
        if same(got, exp):
            passed += 1
        else:
            bad.append((c, got, exp))
    print("%s: %d/%d" % (NAME, passed, len(cs)))
    print("slowest case: %s %.3fs" % (slowest[1], slowest[0]))
    for c, got, exp in bad[:10]:
        print("MISMATCH %s %s" % (c["id"], json.dumps(c)))
        print("   got: %s" % json.dumps(got)[:400])
        print("  want: %s" % json.dumps(exp)[:400])
    return 0 if passed == len(cs) else 1


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
