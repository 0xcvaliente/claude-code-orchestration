"""toolkit.wrap: reference implementation of the textwrap subset in spec/wrap.md.

Pure Python; imports no blocked module (no textwrap, no re, no string).
"""

__all__ = ["TextWrapper", "wrap", "fill", "shorten", "dedent", "indent"]

_WS = "\t\n\x0b\x0c\r "
_WS_TO_SPACE = {ord(c): ord(" ") for c in _WS}
_DIGITS = "0123456789"
_LOWER = "abcdefghijklmnopqrstuvwxyz"
_ALPHA = _LOWER + _LOWER.upper()


def _is_word(c):
    """Like regex \\w for ASCII: letters, digits, underscore."""
    return c in _ALPHA or c in _DIGITS or c == "_" or (c > "\x7f" and (c.isalnum()))


def _is_letter(c):
    """Like regex [^\\d\\W]: word characters that are not digits."""
    return _is_word(c) and not (c in _DIGITS or (c > "\x7f" and c.isdigit()))


def _is_punct(c):
    return _is_word(c) or c in "!\"'&.,?"


def _split_hyphen(text):
    """Split like textwrap's wordsep_re (break_on_hyphens=True)."""
    n = len(text)
    chunks = []
    pos = 0

    def at(i):
        return text[i] if 0 <= i < n else ""

    def letter(i):
        return 0 <= i < n and _is_letter(text[i])

    while pos < n:
        if text[pos] in _WS:
            end = pos
            while end < n and text[end] in _WS:
                end += 1
            chunks.append(text[pos:end])
            pos = end
            continue
        # em-dash between words: previous char is word punctuation, 2+ dashes, then \w
        if pos > 0 and _is_punct(text[pos - 1]) and at(pos) == "-" and at(pos + 1) == "-":
            end = pos
            while end < n and text[end] == "-":
                end += 1
            if end < n and _is_word(text[end]):
                chunks.append(text[pos:end])
                pos = end
                continue
        # word: shortest run of non-whitespace followed by a break point
        end = pos + 1
        while True:
            # (a) hyphenated word: end consumed chars, next is '-'
            if at(end) == "-":
                p = end + 1  # position after the hyphen
                behind = ((letter(p - 3) and letter(p - 2))
                          or (letter(p - 4) and at(p - 3) == "-" and letter(p - 2)))
                ahead = letter(p) and (letter(p + 1) or (at(p + 1) == "-" and letter(p + 2)))
                if behind and ahead:
                    end = p
                    break
            # (b) end of word
            if end >= n or text[end] in _WS:
                break
            # (c) before an em-dash
            if _is_punct(text[end - 1]) and at(end) == "-" and at(end + 1) == "-":
                k = end
                while k < n and text[k] == "-":
                    k += 1
                if k < n and _is_word(text[k]):
                    break
            end += 1
        chunks.append(text[pos:end])
        pos = end
    return chunks


def _split_simple(text):
    chunks = []
    pos, n = 0, len(text)
    while pos < n:
        end = pos
        ws = text[pos] in _WS
        while end < n and (text[end] in _WS) == ws:
            end += 1
        chunks.append(text[pos:end])
        pos = end
    return chunks


def _sentence_end(chunk):
    n = len(chunk)
    if n >= 1 and chunk[-1] in "\"'":
        n -= 1
    return n >= 2 and chunk[n - 1] in ".!?" and chunk[n - 2] in _LOWER


