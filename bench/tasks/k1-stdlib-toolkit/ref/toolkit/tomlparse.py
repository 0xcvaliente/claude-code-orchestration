"""TOML 1.0 parser with the same results and errors as Python 3.13 tomllib.

Pure Python, no regular expressions: the number and date/time grammars are
matched by hand.
"""
import sys
from datetime import date, datetime, time, timedelta, timezone

__all__ = ["loads", "load", "TOMLDecodeError"]

MAX_KEY_PARTS = sys.getrecursionlimit()

ASCII_CTRL = frozenset(chr(i) for i in range(32)) | frozenset(chr(127))
ILLEGAL_BASIC_STR_CHARS = ASCII_CTRL - frozenset("\t")
ILLEGAL_MULTILINE_BASIC_STR_CHARS = ASCII_CTRL - frozenset("\t\n")
ILLEGAL_LITERAL_STR_CHARS = ILLEGAL_BASIC_STR_CHARS
ILLEGAL_MULTILINE_LITERAL_STR_CHARS = ILLEGAL_MULTILINE_BASIC_STR_CHARS
ILLEGAL_COMMENT_CHARS = ILLEGAL_BASIC_STR_CHARS

TOML_WS = frozenset(" \t")
TOML_WS_AND_NEWLINE = TOML_WS | frozenset("\n")
DIGITS = "0123456789"
LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
BARE_KEY_CHARS = frozenset(LETTERS + DIGITS + "-_")
KEY_INITIAL_CHARS = BARE_KEY_CHARS | frozenset("\"'")
HEXDIGIT_CHARS = frozenset("0123456789abcdefABCDEF")
DEC = frozenset(DIGITS)
OCT = frozenset("01234567")
BIN = frozenset("01")

BASIC_STR_ESCAPE_REPLACEMENTS = {
    "\\b": "\u0008",
    "\\t": "\u0009",
    "\\n": "\u000A",
    "\\f": "\u000C",
    "\\r": "\u000D",
    '\\"': '"',
    "\\\\": "\\",
}


class TOMLDecodeError(ValueError):
    """An error raised if a document is not valid TOML."""


def load(fp, /):
    b = fp.read()
    try:
        s = b.decode()
    except AttributeError:
        raise TypeError("File must be opened in binary mode") from None
    return loads(s)


def loads(s, /):
    src = s.replace("\r\n", "\n")
    pos = 0
    flags = Flags()
    data = NestedDict()
    header = ()
    while True:
        pos = skip_chars(src, pos, TOML_WS)
        if pos >= len(src):
            break
        char = src[pos]
        if char == "\n":
            pos += 1
            continue
        if char in KEY_INITIAL_CHARS:
            pos = key_value_rule(src, pos, data, flags, header)
            pos = skip_chars(src, pos, TOML_WS)
        elif char == "[":
            second = src[pos + 1] if pos + 1 < len(src) else None
            flags.finalize_pending()
            if second == "[":
                pos, header = create_list_rule(src, pos, data, flags)
            else:
                pos, header = create_dict_rule(src, pos, data, flags)
            pos = skip_chars(src, pos, TOML_WS)
        elif char != "#":
            raise err(src, pos, "Invalid statement")
        pos = skip_comment(src, pos)
        if pos >= len(src):
            break
        if src[pos] != "\n":
            raise err(src, pos, "Expected newline or end of document after a statement")
        pos += 1
    return data.dict


class Flags:
    FROZEN = 0
    EXPLICIT_NEST = 1

    def __init__(self):
        self._flags = {}
        self._pending = set()

    def add_pending(self, key, flag):
        self._pending.add((key, flag))

    def finalize_pending(self):
        for key, flag in self._pending:
            self.set(key, flag, recursive=False)
        self._pending.clear()

    def unset_all(self, key):
        cont = self._flags
        for k in key[:-1]:
            if k not in cont:
                return
            cont = cont[k]["nested"]
        cont.pop(key[-1], None)

    def set(self, key, flag, *, recursive):
        cont = self._flags
        for k in key[:-1]:
            if k not in cont:
                cont[k] = {"flags": set(), "recursive_flags": set(), "nested": {}}
            cont = cont[k]["nested"]
        stem = key[-1]
        if stem not in cont:
            cont[stem] = {"flags": set(), "recursive_flags": set(), "nested": {}}
        cont[stem]["recursive_flags" if recursive else "flags"].add(flag)

    def is_(self, key, flag):
        if not key:
            return False
        cont = self._flags
        for k in key[:-1]:
            if k not in cont:
                return False
            inner = cont[k]
            if flag in inner["recursive_flags"]:
                return True
            cont = inner["nested"]
        stem = key[-1]
        if stem in cont:
            c = cont[stem]
            return flag in c["flags"] or flag in c["recursive_flags"]
        return False


