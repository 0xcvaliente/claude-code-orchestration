"""Reference implementation of toolkit.regex: a backtracking engine that
mirrors the observable behaviour of the standard library's `re` module for
the subset described in spec/regex.md.  Pure Python, imports nothing on the
blocked list."""

import sys

if sys.getrecursionlimit() < 20000:
    sys.setrecursionlimit(20000)

__all__ = [
    "compile", "match", "search", "fullmatch", "findall", "finditer",
    "sub", "subn", "split", "escape", "error", "PatternError", "Pattern",
    "Match", "I", "IGNORECASE", "M", "MULTILINE", "S", "DOTALL", "NOFLAG",
]

NOFLAG = 0
I = IGNORECASE = 2
M = MULTILINE = 8
S = DOTALL = 16
_FLAG_X = 64
_FLAG_U = 32
_FLAG_A = 256
_FLAG_L = 4
_FLAG_DEBUG = 128

MAXREPEAT = 4294967295
_MAXWIDTH = 1 << 64
_MAXGROUPS = 2147483647 // 2


class error(Exception):
    """Raised for an invalid pattern or replacement template."""

    def __init__(self, msg, pattern=None, pos=None):
        self.msg = msg
        self.pattern = pattern
        self.pos = pos
        if pattern is not None and pos is not None:
            msg = "%s at position %d" % (msg, pos)
        super().__init__(msg)


PatternError = error

_SPECIAL_CHARS = ".\\[{()*+?^$|"
_REPEAT_CHARS = "*+?{"
_DIGITS = frozenset("0123456789")
_OCTDIGITS = frozenset("01234567")
_HEXDIGITS = frozenset("0123456789abcdefABCDEF")
_ASCIILETTERS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
_WHITESPACE = frozenset(" \t\n\r\v\f")

_ESCAPES = {
    "\\a": ("LIT", 7), "\\b": ("LIT", 8), "\\f": ("LIT", 12),
    "\\n": ("LIT", 10), "\\r": ("LIT", 13), "\\t": ("LIT", 9),
    "\\v": ("LIT", 11), "\\\\": ("LIT", 92),
}
_CATEGORIES = {
    "\\A": ("AT", "BEG_STR"), "\\b": ("AT", "BOUND"), "\\B": ("AT", "NBOUND"),
    "\\Z": ("AT", "END_STR"),
    "\\d": ("IN", [("CAT", "d")]), "\\D": ("IN", [("CAT", "D")]),
    "\\s": ("IN", [("CAT", "s")]), "\\S": ("IN", [("CAT", "S")]),
    "\\w": ("IN", [("CAT", "w")]), "\\W": ("IN", [("CAT", "W")]),
}
_FLAGCHARS = {"i": 2, "L": 4, "m": 8, "s": 16, "x": 64, "a": 256, "u": 32}
_TYPE_FLAGS = _FLAG_A | _FLAG_L | _FLAG_U
_REPEAT_OPS = ("MAX_REP", "MIN_REP", "POSS_REP")
_UNIT_OPS = ("ANY", "IN", "LIT", "NOT_LIT")


# ---------------------------------------------------------------- tokenizer

class _Source:
    def __init__(self, string):
        self.string = string
        self.index = 0
        self.next = None
        self._advance()

    def _advance(self):
        index = self.index
        if index >= len(self.string):
            self.next = None
            return
        char = self.string[index]
        if char == "\\":
            index += 1
            if index >= len(self.string):
                raise error("bad escape (end of pattern)", self.string,
                            len(self.string) - 1)
            char += self.string[index]
        self.index = index + 1
        self.next = char

    def match(self, char):
        if char == self.next:
            self._advance()
            return True
        return False

    def get(self):
        this = self.next
        self._advance()
        return this

    def getwhile(self, n, charset):
        result = ""
        for _ in range(n):
            c = self.next
            if c not in charset:
                break
            result += c
            self._advance()
        return result

    def getuntil(self, terminator, name):
        result = ""
        while True:
            c = self.next
            self._advance()
            if c is None:
                if not result:
                    raise self.error("missing " + name)
                raise self.error("missing %s, unterminated name" % terminator,
                                 len(result))
            if c == terminator:
                if not result:
                    raise self.error("missing " + name, 1)
                break
            result += c
        return result

    def tell(self):
        return self.index - len(self.next or "")

    def seek(self, index):
        self.index = index
        self._advance()

    def error(self, msg, offset=0):
        return error(msg, self.string, self.tell() - offset)

    def checkgroupname(self, name, offset):
        if not name.isidentifier():
            raise self.error("bad character in group name %r" % name,
                             len(name) + offset)


# ------------------------------------------------------------------- parser

class _State:
    def __init__(self):
        self.flags = 0
        self.groupdict = {}
        self.groupwidths = [None]
        self.lookbehindgroups = None
        self.grouprefpos = {}

    @property
    def groups(self):
        return len(self.groupwidths)

    def opengroup(self, name=None):
        gid = self.groups
        self.groupwidths.append(None)
        if name is not None:
            ogid = self.groupdict.get(name)
            if ogid is not None:
                raise error("redefinition of group name %r as group %d; "
                            "was group %d" % (name, gid, ogid))
            self.groupdict[name] = gid
        return gid

    def closegroup(self, gid, p):
        self.groupwidths[gid] = _width(p, self)

    def checkgroup(self, gid):
        return gid < self.groups and self.groupwidths[gid] is not None

    def checklookbehindgroup(self, gid, source):
        if self.lookbehindgroups is not None:
            if not self.checkgroup(gid):
                raise source.error("cannot refer to an open group")
            if gid >= self.lookbehindgroups:
                raise source.error("cannot refer to group defined in the same "
                                   "lookbehind subpattern")


