# toolkit.jsonx

A pure-Python JSON encoder and decoder in `toolkit/jsonx.py` that behaves
like the Python 3.13 standard library module `json` for the subset below.
The hidden tests run the same call on `toolkit.jsonx` and on `json` and
compare the results. The solution may not import `json` or `_json`, or any
other module on the blocked list in SPEC.md.

## API

- `dumps(obj, *, skipkeys=False, ensure_ascii=True, check_circular=True,
  allow_nan=True, indent=None, separators=None, default=None,
  sort_keys=False)`: returns a `str`.
- `loads(s, *, object_hook=None, parse_float=None, parse_int=None,
  parse_constant=None, object_pairs_hook=None, strict=True)`: `s` is
  always a `str`.
- `JSONDecodeError`: a subclass of `ValueError` with attributes `msg`,
  `doc`, `pos`, `lineno` and `colno`. Tests check that it is a subclass of
  `ValueError` and compare `pos`, `lineno` and `colno`, never `msg`.
  `lineno` is `doc.count("\n", 0, pos) + 1`; `colno` is
  `pos - doc.rfind("\n", 0, pos)` (both 1-based).

Only the error kind is compared. For `dumps` the kinds are `TypeError` and
`ValueError`. For `loads` they are `JSONDecodeError` (with its three
position attributes) and, where a hook raises one, a plain `ValueError`.

## dumps

Values:

- `None` -> `null`, `True` -> `true`, `False` -> `false`.
- `int` -> `int.__repr__(x)` (any size up to 4300 digits).
- `float` -> `float.__repr__(x)` (`1e+16`, `1.5e-07`, `-0.0`, `5e-324`,
  ...). NaN, positive and negative infinity are written `NaN`, `Infinity`,
  `-Infinity` when `allow_nan` is true, and raise `ValueError` when it is
  false (also when the float is a dict key).
- `str`: written in double quotes. `"` and `\` become `\"` and `\\`;
  `\b \f \n \r \t` become those two-character escapes; any other character
  below U+0020 becomes `\u00XX` (lowercase hex). `/` is never escaped.
  With `ensure_ascii=True` every character outside U+0020..U+007E
  (including U+007F) is also escaped as `\uXXXX` with lowercase hex; a
  character above U+FFFF becomes a UTF-16 surrogate pair of two escapes;
  a lone surrogate code point (U+D800..U+DFFF) in the string is escaped like
  any other character. With `ensure_ascii=False` only the escapes of the
  previous sentence's first part (quote, backslash, below U+0020) are
  applied and every other character, lone surrogates included, is written
  as itself.
- `list` and `tuple` -> JSON array; `dict` -> JSON object in insertion
  order. Empty containers are always `[]` and `{}`, with or without indent.
- Dict keys: a `str` key is used as is; a `float` key becomes its float
  text as above (`NaN`, `Infinity`, `-Infinity` for the special values,
  which raise `ValueError` when `allow_nan` is false); `True`, `False`,
  `None` become `"true"`, `"false"`, `"null"`; an `int` key becomes
  `int.__repr__`. The converted key is then written as a JSON string.
  Different keys may convert to the same text (`1` and `"1"`); both are
  written. Any other key type (tuple, bytes, ...) raises `TypeError`,
  unless `skipkeys` is true, in which case that item is skipped (an
  object whose items are all skipped is written `{}`).
- `sort_keys=True`: items are sorted exactly as `sorted(d.items())` sorts
  them, by the original keys before conversion (so `3, 1, 2.5, True` sort
  numerically). If keys of different types cannot be compared (`"a"` and
  `1`, `None` and `"a"`), `TypeError` is raised, also with `skipkeys=True`,
  because sorting happens before keys are checked.
- Any other object (set, bytes, complex, ...) is passed to `default` and
  the value it returns is encoded in its place. Without `default`,
  `TypeError` is raised. An exception raised by `default` propagates
  (tests use `TypeError`).
- `check_circular=True` (the default): a list, tuple or dict that contains
  itself, directly or through other containers, raises `ValueError`. The
  same applies to an object passed to `default` while it is being
  converted: if `default` returns the very same object, `ValueError` is
  raised. An object that merely appears several times without containing
  itself (`[x, x, x]`) is fine. With `check_circular=False` the output for
  non-circular input is the same; circular input with
  `check_circular=False` is never tested.

Layout:

- `indent=None` (default): everything on one line.
- `indent` an `int` n: the indent string is n spaces (`0` or a negative
  number give the empty string); `indent` a `str`: used as is. With any
  non-`None` indent, each array element and object item goes on its own
  line, preceded by a newline and the indent string repeated once per
  nesting level; the closing bracket goes on a new line at the parent's
  level. An empty indent string still inserts the newlines.