class NestedDict:
    def __init__(self):
        self.dict = {}

    def get_or_create_nest(self, key, *, access_lists=True):
        cont = self.dict
        for k in key:
            if k not in cont:
                cont[k] = {}
            cont = cont[k]
            if access_lists and isinstance(cont, list):
                cont = cont[-1]
            if not isinstance(cont, dict):
                raise KeyError("There is no nest behind this key")
        return cont

    def append_nest_to_list(self, key):
        cont = self.get_or_create_nest(key[:-1])
        last = key[-1]
        if last in cont:
            lst = cont[last]
            if not isinstance(lst, list):
                raise KeyError("An object other than list found behind this key")
            lst.append({})
        else:
            cont[last] = [{}]


def skip_chars(src, pos, chars):
    n = len(src)
    while pos < n and src[pos] in chars:
        pos += 1
    return pos


def skip_until(src, pos, expect, *, error_on, error_on_eof):
    new_pos = src.find(expect, pos)
    if new_pos < 0:
        new_pos = len(src)
        if error_on_eof:
            raise err(src, new_pos, f"Expected {expect!r}")
    if not error_on.isdisjoint(src[pos:new_pos]):
        while src[pos] not in error_on:
            pos += 1
        raise err(src, pos, f"Found invalid character {src[pos]!r}")
    return new_pos


def skip_comment(src, pos):
    if pos < len(src) and src[pos] == "#":
        return skip_until(src, pos + 1, "\n", error_on=ILLEGAL_COMMENT_CHARS, error_on_eof=False)
    return pos


def skip_comments_and_array_ws(src, pos):
    while True:
        before = pos
        pos = skip_chars(src, pos, TOML_WS_AND_NEWLINE)
        pos = skip_comment(src, pos)
        if pos == before:
            return pos


def create_dict_rule(src, pos, data, flags):
    pos += 1
    pos = skip_chars(src, pos, TOML_WS)
    pos, key = parse_key(src, pos)
    if flags.is_(key, Flags.EXPLICIT_NEST) or flags.is_(key, Flags.FROZEN):
        raise err(src, pos, f"Cannot declare {key} twice")
    flags.set(key, Flags.EXPLICIT_NEST, recursive=False)
    try:
        data.get_or_create_nest(key)
    except KeyError:
        raise err(src, pos, "Cannot overwrite a value") from None
    if not src.startswith("]", pos):
        raise err(src, pos, "Expected ']' at the end of a table declaration")
    return pos + 1, key


def create_list_rule(src, pos, data, flags):
    pos += 2
    pos = skip_chars(src, pos, TOML_WS)
    pos, key = parse_key(src, pos)
    if flags.is_(key, Flags.FROZEN):
        raise err(src, pos, f"Cannot mutate immutable namespace {key}")
    flags.unset_all(key)
    flags.set(key, Flags.EXPLICIT_NEST, recursive=False)
    try:
        data.append_nest_to_list(key)
    except KeyError:
        raise err(src, pos, "Cannot overwrite a value") from None
    if not src.startswith("]]", pos):
        raise err(src, pos, "Expected ']]' at the end of an array declaration")
    return pos + 2, key


def key_value_rule(src, pos, data, flags, header):
    pos, key, value = parse_key_value_pair(src, pos)
    key_parent, key_stem = key[:-1], key[-1]
    abs_parent = header + key_parent
    for i in range(1, len(key)):
        cont_key = header + key[:i]
        if flags.is_(cont_key, Flags.EXPLICIT_NEST):
            raise err(src, pos, f"Cannot redefine namespace {cont_key}")
        flags.add_pending(cont_key, Flags.EXPLICIT_NEST)
    if flags.is_(abs_parent, Flags.FROZEN):
        raise err(src, pos, f"Cannot mutate immutable namespace {abs_parent}")
    try:
        nest = data.get_or_create_nest(abs_parent)
    except KeyError:
        raise err(src, pos, "Cannot overwrite a value") from None
    if key_stem in nest:
        raise err(src, pos, "Cannot overwrite a value")
    if isinstance(value, (dict, list)):
        flags.set(header + key, Flags.FROZEN, recursive=True)
    nest[key_stem] = value
    return pos


