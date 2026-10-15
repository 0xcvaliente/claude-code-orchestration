"""Hidden differential cases for toolkit.cal (graded against `calendar`).

Adapter interface: NAME, MODULE, ORACLES, WRAP, cases(), run_impl(mod, case),
run_oracle(case), same(a, b).  `python3 mod_cal.py <package_root>` runs the
self-test against <package_root>/toolkit/cal.py.

cases() imports neither `calendar` nor the solution; generated inputs come
from a fixed seed.  json is imported only by the self-test.

Case shapes:
  {"op": "<module function>", "args": [...], "kw": {...}, "fw": n}
      call mod.<op>(*args, **kw) after mod.setfirstweekday(fw) (fw defaults
      to 0); the first weekday is reset to 0 afterwards.  For "timegm" the
      single argument (a list) is passed as a tuple.
  {"op": "method", "cls": "Calendar"|"TextCalendar", "fw": n,
   "method": name, "args": [...], "kw": {...}}
      cls(fw).<method>(*args, **kw); results of iter* methods are listed.
  {"op": "setfw", "fw": n, "how": "attr"|"method", "value": x}
  {"op": "module_setfw", "fw": n, "value": x}
  {"op": "names", "seq": name, "index": i | "slice": [a, b] | "all": true}
  {"op": "constants"}, {"op": "errclasses"}
"""

import datetime
import random
import sys
import time

NAME = "cal"
MODULE = "toolkit.cal"
ORACLES = ["calendar"]
# _strptime (datetime.strptime, time.strptime) imports calendar: it stays importable, and its
# WRAP entry points are watched only during cal cases (runner.py, WATCH_ONLY). A watched call
# made by genuine _strptime code (calendar.isleap for %W/%U/%G formats) is not solution use,
# even with toolkit code further up the stack (WATCH_CALLERS). Residual limit: calendar can be
# cloned at import time, outside cases, by rebuilding its functions from their code objects
# (types.FunctionType over a copied globals dict); clones bypass the wrapped entry points (a
# captured reference to a wrapped function is caught, a rebuilt clone is not). A reviewer's
# clone scored 147/156 with no flag; the static scan flags __code__, FunctionType, _strptime
# and vars( for the post-run audit.
WATCH_ONLY = True
WATCH_CALLERS = ["_strptime"]
WRAP = ["calendar.Calendar", "calendar.TextCalendar", "calendar.monthrange",
        "calendar.weekday", "calendar.isleap", "calendar.leapdays",
        "calendar.monthcalendar", "calendar.month", "calendar.calendar",
        "calendar.timegm", "calendar.weekheader", "calendar.setfirstweekday",
        "calendar.firstweekday"]

_MODULE_OPS = {"isleap", "leapdays", "weekday", "monthrange", "monthcalendar",
               "month", "calendar", "weekheader", "timegm", "firstweekday"}


# ----------------------------------------------------------- normalization

def _n(v):
    if isinstance(v, datetime.date):
        return {"date": [v.year, v.month, v.day]}
    if isinstance(v, bool) or v is None or isinstance(v, str):
        return v
    if isinstance(v, int):
        return int(v)
    if isinstance(v, float):
        return {"$f": repr(v)}
    if isinstance(v, (list, tuple)):
        return [_n(x) for x in v]
    return {"$other": type(v).__name__}


def _err(mod, e):
    ime = getattr(mod, "IllegalMonthError", None)
    iwe = getattr(mod, "IllegalWeekdayError", None)
    if isinstance(ime, type) and isinstance(e, ime):
        return {"error": "IllegalMonthError", "month": _n(getattr(e, "month", None))}
    if isinstance(iwe, type) and isinstance(e, iwe):
        return {"error": "IllegalWeekdayError",
                "weekday": _n(getattr(e, "weekday", None))}
    for k in (ValueError, IndexError, TypeError):
        if isinstance(e, k):
            return {"error": k.__name__}
    return {"error": type(e).__name__}


