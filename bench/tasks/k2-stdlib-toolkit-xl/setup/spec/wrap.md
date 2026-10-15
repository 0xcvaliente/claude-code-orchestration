# toolkit.wrap

A pure-Python text wrapper in `toolkit/wrap.py` that behaves like the
Python 3.13 standard library module `textwrap` for the subset below. The
hidden tests run the same calls on `toolkit.wrap` and on `textwrap` and
compare the results. The solution may not import `textwrap`, `re`, `string`,
or any other module on the blocked list in SPEC.md.

All text in the tests is ASCII `str`. Results are compared exactly (lists of
lines, or strings).

## API

- `TextWrapper(width=70, initial_indent="", subsequent_indent="",
  expand_tabs=True, replace_whitespace=True, fix_sentence_endings=False,
  break_long_words=True, drop_whitespace=True, break_on_hyphens=True,
  tabsize=8, *, max_lines=None, placeholder=" [...]")`. Every parameter is
  stored as a public attribute of the same name; the tests may change an
  attribute between calls, and later calls must use the new value.
  Methods: `wrap(text) -> list[str]`, `fill(text) -> str` (the `wrap` lines
  joined with `"\n"`).
- `wrap(text, width=70, **kwargs)`, `fill(text, width=70, **kwargs)`: build
  `TextWrapper(width=width, **kwargs)` and call its method.
- `shorten(text, width, **kwargs)`: collapse whitespace with
  `" ".join(text.strip().split())`, then `fill` it with
  `TextWrapper(width=width, max_lines=1, **kwargs)`.
- `dedent(text) -> str`, `indent(text, prefix, predicate=None) -> str`.

In the tests, boolean options are `True` or `False`, `width`, `tabsize` and
`max_lines` are integers (`max_lines` is `None` or at least 1), and no
`initial_indent` or `subsequent_indent` is longer than `width`
(`textwrap` can loop forever in that situation).

## wrap(text): step 1, whitespace munging

1. If `expand_tabs`: `text = text.expandtabs(tabsize)`.
2. If `replace_whitespace`: each of the six whitespace characters
   `"\t\n\x0b\x0c\r "` becomes one space (`"\t"` only survives to here when
   `expand_tabs` is false).

## Step 2, splitting into chunks

Whitespace below means the six characters `"\t\n\x0b\x0c\r "`. A *word
character* is an ASCII letter, digit or `_`; a *letter* is a word character
that is not a digit (so `_` counts as a letter); *word punctuation* is a word
character or one of `!"'&.,?`.

If `break_on_hyphens is True` (the identity test matters only in theory; the
tests pass booleans), the text is cut into chunks by scanning from position
`p = 0` to the end; at each `p` the first rule that applies produces one
chunk:

1. **Whitespace run**: if `text[p]` is whitespace, the chunk is the maximal
   run of whitespace characters.
2. **Em-dash**: if `p > 0`, `text[p-1]` is word punctuation, and `text[p:]`
   starts with two or more `-` followed (after all of them) by a word
   character, the chunk is that run of dashes.
3. **Word**: otherwise the chunk is the *shortest* run of non-whitespace
   characters `text[p:e]` (with `e >= p + 1`) for which one of these holds,
   checked in this order for `e = p + 1, p + 2, ...`:
   - (a) *hyphen break*: `text[e] == "-"`, and with `q = e + 1` (position
     after that hyphen): either `text[q-3]` and `text[q-2]` are letters, or
     `text[q-4]` is a letter, `text[q-3] == "-"` and `text[q-2]` is a letter
     (these look-behind positions may lie before `p`, in earlier chunks, but
     never before the start of the text); and `text[q]` is a letter followed
     either by a letter or by `-` and a letter. Then the chunk is
     `text[p:q]` (it includes the hyphen).
   - (b) *end of word*: `e` is the end of the text or `text[e]` is
     whitespace. The chunk is `text[p:e]`.
   - (c) *before an em-dash*: `text[e-1]` is word punctuation and `text[e:]`
     starts with two or more `-` followed by a word character. The chunk is
     `text[p:e]`.

   Examples: `"well-known"` gives `"well-"`, `"known"`; `"a-b-c"` stays one
   chunk; `"ab-cd-ef"` gives `"ab-"`, `"cd-"`, `"ef"`; `"x-ray"` stays one
   chunk; `"one--two"` gives `"one"`, `"--"`, `"two"`; `"1-2"` stays one
   chunk.

If `break_on_hyphens` is false, the chunks are simply the maximal runs of
whitespace and of non-whitespace characters, in order.

Empty chunks never occur.

## Step 3, sentence endings

