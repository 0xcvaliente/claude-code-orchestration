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
characters after a closing quote (kept when not `strict`).

An escaped line ending (escapechar followed by `\r` or `\n`, outside
quotes) adds that character to the field and continues the field on the
next string: the end of that string does not end the record, and neither
does the end of following strings while the field continues with plain
characters; the record ends at the next unescaped `\r` or `\n` (or at
the end of a later string after another escaped character or a
delimiter). This is `csv`'s behaviour; match it exactly.

Reading errors (all raise `csvx.Error` unless noted):

- the iterable yields an item that is not a `str` (for example an `int`):
  `csvx.Error`, raised when that item is reached;
- `strict` is true and a character other than the delimiter, the
  quotechar or a line ending follows a closing quote;
- the input ends while a field is in progress (inside an open quoted
  field, or with characters collected for the current field but no line
  ending after them) and `strict` is true; when `strict` is false the
  partial record is returned as the last record instead;
- an unescaped `\r` or `\n` outside a quoted field is followed, on the
  same string, by a character other than `\r` or `\n` (for example the
  string `"a\rb\n"`);
- `ValueError` (not `Error`) for a field that `float()` cannot convert
  under `QUOTE_NONNUMERIC` or `QUOTE_STRINGS`.

Records read before an error must still be produced.

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
included, while `int`, `float` and `bool` (a number) stay unquoted; `QUOTE_STRINGS` quotes strings only; `QUOTE_NOTNULL` quotes
everything but `None`); doubling the quotechar, or escaping it with
`escapechar` when `doublequote` is false; escaping the escapechar itself;
`QUOTE_NONE` escaping instead of quoting (the delimiter, the quotechar,
the escapechar, `\r`, `\n` and lineterminator characters are each
preceded by the escapechar); a record made of exactly one field whose
text is empty and unquoted being written as `""`; an empty field (`""`
or `None`) being written quoted, as `""`, when the delimiter is a space
and `skipinitialspace` is true.

Writing errors (all raise `csvx.Error`):

- the row is not iterable (for example `7`);
- a character must be escaped (`QUOTE_NONE` and one of the characters
  above, or `doublequote=False` and the quotechar) and no escapechar is
  set; `quotechar=None` without an explicit `quoting` means `QUOTE_NONE`,
  so `["a,b"]` then raises;
- the row has exactly one field, its text is empty, and either `quoting`
  is `QUOTE_NONE` (`[""]` or `[None]`) or the field is `None` and
  `quoting` is `QUOTE_STRINGS` or `QUOTE_NOTNULL` (`[None]`);
- the delimiter is a space, `skipinitialspace` is true, a field's text is
  empty, and either `quoting` is `QUOTE_NONE` or the field is `None` and
  `quoting` is `QUOTE_STRINGS` or `QUOTE_NOTNULL` (this check runs per
  field, before the one-field rule).

A row that raises writes nothing; earlier rows stay written, and
`writerows` stops at the first row that raises.

Some tests write rows to a `io.StringIO` and read the text back with the
same dialect and parameters, splitting it with `str.splitlines(keepends=True)`
into the strings given to `reader`.

Only the exception type is compared (`Error`, `TypeError`, `ValueError`),
never the message.

## Never tested

`Sniffer`, `DictReader`, `DictWriter`, `register_dialect`,
`unregister_dialect`, `field_size_limit`, `Dialect` subclasses or objects
passed as `dialect`, the `dialect` attribute of readers and writers, NUL
characters, non-ASCII text, fields longer than 1000 characters, numbers
other than `int`, `float` and `bool`, `nan` and `inf`, and inputs where
more than one parameter is invalid.
