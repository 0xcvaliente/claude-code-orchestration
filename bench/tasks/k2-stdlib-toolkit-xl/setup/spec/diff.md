# toolkit.diff

A pure-Python sequence differ in `toolkit/diff.py` that behaves like the
Python 3.13 standard library module `difflib` for the subset below. The
hidden tests run the same calls on `toolkit.diff` and on `difflib` and
compare the results. The solution may not import `difflib`, `re`, or any
other module on the blocked list in SPEC.md.

Sequences in the tests are either `str` (compared character by character)
or lists of `str` (compared element by element; usually lines that keep
their `"\n"`). All text is ASCII. Every case runs in under 2 seconds with
the algorithm below; sequences have at most about 260 items.

## API

- `Match`: a named tuple `Match(a, b, size)` (a `tuple` subclass with fields
  `a`, `b`, `size`; `collections.namedtuple` is fine).
- `SequenceMatcher(isjunk=None, a="", b="", autojunk=True)` with methods
  `set_seqs(a, b)`, `set_seq1(a)`, `set_seq2(b)`,
  `find_longest_match(alo=0, ahi=None, blo=0, bhi=None) -> Match`,
  `get_matching_blocks() -> list[Match]`,
  `get_opcodes() -> list[tuple]` (5-tuples `(tag, i1, i2, j1, j2)`),
  `get_grouped_opcodes(n=3)` (an iterable of lists of such 5-tuples),
  `ratio()`, `quick_ratio()`, `real_quick_ratio()` (floats).
- `unified_diff(a, b, fromfile="", tofile="", fromfiledate="",
  tofiledate="", n=3, lineterm="\n")` and `context_diff(...)` with the same
  parameters: generators of output lines.
- `ndiff(a, b, linejunk=None, charjunk=IS_CHARACTER_JUNK)`: generator of
  delta lines.
- `restore(delta, which)`: generator.
- `get_close_matches(word, possibilities, n=3, cutoff=0.6) -> list`.
- `IS_LINE_JUNK(line) -> bool`, `IS_CHARACTER_JUNK(ch, ws=" \t") -> bool`.

The tests compare: Match objects as both `list(m)` and `[m.a, m.b, m.size]`;
opcodes as lists; generators fully consumed into lists; floats exactly (they
come from the formulas below, so compute them the same way).

## SequenceMatcher

### Indexing b (done by the constructor and by `set_seq2`/`set_seqs`)

1. `b2j`: a dict mapping each distinct element of `b` to the ascending list
   of its indices in `b`.
2. Junk: if `isjunk` is given, every distinct element `x` of `b` with
   `isjunk(x)` true is a junk element. Junk elements are removed from `b2j`
   and remembered in the set `bjunk`.
3. Popular elements ("autojunk"): if `autojunk` is true and `len(b) >= 200`,
   every element still in `b2j` whose index list has more than
   `len(b) // 100 + 1` entries is popular and is removed from `b2j`. Popular
   elements are *not* junk: they are not in `bjunk`. Only `b` is examined;
   the length of `a` does not matter.

### find_longest_match(alo, ahi, blo, bhi)

`ahi=None` means `len(a)`, `bhi=None` means `len(b)`. Searches
`a[alo:ahi]` and `b[blo:bhi]`.

1. Core search, using only `b2j` (so junk and popular elements never start
   or continue a core match). Start with `best = (alo, blo, 0)` and an empty
   map `runs`. For `i` from `alo` to `ahi - 1`: build a new map; for each
   index `j` in `b2j.get(a[i], [])` in ascending order, skip `j < blo`, stop
   at `j >= bhi`, set `k = runs.get(j - 1, 0) + 1`, store `new[j] = k`, and
   if `k > best size` set `best = (i - k + 1, j - k + 1, k)`. Then
   `runs = new`. Because only a strictly larger size replaces the best,
   among the longest blocks the one that starts earliest in `a` wins, and
   among those the one that starts earliest in `b`.
2. Extend with non-junk equal neighbours: while `besti > alo`,
   `bestj > blo`, `b[bestj-1]` is not junk and `a[besti-1] == b[bestj-1]`,
   step back (both starts minus 1, size plus 1). Then while
   `besti+size < ahi`, `bestj+size < bhi`, `b[bestj+size]` is not junk and
   `a[besti+size] == b[bestj+size]`, grow size by 1. (This is how popular
   elements adjacent to a core match, or a match found with no core match
   at all from `best = (alo, blo, 0)`, end up inside the result.)
3. Extend with junk equal neighbours: the same two loops again, but
   requiring `b[...]` to be junk (in `bjunk`).
4. Return `Match(besti, bestj, size)` (size 0 when nothing matched; then
   `besti == alo` and `bestj == blo`).

### get_matching_blocks()

Keep a stack, initially `[(0, len(a), 0, len(b))]`. While it is not empty:
pop `(alo, ahi, blo, bhi)`, take `(i, j, k) = find_longest_match(alo, ahi,
blo, bhi)`; if `k > 0`, record the block, then push `(alo, i, blo, j)` if
`alo < i and blo < j`, then push `(i+k, ahi, j+k, bhi)` if `i+k < ahi and
j+k < bhi`. Sort the recorded blocks, merge blocks that are adjacent in both
sequences (`i1 + k1 == i2 and j1 + k1 == j2`) into one, and append the
sentinel `Match(len(a), len(b), 0)`. The result is a list of `Match`.