If `fix_sentence_endings`: scan `i` from 0 while `i < len(chunks) - 1`: if
`chunks[i+1] == " "` (exactly one space) and `chunks[i]` ends with a
lowercase ASCII letter, then one of `.!?`, then optionally one `"` or `'`,
replace `chunks[i+1]` with two spaces and advance `i` by 2; otherwise
advance `i` by 1. (So `"Mr."` counts as a sentence end; `"A."` and `"3."` do
not.)

## Step 4, filling lines

Errors are checked first, even for empty text:

- `width <= 0` raises `ValueError`.
- If `max_lines` is not `None`: let `ind` be `subsequent_indent` when
  `max_lines > 1`, else `initial_indent`; if
  `len(ind) + len(placeholder.lstrip()) > width`, raise `ValueError`.

Then, with the chunk list used as a stack (first chunk on top) and an empty
list `lines`, repeat while chunks remain:

1. `indent` is `subsequent_indent` if `lines` is non-empty, else
   `initial_indent`; `avail = width - len(indent)`; `cur` is an empty list,
   `cur_len = 0`.
2. If `drop_whitespace` and `lines` is non-empty and the top chunk is all
   whitespace (`chunk.strip() == ""`), discard it.
3. While chunks remain and `cur_len + len(top) <= avail`, move the top chunk
   to `cur` and add its length.
4. If chunks remain and `len(top) > avail`, handle a long word:
   `space = 1 if avail < 1 else avail - cur_len`. If `break_long_words` and
   `space > 0`: `end = space`; if `break_on_hyphens` and
   `len(top) > space`, let `h = top.rfind("-", 0, space)`; if `h > 0` and
   `top[:h]` contains a character other than `-`, set `end = h + 1`. Move
   `top[:end]` to `cur` and leave `top[end:]` on the stack. Otherwise (no
   breaking possible), if `cur` is empty, move the whole top chunk to `cur`.
   Recompute `cur_len` as the total length of `cur`.
5. If `drop_whitespace` and `cur` is non-empty and its last chunk is all
   whitespace, remove that chunk (and subtract its length).
6. If `cur` is empty, go back to step 1. Otherwise, if `max_lines` is
   `None`, or `len(lines) + 1 < max_lines`, or (the stack is empty, or
   `drop_whitespace` holds and the stack has exactly one chunk which is all
   whitespace) and `cur_len <= avail`: append `indent + "".join(cur)` to
   `lines` and go back to step 1.
7. Otherwise this is the last allowed line and text remains: while `cur` is
   non-empty: if its last chunk is not all whitespace and
   `cur_len + len(placeholder) <= avail`, append `placeholder` to `cur`,
   append `indent + "".join(cur)` to `lines`, and stop; otherwise remove the
   last chunk of `cur` (subtracting its length). If `cur` became empty
   without that happening: if `lines` is non-empty and
   `len(lines[-1].rstrip()) + len(placeholder) <= width`, replace the last
   line by `lines[-1].rstrip() + placeholder`; otherwise append
   `indent + placeholder.lstrip()`. In every case of step 7, stop filling.

`wrap` returns `lines` (`[]` for empty or all-whitespace text when
`drop_whitespace` is true; note a leading whitespace chunk on the first line
is *not* dropped by step 2, only by step 5 if nothing else fits).

## dedent(text)

Work on the lines of `text` split on `"\n"` only (`"\r"` is an ordinary
character here). First, every line that is non-empty and consists only of
spaces and tabs becomes empty. Then the margin is computed over lines that
contain a character other than space and tab: each such line's indent is
its leading run of spaces and tabs. The first indent is the margin; for each
further indent: if it starts with the margin, nothing changes; else if the
margin starts with it, it becomes the margin; else the margin is cut to the
longest common prefix of the two. If the margin is non-empty, remove it from
the start of every line that starts with it. Join the lines with `"\n"`.
(So `"  a\n\tb"` has an empty margin and only whitespace-only lines are
normalized.)

## indent(text, prefix, predicate=None)

Split `text` with `text.splitlines(True)` (keeping line endings; `"\r"`,
`"\r\n"` and `"\n"` all end lines). For each line, emit `prefix` first if
`predicate(line)` is true, then the line. The default predicate is
`not line.isspace()` (so lines of only whitespace, including `"\n"`, get no
prefix). Predicates used in the tests: `lambda line: True`,
`lambda line: False`, `lambda line: line.startswith("#")`,
`lambda line: len(line) > 3`.

## Errors

Only `ValueError` is tested: `width <= 0` and a placeholder that is too
large, both raised by `wrap`/`fill`/`shorten` (and by `TextWrapper.wrap`/
`fill`, not by the constructor). The tests compare only the exception type.

## Out of scope (never tested)

Non-ASCII text (Unicode letters, digits and whitespace), non-boolean values
for the boolean options, `max_lines` below 1, indents longer than `width`,
non-string arguments (`TypeError`), and the private methods and class
attributes of `TextWrapper` (`wordsep_re`, `_split`, `_wrap_chunks`, ...).
