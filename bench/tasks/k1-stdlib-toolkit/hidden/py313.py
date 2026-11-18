r"""Recorded oracle results that grade.py uses, on Python 3.14 or later, in place of the live oracle for two cases.

task.md grades against Python 3.13's standard library. grade.py re-runs itself under python3.13 when it finds
one; when it runs under 3.14 or later instead, `expected` returns the value recorded below for a listed case.
What each recorded value is, and what is established about it (no CPython 3.13 was available when this was
last checked, on 2026-11-18, so neither value was reproduced on 3.13 then):
- regex-025-search, regex-188-fullmatch: no match (None). CPython 3.12.16 gives no match; CPython 3.14.4
  matches the empty string (`\B` on an empty string). An earlier review measured the k2 cases on 3.13.5 and
  3.14.4 and did not name these two among the values 3.13.5 contradicts.
"""
import sys

PY313 = {
 "regex-025-search": None,
 "regex-188-fullmatch": None
}


def expected(case_id, result):
    """The oracle result to grade against: the 3.13 one for a listed case on Python 3.14 or later."""
    if sys.version_info >= (3, 14) and case_id in PY313:
        return PY313[case_id]
    return result