def _width(seq, state):
    lo = hi = 0
    for node in seq:
        op = node[0]
        if op == "BRANCH":
            i, j = _MAXWIDTH, 0
            for alt in node[1]:
                l, h = _width(alt, state)
                i = min(i, l)
                j = max(j, h)
            lo += i
            hi += j
        elif op == "ATOMIC":
            i, j = _width(node[1], state)
            lo += i
            hi += j
        elif op == "SUB":
            i, j = _width(node[4], state)
            lo += i
            hi += j
        elif op in _REPEAT_OPS:
            i, j = _width(node[3], state)
            lo += i * node[1]
            if node[2] == MAXREPEAT and j:
                hi = _MAXWIDTH
            else:
                hi += j * node[2]
        elif op in _UNIT_OPS:
            lo += 1
            hi += 1
        elif op == "GROUPREF":
            i, j = state.groupwidths[node[1]]
            lo += i
            hi += j
        elif op == "GROUPREF_EXISTS":
            i, j = _width(node[2], state)
            if node[3] is not None:
                l, h = _width(node[3], state)
                i = min(i, l)
                j = max(j, h)
            else:
                i = 0
            lo += i
            hi += j
    return min(lo, _MAXWIDTH), min(hi, _MAXWIDTH)


def _class_escape(source, escape):
    code = _ESCAPES.get(escape)
    if code:
        return code
    code = _CATEGORIES.get(escape)
    if code and code[0] == "IN":
        return code
    c = escape[1:2]
    if c == "x":
        escape += source.getwhile(2, _HEXDIGITS)
        if len(escape) != 4:
            raise source.error("incomplete escape %s" % escape, len(escape))
        return ("LIT", int(escape[2:], 16))
    elif c == "u":
        escape += source.getwhile(4, _HEXDIGITS)
        if len(escape) != 6:
            raise source.error("incomplete escape %s" % escape, len(escape))
        return ("LIT", int(escape[2:], 16))
    elif c == "U":
        escape += source.getwhile(8, _HEXDIGITS)
        if len(escape) != 10:
            raise source.error("incomplete escape %s" % escape, len(escape))
        v = int(escape[2:], 16)
        if v > 0x10FFFF:
            raise source.error("bad escape %s" % escape, len(escape))
        return ("LIT", v)
    elif c in _OCTDIGITS:
        escape += source.getwhile(2, _OCTDIGITS)
        v = int(escape[1:], 8)
        if v > 0o377:
            raise source.error("octal escape value %s outside of range 0-0o377"
                               % escape, len(escape))
        return ("LIT", v)
    elif c in _DIGITS:
        raise source.error("bad escape %s" % escape, len(escape))
    if len(escape) == 2:
        if c in _ASCIILETTERS:
            raise source.error("bad escape %s" % escape, len(escape))
        return ("LIT", ord(escape[1]))
    raise source.error("bad escape %s" % escape, len(escape))


def _escape(source, escape, state):
    code = _CATEGORIES.get(escape)
    if code:
        return code
    code = _ESCAPES.get(escape)
    if code:
        return code
    c = escape[1:2]
    if c in "xuU":
        return _class_escape(source, escape)
    elif c == "0":
        escape += source.getwhile(2, _OCTDIGITS)
        return ("LIT", int(escape[1:], 8))
    elif c in _DIGITS:
        if source.next in _DIGITS:
            escape += source.get()
            if (escape[1] in _OCTDIGITS and escape[2] in _OCTDIGITS and
                    source.next in _OCTDIGITS):
                escape += source.get()
                v = int(escape[1:], 8)
                if v > 0o377:
                    raise source.error("octal escape value %s outside of "
                                       "range 0-0o377" % escape, len(escape))
                return ("LIT", v)
        group = int(escape[1:])
        if group < state.groups:
            if not state.checkgroup(group):
                raise source.error("cannot refer to an open group", len(escape))
            state.checklookbehindgroup(group, source)
            return ("GROUPREF", group)
        raise source.error("invalid group reference %d" % group, len(escape) - 1)
    if len(escape) == 2:
        if c in _ASCIILETTERS:
            raise source.error("bad escape %s" % escape, len(escape))
        return ("LIT", ord(escape[1]))
    raise source.error("bad escape %s" % escape, len(escape))


def _parse_sub(source, state, verbose, nested):
    items = []
    while True:
        items.append(_parse(source, state, verbose, nested + 1,
                            not nested and not items))
        if not source.match("|"):
            break
        if not nested:
            verbose = state.flags & _FLAG_X
    if len(items) == 1:
        return items[0]
    return [("BRANCH", items)]


