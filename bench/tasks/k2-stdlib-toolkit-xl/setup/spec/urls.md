# toolkit.urls

A pure-Python URL parsing and quoting module in `toolkit/urls.py` that
behaves like the Python 3.13 standard library module `urllib.parse` for the
subset below. The hidden tests run the same call on `toolkit.urls` and on
`urllib.parse` and compare the results. The solution may not import
`urllib` (or any submodule), or any other module on the blocked list in
SPEC.md. Every function here is pure string processing; `ipaddress` is not
needed (the IPv6 rules are spelled out below).

URLs given to the parsing functions are `str`. They are ASCII, except
that percent-encoded UTF-8 appears inside them; the quoting functions also
receive non-ASCII `str` and arbitrary `bytes`, as described per function.

## API

Signatures as in `urllib.parse` (the tests pass the optional arguments by
keyword, except where noted):

- `urlsplit(url, scheme='', allow_fragments=True) -> SplitResult`
- `urlparse(url, scheme='', allow_fragments=True) -> ParseResult`
- `urlunsplit(components) -> str`: `components` is any 5-item iterable
  (list, tuple or a `SplitResult`).
- `urlunparse(components) -> str`: any 6-item iterable.
- `urljoin(base, url, allow_fragments=True) -> str`
- `urldefrag(url) -> DefragResult`
- `quote(string, safe='/', encoding=None, errors=None) -> str`
- `quote_plus(string, safe='', encoding=None, errors=None) -> str`
- `quote_from_bytes(bs, safe='/') -> str`
- `unquote(string, encoding='utf-8', errors='replace') -> str`
- `unquote_plus(string, encoding='utf-8', errors='replace') -> str`
  (`encoding` may be passed positionally)
- `unquote_to_bytes(string) -> bytes`
- `urlencode(query, doseq=False, safe='', encoding=None, errors=None, quote_via=quote_plus) -> str`
- `parse_qs(qs, keep_blank_values=False, strict_parsing=False, encoding='utf-8', errors='replace', max_num_fields=None, separator='&') -> dict`
- `parse_qsl(...)` with the same parameters `-> list` of 2-tuples.

## Result objects

`SplitResult`, `ParseResult` and `DefragResult` are named tuples (`tuple`
subclasses) with the fields `scheme netloc path query fragment`,
`scheme netloc path params query fragment` and `url fragment`. The tests
compare `list(result)`, every field, and `geturl()`:
`SplitResult.geturl()` is `urlunsplit(self)`, `ParseResult.geturl()` is
`urlunparse(self)`, and `DefragResult.geturl()` is `url + '#' + fragment`
when the fragment is non-empty, else `url`.

`SplitResult` and `ParseResult` also have these properties, computed from
`netloc`:

- Split `netloc` at its **last** `@`. With no `@`, `username` and
  `password` are `None`. Otherwise the part before it is the userinfo:
  `username` is the text before its first `:` and `password` is the rest
  (`None` when there is no `:`; `''` when the colon ends the userinfo).
- The host part is what follows the last `@` (all of `netloc` without
  one). If it contains `[`, the hostname is the text after the first `[`
  up to the next `]`, and the port text is whatever follows the first `:`
  after that `]`. Otherwise the hostname is the text before the first `:`
  and the port text is everything after it.
- `hostname`: `None` if that hostname is empty, otherwise the hostname
  lowercased (if it contains `%`, only the part before the first `%` is
  lowercased).
- `port`: `None` if the port text is empty or absent. Otherwise, if the
  port text is all ASCII digits it is converted to `int` (leading zeros
  allowed); if not, reading `port` raises `ValueError`. An int outside
  0..65535 also raises `ValueError`.

## urlsplit

1. Leading characters `\x00`..`\x20` (C0 controls and space) are removed
   from `url`; the `scheme` argument is stripped of them on both sides.
   Then every `\t`, `\r` and `\n` is removed from both, anywhere.
   Trailing spaces in `url` are kept.
2. Scheme: if `url` contains a `:` at index `i > 0`, its first character
   is an ASCII letter, and every character before the `:` is an ASCII
   letter, digit, `+`, `-` or `.`, then `url[:i]` lowercased is the
   scheme and parsing continues after the `:`. Otherwise the `scheme`
   argument is used and nothing is removed (so `localhost:8080/x` has
   scheme `localhost`, and `1http://h` has no scheme and path `1http://h`).
3. Netloc: if the rest starts with `//`, the netloc is everything after
   it up to the first `/`, `?` or `#` (or the end).
4. If `allow_fragments` is true and a `#` remains, the fragment is
   everything after the first `#`. Then the query is everything after the
   first remaining `?`. What is left is the path. With `allow_fragments`
   false a `#` stays in the path or query.

Netloc errors (all `ValueError`):

