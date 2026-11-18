r"""The Python 3.13 oracle results of the hidden cases whose result changed in Python 3.14.

task.md grades against Python 3.13's standard library. grade.py re-runs itself under python3.13 when it finds
one; when it runs under 3.14 or later instead, the oracle of these cases gives the 3.14 result, so their expected
value is the 3.13 one below (one expected value per version, chosen by the check in `expected`). Generated from
the oracle under CPython 3.13.18 and 3.14.4, which differ on exactly these cases:
- regex: `\B` matches an empty string since 3.14 (3.13: no match)
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