def _parse(source, state, verbose, nested, first=False):
    sub = []
    while True:
        this = source.next
        if this is None or this in "|)":
            break
        source.get()
        if verbose:
            if this in _WHITESPACE:
                continue
            if this == "#":
                while True:
                    this = source.get()
                    if this is None or this == "\n":
                        break
                continue

        if this[0] == "\\":
            sub.append(_escape(source, this, state))

        elif this not in _SPECIAL_CHARS:
            sub.append(("LIT", ord(this)))

        elif this == "[":
            here = source.tell() - 1
            items = []
            negate = source.match("^")
            while True:
                this = source.get()
                if this is None:
                    raise source.error("unterminated character set",
                                       source.tell() - here)
                if this == "]" and items:
                    break
                elif this[0] == "\\":
                    code1 = _class_escape(source, this)
                else:
                    code1 = ("LIT", ord(this))
                if source.match("-"):
                    that = source.get()
                    if that is None:
                        raise source.error("unterminated character set",
                                           source.tell() - here)
                    if that == "]":
                        if code1[0] == "IN":
                            code1 = code1[1][0]
                        items.append(code1)
                        items.append(("LIT", ord("-")))
                        break
                    if that[0] == "\\":
                        code2 = _class_escape(source, that)
                    else:
                        code2 = ("LIT", ord(that))
                    if code1[0] != "LIT" or code2[0] != "LIT":
                        raise source.error("bad character range %s-%s" % (this, that),
                                           len(this) + 1 + len(that))
                    lo, hi = code1[1], code2[1]
                    if hi < lo:
                        raise source.error("bad character range %s-%s" % (this, that),
                                           len(this) + 1 + len(that))
                    items.append(("RANGE", lo, hi))
                else:
                    if code1[0] == "IN":
                        code1 = code1[1][0]
                    items.append(code1)
            if len(items) == 1 and items[0][0] == "LIT":
                if negate:
                    sub.append(("NOT_LIT", items[0][1]))
                else:
                    sub.append(items[0])
            else:
                sub.append(("IN", negate, items))

        elif this in _REPEAT_CHARS:
            here = source.tell()
            if this == "?":
                mn, mx = 0, 1
            elif this == "*":
                mn, mx = 0, MAXREPEAT
            elif this == "+":
                mn, mx = 1, MAXREPEAT
            else:  # "{"
                if source.next == "}":
                    sub.append(("LIT", ord(this)))
                    continue
                mn, mx = 0, MAXREPEAT
                lo = hi = ""
                while source.next in _DIGITS:
                    lo += source.get()
                if source.match(","):
                    while source.next in _DIGITS:
                        hi += source.get()
                else:
                    hi = lo
                if not source.match("}"):
                    sub.append(("LIT", ord(this)))
                    source.seek(here)
                    continue
                if lo:
                    mn = int(lo)
                    if mn >= MAXREPEAT:
                        raise OverflowError("the repetition number is too large")
                if hi:
                    mx = int(hi)
                    if mx >= MAXREPEAT:
                        raise OverflowError("the repetition number is too large")
                    if mx < mn:
                        raise source.error("min repeat greater than max repeat",
                                           source.tell() - here)
            item = sub[-1] if sub else None
            if item is None or item[0] == "AT":
                raise source.error("nothing to repeat",
                                   source.tell() - here + len(this))
            if item[0] in _REPEAT_OPS:
                raise source.error("multiple repeat",
                                   source.tell() - here + len(this))
            if item[0] == "SUB" and item[1] is None and not item[2] and not item[3]:
                body = item[4]
            else:
                body = [item]
            if source.match("?"):
                sub[-1] = ("MIN_REP", mn, mx, body)
            elif source.match("+"):
                sub[-1] = ("POSS_REP", mn, mx, body)
            else:
                sub[-1] = ("MAX_REP", mn, mx, body)

        elif this == ".":
            sub.append(("ANY",))

        elif this == "(":
            start = source.tell() - 1
            capture = True
            atomic = False
            name = None
            add_flags = del_flags = 0
            if source.match("?"):
                char = source.get()
                if char is None:
                    raise source.error("unexpected end of pattern")
                if char == "P":
                    if source.match("<"):
                        name = source.getuntil(">", "group name")
                        source.checkgroupname(name, 1)
                    elif source.match("="):
                        name = source.getuntil(")", "group name")
                        source.checkgroupname(name, 1)
                        gid = state.groupdict.get(name)
                        if gid is None:
                            raise source.error("unknown group name %r" % name,
                                               len(name) + 1)
                        if not state.checkgroup(gid):
                            raise source.error("cannot refer to an open group",
                                               len(name) + 1)
                        state.checklookbehindgroup(gid, source)
                        sub.append(("GROUPREF", gid))
                        continue
                    else:
                        char = source.get()
                        if char is None:
                            raise source.error("unexpected end of pattern")
                        raise source.error("unknown extension ?P" + char,
                                           len(char) + 2)
                elif char == ":":
                    capture = False
                elif char == "#":
                    while True:
                        if source.next is None:
                            raise source.error("missing ), unterminated comment",
                                               source.tell() - start)
                        if source.get() == ")":
                            break
                    continue
                elif char in "=!<":
                    direction = 1
                    lookbehindgroups = None
                    if char == "<":
                        char = source.get()
                        if char is None:
                            raise source.error("unexpected end of pattern")
                        if char not in "=!":
                            raise source.error("unknown extension ?<" + char,
                                               len(char) + 2)
                        direction = -1
                        lookbehindgroups = state.lookbehindgroups
                        if lookbehindgroups is None:
                            state.lookbehindgroups = state.groups
                    p = _parse_sub(source, state, verbose, nested + 1)
                    if direction < 0 and lookbehindgroups is None:
                        state.lookbehindgroups = None
                    if not source.match(")"):
                        raise source.error("missing ), unterminated subpattern",
                                           source.tell() - start)
                    if char == "=":
                        sub.append(("ASSERT", direction, p))
                    elif p:
                        sub.append(("ASSERT_NOT", direction, p))
                    else:
                        sub.append(("FAILURE",))
                    continue
                elif char == "(":
                    condname = source.getuntil(")", "group name")
                    if not (condname.isdecimal() and condname.isascii()):
                        source.checkgroupname(condname, 1)
                        condgroup = state.groupdict.get(condname)
                        if condgroup is None:
                            raise source.error("unknown group name %r" % condname,
                                               len(condname) + 1)
                    else:
                        condgroup = int(condname)
                        if not condgroup:
                            raise source.error("bad group number", len(condname) + 1)
                        if condgroup >= _MAXGROUPS:
                            raise source.error("invalid group reference %d" % condgroup,
                                               len(condname) + 1)
                        if condgroup not in state.grouprefpos:
                            state.grouprefpos[condgroup] = (
                                source.tell() - len(condname) - 1)
                    state.checklookbehindgroup(condgroup, source)
                    item_yes = _parse(source, state, verbose, nested + 1)
                    if source.match("|"):
                        item_no = _parse(source, state, verbose, nested + 1)
                        if source.next == "|":
                            raise source.error(
                                "conditional backref with more than two branches")
                    else:
                        item_no = None
                    if not source.match(")"):
                        raise source.error("missing ), unterminated subpattern",
                                           source.tell() - start)
                    sub.append(("GROUPREF_EXISTS", condgroup, item_yes, item_no))
                    continue
                elif char == ">":
                    capture = False
                    atomic = True
                elif char in _FLAGCHARS or char == "-":
                    flags = _parse_flags(source, state, char)
                    if flags is None:
                        if not first or sub:
                            raise source.error("global flags not at the start "
                                               "of the expression",
                                               source.tell() - start)
                        verbose = state.flags & _FLAG_X
                        continue
                    add_flags, del_flags = flags
                    capture = False
                else:
                    raise source.error("unknown extension ?" + char, len(char) + 1)

            if capture:
                try:
                    group = state.opengroup(name)
                except error as err:
                    raise source.error(err.msg, len(name) + 1) from None
            else:
                group = None
            sub_verbose = ((verbose or (add_flags & _FLAG_X)) and
                           not (del_flags & _FLAG_X))
            p = _parse_sub(source, state, sub_verbose, nested + 1)
            if not source.match(")"):
                raise source.error("missing ), unterminated subpattern",
                                   source.tell() - start)
            if group is not None:
                state.closegroup(group, p)
            if atomic:
                sub.append(("ATOMIC", p))
            else:
                sub.append(("SUB", group, add_flags, del_flags, p))

        elif this == "^":
            sub.append(("AT", "BEG"))

        elif this == "$":
            sub.append(("AT", "END"))

    return sub


