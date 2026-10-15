# toolkit.regex

A pure-Python regular expression engine in `toolkit/regex.py` that behaves
like the Python 3.13 standard library module `re` for the subset below. The
hidden tests run the same call on `toolkit.regex` and on `re` and compare
the results. The solution may not import `re`, `sre_*` or `_sre`, or any
other module on the blocked list in SPEC.md. A backtracking matcher is fine.

Patterns, subjects and templates in the tests are ASCII strings (`str`,
never `bytes`). Each case gets 2 seconds; the tests contain no
catastrophic-backtracking inputs, and subjects are short (under 40
characters).

## API

Module level (signatures as in `re`; the tests pass `count`, `maxsplit` and
`flags` by keyword):

- `compile(pattern, flags=0) -> Pattern`
- `match(pattern, string, flags=0)`, `fullmatch(...)`, `search(...)`:
  return a `Match` or `None`
- `findall(pattern, string, flags=0) -> list`
- `finditer(pattern, string, flags=0) -> iterator of Match`
- `sub(pattern, repl, string, count=0, flags=0) -> str`
- `subn(pattern, repl, string, count=0, flags=0) -> (str, int)`
- `split(pattern, string, maxsplit=0, flags=0) -> list`
- `escape(string) -> str`: backslash-escapes exactly the characters
  `()[]{}?*+-|^$\.&~#`, space, `\t`, `\n`, `\r`, `\v` and `\f`.
- Flags: `I`/`IGNORECASE` = 2, `M`/`MULTILINE` = 8, `S`/`DOTALL` = 16 (and
  `NOFLAG` = 0). Flags may be combined with `|`.
- `error`: exception class (subclass of `Exception`), also available as
  `PatternError`.

`Pattern` objects:

- `match(string, pos=0, endpos=<len>)`, `fullmatch(...)`, `search(...)`,
  `findall(...)`, `finditer(...)` with the optional `pos` and `endpos`
  positional arguments, `sub(repl, string, count=0)`,
  `subn(repl, string, count=0)`, `split(string, maxsplit=0)`.
- Attributes `pattern` (the source string), `flags` (as `re` reports
  them: the given and inline flags plus `re.UNICODE` = 32, so
  `compile("a").flags == 32` and `compile("(?i)a").flags == 34`),
  `groups` (number of capturing groups), `groupindex` (mapping of group
  name to number; compared as a dict).

`Match` objects:

- `group()`, `group(g)`, `group(g1, g2, ...)` with integer indexes or
  group names; a group that did not participate gives `None`. An index or
  name that does not exist raises `IndexError`.
- `groups(default=None)`, `groupdict(default=None)`.
- `start(g=0)`, `end(g=0)`, `span(g=0)`: -1 / (-1, -1) for a group that did
  not participate.
- `expand(template)`: the template rules of `sub`.
- Attributes `string`, `re` (the Pattern), `pos`, `endpos`, `lastindex`
  (number of the last group that closed, or `None`), `lastgroup` (its name,
  or `None`).

## Semantics to match

- `pos` and `endpos` are clamped to `[0, len(string)]`. Characters at or
  after `endpos` are invisible (the subject behaves as if it ended there);
  characters before `pos` are still visible to lookbehind and `\b`, but
  `^` and `\A` match only at the real start of the string. Tests always
  have `pos <= endpos` after clamping.
- `findall`, `finditer`, `sub`, `subn` and `split` scan left to right. An
  empty match is allowed right after a non-empty match, but never at the
  same position as the previous empty match (so `sub('x*', '-', 'abxd')`
  is `'-a-b--d-'`).
- `findall` returns whole matches when the pattern has no groups, the group
  1 string when it has one, and tuples otherwise; non-participating groups
  become `''`.
- `split` includes all groups' values (`None` for non-participating ones)
  between the pieces. `maxsplit` and `count` of 0 mean no limit.
