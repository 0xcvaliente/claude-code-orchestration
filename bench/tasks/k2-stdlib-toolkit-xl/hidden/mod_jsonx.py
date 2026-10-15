"""Hidden differential cases for toolkit.jsonx (graded against `json`).

Adapter interface: NAME, MODULE, ORACLES, WRAP, cases(), run_impl(mod, case),
run_oracle(case), same(a, b).  `python3 mod_jsonx.py <package_root>` runs the
self-test against <package_root>/toolkit/jsonx.py.

The sandbox child does not load `json`, so it is imported only inside
run_oracle and the self-test.  cases() imports neither `json` nor the
solution; generated inputs come from a fixed seed.

Case encoding (JSON cannot hold every Python value):
  {"$f": "<repr>"}        float (covers nan, inf, -inf, -0.0)
  {"$t": [...]}           tuple
  {"$d": [[k, v], ...]}   dict in insertion order; keys are encoded too
  {"$cp": [int, ...]}     str given as code points (used for surrogates)
  {"$set": [int, ...]}    set;  {"$frozenset": [...]} frozenset
  {"$bytes": "ascii"}     bytes;  {"$complex": [re, im]} complex
  {"$circ": "list"|"dict"|"deep"}   a container that contains itself
  {"$same": X, "n": k}    a list holding the same decoded object k times
Every JSON object in an encoded value is one of these tags; JSON arrays are
lists, other JSON scalars are themselves.
"""

import random
import sys
import time

NAME = "jsonx"
MODULE = "toolkit.jsonx"
ORACLES = ["json", "_json"]
WRAP = ["json.dumps", "json.loads", "json.JSONDecodeError"]


# ------------------------------------------------------------ case decoding

def _s(v):
    if isinstance(v, dict):
        return "".join(chr(c) for c in v["$cp"])
    return v


def _obj(v):
    if isinstance(v, list):
        return [_obj(x) for x in v]
    if not isinstance(v, dict):
        return v
    if "$f" in v:
        return float(v["$f"])
    if "$t" in v:
        return tuple(_obj(x) for x in v["$t"])
    if "$d" in v:
        return {_obj(k): _obj(x) for k, x in v["$d"]}
    if "$cp" in v:
        return _s(v)
    if "$set" in v:
        return set(v["$set"])
    if "$frozenset" in v:
        return frozenset(v["$frozenset"])
    if "$bytes" in v:
        return v["$bytes"].encode("ascii")
    if "$complex" in v:
        return complex(*v["$complex"])
    if "$circ" in v:
        kind = v["$circ"]
        if kind == "list":
            x = [1, "a"]
            x.append(x)
            return x
        if kind == "dict":
            x = {"a": 1}
            x["self"] = x
            return x
        inner = {"k": []}
        outer = [0, {"x": inner}]
        inner["k"].append(outer)
        return outer
    if "$same" in v:
        x = _obj(v["$same"])
        return [x] * v["n"]
    raise ValueError("bad tag %r" % (v,))


# named callables used for default= and the loads hooks

def _d_sorted_list(o):
    if isinstance(o, (set, frozenset)):
        return sorted(o)
    raise TypeError("not a set")


def _d_typename(o):
    return type(o).__name__


def _d_identity(o):
    return o


def _d_none(o):
    return None


def _d_complex(o):
    if isinstance(o, complex):
        return {"re": o.real, "im": o.imag}
    raise TypeError("not complex")


DEFAULTS = {"sorted_list": _d_sorted_list, "typename": _d_typename,
            "identity": _d_identity, "none": _d_none, "complex": _d_complex}


def _reject(s):
    raise ValueError("constant rejected: " + s)


HOOKS = {
    "parse_float": {"str": str, "tag": lambda s: ["float", s]},
    "parse_int": {"str": str, "tag": lambda s: ["int", s], "float": float},
    "parse_constant": {"str": str, "tag": lambda s: ["const", s],
                       "reject": _reject},
    "object_hook": {"items": lambda d: ["obj", [[k, v] for k, v in d.items()]],
                    "len": len},
    "object_pairs_hook": {"pairs": lambda p: ["pairs", [[k, v] for k, v in p]],
                          "reversed": lambda p: dict(reversed(p))},
}