class TextWrapper:
    def __init__(self, width=70, initial_indent="", subsequent_indent="",
                 expand_tabs=True, replace_whitespace=True,
                 fix_sentence_endings=False, break_long_words=True,
                 drop_whitespace=True, break_on_hyphens=True, tabsize=8,
                 *, max_lines=None, placeholder=" [...]"):
        self.width = width
        self.initial_indent = initial_indent
        self.subsequent_indent = subsequent_indent
        self.expand_tabs = expand_tabs
        self.replace_whitespace = replace_whitespace
        self.fix_sentence_endings = fix_sentence_endings
        self.break_long_words = break_long_words
        self.drop_whitespace = drop_whitespace
        self.break_on_hyphens = break_on_hyphens
        self.tabsize = tabsize
        self.max_lines = max_lines
        self.placeholder = placeholder

    def _chunks(self, text):
        if self.expand_tabs:
            text = text.expandtabs(self.tabsize)
        if self.replace_whitespace:
            text = text.translate(_WS_TO_SPACE)
        if self.break_on_hyphens is True:
            chunks = _split_hyphen(text)
        else:
            chunks = _split_simple(text)
        if self.fix_sentence_endings:
            i = 0
            while i < len(chunks) - 1:
                if chunks[i + 1] == " " and _sentence_end(chunks[i]):
                    chunks[i + 1] = "  "
                    i += 2
                else:
                    i += 1
        return chunks

    def _long_word(self, rev, line, cur, width):
        space = 1 if width < 1 else width - cur
        if self.break_long_words and space > 0:
            end = space
            chunk = rev[-1]
            if self.break_on_hyphens and len(chunk) > space:
                h = chunk.rfind("-", 0, space)
                if h > 0 and any(c != "-" for c in chunk[:h]):
                    end = h + 1
            line.append(chunk[:end])
            rev[-1] = chunk[end:]
        elif not line:
            line.append(rev.pop())

    def _wrap_chunks(self, chunks):
        if self.width <= 0:
            raise ValueError("invalid width %r (must be > 0)" % self.width)
        if self.max_lines is not None:
            ind = self.subsequent_indent if self.max_lines > 1 else self.initial_indent
            if len(ind) + len(self.placeholder.lstrip()) > self.width:
                raise ValueError("placeholder too large for max width")
        lines = []
        rev = chunks[::-1]
        while rev:
            line = []
            cur = 0
            ind = self.subsequent_indent if lines else self.initial_indent
            width = self.width - len(ind)
            if self.drop_whitespace and lines and rev[-1].strip() == "":
                rev.pop()
            while rev and cur + len(rev[-1]) <= width:
                cur += len(rev[-1])
                line.append(rev.pop())
            if rev and len(rev[-1]) > width:
                self._long_word(rev, line, cur, width)
                cur = sum(len(c) for c in line)
            if self.drop_whitespace and line and line[-1].strip() == "":
                cur -= len(line[-1])
                line.pop()
            if not line:
                continue
            rest_blank = (not rev or (self.drop_whitespace and len(rev) == 1
                                      and not rev[0].strip()))
            if (self.max_lines is None or len(lines) + 1 < self.max_lines
                    or (rest_blank and cur <= width)):
                lines.append(ind + "".join(line))
                continue
            while line:
                if line[-1].strip() and cur + len(self.placeholder) <= width:
                    line.append(self.placeholder)
                    lines.append(ind + "".join(line))
                    break
                cur -= len(line[-1])
                line.pop()
            else:
                if lines:
                    prev = lines[-1].rstrip()
                    if len(prev) + len(self.placeholder) <= self.width:
                        lines[-1] = prev + self.placeholder
                        break
                lines.append(ind + self.placeholder.lstrip())
            break
        return lines

    def wrap(self, text):
        return self._wrap_chunks(self._chunks(text))

    def fill(self, text):
        return "\n".join(self.wrap(text))


def wrap(text, width=70, **kwargs):
    return TextWrapper(width=width, **kwargs).wrap(text)


def fill(text, width=70, **kwargs):
    return TextWrapper(width=width, **kwargs).fill(text)


def shorten(text, width, **kwargs):
    w = TextWrapper(width=width, max_lines=1, **kwargs)
    return w.fill(" ".join(text.strip().split()))


def dedent(text):
    lines = text.split("\n")
    lines = ["" if ln and all(c in " \t" for c in ln) else ln for ln in lines]
    margin = None
    for ln in lines:
        k = 0
        while k < len(ln) and ln[k] in " \t":
            k += 1
        if k == len(ln):
            continue  # empty line: no non-blank character after the indent
        ind = ln[:k]
        if margin is None:
            margin = ind
        elif ind.startswith(margin):
            pass
        elif margin.startswith(ind):
            margin = ind
        else:
            for i, (x, y) in enumerate(zip(margin, ind)):
                if x != y:
                    margin = margin[:i]
                    break
    if margin:
        lines = [ln[len(margin):] if ln.startswith(margin) else ln for ln in lines]
    return "\n".join(lines)


def indent(text, prefix, predicate=None):
    if predicate is None:
        def predicate(s):
            return not s.isspace()
    out = []
    for line in text.splitlines(True):
        if predicate(line):
            out.append(prefix)
        out.append(line)
    return "".join(out)