def _parse_flags(source, state, char):
    add_flags = del_flags = 0
    if char != "-":
        while True:
            flag = _FLAGCHARS[char]
            if char == "L":
                raise source.error("bad inline flags: cannot use 'L' flag "
                                   "with a str pattern")
            add_flags |= flag
            if (flag & _TYPE_FLAGS) and (add_flags & _TYPE_FLAGS) != flag:
                raise source.error("bad inline flags: flags 'a', 'u' and 'L' "
                                   "are incompatible")
            char = source.get()
            if char is None:
                raise source.error("missing -, : or )")
            if char in ")-:":
                break
            if char not in _FLAGCHARS:
                msg = "unknown flag" if char.isalpha() else "missing -, : or )"
                raise source.error(msg, len(char))
    if char == ")":
        state.flags |= add_flags
        return None
    if char == "-":
        char = source.get()
        if char is None:
            raise source.error("missing flag")
        if char not in _FLAGCHARS:
            msg = "unknown flag" if char.isalpha() else "missing flag"
            raise source.error(msg, len(char))
        while True:
            flag = _FLAGCHARS[char]
            if flag & _TYPE_FLAGS:
                raise source.error("bad inline flags: cannot turn off flags "
                                   "'a', 'u' and 'L'")
            del_flags |= flag
            char = source.get()
            if char is None:
                raise source.error("missing :")
            if char == ":":
                break
            if char not in _FLAGCHARS:
                msg = "unknown flag" if char.isalpha() else "missing :"
                raise source.error(msg, len(char))
    if add_flags & del_flags:
        raise source.error("bad inline flags: flag turned on and off", 1)
    return add_flags, del_flags


