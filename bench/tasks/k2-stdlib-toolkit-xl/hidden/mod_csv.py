"""Hidden differential cases for toolkit.csvx (graded against `csv`).

Adapter interface: NAME, MODULE, cases(), run_impl(mod, case),
run_oracle(case), same(a, b).  `python3 mod_csv.py <package_root>` runs the
self-test against <package_root>/toolkit/csvx.py.

cases() imports neither `csv` nor the solution; inputs are generated from a
fixed seed.
"""

import io
import random
import sys
import time

NAME = "csv"
MODULE = "toolkit.csvx"
ORACLES = ["csv", "_csv"]
WRAP = ["csv.reader", "csv.writer", "csv.DictReader", "csv.DictWriter", "csv.Sniffer",
        "_csv.reader", "_csv.writer"]

_MIN, _ALL, _NONNUM, _NONE, _STRINGS, _NOTNULL = 0, 1, 2, 3, 4, 5


# ----------------------------------------------------------- normalization

def _kind(e, errcls):
    if errcls is not None and isinstance(e, errcls):
        return "Error"
    return type(e).__name__


def _val(v):
    if isinstance(v, float):
        return {"float": repr(v)}
    return v


def _read(mod, case, errcls):
    out = {"rows": [], "line_nums": []}
    try:
        args = [case["lines"]]
        if "dialect" in case:
            args.append(case["dialect"])
        rd = mod.reader(args[0], *args[1:], **case.get("params", {}))
        for row in rd:
            out["rows"].append([_val(v) for v in row])
            out["line_nums"].append(rd.line_num)
        out["line_num_end"] = rd.line_num
    except Exception as e:  # noqa: BLE001
        out["error"] = _kind(e, errcls)
    return out


def _write(mod, case, errcls):
    f = io.StringIO()
    out = {"returns": []}
    try:
        args = [f]
        if "dialect" in case:
            args.append(case["dialect"])
        w = mod.writer(*args, **case.get("params", {}))
        if case.get("method") == "writerows":
            out["returns"].append(w.writerows(case["rows"]))
        else:
            for row in case["rows"]:
                out["returns"].append(w.writerow(row))
    except Exception as e:  # noqa: BLE001
        out["error"] = _kind(e, errcls)
    out["text"] = f.getvalue()
    return out


def _roundtrip(mod, case, errcls):
    w = _write(mod, case, errcls)
    if "error" in w:
        return {"write": w}
    lines = w["text"].splitlines(keepends=True)
    r = _read(mod, {"lines": lines, "params": case.get("params", {}),
                    **({"dialect": case["dialect"]} if "dialect" in case else {})},
              errcls)
    return {"write": w, "read": r}


def _run(mod, case):
    errcls = getattr(mod, "Error", None)
    op = case["op"]
    try:
        if op == "read":
            return _read(mod, case, errcls)
        if op == "write":
            return _write(mod, case, errcls)
        if op == "roundtrip":
            return _roundtrip(mod, case, errcls)
        if op == "constants":
            return [getattr(mod, n) for n in ("QUOTE_MINIMAL", "QUOTE_ALL",
                                               "QUOTE_NONNUMERIC", "QUOTE_NONE",
                                               "QUOTE_STRINGS", "QUOTE_NOTNULL")]
    except Exception as e:  # noqa: BLE001
        return {"error": _kind(e, errcls)}
    raise ValueError(op)


def run_impl(mod, case):
    return _run(mod, case)


def run_oracle(case):
    import csv
    return _run(csv, case)


def same(a, b):
    return a == b


# --------------------------------------------------------------- hand cases