### get_opcodes()

Walk the matching blocks with `i = j = 0`; for each block `(ai, bj, size)`:
if `i < ai and j < bj` emit `("replace", i, ai, j, bj)`, else if `i < ai`
emit `("delete", i, ai, j, bj)`, else if `j < bj` emit
`("insert", i, ai, j, bj)`; then set `i, j = ai + size, bj + size` and, if
`size > 0`, emit `("equal", ai, i, bj, j)`. Two empty sequences give `[]`.

### get_grouped_opcodes(n=3)

Start from the opcodes; if they are empty use `[("equal", 0, 1, 0, 1)]`. If
the first opcode is `equal`, trim it to its last `n` items
(`i1 = max(i1, i2 - n)`, `j1 = max(j1, j2 - n)`); if the last is `equal`,
trim it to its first `n` items (`i2 = min(i2, i1 + n)`, `j2 = min(j2, j1 +
n)`). Then scan: an `equal` opcode with `i2 - i1 > 2 * n` closes the current
group after appending its first `n` items
`("equal", i1, min(i2, i1+n), j1, min(j2, j1+n))`, and starts the next group
with its last `n` items (`i1 = max(i1, i2-n)`, `j1 = max(j1, j2-n)`); every
other opcode is appended to the current group as is. At the end, the last
group is yielded unless it is empty or consists of a single `equal` opcode.

(In `difflib` this trims the cached opcode list in place, so a later
`get_opcodes()` on the same matcher would see the trimmed version. The tests
never call `get_opcodes()` or `get_grouped_opcodes()` after
`get_grouped_opcodes()` on the same matcher, so either behaviour passes.)

### Ratios

With `T = len(a) + len(b)` and `f(M) = 2.0 * M / T` if `T > 0` else `1.0`:

- `ratio()`: `M` = sum of the sizes of `get_matching_blocks()`.
- `quick_ratio()`: `M` = size of the multiset intersection of `a` and `b`
  (for each element, the smaller of its counts in `a` and in `b`, summed;
  junk is ignored here).
- `real_quick_ratio()`: `M = min(len(a), len(b))`.

### set_seqs / set_seq1 / set_seq2

`set_seq1(a)` replaces `a`; `set_seq2(b)` replaces `b` and re-indexes it
(junk and popular elements are recomputed with the matcher's `isjunk` and
`autojunk`); `set_seqs(a, b)` does both. Later calls use the new sequences.
They return `None`.

### Junk predicates used in the tests

`isjunk` is `None` or one of: `lambda x: x == " "`,
`lambda x: x.strip() == ""`, `lambda x: x in ("a", "e", "i", "o", "u")`,
`lambda x: x.startswith("#")`, or the module's own `IS_LINE_JUNK` /
`IS_CHARACTER_JUNK`. Calls are made by the tests; just call `isjunk(x)` on
each distinct element of `b`.

## unified_diff and context_diff

Both build `SequenceMatcher(None, a, b)` and iterate over
`get_grouped_opcodes(n)`. Nothing at all is produced when there are no
groups (identical inputs, or both empty). Before the first group, two header
lines are produced. For each name/date pair the header text is
`name + ("\t" + date if date else "") + lineterm`.

`unified_diff`:

- Headers: `"--- " + fromfile...`, `"+++ " + tofile...`.
- Each group: `"@@ -R1 +R2 @@" + lineterm`, where R1 is the range of
  `first.i1 .. last.i2` and R2 of `first.j1 .. last.j2` (first and last
  opcode of the group). Range `(start, stop)`: `length = stop - start`; if
  `length == 1` it is `str(start + 1)`; otherwise `"B,L"` with
  `B = start + 1`, minus 1 more when `length == 0`, and `L = length`.
- Then for each opcode: `equal` lines of `a[i1:i2]` prefixed `" "`;
  `replace`/`delete` give `"-" + line` for `a[i1:i2]`; then
  `replace`/`insert` give `"+" + line` for `b[j1:j2]`. Content lines get no
  extra `lineterm`.

`context_diff`:

- Headers: `"*** " + fromfile...`, `"--- " + tofile...`.
- Each group: `"***************" + lineterm`, then
  `"*** R1 ****" + lineterm`; if any opcode in the group is `replace` or
  `delete`, every non-`insert` opcode outputs its `a[i1:i2]` lines with
  prefix `"  "` (equal), `"- "` (delete) or `"! "` (replace). Then
  `"--- R2 ----" + lineterm`; if any opcode is `replace` or `insert`, every
  non-`delete` opcode outputs its `b[j1:j2]` lines with prefix `"  "`,
  `"+ "` (insert) or `"! "` (replace).
- Context range `(start, stop)`: `B = start + 1`, `length = stop - start`;
  if `length == 0` then `B -= 1`; if `length <= 1` the range is `str(B)`,
  otherwise `"B,E"` with `E = B + length - 1`.

