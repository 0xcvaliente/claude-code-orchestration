"""Public examples for toolkit.cal, checked against the standard library.

The hidden tests use the same kind of comparison on many more inputs.
Run all public tests with run_public.py, or this file directly:
    python3 tests/public_cal.py
"""

import datetime
import os
import sys

EXAMPLES = [
    {"name": "monthrange-leap-feb", "call": lambda m: m.monthrange(2028, 2)},
    {"name": "leapdays-span", "call": lambda m: m.leapdays(1800, 2101)},
    {"name": "weekday-bad-day", "call": lambda m: m.weekday(2022, 6, 31)},
    {"name": "monthcalendar-sunday-first",
     "call": lambda m: (m.setfirstweekday(6), m.monthcalendar(2022, 5))[1]},
    {"name": "itermonthdays4-fw-mod-7",
     "call": lambda m: list(m.Calendar(10).itermonthdays4(2027, 3))},
    {"name": "monthdatescalendar",
     "call": lambda m: m.Calendar(2).monthdatescalendar(2019, 9)},
    {"name": "formatmonth-wide",
     "call": lambda m: m.TextCalendar(6).formatmonth(2030, 6, 4, 2)},
    {"name": "formatyear-two-columns",
     "call": lambda m: m.TextCalendar(0).formatyear(2031, 3, 1, 4, 2)},
    {"name": "illegal-month", "call": lambda m: m.monthcalendar(2022, 0)},
    {"name": "names-and-timegm",
     "call": lambda m: [list(m.month_abbr), m.day_name[-3:],
                        m.timegm((2001, 9, 9, 1, 46, 40))]},
]


def _norm(v):
    if isinstance(v, datetime.date):
        return ("date", v.year, v.month, v.day)
    if isinstance(v, (list, tuple)):
        return [_norm(x) for x in v]
    if isinstance(v, int) and not isinstance(v, bool):
        return int(v)
    return v


def _run(mod, ex):
    try:
        return _norm(ex["call"](mod))
    except Exception as e:  # noqa: BLE001
        for k in ("IllegalMonthError", "IllegalWeekdayError"):
            cls = getattr(mod, k, None)
            if isinstance(cls, type) and isinstance(e, cls):
                return ("error", k)
        return ("exception", type(e).__name__)
    finally:
        try:
            mod.setfirstweekday(0)
        except Exception:  # noqa: BLE001
            pass


def check(ex, mod=None):
    if mod is None:
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        import toolkit.cal as mod
    import calendar
    got = _run(mod, ex)
    want = _run(calendar, ex)
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
    print("cal public: %d/%d" % (ok, len(EXAMPLES)))
    sys.exit(0 if ok == len(EXAMPLES) else 1)