# ----------------------------------------------------------- normalization

def _has_surrogate(s):
    for ch in s:
        if "\ud800" <= ch <= "\udfff":
            return True
    return False


def _nstr(s):
    if _has_surrogate(s):
        return {"$cp": [ord(c) for c in s]}
    return s


def _norm(v):
    if v is None or isinstance(v, bool):
        return v
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return {"$f": repr(v)}
    if isinstance(v, str):
        return _nstr(v)
    if isinstance(v, list):
        return [_norm(x) for x in v]
    if isinstance(v, tuple):
        return {"$t": [_norm(x) for x in v]}
    if isinstance(v, dict):
        return {"$d": [[_norm(k), _norm(x)] for k, x in v.items()]}
    return {"$other": type(v).__name__}


def _run(mod, case):
    op = case["op"]
    errcls = getattr(mod, "JSONDecodeError", None)
    try:
        if op == "errclass":
            # the class is a ValueError subclass and loads raises it
            try:
                mod.loads(_s(case["s"]))
                caught = None
            except ValueError as e:
                caught = [type(e) is errcls, e.pos, e.lineno, e.colno]
            return [isinstance(errcls, type) and issubclass(errcls, ValueError),
                    caught]
        if op == "dumps":
            kw = dict(case.get("kw", {}))
            if "separators" in kw:
                kw["separators"] = tuple(kw["separators"])
            if "default" in case:
                kw["default"] = DEFAULTS[case["default"]]
            r = mod.dumps(_obj(case["obj"]), **kw)
            if not isinstance(r, str):
                return {"badtype": type(r).__name__}
            return {"ok": _nstr(r)}
        if op == "loads":
            kw = dict(case.get("kw", {}))
            for hk, name in case.get("hooks", {}).items():
                kw[hk] = HOOKS[hk][name]
            return {"ok": _norm(mod.loads(_s(case["s"]), **kw))}
    except Exception as e:  # noqa: BLE001
        if errcls is not None and isinstance(errcls, type) and isinstance(e, errcls):
            return {"error": "JSONDecodeError", "pos": getattr(e, "pos", None),
                    "lineno": getattr(e, "lineno", None),
                    "colno": getattr(e, "colno", None)}
        if isinstance(e, ValueError):
            return {"error": "ValueError"}
        if isinstance(e, TypeError):
            return {"error": "TypeError"}
        return {"error": type(e).__name__}
    raise ValueError(op)


def run_impl(mod, case):
    return _run(mod, case)


def run_oracle(case):
    import json
    return _run(json, case)


def same(a, b):
    return a == b


# --------------------------------------------------------------- hand cases

def F(x):
    return {"$f": repr(float(x))}


def T(*xs):
    return {"$t": list(xs)}


def D(*pairs):
    return {"$d": [list(p) for p in pairs]}


def CP(s):
    return {"$cp": [ord(c) for c in s]}


NAN, INF, NINF = {"$f": "nan"}, {"$f": "inf"}, {"$f": "-inf"}