- `separators=(item_separator, key_separator)`; tests pass a 2-item list
  or tuple of strings. Default: `(", ", ": ")` when `indent` is `None`,
  `(",", ": ")` otherwise. The item separator is written between items
  before the newline exactly as given (with indent and `", "` you get a
  trailing space).

## loads

Grammar (RFC 8259 plus the extensions below). Whitespace is only space,
tab, `\n` and `\r`, allowed before and after any value and around `,` and
`:`; any other character (form feed, U+00A0, ...) is not whitespace.

- Literals `null`, `true`, `false`; also `NaN`, `Infinity` and
  `-Infinity`, which give `parse_constant("NaN")` etc., by default
  `float('nan')`, `float('inf')`, `float('-inf')`. Spellings are case
  sensitive (`nan`, `infinity` are errors).
- Numbers: `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?`, ASCII digits
  only. A number with a fraction or exponent part goes to `parse_float`
  (default `float`, so `1e400` is `inf`), otherwise to `parse_int`
  (default `int`; `-0` is the int `0`). The number ends where this pattern
  stops matching: a `.` not followed by a digit or an `e` not followed by
  digits is not part of it (`1.` and `1e` read `1`, then fail with "extra
  data" at index 1; `01` reads `0`, then extra data at 1). Integers with
  more than 4300 digits are never tested.
- Strings: escapes `\" \\ \/ \b \f \n \r \t` and `\uXXXX` (exactly four
  hex digits, either case). A `\uXXXX` high surrogate (D800..DBFF)
  immediately followed by `\u` and a low surrogate (DC00..DFFF) combines
  into one character; a high surrogate not followed by a low-surrogate
  escape, and a lone low surrogate, are kept as lone surrogate characters.
  Raw (unescaped) characters, lone surrogates included, are kept as they
  are. With `strict=True` (default) a raw character below U+0020 inside a
  string is an error; with `strict=False` it is kept.
- Arrays and objects: commas between elements, no trailing comma. Object
  keys must be strings. Duplicate keys: the last value wins, at the
  position of the first occurrence (a plain `dict` built from the pairs in
  order).
- Hooks: `object_pairs_hook`, if given, is called with the list of
  `(key, value)` pairs of each object (innermost first, duplicates kept)
  and its result replaces the object; it takes priority over
  `object_hook`. Otherwise `object_hook`, if given, is called with each
  decoded dict. `parse_float`, `parse_int` and `parse_constant` receive the
  exact source text of the token (`"-3e2"`, `"-0"`, `"-Infinity"`). An
  exception raised by a hook propagates unchanged (tests use a
  `parse_constant` that raises a plain `ValueError`).

Errors: `loads` raises `JSONDecodeError` with these positions (`pos` is a
0-based index into `s`):

| Situation | `pos` |
|---|---|
| `s` starts with U+FEFF (BOM) | 0 |
| no value where one is expected (empty or whitespace-only input, bad literal such as `nul`, `-` alone, `+1`, `.5`, `-Inf`, `[,`, `{"a": }`, an array that ends right after `[`) | index where the value should start (after skipping whitespace) |
| object: something other than `"` where a key is expected (including `{` at end of input, `{,`, `{1:`) | index of that character, or `len(s)` |
| object: no `:` after a key | index after the key and whitespace |
| array/object: no `,` (or closing bracket) after an element | index after the element and whitespace |
| trailing comma (`[1,]`, `{"a": 1 ,\n }`) | index of the comma |
| text left after the top-level value and whitespace ("extra data") | index of the first such character |
| string never closed, or input ends right after a backslash | index of the opening quote |
| strict mode: raw character below U+0020 in a string | index of that character |
| backslash followed by a character not in `"\/bfnrtu` | index of the backslash |
| `\u` not followed by four hex digits (fewer characters left, or a non-hex one), including the second `\u` after a high surrogate | index of the `u` |

Checks happen left to right, so the first problem in the text decides the
error. For example `"\u1234` (four hex digits, then end of input) is an
unterminated string at 0, while `"\u123` is an invalid `\u` escape at 2.
A hook that raises a `ValueError` gives that `ValueError`, not a
`JSONDecodeError`.

## Never tested

`dump` and `load` with files, `JSONEncoder`/`JSONDecoder` and the `cls`
argument, `raw_decode` and its `idx` argument, `bytes` input to `loads`,
`str`/`int`/`float`/`dict` subclasses, integers with more than 4300 digits
(either direction), nesting deeper than 20 levels, circular input with
`check_circular=False`, invalid `separators` or `indent` types, error
messages, and the `doc` and `msg` attributes.