def _parse_pattern(pattern, flags):
    source = _Source(pattern)
    state = _State()
    state.flags = flags
    p = _parse_sub(source, state, flags & _FLAG_X, 0)
    f = state.flags
    if f & _FLAG_L:
        raise ValueError("cannot use LOCALE flag with a str pattern")
    if not f & _FLAG_A:
        f |= _FLAG_U
    elif f & _FLAG_U:
        raise ValueError("ASCII and UNICODE flags are incompatible")
    state.flags = f
    if source.next is not None:
        raise source.error("unbalanced parenthesis")
    for g in state.grouprefpos:
        if g >= state.groups:
            raise error("invalid group reference %d" % g, pattern,
                        state.grouprefpos[g])
    return p, state


# ----------------------------------------------------------------- compiler

def _is_word(ch):
    return ch.isalnum() or ch == "_"


_CAT_PRED = {
    "d": lambda ch: ch.isdecimal(),
    "D": lambda ch: not ch.isdecimal(),
    "s": lambda ch: ch.isspace(),
    "S": lambda ch: not ch.isspace(),
    "w": _is_word,
    "W": lambda ch: not _is_word(ch),
}


def _set_pred(negate, items, ignore):
    lits = set()
    ranges = []
    cats = []
    for it in items:
        if it[0] == "LIT":
            lits.add(chr(it[1]))
        elif it[0] == "RANGE":
            ranges.append((chr(it[1]), chr(it[2])))
        else:
            cats.append(_CAT_PRED[it[1]])

    def inset(ch):
        if ch in lits:
            return True
        for lo, hi in ranges:
            if lo <= ch <= hi:
                return True
        for p in cats:
            if p(ch):
                return True
        return False

    if ignore:
        def member(ch):
            return inset(ch) or inset(ch.lower()) or inset(ch.upper())
    else:
        member = inset
    if negate:
        return lambda ch: not member(ch)
    return member


def _unit_pred(node, flags):
    op = node[0]
    ignore = flags & IGNORECASE
    if op == "LIT":
        c = chr(node[1])
        if ignore:
            lc = c.lower()
            return lambda ch: ch.lower() == lc
        return lambda ch: ch == c
    if op == "NOT_LIT":
        c = chr(node[1])
        if ignore:
            lc = c.lower()
            return lambda ch: ch.lower() != lc
        return lambda ch: ch != c
    if op == "ANY":
        if flags & DOTALL:
            return lambda ch: True
        return lambda ch: ch != "\n"
    if op == "IN":
        if len(node) == 2:  # category escape outside a set
            return _set_pred(False, node[1], ignore)
        return _set_pred(node[1], node[2], ignore)
    raise AssertionError(op)


def _at_pred(kind, flags):
    multiline = flags & MULTILINE
    if kind == "BEG":
        if multiline:
            return lambda s, i: i == 0 or s[i - 1] == "\n"
        return lambda s, i: i == 0
    if kind == "BEG_STR":
        return lambda s, i: i == 0
    if kind == "END":
        if multiline:
            return lambda s, i: i == len(s) or s[i] == "\n"
        return lambda s, i: i == len(s) or (i + 1 == len(s) and s[i] == "\n")
    if kind == "END_STR":
        return lambda s, i: i == len(s)
    if kind in ("BOUND", "NBOUND"):
        want = kind == "BOUND"

        def bound(s, i):
            if not s:
                return False
            that = i > 0 and _is_word(s[i - 1])
            this = i < len(s) and _is_word(s[i])
            return (this != that) == want
        return bound
    raise AssertionError(kind)


def _setgroup(c, g, a, b):
    lst = list(c)
    lst[0] = g
    lst[2 * g] = a
    lst[2 * g + 1] = b
    return tuple(lst)


def _empty(s, i, c, k):
    return k(i, c)


def _compile_seq(seq, flags):
    ms = [_compile_node(node, flags) for node in seq]
    if not ms:
        return _empty
    m = ms[-1]
    for prev in reversed(ms[:-1]):
        m = _cat(prev, m)
    return m


def _cat(m1, m2):
    def m(s, i, c, k):
        return m1(s, i, c, lambda j, c2: m2(s, j, c2, k))
    return m


