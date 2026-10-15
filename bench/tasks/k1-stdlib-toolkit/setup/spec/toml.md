# toolkit.tomlparse: a tomllib clone

Mirror Python 3.13's `tomllib` for TOML 1.0.0 documents (https://toml.io/en/v1.0.0).

## API

```python
from toolkit import tomlparse

tomlparse.loads(s: str) -> dict          # like tomllib.loads(s)
tomlparse.load(fp) -> dict               # like tomllib.load(fp): fp is a binary file object; decode as UTF-8
class tomlparse.TOMLDecodeError(ValueError)   # raised wherever tomllib raises tomllib.TOMLDecodeError
```

`parse_float` is never passed. `TOMLDecodeError` must be a subclass of `ValueError`.

## Result types

| TOML | Python |
|---|---|
| table, inline table | `dict` (keys are `str`) |
| array | `list` |
| string (all four kinds) | `str` |
| integer (decimal, `0x`, `0o`, `0b`, with `_` separators) | `int` |
| float, including `inf`, `+inf`, `-inf`, `nan`, `+nan`, `-nan`, `-0.0` | `float` |
| boolean | `bool` |
| offset date-time | `datetime.datetime` with a fixed-offset `tzinfo` (`Z` means UTC) |
| local date-time | `datetime.datetime` with `tzinfo=None` |
| local date | `datetime.date` |
| local time | `datetime.time` |

Fractional seconds keep at most 6 digits (microseconds); further digits are dropped, not rounded, as in tomllib. Lowercase `t`/`z` and a space instead of `T` are accepted, as in tomllib.

## In scope

All of TOML 1.0:

- Comments, whitespace, blank lines, `\n` and `\r\n` line endings (a `\r\n` is read as `\n` everywhere, including inside strings).
- Bare keys, quoted keys (basic and literal, including the empty key `""`), dotted keys with optional whitespace around the dots.
- Basic strings with every escape (`\b \t \n \f \r \" \\ \uXXXX \UXXXXXXXX`), literal strings, multi-line basic strings (first newline trimmed, line-ending backslash, up to two extra quotes before the closing delimiter), multi-line literal strings.
- Integers, floats (fraction, exponent, underscores, special values), booleans, the four date/time types.
- Arrays (mixed types, nested, multi-line with comments and a trailing comma), inline tables (no newlines, no trailing comma).
- Tables, implicit super-tables, arrays of tables, sub-tables of array elements.

## Errors

Raise `TOMLDecodeError` for every document tomllib rejects. The hidden tests include, among others: duplicate keys; a table declared twice; a key redefined as a table or a table redefined by dotted keys; extending an inline table or a static array (`[a.b]` after `a = {...}`, `[[a]]` after `a = [...]`); mixing `[a]` and `[[a]]`; unterminated or multi-line single-line strings; invalid escapes and non-scalar `\u` values; control characters in strings or comments; leading zeros, misplaced underscores and bad prefixes in numbers; incomplete floats (`.5`, `5.`, `1e`); wrongly cased `inf`/`nan`; impossible dates (`1979-02-30`); missing `=`, values, commas or brackets; two statements on one line; a lone `\r`.

Only the error kind is compared, never the message. Anything other than `TOMLDecodeError` (for example `IndexError` or `KeyError` leaking out) counts as a crash and fails the test.

## Not used by the hidden tests

`parse_float`; non-`str` arguments to `loads`; text-mode files for `load`; invalid UTF-8; integers outside the signed 64-bit range; keys with more parts than the recursion limit; documents nested deeper than 10 levels; error messages and positions.