def _call_module(mod, case):
    op = case["op"]
    args = list(case.get("args", []))
    if op == "timegm":
        args = [tuple(args[0])]
    mod.setfirstweekday(case.get("fw", 0))
    try:
        return _n(getattr(mod, op)(*args, **case.get("kw", {})))
    finally:
        try:
            mod.setfirstweekday(0)
        except Exception:  # noqa: BLE001
            pass


def _run(mod, case):
    op = case["op"]
    try:
        if op in _MODULE_OPS:
            return {"ok": _call_module(mod, case)}
        if op == "method":
            obj = getattr(mod, case["cls"])(case["fw"])
            r = getattr(obj, case["method"])(*case.get("args", []),
                                             **case.get("kw", {}))
            if case["method"].startswith("iter"):
                r = list(r)
            return {"ok": _n(r)}
        if op == "setfw":
            c = mod.Calendar(case["fw"])
            if case["how"] == "attr":
                c.firstweekday = case["value"]
            else:
                c.setfirstweekday(case["value"])
            return {"ok": [_n(c.firstweekday), _n(c.getfirstweekday()),
                           _n(list(c.iterweekdays()))]}
        if op == "module_setfw":
            mod.setfirstweekday(case["fw"])
            try:
                try:
                    mod.setfirstweekday(case["value"])
                    e1 = None
                except Exception as e:  # noqa: BLE001
                    e1 = _err(mod, e)
                return {"ok": [e1, _n(mod.firstweekday()), mod.weekheader(3)]}
            finally:
                try:
                    mod.setfirstweekday(0)
                except Exception:  # noqa: BLE001
                    pass
        if op == "names":
            seq = getattr(mod, case["seq"])
            if "index" in case:
                return {"ok": _n(seq[case["index"]])}
            if "slice" in case:
                a, b = case["slice"]
                return {"ok": _n(list(seq[a:b]))}
            return {"ok": [len(seq), _n([seq[i] for i in range(len(seq))]),
                           _n(list(seq))]}
        if op == "constants":
            return {"ok": [int(getattr(mod, n)) for n in
                           ("MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY",
                            "FRIDAY", "SATURDAY", "SUNDAY")]}
        if op == "errclasses":
            ime, iwe = mod.IllegalMonthError, mod.IllegalWeekdayError
            out = [issubclass(ime, ValueError), issubclass(ime, IndexError),
                   issubclass(iwe, ValueError)]
            try:
                mod.monthrange(2001, 14)
                out.append(None)
            except ime as e:
                out.append(["IllegalMonthError", e.month])
            return {"ok": out}
    except Exception as e:  # noqa: BLE001
        return _err(mod, e)
    raise ValueError(op)


def run_impl(mod, case):
    return _run(mod, case)


def run_oracle(case):
    import calendar
    return _run(calendar, case)


def same(a, b):
    return a == b


# --------------------------------------------------------------- hand cases