- `[` without `]` in the netloc, or `]` without `[`.
- When both are present, take the host part (after the last `@`). If it
  contains `[`: any text before the first `[` is an error; text after the
  `]` that does not start with `:` is an error. The bracketed hostname
  (text between the first `[` and the next `]`; for a host part with no
  `[` it is the text before the first `:`) must then be valid:
  - If it starts with `v` or `V` it must be an IPvFuture address: `v`,
    one or more hex digits, `.`, and at least one more character.
  - Otherwise it must be an IPv6 address: eight groups of 1-4 hex digits
    separated by `:`, where one run of groups may be replaced by `::`
    (at most one `::`, standing for at least one group), and the last two
    groups may be written as a dotted IPv4 address (four decimal numbers
    0-255, no leading zeros). A valid IPv4 address in brackets (such as
    `[1.2.3.4]`) is an error, as is anything else.
  - Zone ids (`%` inside brackets) are never tested.

## urlparse

`urlparse` is `urlsplit` plus params: if the scheme is in `uses_params`
and the path contains `;`, then the params are split off the path. When
the path contains `/`, the split is at the first `;` after the last `/`
(no split if there is none); otherwise at the first `;`. Params are what
follows that `;`; the path keeps what precedes it. Else params are `''`.

## urlunsplit and urlunparse

`urlunsplit((scheme, netloc, path, query, fragment))`:

- If `netloc` is non-empty: a non-empty path that does not start with
  `/` gets a `/` prepended, and the result starts `//` + netloc + path.
- Else, if the path starts with `//`, it becomes `//` + path.
- Else, if the scheme is non-empty, in `uses_netloc`, and the path is
  empty or starts with `/`, it becomes `//` + path.
- Then `scheme + ':'` is prepended when the scheme is non-empty, and
  `'?' + query` and `'#' + fragment` are appended when non-empty.

`urlunparse` first appends `';' + params` to the path when params are
non-empty, then calls `urlunsplit`.

## urljoin

`urljoin(base, url, allow_fragments=True)`:

1. If `base` is empty return `url`; if `url` is empty return `base`.
2. Parse `base` with `urlparse(base, '', allow_fragments)` and `url`
   with `urlparse(url, base_scheme, allow_fragments)` (so a relative URL
   inherits the base scheme).
3. If the schemes differ, or the scheme is not in `uses_relative`, return
   `url` unchanged.
4. If the scheme is in `uses_netloc`: if `url` has a netloc, return
   `urlunparse` of the parsed `url`; otherwise use the base netloc. (For a
   scheme not in `uses_netloc` the netloc of `url`, usually empty, is
   kept.)
5. If `url` has neither path nor params: use the base path and params,
   and the base query unless `url` has a query; keep `url`'s fragment;
   return `urlunparse` of that.
6. Otherwise resolve the path: take the base path split on `/` and drop
   its last item unless it is empty. If the `url` path starts with `/`,
   the segments are just the `url` path split on `/`; otherwise they are
   the base items followed by the `url` path items, with empty items
   removed everywhere except the first and last position. Walk the
   segments: `..` removes the last kept segment (ignored when none is
   kept), `.` is skipped, anything else is kept. If the last segment was
   `.` or `..`, append an empty segment. Join with `/` (use `/` if the
   result is empty) and return `urlunparse` of the scheme, netloc, this
   path and `url`'s params, query and fragment.

## urldefrag

If `url` contains `#`: parse it with `urlparse`, and return
`DefragResult(urlunparse(parts with fragment ''), fragment)`. Otherwise
return `DefragResult(url, '')` (the URL unchanged).

## Scheme lists

- `uses_relative`: `''`, `ftp`, `http`, `gopher`, `nntp`, `imap`, `wais`,
  `file`, `https`, `shttp`, `mms`, `prospero`, `rtsp`, `rtsps`, `rtspu`,
  `sftp`, `svn`, `svn+ssh`, `ws`, `wss`.
- `uses_netloc`: `''`, `ftp`, `http`, `gopher`, `nntp`, `telnet`, `imap`,
  `wais`, `file`, `mms`, `https`, `shttp`, `snews`, `prospero`, `rtsp`,
  `rtsps`, `rtspu`, `rsync`, `svn`, `svn+ssh`, `sftp`, `nfs`, `git`,
  `git+ssh`, `ws`, `wss`, `itms-services`.
- `uses_params`: `''`, `ftp`, `hdl`, `prospero`, `http`, `imap`, `https`,
  `shttp`, `rtsp`, `rtsps`, `rtspu`, `sip`, `sips`, `mms`, `sftp`, `tel`.

## Quoting

Always-safe bytes: ASCII letters, digits and `_.-~`.

- `quote_from_bytes(bs, safe='/')`: `bs` must be `bytes` or `bytearray`,
  else `TypeError` (a `str` too). Empty input gives `''`. `safe` is a
  `str` or `bytes`; its non-ASCII characters/bytes are ignored. Every byte
  that is always-safe or in `safe` is kept as its character; every other
  byte becomes `%XX` with uppercase hex.
- `quote(string, safe='/', encoding=None, errors=None)`: a `str` is
  first encoded with `encoding` (default `'utf-8'`) and `errors` (default
  `'strict'`), exactly as `str.encode` does it (so an unencodable
  character with `errors='strict'` raises `UnicodeEncodeError`); the empty
  `str` returns `''`. For a non-`str` input, passing `encoding` or `errors`
  (not `None`) raises `TypeError`; otherwise it goes to
  `quote_from_bytes` (so an `int` raises `TypeError`, and a `bytearray`
  works).