def _hand():
    H = []

    def Dm(obj, default=None, **kw):
        c = {"op": "dumps", "obj": obj, "kw": kw}
        if default:
            c["default"] = default
        H.append(c)

    def L(s, hooks=None, **kw):
        c = {"op": "loads", "s": s, "kw": kw}
        if hooks:
            c["hooks"] = hooks
        H.append(c)

    H.append({"op": "errclass", "s": '{\n  "a" 1}'})
    # --- dumps: scalars
    Dm(None)
    Dm(False)
    Dm(-12345678901234567890123456789)
    Dm(F(1.0))
    Dm(F(-0.0))
    Dm(F(0.1))
    Dm(F(123456789.125))
    Dm(F(1e300 * 10))
    Dm(F(5e-324))
    Dm(NAN)
    Dm([NAN, INF, NINF])
    Dm(NAN, allow_nan=False)
    Dm([1, [2, INF]], allow_nan=False)
    Dm(D(["a", NINF]), allow_nan=False)
    # --- dumps: strings
    Dm('quote " backslash \\ end')
    Dm("\b\f\n\r\t\x00\x01\x1f\x7f")
    Dm("caf\u00e9 \u4e2d\u6587 \U0001f600 \u2028")
    Dm("caf\u00e9 \u4e2d\u6587 \U0001f600 \u2028", ensure_ascii=False)
    Dm("\b\f\n\r\t\x00\x1f\x7f\u0080", ensure_ascii=False)
    Dm(CP("a\ud800b\udc00c"))
    Dm(CP("a\ud800b\udc00c"), ensure_ascii=False)
    Dm(CP(chr(0xdbff) + chr(0xdfff) + chr(0xdfff)))
    # --- dumps: containers
    Dm([])
    Dm(D())
    Dm(T(1, T(2, 3), [4]))
    Dm(D(["b", 1], ["a", [1, 2]], ["c", D(["x", None])]))
    Dm(D([1, "int"], [F(2.5), "float"], [True, "t"], [False, "f"], [None, "n"]))
    Dm(D([NAN, 1], [INF, 2], [NINF, 3]))
    Dm(D([F(-0.0), 0], [F(1e20), 1]))
    Dm(D([T(1, 2), "tuple key"]))
    Dm(D(["a", 1], [T(1, 2), "skipped"], ["b", 2]), skipkeys=True)
    Dm(D(["x", 1], [{"$bytes": "k"}, 2]), skipkeys=True)
    Dm(D(["b", 1], ["a", 2], ["c", D(["z", 1], ["y", 2])]), sort_keys=True)
    Dm(D([3, "c"], [1, "a"], [F(2.5), "b"], [True, "t"]), sort_keys=True)
    Dm(D(["a", 1], [1, 2]), sort_keys=True)
    Dm(D(["a", 1], [T(1,), 2]), sort_keys=True, skipkeys=True)
    Dm(D(["\u00e9", 1], ["e", 2], ["E", 3], ["", 4]), sort_keys=True)
    # --- dumps: indent and separators
    Dm(D(["a", [1, 2, D()]], ["b", []], ["c", D(["d", None])]), indent=2)
    Dm([1, [2, [3]]], indent=0)
    Dm(D(["a", 1], ["b", [True]]), indent="\t")
    Dm([1, 2], indent=-3)
    Dm([1, D(["k", "v"])], indent=1, separators=[", ", " = "])
    Dm([1, D(["k", "v"])], separators=[",", ":"])
    Dm([1, D(["k", "v"])], separators=[" ;", "->"])
    Dm(D(["b", 1], ["a", D(["d", 1], ["c", 2])]), indent=2, sort_keys=True,
       separators=[",", ":"])
    # --- dumps: default, unserializable, circular
    Dm({"$set": [3, 1, 2]})
    Dm([1, {"$bytes": "ab"}])
    Dm({"$set": [3, 1, 2]}, default="sorted_list")
    Dm([{"$bytes": "x"}], default="sorted_list")
    Dm([{"$bytes": "x"}, {"$complex": [0, 1]}], default="typename")
    Dm(D(["z", {"$complex": [1.5, -2]}]), default="complex")
    Dm({"$set": [1]}, default="identity")
    Dm({"$circ": "list"})
    Dm({"$circ": "deep"})
    Dm({"$same": [1, 2], "n": 3})
    Dm({"$same": D(["a", 1]), "n": 2}, check_circular=False)
    # --- loads: values
    L("null")
    L(" \t\n\r true \n")
    L("-0")
    L("-0.0")
    L("123456789012345678901234567890")
    L("-2.5E+10")
    L("1e400")
    L("0.1000000000000000055511151231257827")
    L('"esc \\" \\\\ \\/ \\b \\f \\n \\r \\t"')
    L('"\\u00e9\\u4E2D\\uffff"')
    L('"\\ud83d\\ude00"')
    L('"\\ud800"')
    L('"\\ud800\\u0041"')
    L('"\\ud800x\\udc00"')
    L(CP('"raw \ud800 surrogate"'))
    L("[]")
    L(' [ 1 , [ 2 , [ ] ] , { } ] ')
    L('{"a": 1, "b": [true, null], "c": {"d": "e"}}')
    L('{"a": 1, "a": 2, "b": 3, "a": 4}')
    L("NaN")
    # --- loads: hooks
    L("[1, 2.5, -3e2, 0]", hooks={"parse_float": "str"})
    L("[1, 2.5, -3e2, 0, -0]", hooks={"parse_int": "tag"})
    L("[1.0, 7]", hooks={"parse_float": "tag", "parse_int": "str"})
    L("[NaN, Infinity, -Infinity]", hooks={"parse_constant": "tag"})
    L("[1, NaN]", hooks={"parse_constant": "reject"})
    L('{"a": {"b": 1}, "c": [{}]}', hooks={"object_hook": "items"})
    L('{"a": 1, "a": 2, "b": {"x": [1]}}', hooks={"object_pairs_hook": "pairs"})
    L('{"a": 1, "b": 2, "a": 3}', hooks={"object_pairs_hook": "reversed"})
    L('{"a": {"b": 1}}', hooks={"object_hook": "len", "object_pairs_hook": "pairs"})
    # --- loads: strict
    L('"tab\there\nnewline"', strict=False)
    L('["ok", "bad\x00"]')
    # --- loads: errors
    L("")
    L("\ufeff[1]")
    L("nul")
    L("[1,]")
    L('{"a": 1 ,\n }')
    L("[1 2]")
    L("{1: 2}")
    L('{"a" 1}')
    L('{"a":\n}')
    L('{"a": 1')
    L("[")
    L('{"a"')
    L("[,1]")
    L('"abc')
    L('"a\\x"')
    L('"a\\')
    L('"\\u12"')
    L('"\\u123')
    L('"\\u1234')
    L('"\\ud800\\u12"')
    L('"\\ud800\\uzz00"')
    L('"\\ud800\\x"')
    L("1.")
    L("1.e5")
    L("1E+")
    L("01")
    L("-")
    L("+1")
    L("-Inf")
    L("[1] [2]")
    L("1\x0c")
    L("\u00a01")
    L("[true false]")
    L('{"a": [1, {"b": [2,]}]}')
    return H