def parse_key_value_pair(src, pos):
    pos, key = parse_key(src, pos)
    if pos >= len(src) or src[pos] != "=":
        raise err(src, pos, "Expected '=' after a key in a key/value pair")
    pos += 1
    pos = skip_chars(src, pos, TOML_WS)
    pos, value = parse_value(src, pos)
    return pos, key, value


def parse_key(src, pos):
    pos, part = parse_key_part(src, pos)
    key = (part,)
    pos = skip_chars(src, pos, TOML_WS)
    while True:
        if pos >= len(src) or src[pos] != ".":
            return pos, key
        pos += 1
        pos = skip_chars(src, pos, TOML_WS)
        pos, part = parse_key_part(src, pos)
        key += (part,)
        if len(key) > MAX_KEY_PARTS:
            raise RecursionError("TOML key has too many parts")
        pos = skip_chars(src, pos, TOML_WS)


def parse_key_part(src, pos):
    char = src[pos] if pos < len(src) else None
    if char is not None and char in BARE_KEY_CHARS:
        start = pos
        pos = skip_chars(src, pos, BARE_KEY_CHARS)
        return pos, src[start:pos]
    if char == "'":
        return parse_literal_str(src, pos)
    if char == '"':
        return parse_basic_str(src, pos + 1, multiline=False)
    raise err(src, pos, "Invalid initial character for a key part")


def parse_array(src, pos):
    pos += 1
    array = []
    pos = skip_comments_and_array_ws(src, pos)
    if src.startswith("]", pos):
        return pos + 1, array
    while True:
        pos, val = parse_value(src, pos)
        array.append(val)
        pos = skip_comments_and_array_ws(src, pos)
        c = src[pos:pos + 1]
        if c == "]":
            return pos + 1, array
        if c != ",":
            raise err(src, pos, "Unclosed array")
        pos += 1
        pos = skip_comments_and_array_ws(src, pos)
        if src.startswith("]", pos):
            return pos + 1, array


def parse_inline_table(src, pos):
    pos += 1
    nested = NestedDict()
    flags = Flags()
    pos = skip_chars(src, pos, TOML_WS)
    if src.startswith("}", pos):
        return pos + 1, nested.dict
    while True:
        pos, key, value = parse_key_value_pair(src, pos)
        key_parent, key_stem = key[:-1], key[-1]
        if flags.is_(key, Flags.FROZEN):
            raise err(src, pos, f"Cannot mutate immutable namespace {key}")
        try:
            nest = nested.get_or_create_nest(key_parent, access_lists=False)
        except KeyError:
            raise err(src, pos, "Cannot overwrite a value") from None
        if key_stem in nest:
            raise err(src, pos, f"Duplicate inline table key {key_stem!r}")
        nest[key_stem] = value
        pos = skip_chars(src, pos, TOML_WS)
        c = src[pos:pos + 1]
        if c == "}":
            return pos + 1, nested.dict
        if c != ",":
            raise err(src, pos, "Unclosed inline table")
        if isinstance(value, (dict, list)):
            flags.set(key, Flags.FROZEN, recursive=True)
        pos += 1
        pos = skip_chars(src, pos, TOML_WS)


def parse_escape(src, pos, multiline):
    escape_id = src[pos:pos + 2]
    pos += 2
    if multiline and escape_id in ("\\ ", "\\\t", "\\\n"):
        if escape_id != "\\\n":
            pos = skip_chars(src, pos, TOML_WS)
            if pos >= len(src):
                return pos, ""
            if src[pos] != "\n":
                raise err(src, pos, "Unescaped '\\' in a string")
            pos += 1
        pos = skip_chars(src, pos, TOML_WS_AND_NEWLINE)
        return pos, ""
    if escape_id == "\\u":
        return parse_hex_char(src, pos, 4)
    if escape_id == "\\U":
        return parse_hex_char(src, pos, 8)
    rep = BASIC_STR_ESCAPE_REPLACEMENTS.get(escape_id)
    if rep is None:
        raise err(src, pos, "Unescaped '\\' in a string")
    return pos, rep


