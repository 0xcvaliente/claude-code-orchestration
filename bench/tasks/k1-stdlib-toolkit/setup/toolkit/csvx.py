"""toolkit.csvx: a pure-Python CSV reader and writer compatible with the
standard library's `csv` module for the subset in spec/csv.md.

This is a stub.  Every public name exists so imports succeed; replace the
bodies and give the QUOTE_* constants csv's values.  Do not import csv, _csv
or any other blocked module.
"""

# TODO: set these to the same integer values as csv.QUOTE_*.
QUOTE_MINIMAL = None
QUOTE_ALL = None
QUOTE_NONNUMERIC = None
QUOTE_NONE = None
QUOTE_STRINGS = None
QUOTE_NOTNULL = None


class Error(Exception):
    """Raised wherever `csv` raises csv.Error."""


def reader(iterable, dialect="excel", **fmtparams):
    """Return an iterator of rows (lists) parsed from an iterable of strings.
    The returned object has a line_num attribute."""
    raise NotImplementedError("toolkit.csvx.reader")


def writer(fileobj, dialect="excel", **fmtparams):
    """Return an object with writerow(row) and writerows(rows) that writes
    delimited lines to fileobj.write."""
    raise NotImplementedError("toolkit.csvx.writer")