# ---------------------------------------------------------- generated cases

_STR_CHARS = ["a", "b", "Z", " ", '"', "\\", "/", "\n", "\t", "\x00", "\x1f",
              "\x7f", "\u00e9", "\u20ac", "\U0001f600", "\ud800", "\udc00"]
_KEYS = ["a", "b", "key", "", "\u00e9", 1, 0, -5, True, False, None,
         {"$f": "2.5"}, {"$f": "-0.0"}]
_FLOATS = ["0.1", "1e+16", "-2.5", "3.0", "1e-05", "123.456", "-0.0",
           "1.7976931348623157e+308", "inf", "nan"]


def _gstr(rng):
    s = "".join(rng.choice(_STR_CHARS) for _ in range(rng.randint(0, 6)))
    return CP(s) if _has_surrogate(s) else s


def _gval(rng, depth):
    x = rng.random()
    if depth <= 0 or x < 0.45:
        k = rng.randint(0, 6)
        if k == 0:
            return None
        if k == 1:
            return rng.choice([True, False])
        if k == 2:
            return rng.choice([0, 7, -42, 10 ** 20, -(2 ** 63)])
        if k == 3:
            return {"$f": rng.choice(_FLOATS)}
        return _gstr(rng)
    if x < 0.65:
        return [_gval(rng, depth - 1) for _ in range(rng.randint(0, 3))]
    if x < 0.72:
        return T(*[_gval(rng, depth - 1) for _ in range(rng.randint(0, 3))])
    pairs = []
    seen = []
    for _ in range(rng.randint(0, 3)):
        k = rng.choice(_KEYS)
        kd = _obj(k)
        if any(kd == x for x in seen):
            continue
        seen.append(kd)
        pairs.append([k, _gval(rng, depth - 1)])
    return D(*pairs)