def parse_hex_char(src, pos, hex_len):
    hex_str = src[pos:pos + hex_len]
    if len(hex_str) != hex_len or not HEXDIGIT_CHARS.issuperset(hex_str):
        raise err(src, pos, "Invalid hex value")
    pos += hex_len
    cp = int(hex_str, 16)
    if not (0 <= cp <= 0xD7FF or 0xE000 <= cp <= 0x10FFFF):
        raise err(src, pos, "Escaped character is not a Unicode scalar value")
    return pos, chr(cp)


def parse_literal_str(src, pos):
    pos += 1
    start = pos
    pos = skip_until(src, pos, "'", error_on=ILLEGAL_LITERAL_STR_CHARS, error_on_eof=True)
    return pos + 1, src[start:pos]


def parse_multiline_str(src, pos, literal):
    pos += 3
    if src.startswith("\n", pos):
        pos += 1
    if literal:
        delim = "'"
        end = skip_until(src, pos, "'''", error_on=ILLEGAL_MULTILINE_LITERAL_STR_CHARS, error_on_eof=True)
        result = src[pos:end]
        pos = end + 3
    else:
        delim = '"'
        pos, result = parse_basic_str(src, pos, multiline=True)
    if not src.startswith(delim, pos):
        return pos, result
    pos += 1
    if not src.startswith(delim, pos):
        return pos, result + delim
    pos += 1
    return pos, result + delim * 2


def parse_basic_str(src, pos, *, multiline):
    error_on = ILLEGAL_MULTILINE_BASIC_STR_CHARS if multiline else ILLEGAL_BASIC_STR_CHARS
    parts = []
    start = pos
    n = len(src)
    while True:
        if pos >= n:
            raise err(src, pos, "Unterminated string")
        char = src[pos]
        if char == '"':
            if not multiline:
                parts.append(src[start:pos])
                return pos + 1, "".join(parts)
            if src.startswith('"""', pos):
                parts.append(src[start:pos])
                return pos + 3, "".join(parts)
            pos += 1
            continue
        if char == "\\":
            parts.append(src[start:pos])
            pos, esc = parse_escape(src, pos, multiline)
            parts.append(esc)
            start = pos
            continue
        if char in error_on:
            raise err(src, pos, f"Illegal character {char!r}")
        pos += 1


# ---- hand-written matchers for numbers, dates and times ----

def _digits(src, pos, count):
    """Return True if src[pos:pos+count] is `count` decimal digits."""
    s = src[pos:pos + count]
    return len(s) == count and all(c in DEC for c in s)


def _in_range2(src, pos, lo, hi):
    """Two digits forming a number in [lo, hi]."""
    if not _digits(src, pos, 2):
        return False
    v = int(src[pos:pos + 2])
    return lo <= v <= hi


def match_time(src, pos):
    """Match HH:MM:SS(.frac)? -> (end, (h, m, s, micros_str|None)) or None."""
    if not (_in_range2(src, pos, 0, 23) and src[pos + 2:pos + 3] == ":"
            and _in_range2(src, pos + 3, 0, 59) and src[pos + 5:pos + 6] == ":"
            and _in_range2(src, pos + 6, 0, 59)):
        return None
    h, m, s = src[pos:pos + 2], src[pos + 3:pos + 5], src[pos + 6:pos + 8]
    end = pos + 8
    micros = None
    if src[end:end + 1] == "." and src[end + 1:end + 2] in DEC and src[end + 1:end + 2] != "":
        p = end + 1
        while p < len(src) and src[p] in DEC:
            p += 1
        micros = src[end + 1:min(p, end + 7)]
        end = p
    return end, (h, m, s, micros)


def match_datetime(src, pos):
    if not (_digits(src, pos, 4) and src[pos + 4:pos + 5] == "-"
            and _in_range2(src, pos + 5, 1, 12) and src[pos + 7:pos + 8] == "-"
            and _in_range2(src, pos + 8, 1, 31)):
        return None
    y, mo, d = src[pos:pos + 4], src[pos + 5:pos + 7], src[pos + 8:pos + 10]
    end = pos + 10
    tm = None
    zulu = sign = oh = om = None
    if src[end:end + 1] in ("T", "t", " ") and src[end:end + 1] != "":
        t = match_time(src, end + 1)
        if t is not None:
            end, tm = t
            c = src[end:end + 1]
            if c in ("Z", "z") and c != "":
                zulu = c
                end += 1
            elif c in ("+", "-") and c != "":
                if (_in_range2(src, end + 1, 0, 23) and src[end + 3:end + 4] == ":"
                        and _in_range2(src, end + 4, 0, 59)):
                    sign, oh, om = c, src[end + 1:end + 3], src[end + 4:end + 6]
                    end += 6
    return end, (y, mo, d, tm, zulu, sign, oh, om)