def _compile_node(node, flags):
    op = node[0]
    if op in _UNIT_OPS:
        pred = _unit_pred(node, flags)

        def unit(s, i, c, k):
            if i < len(s) and pred(s[i]):
                return k(i + 1, c)
            return None
        return unit

    if op == "AT":
        at = _at_pred(node[1], flags)

        def anchor(s, i, c, k):
            if at(s, i):
                return k(i, c)
            return None
        return anchor

    if op == "BRANCH":
        alts = [_compile_seq(alt, flags) for alt in node[1]]

        def branch(s, i, c, k):
            for a in alts:
                r = a(s, i, c, k)
                if r is not None:
                    return r
            return None
        return branch

    if op == "SUB":
        gid, add, rem = node[1], node[2], node[3]
        body = _compile_seq(node[4], (flags | add) & ~rem)
        if gid is None:
            return body

        def group(s, i, c, k):
            return body(s, i, c, lambda j, c2: k(j, _setgroup(c2, gid, i, j)))
        return group

    if op in _REPEAT_OPS:
        return _compile_repeat(node, flags)

    if op == "ATOMIC":
        body = _compile_seq(node[1], flags)

        def atomic(s, i, c, k):
            r = body(s, i, c, lambda j, c2: (j, c2))
            if r is None:
                return None
            return k(r[0], r[1])
        return atomic

    if op == "GROUPREF":
        g = node[1]
        ignore = flags & IGNORECASE

        def groupref(s, i, c, k):
            a, b = c[2 * g], c[2 * g + 1]
            if a is None or b is None or b < a:
                return None
            n = b - a
            if i + n > len(s):
                return None
            if ignore:
                if s[i:i + n].lower() != s[a:b].lower():
                    return None
            elif s[i:i + n] != s[a:b]:
                return None
            return k(i + n, c)
        return groupref

    if op == "GROUPREF_EXISTS":
        g = node[1]
        yes = _compile_seq(node[2], flags)
        no = _compile_seq(node[3], flags) if node[3] is not None else _empty

        def cond(s, i, c, k):
            if g < len(c) // 2 and c[2 * g] is not None and c[2 * g + 1] is not None:
                return yes(s, i, c, k)
            return no(s, i, c, k)
        return cond

    if op in ("ASSERT", "ASSERT_NOT"):
        direction = node[1]
        body = _compile_seq(node[2], flags)
        width = 0
        if direction < 0:
            lo, hi = _width(node[2], _COMPILE_STATE[-1])
            if lo != hi:
                raise error("look-behind requires fixed-width pattern")
            width = lo
        positive = op == "ASSERT"

        def look(s, i, c, k):
            start = i - width
            if start < 0:
                return None if positive else k(i, c)
            r = body(s, start, c, lambda j, c2: c2)
            if positive:
                if r is None:
                    return None
                return k(i, r)
            if r is not None:
                return None
            return k(i, c)
        return look

    if op == "FAILURE":
        return lambda s, i, c, k: None

    raise AssertionError(op)


def _compile_repeat(node, flags):
    op, mn, mx, seq = node
    if len(seq) == 1 and seq[0][0] in _UNIT_OPS:
        pred = _unit_pred(seq[0], flags)
        if op == "MIN_REP":
            def lazy_one(s, i, c, k):
                n = len(s)
                j = i
                count = 0
                while count < mn:
                    if j < n and pred(s[j]):
                        j += 1
                        count += 1
                    else:
                        return None
                while True:
                    r = k(j, c)
                    if r is not None:
                        return r
                    if count >= mx or j >= n or not pred(s[j]):
                        return None
                    j += 1
                    count += 1
            return lazy_one

        def greedy_one(s, i, c, k):
            n = len(s)
            j = i
            limit = n if mx == MAXREPEAT else min(n, i + mx)
            while j < limit and pred(s[j]):
                j += 1
            low = i + mn
            if op == "POSS_REP":
                return k(j, c) if j >= low else None
            while j >= low:
                r = k(j, c)
                if r is not None:
                    return r
                j -= 1
            return None
        return greedy_one

    body = _compile_seq(seq, flags)

    if op == "MIN_REP":
        def lazy(s, i, c, k):
            def until(count, j, c1, last):
                if count < mn:
                    return body(s, j, c1, lambda j2, c2: until(count + 1, j2, c2, last))
                r = k(j, c1)
                if r is not None:
                    return r
                if (count >= mx and mx != MAXREPEAT) or j == last:
                    return None
                return body(s, j, c1, lambda j2, c2: until(count + 1, j2, c2, j))
            return until(0, i, c, None)
        return lazy

    def greedy_k(s, i, c, k):
        def until(count, j, c1, last):
            if count < mn:
                return body(s, j, c1, lambda j2, c2: until(count + 1, j2, c2, last))
            if (count < mx or mx == MAXREPEAT) and j != last:
                r = body(s, j, c1, lambda j2, c2: until(count + 1, j2, c2, j))
                if r is not None:
                    return r
            return k(j, c1)
        return until(0, i, c, None)

    if op == "POSS_REP":
        def possessive(s, i, c, k):
            r = greedy_k(s, i, c, lambda j, c2: (j, c2))
            if r is None:
                return None
            return k(r[0], r[1])
        return possessive
    return greedy_k


_COMPILE_STATE = []


# ------------------------------------------------------------ public types