def _hand():
    H = []

    def R(lines, dialect=None, **params):
        c = {"op": "read", "lines": lines, "params": params}
        if dialect:
            c["dialect"] = dialect
        H.append(c)

    def W(rows, dialect=None, method="writerow", **params):
        c = {"op": "write", "rows": rows, "params": params, "method": method}
        if dialect:
            c["dialect"] = dialect
        H.append(c)

    H.append({"op": "constants"})
    R(['a,"b,c",d\r\n', '"x ""y""",,z\r\n', '\r\n', 'last'])
    R(['"multi\r\n', 'line",2\r\n', '"open quote'])
    R(['"open quote\n', 'never closed'], strict=True)
    R(['"a"b,c\n'], strict=True)
    R(['"a"b,c\n', 'q,"r"  ,s\n'])
    R(['a\rb\n'])
    R(['a, b,  "c d", e\n'], skipinitialspace=True)
    R(['1,"2",3.5,-4e2,\n', ' 7 ,"x"\n'], quoting=_NONNUM)
    R(['1,abc\n'], quoting=_NONNUM)
    R(['1,,"",x\n'], quoting=_NOTNULL)
    R(['1,,"",x\n'], quoting=_STRINGS)
    R(['a\\,b,c\\\n', 'd,"e\\"f"\n'], escapechar="\\")
    R(['a\\,b,"c""d"\n'], escapechar="\\", quoting=_NONE)
    R(['a\\\n', 'b c\n', 'd,e\\\r\n', 'f'], escapechar="\\")
    R(['a\tb\t"c\td"\n'], "excel-tab")
    R(['x;y;"z;w"\n'], delimiter=";", quotechar="'")
    R(["'a''b';c\n"], delimiter=";", quotechar="'")
    R(['a,"b"""c\n'], doublequote=False)
    R(['a,"b\\"c",d\n'], doublequote=False, escapechar="\\")
    R(['a,b\n', 5])
    R(['a,b\n'], "nope")
    R(['a b  "c d"\n'], delimiter=" ", skipinitialspace=True)
    R(['a,b\n'], quotechar="ab")
    R(['a,b\n'], delimiter="\n")
    R(['a,b\n'], quoting=17)
    R(['a,b\n'], escapechar=",")
    W([["a", "b,c", 'd"e', "f\ng", ""], [], [None], [""], [1, 2.5, True, None]])
    W([["a", None, 3, 0.1, -2.0, "x"]], quoting=_NONNUM)
    W([["a", None, 3, "", "x"]], quoting=_STRINGS)
    W([["a", None, 3, "", "x"]], quoting=_NOTNULL)
    W([["a", "b"], ["c"]], quoting=_ALL, lineterminator="\n")
    W([["a,b", 'c"d', "e\\f"]], quoting=_NONE, escapechar="\\")
    W([["a,b"]], quoting=_NONE)
    W([['x"y', "e\\f"]], escapechar="\\", doublequote=False)
    W([['x"y']], doublequote=False)
    W([[""]], quoting=_NONE)
    W([["", "x", None]], delimiter=" ", skipinitialspace=True)
    W([["", "x"]], delimiter=" ", skipinitialspace=True, quoting=_NONE, escapechar="\\")
    W([[None]], quoting=_NOTNULL)
    W([["a", "b"], 7, ["c"]])
    W([["a", "b"], ["c"]], method="writerows")
    W([["a!b", "c"]], lineterminator="!")
    W([["a b", "c"]], "excel-tab")
    W([["a", "b"]], "unix")
    W(["abc", ["d"]])
    W([["a"]], quotechar=None)
    W([["a,b"]], quotechar=None)
    W([["a"]], quotechar=None, quoting=_ALL)
    W([["a"]], delimiter=",", quotechar=",")
    W([["a"]], lineterminator=None)
    W([["a"]], bogus=1)
    W([["a"]], delimiter=1)
    W([["a"]], escapechar=" ", skipinitialspace=True)
    return H


# ---------------------------------------------------------- generated cases

_TOKENS = ["a", "b", "ab", " ", "  ", ",", ";", "\t", '"', '""', "'", "\\", "|",
           "\r\n", "\n", "\r", "1", "2.5", "-3"]
_FIELD_CHARS = "aab  ,;\t\"\"'\\|\n\r"


def _params(rng):
    p = {}
    delim = rng.choice([",", ",", ";", "\t", "|", " "])
    if delim != ",":
        p["delimiter"] = delim
    quote = rng.choice([q for q in ['"', '"', "'", "|"] if q != delim])
    if quote != '"':
        p["quotechar"] = quote
    if rng.random() < 0.35:
        p["escapechar"] = rng.choice(["\\", "/"])
    if rng.random() < 0.25:
        p["doublequote"] = False
    if rng.random() < 0.3:
        p["skipinitialspace"] = True
    if rng.random() < 0.3:
        p["lineterminator"] = rng.choice(["\n", "\r", "\r\n", "~"])
    if rng.random() < 0.55:
        p["quoting"] = rng.choice([_MIN, _ALL, _NONNUM, _NONE, _STRINGS, _NOTNULL])
    if rng.random() < 0.3:
        p["strict"] = True
    return p


def _split_lines(text):
    """Split like iterating a file opened with newline=''."""
    lines = []
    cur = ""
    i = 0
    while i < len(text):
        ch = text[i]
        cur += ch
        if ch == "\n" or (ch == "\r" and (i + 1 >= len(text) or text[i + 1] != "\n")):
            lines.append(cur)
            cur = ""
        i += 1
    if cur:
        lines.append(cur)
    return lines


def _gen_read(rng):
    params = _params(rng)
    if params.get("quoting") in (_NONNUM, _STRINGS) and rng.random() < 0.7:
        toks = ["1", "2.5", "-3", "4e1", ",", ",", '"', '"x"', " ", "\n", "\r\n", "1.0"]
    else:
        toks = _TOKENS
    text = "".join(rng.choice(toks) for _ in range(rng.randint(3, 22)))
    lines = _split_lines(text)
    if rng.random() < 0.2:
        # feed arbitrary chunks instead of whole lines
        lines = [text[i:i + 4] for i in range(0, len(text), 4)]
    return {"op": "read", "lines": lines, "params": params}


def _field(rng):
    x = rng.random()
    if x < 0.12:
        return None
    if x < 0.2:
        return rng.choice([0, 7, -12, 1.5, -0.25, 1e20, 3.0, True])
    return "".join(rng.choice(_FIELD_CHARS) for _ in range(rng.randint(0, 5)))


def _gen_write(rng, op):
    params = _params(rng)
    rows = [[_field(rng) for _ in range(rng.randint(1, 4))]
            for _ in range(rng.randint(1, 3))]
    c = {"op": op, "rows": rows, "params": params}
    if op == "write" and rng.random() < 0.3:
        c["method"] = "writerows"
    return c


def _generated():
    rng = random.Random(15102026)
    out = []
    for i in range(52):
        kind = i % 4
        if kind in (0, 1):
            out.append(_gen_read(rng))
        elif kind == 2:
            out.append(_gen_write(rng, "write"))
        else:
            out.append(_gen_write(rng, "roundtrip"))
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
        print("usage: mod_csv.py <package_root>")
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