def _gen_dumps(rng):
    kw = {}
    if rng.random() < 0.5:
        kw["ensure_ascii"] = False
    if rng.random() < 0.3:
        kw["allow_nan"] = False
    if rng.random() < 0.4:
        kw["indent"] = rng.choice([0, 1, 2, 4, "", "  ", "\t", "ab"])
    if rng.random() < 0.3:
        kw["separators"] = rng.choice([[",", ":"], [", ", ": "], [";", "="],
                                       [" , ", " : "]])
    if rng.random() < 0.15:
        kw["check_circular"] = False
    return {"op": "dumps", "obj": _gval(rng, 3), "kw": kw}


_TOK = ["{", "}", "[", "]", ",", ":", " ", "\n", '"a"', '"k"', "1", "-0",
        "2.5", "1e3", "true", "null", "NaN", "-", "0", '"\\u00e9"', '"x\\n"',
        '"', "\\", "\t"]


def _to_json_text(v, rng):
    """Serialize an encoded value as JSON text with random whitespace
    (hand-rolled so cases() needs no json import)."""
    ws = lambda: rng.choice(["", "", " ", "\n", " \t", "\r\n "])  # noqa: E731
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, str) or (isinstance(v, dict) and "$cp" in v):
        s = _s(v)
        out = ['"']
        for ch in s:
            n = ord(ch)
            if ch == '"' or ch == "\\":
                out.append("\\" + ch)
            elif n < 0x20 or 0xD800 <= n <= 0xDFFF or rng.random() < 0.2:
                if n >= 0x10000:
                    n -= 0x10000
                    out.append("\\u%04x\\u%04X" % (0xD800 | (n >> 10),
                                                   0xDC00 | (n & 0x3FF)))
                else:
                    out.append("\\u%04x" % n if rng.random() < 0.5 else "\\u%04X" % n)
            else:
                out.append(ch)
        out.append('"')
        return "".join(out)
    if isinstance(v, dict) and "$f" in v:
        return {"nan": "NaN", "inf": "Infinity", "-inf": "-Infinity"}.get(
            v["$f"], v["$f"])
    if isinstance(v, list) or (isinstance(v, dict) and "$t" in v):
        items = v if isinstance(v, list) else v["$t"]
        return "[" + ws() + ("," + ws()).join(
            _to_json_text(x, rng) + ws() for x in items) + "]"
    pairs = v["$d"]
    parts = []
    for k, x in pairs:
        if not isinstance(k, str):
            k = rng.choice(["k", "\u00e9", "a b"])
        parts.append(_to_json_text(k, rng) + ws() + ":" + ws()
                     + _to_json_text(x, rng) + ws())
    return "{" + ws() + ("," + ws()).join(parts) + "}"


def _gen_loads(rng, broken):
    text = _to_json_text(_gval(rng, 3), rng)
    if broken and text:
        k = rng.randint(0, 3)
        i = rng.randint(0, len(text))
        if k == 0:
            text = text[:i]
        elif k == 1:
            text = text[:i] + rng.choice(_TOK) + text[i:]
        elif k == 2 and len(text) > 1:
            text = text[:i] + text[i + 1:]
        else:
            text = text[:i] + rng.choice(_TOK) + rng.choice(_TOK) + text[i:]
    c = {"op": "loads", "s": CP(text) if _has_surrogate(text) else text, "kw": {}}
    r = rng.random()
    if r < 0.1:
        c["kw"]["strict"] = False
    elif r < 0.25:
        c["hooks"] = {rng.choice(["parse_float", "parse_int"]): "tag"}
    elif r < 0.35:
        c["hooks"] = {"object_pairs_hook": "pairs"}
    return c


def _generated():
    rng = random.Random(20261015)
    out = []
    for i in range(18):
        out.append(_gen_dumps(rng))
    for i in range(8):
        out.append(_gen_loads(rng, False))
    for i in range(12):
        out.append(_gen_loads(rng, True))
    return out


def cases():
    all_cases = _hand() + _generated()
    for i, c in enumerate(all_cases):
        c["id"] = "%s-%03d-%s" % (NAME, i, c["op"])
    return all_cases


# ---------------------------------------------------------------- self-test

def _main(argv):
    import json
    if len(argv) != 2:
        print("usage: mod_jsonx.py <package_root>")
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