class Match:
    def __init__(self, pattern, string, pos, endpos, caps, a, b):
        self._a = a
        self._b = b
        self.re = pattern
        self.string = string
        self.pos = pos
        self.endpos = endpos
        self._caps = caps
        li = caps[0]
        self.lastindex = li if li > 0 else None
        self.lastgroup = None
        if self.lastindex is not None:
            for name, idx in pattern.groupindex.items():
                if idx == self.lastindex:
                    self.lastgroup = name
                    break

    def _index(self, g):
        if isinstance(g, int) and not isinstance(g, bool):
            if 0 <= g <= self.re.groups:
                return g
            raise IndexError("no such group")
        if isinstance(g, str):
            if g in self.re.groupindex:
                return self.re.groupindex[g]
            raise IndexError("no such group")
        try:
            g2 = g.__index__()
        except AttributeError:
            raise IndexError("no such group") from None
        return self._index(g2)

    def _get(self, idx, default=None):
        if idx == 0:
            return self.string[self._a:self._b]
        a, b = self._caps[2 * idx], self._caps[2 * idx + 1]
        if a is None or b is None or b < a:
            return default
        return self.string[a:b]

    def group(self, *args):
        if not args:
            return self._get(0)
        if len(args) == 1:
            return self._get(self._index(args[0]))
        return tuple(self._get(self._index(a)) for a in args)

    def __getitem__(self, g):
        return self._get(self._index(g))

    def groups(self, default=None):
        return tuple(self._get(i, default) for i in range(1, self.re.groups + 1))

    def groupdict(self, default=None):
        return {name: self._get(idx, default)
                for name, idx in self.re.groupindex.items()}

    def span(self, group=0):
        idx = self._index(group)
        if idx == 0:
            return (self._a, self._b)
        a, b = self._caps[2 * idx], self._caps[2 * idx + 1]
        if a is None or b is None or b < a:
            return (-1, -1)
        return (a, b)

    def start(self, group=0):
        return self.span(group)[0]

    def end(self, group=0):
        return self.span(group)[1]

    @property
    def regs(self):
        return tuple(self.span(i) for i in range(self.re.groups + 1))

    def expand(self, template):
        return _expand_template(_parse_template(template, self.re), self)

    def __repr__(self):
        return "<toolkit.regex.Match object; span=%r, match=%r>" % (
            self.span(), self.group())

    def __bool__(self):
        return True


class Pattern:
    def __init__(self, pattern, flags):
        if isinstance(flags, bool) or not isinstance(flags, int):
            raise TypeError("flags must be an integer")
        seq, state = _parse_pattern(pattern, flags)
        _COMPILE_STATE.append(state)
        try:
            self._m = _compile_seq(seq, state.flags)
        finally:
            _COMPILE_STATE.pop()
        self.pattern = pattern
        self.flags = state.flags
        self.groups = state.groups - 1
        self.groupindex = dict(state.groupdict)
        self._ncaps = 2 * state.groups

    def __repr__(self):
        return "toolkit.regex.compile(%r)" % (self.pattern,)

    def __eq__(self, other):
        return (isinstance(other, Pattern) and self.pattern == other.pattern
                and self.flags == other.flags)

    def __hash__(self):
        return hash((self.pattern, self.flags))

    # -- core
    def _bounds(self, string, pos, endpos):
        if not isinstance(string, str):
            raise TypeError("expected string, got %s" % type(string).__name__)
        n = len(string)
        pos = max(0, min(pos, n))
        endpos = max(0, min(endpos, n))
        return pos, endpos

    def _try(self, s, start, mode, search_start, must_advance):
        end = len(s)

        def final(j, c):
            if mode == "full" and j != end:
                return None
            if must_advance and j == search_start:
                return None
            return (j, c)

        init = (-1,) + (None,) * (self._ncaps - 1)
        r = self._m(s, start, init, final)
        if r is None:
            return None
        j, c = r
        return start, j, c

    def _search(self, string, pos, endpos, mode="search", must_advance=False):
        s = string[:endpos]
        if mode != "search":
            return self._try(s, pos, mode, pos, must_advance)
        for start in range(pos, len(s) + 1):
            r = self._try(s, start, mode, pos, must_advance)
            if r is not None:
                return r
        return None

    def _make(self, string, pos, endpos, r):
        a, b, c = r
        return Match(self, string, pos, endpos, c, a, b)

    def match(self, string, pos=0, endpos=sys.maxsize):
        pos, endpos = self._bounds(string, pos, endpos)
        r = self._search(string, pos, endpos, "match")
        return None if r is None else self._make(string, pos, endpos, r)

    def fullmatch(self, string, pos=0, endpos=sys.maxsize):
        pos, endpos = self._bounds(string, pos, endpos)
        r = self._search(string, pos, endpos, "full")
        return None if r is None else self._make(string, pos, endpos, r)

    def search(self, string, pos=0, endpos=sys.maxsize):
        pos, endpos = self._bounds(string, pos, endpos)
        r = self._search(string, pos, endpos, "search")
        return None if r is None else self._make(string, pos, endpos, r)

    def _iter(self, string, pos=0, endpos=sys.maxsize):
        pos, endpos = self._bounds(string, pos, endpos)
        start = pos
        must_advance = False
        while start <= endpos:
            r = self._search(string, start, endpos, "search", must_advance)
            if r is None:
                return
            m = self._make(string, pos, endpos, r)
            yield m
            must_advance = r[1] == r[0]
            start = r[1]

    def finditer(self, string, pos=0, endpos=sys.maxsize):
        return iter(list(self._iter(string, pos, endpos)))

    def findall(self, string, pos=0, endpos=sys.maxsize):
        out = []
        for m in self._iter(string, pos, endpos):
            if self.groups == 0:
                out.append(m.group(0))
            elif self.groups == 1:
                out.append(m.group(1) or "")
            else:
                out.append(tuple(g or "" for g in m.groups()))
        return out

    def split(self, string, maxsplit=0):
        if not isinstance(string, str):
            raise TypeError("expected string, got %s" % type(string).__name__)
        out = []
        last = 0
        n = 0
        for m in self._iter(string):
            if maxsplit > 0 and n >= maxsplit:
                break
            if maxsplit < 0:
                break
            out.append(string[last:m.start()])
            out.extend(m.groups())
            last = m.end()
            n += 1
        out.append(string[last:])
        return out

    def subn(self, repl, string, count=0):
        if not isinstance(string, str):
            raise TypeError("expected string, got %s" % type(string).__name__)
        if callable(repl):
            fn = repl
        elif isinstance(repl, str):
            if "\\" in repl:
                template = _parse_template(repl, self)
                fn = lambda m: _expand_template(template, m)
            else:
                fn = lambda m: repl
        else:
            raise TypeError("expected str instance, %s found" % type(repl).__name__)
        out = []
        last = 0
        n = 0
        for m in self._iter(string):
            if count > 0 and n >= count:
                break
            if count < 0:
                break
            out.append(string[last:m.start()])
            piece = fn(m)
            if piece is not None:
                if not isinstance(piece, str):
                    raise TypeError("expected str instance, %s found"
                                    % type(piece).__name__)
                out.append(piece)
            last = m.end()
            n += 1
        out.append(string[last:])
        return "".join(out), n

    def sub(self, repl, string, count=0):
        return self.subn(repl, string, count)[0]


