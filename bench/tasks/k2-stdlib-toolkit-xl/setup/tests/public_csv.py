"""Public examples for toolkit.csvx, checked against the standard library.

The hidden tests use the same kind of comparison on many more inputs.
Run all public tests with run_public.py, or this file directly:
    python3 tests/public_csv.py
"""

import io
import os
import sys

EXAMPLES = [
    {"op": "read", "lines": ['name,age\r\n', '"Doe, J",42\r\n', '"say ""hi""",\r\n']},
    {"op": "read", "lines": ['"two\n', 'lines",x\n', 'tail'], "params": {}},
    {"op": "read", "lines": ['1, 2,"3"\n'], "params": {"quoting": 2, "skipinitialspace": True}},
    {"op": "read", "lines": ['a|b\\|c|"d"\n'], "params": {"delimiter": "|", "escapechar": "\\"}},
    {"op": "read", "lines": ['"x"y,z\n'], "params": {"strict": True}},
    {"op": "write", "rows": [["a", "b c", "d,e", 'f"g'], [None, 1, 2.0, ""]]},
    {"op": "write", "rows": [["a", 3, None]], "params": {"quoting": 2, "lineterminator": "\n"}},
    {"op": "write", "rows": [["a;b", "c"]], "params": {"delimiter": ";", "quoting": 3, "escapechar": "^"}},
    {"op": "write", "rows": [["x"]], "params": {"quotechar": "x", "delimiter": "x"}},
]


def _val(v):
    return {"float": repr(v)} if isinstance(v, float) else v


def _run(mod, ex):
    err = getattr(mod, "Error", ())
    params = ex.get("params", {})
    out = {}
    try:
        if ex["op"] == "read":
            rd = mod.reader(ex["lines"], **params)
            out["rows"] = []
            for row in rd:
                out["rows"].append([_val(v) for v in row])
            out["line_num"] = rd.line_num
        else:
            f = io.StringIO()
            w = mod.writer(f, **params)
            out["returns"] = [w.writerow(r) for r in ex["rows"]]
            out["text"] = f.getvalue()
    except Exception as e:  # noqa: BLE001
        out["error"] = "Error" if err and isinstance(e, err) else type(e).__name__
    return out


def check(ex, mod=None):
    if mod is None:
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        import toolkit.csvx as mod
    import csv
    return _run(mod, ex) == _run(csv, ex)


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
    print("csv public: %d/%d" % (ok, len(EXAMPLES)))
    sys.exit(0 if ok == len(EXAMPLES) else 1)
