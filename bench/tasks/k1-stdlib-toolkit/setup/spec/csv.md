# toolkit.csvx

A pure-Python CSV reader and writer in `toolkit/csvx.py` that behaves like
the Python 3.13 standard library module `csv` for the subset below. The
hidden tests run the same call on `toolkit.csvx` and on `csv` and compare
the results. The solution may not import `csv` or `_csv`, or any other
module on the blocked list in SPEC.md.

## API

- `reader(iterable, dialect="excel", **fmtparams)`: returns an iterator
  over records. `iterable` yields strings (usually lines that keep their
  line endings, but any chunks are possible; each string is processed as
  one line). Each record is a list of fields. The iterator has a
  `line_num` attribute: the number of strings read from `iterable` so far.
- `writer(fileobj, dialect="excel", **fmtparams)`: returns an object with
  `writerow(row)` and `writerows(rows)`. `writerow` builds one record plus
  the line terminator and returns what `fileobj.write` returned for it;
  `writerows` calls `writerow` for each row and returns `None`.
- `dialect` is one of the names `"excel"`, `"excel-tab"`, `"unix"`; any
  other name raises `Error`.
- `fmtparams` (each overrides the dialect): `delimiter`, `quotechar`,
  `escapechar`, `doublequote`, `skipinitialspace`, `lineterminator`,
  `quoting`, `strict`.
- Constants with `csv`'s values: `QUOTE_MINIMAL` = 0, `QUOTE_ALL` = 1,
  `QUOTE_NONNUMERIC` = 2, `QUOTE_NONE` = 3, `QUOTE_STRINGS` = 4,
  `QUOTE_NOTNULL` = 5.
- `Error`: exception class (subclass of `Exception`).

Dialects: `excel` is `delimiter=","`, `quotechar='"'`, `doublequote=True`,
`skipinitialspace=False`, `lineterminator="\r\n"`, `quoting=QUOTE_MINIMAL`,
no escapechar, `strict=False`. `excel-tab` is the same with
`delimiter="\t"`. `unix` is `excel` with `lineterminator="\n"` and
`quoting=QUOTE_ALL`.

## Parameter validation (at reader/writer creation)

Raise the same exception type as `csv`:

- `TypeError`: an unknown keyword; `delimiter` not a 1-character string
  (including `None`); `quotechar` or `escapechar` neither `None` nor a
  1-character string; `lineterminator` `None` or not a string; `quoting`
  not an integer or not one of the six constants; `quotechar=None` with
  an explicit quoting other than `QUOTE_NONE`. (`quotechar=None` without
  an explicit `quoting` switches quoting to `QUOTE_NONE`.)
- `ValueError`: `delimiter`, `quotechar` or `escapechar` is `\r` or `\n`
  or occurs in `lineterminator`; `quotechar` or `escapechar` is a space
  while `skipinitialspace` is true; two of `delimiter`, `quotechar`,
  `escapechar` are the same character.
- `Error`: unknown dialect name.

Tests that check validation have a single invalid parameter.

## Reading

Match `csv.reader` exactly, including: quoted fields with doubled quotes,
quoted fields spanning several strings, `\r`, `\n` and `\r\n` endings, an
empty string or a line of only a line ending giving `[]`, `escapechar` in
and out of quotes (including an escaped line ending), `skipinitialspace`,
`doublequote=False`, `QUOTE_NONE` (quotechar is an ordinary character),
characters after a closing quote (kept when not `strict`), and the errors
`csv` raises: a non-string from the iterable, a character after a closing
quote in `strict` mode, end of data inside a quoted field in `strict`
mode, a line ending inside an unquoted field followed by more data on the
same string. Records read before an error must still be produced.

Quoting modes when reading: with `QUOTE_NONNUMERIC` and `QUOTE_STRINGS`
every non-empty unquoted field is converted with `float()` (a field that
does not convert raises `ValueError`, as in `csv`); with `QUOTE_NOTNULL`
and `QUOTE_STRINGS` an empty unquoted field is `None`.

## Writing

Match `csv.writer` exactly. Fields are strings, `None` (written as an
empty field), integers, floats (written as `str(x)`) and booleans. A row
that is not iterable raises `Error`; a string row is iterated character by
character. Rules to match include: when a field is quoted for each
`quoting` mode (`QUOTE_MINIMAL` quotes a field containing the delimiter,
the quotechar, `\r`, `\n` or any character of `lineterminator`;
`QUOTE_NONNUMERIC` quotes everything that is not a number, `None`
included; `QUOTE_STRINGS` quotes strings only; `QUOTE_NOTNULL` quotes
everything but `None`); doubling the quotechar, or escaping it with
`escapechar` when `doublequote` is false; escaping the escapechar itself;
`QUOTE_NONE` escaping instead of quoting (and raising `Error` when an
escape is needed but no escapechar is set); a record made of one empty
field being written as `""` (or raising `Error` where `csv` does); empty
fields when the delimiter is a space and `skipinitialspace` is true. A row
that raises writes nothing; earlier rows stay written.

Only the exception type is compared (`Error`, `TypeError`, `ValueError`),
never the message.

## Never tested

`Sniffer`, `DictReader`, `DictWriter`, `register_dialect`,
`unregister_dialect`, `field_size_limit`, `Dialect` subclasses or objects
passed as `dialect`, the `dialect` attribute of readers and writers, NUL
characters, non-ASCII text, fields longer than 1000 characters, numbers
other than `int`, `float` and `bool`, `nan` and `inf`, and inputs where
more than one parameter is invalid.
