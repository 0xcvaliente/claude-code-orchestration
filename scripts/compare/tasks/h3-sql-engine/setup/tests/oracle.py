"""Differential test helper: runs a case on SQLite and on minisql and compares the results.

A case is a dict: {"tables": {name: (create_sql, rows)}, "setup": [sql, ...], "sql": str,
"error": bool}. Rows are inserted in multi-row INSERTs. The case is run on SQLite twice, with the
rows of every table inserted in forward and in reverse order: if both runs return the same list,
row order is part of the expected result; otherwise rows are compared as a multiset.
"""
import math
import sqlite3


def sql_literal(v):
    if v is None:
        return "NULL"
    if isinstance(v, str):
        return "'" + v.replace("'", "''") + "'"
    return repr(v)


def setup_statements(case, reverse=False):
    stmts = []
    for name, (create, rows) in case.get("tables", {}).items():
        stmts.append(create)
        rows = list(reversed(rows)) if reverse else list(rows)
        for i in range(0, len(rows), 1000):
            chunk = rows[i:i + 1000]
            values = ", ".join("(" + ", ".join(sql_literal(v) for v in r) + ")" for r in chunk)
            stmts.append(f"INSERT INTO {name} VALUES {values}")
    stmts.extend(case.get("setup", []))
    return stmts


def run_sqlite(case, reverse=False):
    con = sqlite3.connect(":memory:")
    for s in setup_statements(case, reverse):
        con.execute(s)
    try:
        return ("rows", [tuple(r) for r in con.execute(case["sql"]).fetchall()])
    except sqlite3.Error as e:
        return ("error", str(e))


def norm_value(v):
    if isinstance(v, bool):
        return int(v)
    return v


def values_equal(a, b):
    a, b = norm_value(a), norm_value(b)
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, str) or isinstance(b, str):
        return isinstance(a, str) and isinstance(b, str) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return math.isclose(a, b, rel_tol=1e-6, abs_tol=1e-6)
    return False


def rows_equal(r1, r2):
    return len(r1) == len(r2) and all(values_equal(a, b) for a, b in zip(r1, r2))


def sort_key(row):
    out = []
    for v in row:
        v = norm_value(v)
        if v is None:
            out.append((0, 0))
        elif isinstance(v, (int, float)):
            out.append((1, round(float(v), 6)))
        else:
            out.append((2, str(v)))
    return out


def results_equal(expected, actual, ordered):
    if not isinstance(actual, list) or len(expected) != len(actual):
        return False
    if any(not isinstance(r, tuple) for r in actual):
        return False
    if not ordered:
        try:
            expected = sorted(expected, key=sort_key)
            actual = sorted(actual, key=sort_key)
        except TypeError:
            return False
    return all(rows_equal(a, b) for a, b in zip(expected, actual))


def expected_result(case):
    """Returns ("error", msg) or ("rows", rows, ordered)."""
    fwd = run_sqlite(case)
    if fwd[0] == "error":
        return fwd
    rev = run_sqlite(case, reverse=True)
    ordered = rev[0] == "rows" and results_equal(fwd[1], rev[1], ordered=True)
    return ("rows", fwd[1], ordered)


def check(case, minisql):
    """Returns (passed, detail)."""
    exp = expected_result(case)
    db = minisql.connect()
    try:
        for s in setup_statements(case):
            db.execute(s)
    except Exception as e:
        return False, f"setup failed: {type(e).__name__}: {e}"
    try:
        got = db.execute(case["sql"])
    except minisql.Error as e:
        if exp[0] == "error":
            return True, "raised minisql.Error as expected"
        return False, f"unexpected minisql.Error: {e}"
    except Exception as e:
        return False, f"raised {type(e).__name__} (not minisql.Error): {e}"
    if exp[0] == "error":
        return False, f"expected an error ({exp[1]}), got {got!r}"
    if results_equal(exp[1], got, exp[2]):
        return True, "ok"
    return False, f"expected {exp[1]!r}{' (ordered)' if exp[2] else ''}, got {got!r}"