- `sub` replacement: a string template or a callable taking the `Match`
  and returning a string. Template escapes: `\1`..`\99`, `\g<number>`,
  `\g<name>`, `\g<0>`; `\n`, `\t`, `\r`, `\f`, `\v`, `\a`, `\b`, `\\`, octal
  `\0`, `\0oo`, `\ooo`; a backslash before any other non-letter character
  keeps both characters. Non-participating groups expand to `''`.
- Repetition semantics are those of `re` exactly, including captures: a
  group inside a repetition reports its last iteration, and an iteration
  that matched the empty string ends the repetition (so
  `match('(a?)*', 'aa').groups() == ('',)`).
- IGNORECASE: literals, ranges, classes and backreferences compare
  case-insensitively (for ASCII, a character matches a set if it, its
  lowercase or its uppercase is in the set).
- `\d`, `\w`, `\s` and their negations follow `re`'s default (Unicode)
  definitions restricted to ASCII: `\d` is `0-9`; `\w` is
  `[a-zA-Z0-9_]`; `\s` is the characters for which `str.isspace()` is true,
  which in ASCII is space, `\t\n\v\f\r` and `\x1c`-`\x1f`.
- `.` matches anything but `\n` (anything with DOTALL). `$` matches at the
  end and before a final `\n`; with MULTILINE `^`/`$` also match after/before
  every `\n`. `\A` and `\Z` match only at the very start and end. `\b` and
  `\B` never match in an empty subject.

## Pattern syntax in scope

- Literals and escapes: `\.` etc. for punctuation, `\n \t \r \f \v \a \\`,
  `\xhh`, octal `\0`, `\0o`, `\0oo` and three-digit `\ooo`.
- `.`, character classes `[...]` with ranges, negation `[^...]`, escapes
  and `\d \w \s \D \W \S` inside, `]` first is literal, `-` first or last
  is literal, `[\b]` is backspace.
- `\d \D \w \W \s \S`, anchors `^ $ \A \Z \b \B`.
- Groups: `(...)`, `(?:...)`, `(?P<name>...)`; backreferences `\N` and
  `(?P=name)`.
- Alternation `|`; quantifiers `* + ? {m} {m,} {m,n} {,n}` and their lazy
  forms with `?`. A `{` that does not form a valid quantifier is a literal.
- Lookahead `(?=...)`, `(?!...)`; lookbehind `(?<=...)`, `(?<!...)` whose
  body has a fixed width.
- Inline flags `(?i)`, `(?m)`, `(?s)` and combinations at the start of the
  pattern; scoped flags `(?i:...)`.
- `(?#comment)`.

## Errors

Raise `toolkit.regex.error` wherever `re` raises `re.error` for a pattern
or template in scope, for example: unbalanced parenthesis, missing `)`,
unterminated character set, nothing to repeat (including a quantifier
after an anchor), multiple repeat (`a**`, `a{2}{3}`), bad escape (an
unknown ASCII-letter escape such as `\q`, in or out of a class),
incomplete `\x` escape, octal value above `\377`, bad character range
(`[z-a]`, `[a-\d]`), invalid group reference (including in templates),
reference to an open group, unknown or badly formed group name,
redefinition of a group name, min greater than max in `{m,n}`, look-behind
that is not fixed width, global flags not at the start, unknown extension
or flag, missing `<` or group name in a `\g` template reference.

A template `\g<name>` naming a group that does not exist raises
`IndexError`, as in `re`. Only the exception type is compared, never the
message or position.

## Never tested

VERBOSE, LOCALE, ASCII and UNICODE flags; bytes patterns; non-ASCII
characters or escapes denoting them (`\u`, `\U`, `\N{...}`, `\x80` and up);
possessive quantifiers; atomic groups; conditional groups `(?(1)...)`;
`Pattern.scanner`, `re.purge`, `re.template`, pickling or copying; `Match`
indexing with `m[g]` and `regs`; repetition counts above 1000; `pos >
endpos`; deprecated positional `count`/`maxsplit`/`flags` in the module
functions; `OverflowError`/`ValueError` cases; warning behaviour.