def _hand():
    H = []

    def M(op, *args, fw=0, **kw):
        c = {"op": op, "args": list(args), "kw": kw}
        if fw:
            c["fw"] = fw
        H.append(c)

    def C(method, fw, *args, cls="Calendar", **kw):
        H.append({"op": "method", "cls": cls, "fw": fw, "method": method,
                  "args": list(args), "kw": kw})

    def TC(method, fw, *args, **kw):
        C(method, fw, *args, cls="TextCalendar", **kw)

    H.append({"op": "constants"})
    H.append({"op": "errclasses"})
    for y in (2000, 1900, 2024, 2023, 1, 4):
        M("isleap", y)
    for a, b in ((1, 1), (1900, 2000), (2000, 2001), (2001, 2000), (1, 9999),
                 (1997, 2025)):
        M("leapdays", a, b)
    M("weekday", 1, 1, 1)
    M("weekday", 9999, 12, 31)
    M("weekday", 2024, 2, 29)
    M("weekday", 2023, 2, 29)
    M("weekday", 2024, 13, 1)
    M("weekday", 2024, 4, 31)
    M("weekday", 2024, 1, 0)
    M("monthrange", 2024, 2)
    M("monthrange", 1900, 2)
    M("monthrange", 2000, 2)
    M("monthrange", 2023, 12)
    M("monthrange", 2023, 0)
    M("monthrange", 2023, 13)
    M("monthrange", 2023, -1)
    M("monthcalendar", 2024, 3)
    M("monthcalendar", 2023, 10, fw=6)
    M("monthcalendar", 2021, 2)
    M("monthcalendar", 2015, 2, fw=6)
    M("monthcalendar", 2024, 13)
    M("month", 2024, 1)
    M("month", 2023, 9, 3, 2, fw=6)
    M("month", 2024, 2, w=0, l=0)
    M("month", 2024, 2, w=-5, l=-1)
    M("month", 2024, 0)
    M("month", 9999, 12, w=4, fw=2)
    M("calendar", 2024)
    M("calendar", 2023, w=3, l=2, c=4, m=4, fw=6)
    M("calendar", 2000, 2, 1, 0, 2)
    M("calendar", 1, m=6, c=3)
    M("calendar", 9999, m=1)
    M("calendar", 2025, w=1, m=12)
    M("weekheader", 1)
    M("weekheader", 2, fw=6)
    M("weekheader", 3, fw=3)
    M("weekheader", 9)
    M("weekheader", 12, fw=5)
    M("timegm", [1970, 1, 1, 0, 0, 0])
    M("timegm", [2024, 2, 29, 23, 59, 59])
    M("timegm", [1969, 12, 31, 23, 59, 59, 2, 365, 0])
    M("timegm", [2000, 1, 40, 25, 61, 61])
    M("timegm", [2000, 13, 1, 0, 0, 0])
    M("timegm", [1, 1, 1, 0, 0, 0])
    M("timegm", [2024, 1, 1, 0, 0, 1.5])
    M("firstweekday")
    M("firstweekday", fw=6)
    H.append({"op": "module_setfw", "fw": 0, "value": 3})
    H.append({"op": "module_setfw", "fw": 2, "value": 7})
    H.append({"op": "module_setfw", "fw": 5, "value": -1})
    for seq in ("day_name", "day_abbr", "month_name", "month_abbr"):
        H.append({"op": "names", "seq": seq, "all": True})
    H.append({"op": "names", "seq": "month_name", "index": -1})
    H.append({"op": "names", "seq": "day_abbr", "index": -7})
    H.append({"op": "names", "seq": "month_abbr", "index": 0})
    H.append({"op": "names", "seq": "month_name", "index": 13})
    H.append({"op": "names", "seq": "month_name", "slice": [1, 4]})
    H.append({"op": "names", "seq": "day_name", "slice": [-2, None]})
    for fw in (0, 3, 6, 9, -1):
        C("iterweekdays", fw)
    H.append({"op": "setfw", "fw": 0, "how": "attr", "value": 10})
    H.append({"op": "setfw", "fw": 4, "how": "method", "value": -3})
    C("itermonthdates", 0, 2024, 2)
    C("itermonthdates", 6, 2023, 1)
    C("itermonthdates", 0, 1, 1)
    C("itermonthdates", 6, 1, 1)
    C("itermonthdates", 0, 9999, 12)
    C("itermonthdates", 5, 9999, 12)
    C("itermonthdays", 0, 2024, 6)
    C("itermonthdays", 6, 2023, 2)
    C("itermonthdays", 0, 2024, 13)
    C("itermonthdays2", 2, 2024, 9)
    C("itermonthdays2", 5, 2025, 3)
    C("itermonthdays3", 6, 1, 1)
    C("itermonthdays3", 0, 9999, 12)
    C("itermonthdays3", 1, 2024, 3)
    C("itermonthdays4", 3, 1, 1)
    C("itermonthdays4", 6, 2024, 12)
    C("itermonthdays4", 0, 2023, 0)
    C("monthdatescalendar", 0, 2024, 7)
    C("monthdatescalendar", 6, 2026, 2)
    C("monthdatescalendar", 1, 1, 1)
    C("monthdays2calendar", 4, 2024, 11)
    C("monthdays2calendar", 0, 2020, 2)
    C("monthdayscalendar", 6, 2021, 8)
    C("monthdayscalendar", 0, 2024, 5)
    C("yeardatescalendar", 0, 2024)
    C("yeardatescalendar", 6, 2023, 4)
    C("yeardatescalendar", 2, 2025, width=5)
    C("yeardatescalendar", 0, 2022, 12)
    C("yeardatescalendar", 6, 1, 1)
    TC("formatmonth", 6, 2024, 2)
    TC("formatmonth", 0, 2023, 10, 5, 3)
    TC("formatmonth", 0, 2024, 13)
    TC("formatmonth", 2, 2023, 0)
    TC("formatyear", 6, 2024)
    TC("formatyear", 1, 2020, w=4, l=2, c=8, m=2)
    TC("formatyear", 0, 1999, m=5, c=1)
    TC("formatyear", 0, 2026, 0, 0, 0, 12)
    TC("formatweekheader", 0, 0)
    TC("formatweekheader", 1, 4)
    TC("formatweekheader", 6, 9)
    TC("formatweekheader", 2, 15)
    return H