Arguments in the tests always have valid types (no `TypeError` cases).
`n` is a non-negative integer.

## ndiff

`ndiff(a, b, linejunk, charjunk)` compares two lists of lines. In the tests
`linejunk` is `None` or the module's `IS_LINE_JUNK`, and `charjunk` is the
module's `IS_CHARACTER_JUNK` (the default) or `None`.

Build `SequenceMatcher(linejunk, a, b)` (autojunk on) and walk its opcodes:
`equal` lines become `"  " + line`, `delete` lines `"- " + line`, `insert`
lines `"+ " + line`, and a `replace` block `a[alo:ahi]`, `b[blo:bhi]` goes
through *fancy replace*:

1. `best = 0.74`, `cutoff = 0.75`; a matcher `cm = SequenceMatcher(charjunk)`.
   For `j` in `blo..bhi-1` (outer loop; `cm.set_seq2(b[j])`) and `i` in
   `alo..ahi-1` (inner loop): if `a[i] == b[j]`, remember the first such
   pair `(eqi, eqj)` and skip it; otherwise `cm.set_seq1(a[i])` and if
   `real_quick_ratio() > best`, `quick_ratio() > best` and `ratio() > best`
   (checked in this order) set `best = ratio()` and the best pair to
   `(i, j)`.
2. If `best < cutoff`: when no identical pair was seen, emit a *plain
   replace* and stop: if `bhi - blo < ahi - alo` all `"+ "` lines of
   `b[blo:bhi]` then all `"- "` lines of `a[alo:ahi]`, else the `"- "`
   lines first, then the `"+ "` lines. Otherwise use the identical pair
   `(eqi, eqj)` as the synch point. If `best >= cutoff`, the best pair is
   the synch point (and any identical pair is ignored).
3. Recursively handle the part before the synch point,
   `a[alo:i]` vs `b[blo:j]` (the *helper*: both non-empty means fancy
   replace again; only `a` non-empty gives `"- "` lines; only `b` non-empty
   gives `"+ "` lines; both empty gives nothing).
4. Synch pair: if it is an identical pair, emit `"  " + a[i]`. Otherwise run
   `cm.set_seqs(a[i], b[j])` and walk `cm.get_opcodes()` building two tag
   strings: `replace` adds `"^"` per character to both, `delete` adds `"-"`
   to the a-tags, `insert` adds `"+"` to the b-tags, `equal` adds `" "` to
   both. In each tag string, a `" "` tag whose character of the line (by
   position) is whitespace (`str.isspace`) is replaced by that character;
   then the tag string is right-stripped. Emit `"- " + a[i]`, then
   `"? " + atags + "\n"` if atags is non-empty, then `"+ " + b[j]`, then
   `"? " + btags + "\n"` if btags is non-empty.
5. Recursively handle the part after the synch point,
   `a[i+1:ahi]` vs `b[j+1:bhi]`, with the helper.

## restore(delta, which)

`which` is converted with `int()`; 1 selects prefix `"- "`, 2 selects
`"+ "`; any other value raises `ValueError` (when the generator is first
advanced). Yields `line[2:]` for every line of `delta` whose first two
characters are `"  "` or the selected prefix.

## get_close_matches(word, possibilities, n=3, cutoff=0.6)

Raises `ValueError` if `n <= 0`, or if `cutoff` is not in `[0.0, 1.0]`
(checked in that order, before anything else). Otherwise, with a matcher
whose `b` is `word` and whose `a` is set to each possibility in turn (no
junk, autojunk on), keep `(ratio, x)` for each `x` whose
`real_quick_ratio()`, `quick_ratio()` and `ratio()` are all `>= cutoff`.
Return the `x` of the `n` largest pairs, largest first (pairs compare as
tuples, so equal ratios are ordered by the larger string first).

## IS_LINE_JUNK and IS_CHARACTER_JUNK

- `IS_LINE_JUNK(line)`: true when the line is only whitespace, or optional
  whitespace, one `"#"`, and optional whitespace (whitespace: characters
  with `str.isspace()`). So `"\n"`, `"  #  \n"` and `""` are junk; `"##\n"`
  and `"x\n"` are not.
- `IS_CHARACTER_JUNK(ch, ws=" \t")`: `ch in ws` (space or tab by default;
  so `"\n"` is not junk, and `""` is, since `"" in " \t"`).

## Errors

Only `ValueError` is tested: `get_close_matches` with a bad `n` or `cutoff`,
and `restore` with a bad `which`. The tests compare only the exception
type.

## Out of scope (never tested)

`HtmlDiff`, `Differ` (as a class; `ndiff` is tested), `diff_bytes`,
`_mdiff`, custom `linejunk`/`charjunk` functions in `ndiff` other than those
listed above, the `bjunk`/`bpopular`/`b2j` attributes, `TypeError` checks
on argument types, bytes input, non-ASCII text, and calling `get_opcodes`
or `get_grouped_opcodes` after `get_grouped_opcodes` on the same matcher
without resetting a sequence.