# ---------------------------------------------------------------- templates

def _parse_template(template, pattern):
    if not isinstance(template, str):
        raise TypeError("expected str instance, %s found" % type(template).__name__)
    s = _Source(template)
    result = []
    literal = []

    def addgroup(index, pos):
        if index > pattern.groups:
            raise s.error("invalid group reference %d" % index, pos)
        result.append("".join(literal))
        del literal[:]
        result.append(index)

    groupindex = pattern.groupindex
    while True:
        this = s.get()
        if this is None:
            break
        if this[0] == "\\":
            c = this[1]
            if c == "g":
                if not s.match("<"):
                    raise s.error("missing <")
                name = s.getuntil(">", "group name")
                if not (name.isdecimal() and name.isascii()):
                    s.checkgroupname(name, 1)
                    try:
                        index = groupindex[name]
                    except KeyError:
                        raise IndexError("unknown group name %r" % name) from None
                else:
                    index = int(name)
                    if index >= _MAXGROUPS:
                        raise s.error("invalid group reference %d" % index,
                                      len(name) + 1)
                addgroup(index, len(name) + 1)
            elif c == "0":
                if s.next in _OCTDIGITS:
                    this += s.get()
                    if s.next in _OCTDIGITS:
                        this += s.get()
                literal.append(chr(int(this[1:], 8) & 0xff))
            elif c in _DIGITS:
                isoctal = False
                if s.next in _DIGITS:
                    this += s.get()
                    if (c in _OCTDIGITS and this[2] in _OCTDIGITS and
                            s.next in _OCTDIGITS):
                        this += s.get()
                        isoctal = True
                        v = int(this[1:], 8)
                        if v > 0o377:
                            raise s.error("octal escape value %s outside of "
                                          "range 0-0o377" % this, len(this))
                        literal.append(chr(v))
                if not isoctal:
                    addgroup(int(this[1:]), len(this) - 1)
            else:
                if this in _ESCAPES:
                    this = chr(_ESCAPES[this][1])
                elif c in _ASCIILETTERS:
                    raise s.error("bad escape %s" % this, len(this))
                literal.append(this)
        else:
            literal.append(this)
    result.append("".join(literal))
    return result


def _expand_template(template, m):
    out = []
    for i, item in enumerate(template):
        if i % 2 == 0:
            out.append(item)
        else:
            g = m.group(item)
            if g is not None:
                out.append(g)
    return "".join(out)


# ------------------------------------------------------------- module level

_cache = {}


def compile(pattern, flags=0):
    if isinstance(pattern, Pattern):
        if flags:
            raise ValueError("cannot process flags argument with a compiled pattern")
        return pattern
    if not isinstance(pattern, str):
        raise TypeError("first argument must be string or compiled pattern")
    key = (pattern, flags)
    p = _cache.get(key)
    if p is None:
        p = Pattern(pattern, flags)
        if len(_cache) > 512:
            _cache.clear()
        _cache[key] = p
    return p


def match(pattern, string, flags=0):
    return compile(pattern, flags).match(string)


def fullmatch(pattern, string, flags=0):
    return compile(pattern, flags).fullmatch(string)


def search(pattern, string, flags=0):
    return compile(pattern, flags).search(string)


def findall(pattern, string, flags=0):
    return compile(pattern, flags).findall(string)


def finditer(pattern, string, flags=0):
    return compile(pattern, flags).finditer(string)


def sub(pattern, repl, string, count=0, flags=0):
    return compile(pattern, flags).sub(repl, string, count)


def subn(pattern, repl, string, count=0, flags=0):
    return compile(pattern, flags).subn(repl, string, count)


def split(pattern, string, maxsplit=0, flags=0):
    return compile(pattern, flags).split(string, maxsplit)


_SPECIAL_ESCAPE = {c: "\\" + c for c in "()[]{}?*+-|^$\\.&~# \t\n\r\v\f"}


def escape(pattern):
    return "".join(_SPECIAL_ESCAPE.get(ch, ch) for ch in pattern)
