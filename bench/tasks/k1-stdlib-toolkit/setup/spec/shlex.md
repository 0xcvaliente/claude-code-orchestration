# toolkit.shellsplit: a shlex clone

Mirror Python 3.13's `shlex.split`, `shlex.quote` and `shlex.join`.

## API

```python
from toolkit import shellsplit

shellsplit.split(s: str, comments=False, posix=True) -> list[str]   # like shlex.split(s, comments, posix)
shellsplit.quote(s: str) -> str                                      # like shlex.quote(s)
shellsplit.join(split_command: list[str]) -> str                     # like shlex.join(split_command)
```

## Behaviour

`split` must give exactly the tokens of `shlex.split`, which runs the `shlex.shlex` lexer with `whitespace_split=True`, and with `commenters` set to `''` unless `comments=True` (then `#` starts a comment that runs to the end of the line).

- Whitespace is space, tab, `\r` and `\n`.
- Quote characters are `'` and `"`; the escape character is `\`, and inside double quotes only `"` and `\` can be escaped (a backslash before any other character is kept).
- POSIX mode (`posix=True`): quotes are removed, quoted parts join the surrounding word (`a"b c"d` is one token `ab cd`), an empty quoted string gives an empty token, `\` escapes the next character outside single quotes.
- Non-POSIX mode (`posix=False`): quotes are kept in the token, a quoted string ends its token at the closing quote, `\` is an ordinary character, and a comment inside a word behaves exactly as in `shlex` (study the lexer: it differs from POSIX mode).
- Raise `ValueError` where shlex raises it: a missing closing quote (`No closing quotation`) or a trailing escape with nothing after it (`No escaped character`).

`quote` returns `''` for the empty string, the string itself when every character is an ASCII letter, digit or one of `_@%+=:,./-`, and otherwise the string wrapped in single quotes with each `'` written as `'"'"'`. `join` is `' '.join(quote(arg) for arg in split_command)`.

## In scope

POSIX and non-POSIX mode, with and without comments; any mix of words, both quote kinds, escapes inside and outside quotes, comments at the start of the input, between words and inside words, runs of mixed whitespace and newlines, empty input, unbalanced quotes and trailing backslashes. Only the result list (or the `ValueError`) is compared, never the message.

## Not used by the hidden tests

Non-ASCII input; `s=None`; non-`str` arguments to `quote` or non-list arguments to `join`; the `shlex.shlex` class itself, `punctuation_chars`, `wordchars`, `source` inclusion and line numbers.