def to_datetime(groups):
    y, mo, d, tm, zulu, sign, oh, om = groups
    year, month, day = int(y), int(mo), int(d)
    if tm is None:
        return date(year, month, day)
    h, m, s, micros = tm
    us = int(micros.ljust(6, "0")) if micros else 0
    if sign:
        k = 1 if sign == "+" else -1
        tz = timezone(timedelta(hours=k * int(oh), minutes=k * int(om)))
    elif zulu:
        tz = timezone.utc
    else:
        tz = None
    return datetime(year, month, day, int(h), int(m), int(s), us, tzinfo=tz)


def _run(src, pos, digitset):
    """Match D(_?D)* starting at pos; return end or -1 if no first digit."""
    n = len(src)
    if pos >= n or src[pos] not in digitset:
        return -1
    pos += 1
    while pos < n:
        if src[pos] in digitset:
            pos += 1
        elif src[pos] == "_" and pos + 1 < n and src[pos + 1] in digitset:
            pos += 2
        else:
            break
    return pos


def match_number(src, pos):
    """Return (end, value) or None, mirroring tomllib's RE_NUMBER."""
    n = len(src)
    if src.startswith("0", pos) and pos + 1 < n and src[pos + 1] in "xbo":
        ds = {"x": HEXDIGIT_CHARS, "b": BIN, "o": OCT}[src[pos + 1]]
        end = _run(src, pos + 2, ds)
        if end >= 0:
            return end, int(src[pos:end], 0)
    p = pos
    if p < n and src[p] in "+-":
        p += 1
    if p < n and src[p] == "0":
        p += 1
    elif p < n and src[p] in DEC:
        p = _run(src, p, DEC)
    else:
        return None
    float_start = p
    if src[p:p + 1] == ".":
        e = _run(src, p + 1, DEC)
        if e >= 0:
            p = e
    if src[p:p + 1] in ("e", "E") and src[p:p + 1] != "":
        q = p + 1
        if src[q:q + 1] in ("+", "-") and src[q:q + 1] != "":
            q += 1
        e = _run(src, q, DEC)
        if e >= 0:
            p = e
    text = src[pos:p]
    if p > float_start:
        return p, float(text)
    return p, int(text, 0)


def parse_value(src, pos):
    char = src[pos] if pos < len(src) else None
    if char == '"':
        if src.startswith('"""', pos):
            return parse_multiline_str(src, pos, literal=False)
        return parse_basic_str(src, pos + 1, multiline=False)
    if char == "'":
        if src.startswith("'''", pos):
            return parse_multiline_str(src, pos, literal=True)
        return parse_literal_str(src, pos)
    if char == "t" and src.startswith("true", pos):
        return pos + 4, True
    if char == "f" and src.startswith("false", pos):
        return pos + 5, False
    if char == "[":
        return parse_array(src, pos)
    if char == "{":
        return parse_inline_table(src, pos)
    m = match_datetime(src, pos)
    if m is not None:
        end, groups = m
        try:
            value = to_datetime(groups)
        except ValueError:
            raise err(src, pos, "Invalid date or datetime") from None
        return end, value
    t = match_time(src, pos)
    if t is not None:
        end, (h, mi, s, micros) = t
        us = int(micros.ljust(6, "0")) if micros else 0
        return end, time(int(h), int(mi), int(s), us)
    num = match_number(src, pos)
    if num is not None:
        return num
    first3 = src[pos:pos + 3]
    if first3 in ("inf", "nan"):
        return pos + 3, float(first3)
    first4 = src[pos:pos + 4]
    if first4 in ("-inf", "+inf", "-nan", "+nan"):
        return pos + 4, float(first4)
    raise err(src, pos, "Invalid value")


def err(src, pos, msg):
    if pos >= len(src):
        where = "end of document"
    else:
        line = src.count("\n", 0, pos) + 1
        col = pos + 1 if line == 1 else pos - src.rindex("\n", 0, pos)
        where = f"line {line}, column {col}"
    return TOMLDecodeError(f"{msg} (at {where})")