# ---------------------------------------------------------- generated cases

def _year(rng):
    r = rng.random()
    if r < 0.1:
        return rng.choice([1, 2, 9998, 9999])
    if r < 0.6:
        return rng.randint(1890, 2110)
    return rng.randint(1, 9999)


def _month(rng):
    return rng.choice([0, 13]) if rng.random() < 0.06 else rng.randint(1, 12)


def _gen(rng):
    k = rng.randint(0, 11)
    fw = rng.randint(0, 6)
    if k == 0:
        return {"op": "weekday", "args": [_year(rng), _month(rng),
                                          rng.randint(0, 31)]}
    if k == 1:
        return {"op": "monthrange", "args": [_year(rng), _month(rng)]}
    if k == 2:
        return {"op": "monthcalendar", "args": [_year(rng), _month(rng)], "fw": fw}
    if k == 3:
        return {"op": "month", "args": [_year(rng), _month(rng),
                                        rng.randint(-1, 4), rng.randint(0, 2)],
                "fw": fw}
    if k == 4:
        y = _year(rng)
        y2 = min(9999, max(1, y + rng.randint(-50, 400)))
        return {"op": "leapdays", "args": [y, y2] if rng.random() < 0.8 else [y2, y]}
    if k == 5:
        return {"op": "timegm", "args": [[_year(rng), rng.randint(1, 12),
                                          rng.randint(1, 31), rng.randint(0, 23),
                                          rng.randint(0, 59), rng.randint(0, 59)]]}
    if k == 6:
        return {"op": "calendar", "args": [_year(rng)],
                "kw": {"w": rng.randint(1, 3), "l": rng.randint(1, 2),
                       "c": rng.randint(1, 7), "m": rng.randint(1, 6)}, "fw": fw}
    methods = ["itermonthdates", "itermonthdays2", "itermonthdays4",
               "monthdayscalendar", "formatmonth"]
    meth = methods[k - 7]
    cls = "TextCalendar" if meth == "formatmonth" else "Calendar"
    return {"op": "method", "cls": cls, "fw": rng.randint(-8, 15),
            "method": meth, "args": [_year(rng), _month(rng)], "kw": {}}


def _generated():
    rng = random.Random(1510202604)
    return [_gen(rng) for _ in range(36)]


def cases():
    all_cases = _hand() + _generated()
    for i, c in enumerate(all_cases):
        tag = c.get("method", c["op"])
        c["id"] = "%s-%03d-%s" % (NAME, i, tag)
    return all_cases


# ---------------------------------------------------------------- self-test

def _main(argv):
    import json
    if len(argv) != 2:
        print("usage: mod_cal.py <package_root>")
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