- `quote_plus(string, safe='', encoding=None, errors=None)`: if the
  string (a `str` or `bytes`) has no space, the same as `quote`. Otherwise
  `quote(string, safe + ' ', ...)` (with `b' '` when `safe` is `bytes`)
  and then every space becomes `+`. A `+` in the input is escaped unless
  it is in `safe`.

## Unquoting

- `unquote_to_bytes(string)`: a `str` is encoded to UTF-8 first; `bytes`
  is used as is. Each `%` followed by two hex digits (either case) becomes
  that byte; any other `%` is kept literally. Empty input gives `b''`.
  Returns `bytes`.
- `unquote(string, encoding='utf-8', errors='replace')`: for `bytes`,
  `unquote_to_bytes(string).decode(encoding, errors)`. For a `str` with no
  `%`, the string itself. Otherwise the string is cut into maximal runs of
  ASCII characters and of non-ASCII characters; each ASCII run is
  unquoted to bytes and decoded with `encoding`/`errors` (as
  `bytes.decode` does, so `errors='strict'` raises `UnicodeDecodeError`
  on bad data), and non-ASCII runs are copied unchanged. So `'%C3é%A9'`
  decodes `%C3` and `%A9` separately. An `int` argument raises
  `TypeError`. `None` for `encoding`/`errors` means the defaults.
- `unquote_plus(string, encoding='utf-8', errors='replace')`: replaces
  every `+` with a space and then calls `unquote`. Only `str` is
  accepted: `bytes` raises `TypeError`.

## urlencode

- `query` is a mapping (anything with `items()`, used in its iteration
  order) or a sequence of 2-tuples. Anything else raises `TypeError`:
  that includes a non-empty sequence whose first item is not a `tuple`
  (for example a list of 2-item lists, or a string) and an object with no
  `len()` (an `int`). An empty sequence gives `''`.
- Each key and value is quoted with `quote_via` (default `quote_plus`;
  the tests also pass `quote`): a `bytes` item as `quote_via(item, safe)`,
  anything else as `quote_via(str(item), safe, encoding, errors)`. Pairs
  become `k=v`, joined with `&`.
- With `doseq` true, a value that is not `str` or `bytes` but has a
  `len()` (list, tuple) produces one `k=elt` pair per element (none for an
  empty sequence), each element quoted by the same rule; other values
  (numbers, `None`) are quoted as `str(value)`. With `doseq` false, every
  non-`bytes` value is quoted as `str(value)`, so a list becomes the
  quoted text of its `repr`.

## parse_qsl and parse_qs

`parse_qsl(qs, keep_blank_values=False, strict_parsing=False, encoding='utf-8', errors='replace', max_num_fields=None, separator='&')`:

1. `separator` must be a non-empty `str` or `bytes`, else `ValueError`
   (also for `None` or an `int`).
2. For a `str` query a `bytes` separator is decoded as ASCII. For a
   `bytes` query a `str` separator is encoded as ASCII, and an empty
   query returns `[]`.
3. An empty query returns `[]` (before any other check).
4. If `max_num_fields` is not `None` and `1 + qs.count(separator)` is
   greater than it, raise `ValueError`.
5. Split on `separator`. Skip empty fields unless `strict_parsing`. Split
   each field at its first `=`; with `strict_parsing` a field with no `=`
   (including an empty field) raises `ValueError`. A field with no `=` has
   value `''`. A pair is kept only if its value is non-empty or
   `keep_blank_values` is true.
6. Names and values of `str` queries are decoded with
   `unquote_plus(s, encoding=encoding, errors=errors)`; for `bytes`
   queries, `+` becomes a space and then `unquote_to_bytes` is applied
   (results are `bytes`).

Returns a list of `(name, value)` tuples. `parse_qs` takes the same
arguments and returns a dict mapping each name (in order of first
appearance) to the list of its values.

## Errors

Only the exception kind is compared, never the message:
`UnicodeEncodeError`/`UnicodeDecodeError` (raised by `str.encode` /
`bytes.decode`) count as one kind, other `ValueError`s as another, and
`TypeError` as a third. The cases where these are raised are exactly the
ones named above.

## Never tested

Parsing functions (`urlsplit`, `urlparse`, `urlunsplit`, `urlunparse`,
`urljoin`, `urldefrag`) with `bytes` arguments, and mixing `str` and
`bytes` arguments; non-ASCII characters in URLs given to the parsing
functions (and the NFKC netloc check); zone ids in bracketed hosts; the
`encode()`/`decode()` methods of the results and the `*Bytes` result
classes; `bytearray` passed to `unquote` or `unquote_to_bytes`; `quote_via`
other than `quote`/`quote_plus`; non-ASCII `separator`; deprecated helpers
(`splittype`, `to_bytes`, `unwrap`, ...); caching (`clear_cache`); the
module-level scheme lists themselves (only their effect is tested).
