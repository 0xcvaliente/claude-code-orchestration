"""toolkit.jsonx: a pure-Python JSON encoder and decoder compatible with the
Python 3.13 `json` module for the subset in spec/jsonx.md (reference
solution)."""

__all__ = ["dumps", "loads", "JSONDecodeError"]


class JSONDecodeError(ValueError):
    """Subclass of ValueError with msg, doc, pos, lineno and colno."""

    def __init__(self, msg, doc, pos):
        lineno = doc.count("\n", 0, pos) + 1
        colno = pos - doc.rfind("\n", 0, pos)
        ValueError.__init__(self, "%s: line %d column %d (char %d)"
                            % (msg, lineno, colno, pos))
        self.msg = msg
        self.doc = doc
        self.pos = pos
        self.lineno = lineno
        self.colno = colno

    def __reduce__(self):
        return self.__class__, (self.msg, self.doc, self.pos)


# ------------------------------------------------------------------ encoding

_ESC = {"\\": "\\\\", '"': '\\"', "\b": "\\b", "\f": "\\f",
        "\n": "\\n", "\r": "\\r", "\t": "\\t"}
_INF = float("inf")


def _str_ascii(s):
    out = ['"']
    for ch in s:
        e = _ESC.get(ch)
        if e is not None:
            out.append(e)
        elif " " <= ch <= "~":
            out.append(ch)
        else:
            n = ord(ch)
            if n < 0x10000:
                out.append("\\u%04x" % n)
            else:
                n -= 0x10000
                out.append("\\u%04x\\u%04x" % (0xD800 | ((n >> 10) & 0x3FF),
                                               0xDC00 | (n & 0x3FF)))
    out.append('"')
    return "".join(out)


def _str_plain(s):
    out = ['"']
    for ch in s:
        e = _ESC.get(ch)
        if e is not None:
            out.append(e)
        elif ch < " ":
            out.append("\\u%04x" % ord(ch))
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _default_default(o):
    raise TypeError("Object of type %s is not JSON serializable"
                    % type(o).__name__)


def dumps(obj, *, skipkeys=False, ensure_ascii=True, check_circular=True,
          allow_nan=True, cls=None, indent=None, separators=None,
          default=None, sort_keys=False, **kw):
    if separators is not None:
        item_sep, key_sep = separators
    elif indent is not None:
        item_sep, key_sep = ",", ": "
    else:
        item_sep, key_sep = ", ", ": "
    if indent is not None and not isinstance(indent, str):
        indent = " " * indent
    if default is None:
        default = _default_default
    enc_str = _str_ascii if ensure_ascii else _str_plain
    markers = {} if check_circular else None
    out = []
    emit = out.append

    def floatstr(o):
        if o != o:
            text = "NaN"
        elif o == _INF:
            text = "Infinity"
        elif o == -_INF:
            text = "-Infinity"
        else:
            return float.__repr__(o)
        if not allow_nan:
            raise ValueError("Out of range float values are not JSON compliant: "
                             + repr(o))
        return text

    def enc(o, level):
        if isinstance(o, str):
            emit(enc_str(o))
        elif o is None:
            emit("null")
        elif o is True:
            emit("true")
        elif o is False:
            emit("false")
        elif isinstance(o, int):
            emit(int.__repr__(o))
        elif isinstance(o, float):
            emit(floatstr(o))
        elif isinstance(o, (list, tuple)):
            enc_list(o, level)
        elif isinstance(o, dict):
            enc_dict(o, level)
        else:
            mid = None
            if markers is not None:
                mid = id(o)
                if mid in markers:
                    raise ValueError("Circular reference detected")
                markers[mid] = o
            enc(default(o), level)
            if markers is not None:
                del markers[mid]

    def enter(o):
        if markers is not None:
            mid = id(o)
            if mid in markers:
                raise ValueError("Circular reference detected")
            markers[mid] = o
            return mid
        return None

    def leave(mid):
        if mid is not None:
            del markers[mid]

    def enc_list(lst, level):
        if not lst:
            emit("[]")
            return
        mid = enter(lst)
        emit("[")
        if indent is not None:
            level += 1
            nl = "\n" + indent * level
            sep = item_sep + nl
            emit(nl)
        else:
            nl = None
            sep = item_sep
        first = True
        for v in lst:
            if not first:
                emit(sep)
            first = False
            enc(v, level)
        if nl is not None:
            level -= 1
            emit("\n" + indent * level)
        emit("]")
        leave(mid)

    def enc_dict(d, level):
        if not d:
            emit("{}")
            return
        mid = enter(d)
        emit("{")
        if indent is not None:
            level += 1
            nl = "\n" + indent * level
            sep = item_sep + nl
            emit(nl)
        else:
            nl = None
            sep = item_sep
        items = sorted(d.items()) if sort_keys else d.items()
        first = True
        for k, v in items:
            if isinstance(k, str):
                pass
            elif isinstance(k, float):
                k = floatstr(k)
            elif k is True:
                k = "true"
            elif k is False:
                k = "false"
            elif k is None:
                k = "null"
            elif isinstance(k, int):
                k = int.__repr__(k)
            elif skipkeys:
                continue
            else:
                raise TypeError("keys must be str, int, float, bool or None, "
                                "not %s" % type(k).__name__)
            if not first:
                emit(sep)
            first = False
            emit(enc_str(k))
            emit(key_sep)
            enc(v, level)
        if nl is not None:
            level -= 1
            emit("\n" + indent * level)
        emit("}")
        leave(mid)

    enc(obj, 0)
    return "".join(out)


# ------------------------------------------------------------------ decoding

_WS = " \t\n\r"
_HEX = "0123456789abcdefABCDEF"
_DIGITS = "0123456789"
_BACK = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f",
         "n": "\n", "r": "\r", "t": "\t"}


class _Stop(Exception):
    def __init__(self, idx):
        Exception.__init__(self, idx)
        self.idx = idx


def _hex4(s, upos):
    """Parse 4 hex digits after the 'u' at upos; error at upos."""
    esc = s[upos + 1:upos + 5]
    if len(esc) != 4 or any(c not in _HEX for c in esc):
        raise JSONDecodeError("Invalid \\uXXXX escape", s, upos)
    return int(esc, 16)


def _scanstring(s, end, strict):
    """end is just after the opening quote. Returns (str, index after the
    closing quote)."""
    begin = end - 1
    n = len(s)
    chunks = []
    while True:
        i = end
        while i < n:
            c = s[i]
            if c == '"' or c == "\\" or (strict and c < " "):
                break
            i += 1
        if i >= n:
            raise JSONDecodeError("Unterminated string starting at", s, begin)
        if i > end:
            chunks.append(s[end:i])
        c = s[i]
        if c == '"':
            return "".join(chunks), i + 1
        if c != "\\":
            raise JSONDecodeError("Invalid control character at", s, i)
        i += 1
        if i >= n:
            raise JSONDecodeError("Unterminated string starting at", s, begin)
        esc = s[i]
        if esc != "u":
            ch = _BACK.get(esc)
            if ch is None:
                raise JSONDecodeError("Invalid \\escape", s, i - 1)
            chunks.append(ch)
            end = i + 1
            continue
        uni = _hex4(s, i)
        end = i + 5
        if 0xD800 <= uni <= 0xDBFF and s[end:end + 2] == "\\u":
            uni2 = _hex4(s, end + 1)
            if 0xDC00 <= uni2 <= 0xDFFF:
                uni = 0x10000 + (((uni - 0xD800) << 10) | (uni2 - 0xDC00))
                end += 6
        chunks.append(chr(uni))


class _Decoder:
    def __init__(self, s, strict, object_hook, object_pairs_hook,
                 parse_float, parse_int, parse_constant):
        self.s = s
        self.n = len(s)
        self.strict = strict
        self.object_hook = object_hook
        self.object_pairs_hook = object_pairs_hook
        self.parse_float = parse_float or float
        self.parse_int = parse_int or int
        self.parse_constant = parse_constant or _CONSTANTS.__getitem__

    def ws(self, i):
        s, n = self.s, self.n
        while i < n and s[i] in _WS:
            i += 1
        return i

    def value(self, i):
        s, n = self.s, self.n
        if i >= n:
            raise _Stop(i)
        c = s[i]
        if c == '"':
            return _scanstring(s, i + 1, self.strict)
        if c == "{":
            return self.obj(i + 1)
        if c == "[":
            return self.arr(i + 1)
        if c == "n" and s.startswith("null", i):
            return None, i + 4
        if c == "t" and s.startswith("true", i):
            return True, i + 4
        if c == "f" and s.startswith("false", i):
            return False, i + 5
        if c == "N" and s.startswith("NaN", i):
            return self.parse_constant("NaN"), i + 3
        if c == "I" and s.startswith("Infinity", i):
            return self.parse_constant("Infinity"), i + 8
        if c == "-" and s.startswith("-Infinity", i):
            return self.parse_constant("-Infinity"), i + 9
        return self.number(i)

    def number(self, start):
        s, n = self.s, self.n
        i = start
        if s[i] == "-":
            i += 1
            if i >= n:
                raise _Stop(start)
        if "1" <= s[i] <= "9":
            i += 1
            while i < n and s[i] in _DIGITS:
                i += 1
        elif s[i] == "0":
            i += 1
        else:
            raise _Stop(start)
        is_float = False
        if i + 1 < n and s[i] == "." and s[i + 1] in _DIGITS:
            is_float = True
            i += 2
            while i < n and s[i] in _DIGITS:
                i += 1
        if i < n and s[i] in "eE":
            e = i
            i += 1
            if i < n and s[i] in "+-":
                i += 1
            j = i
            while i < n and s[i] in _DIGITS:
                i += 1
            if i > j:
                is_float = True
            else:
                i = e
        text = s[start:i]
        if is_float:
            return self.parse_float(text), i
        return self.parse_int(text), i

    def obj(self, i):
        s, n = self.s, self.n
        pairs = []
        i = self.ws(i)
        if i < n and s[i] == "}":
            i += 1
        else:
            while True:
                if i >= n or s[i] != '"':
                    raise JSONDecodeError(
                        "Expecting property name enclosed in double quotes", s, i)
                key, i = _scanstring(s, i + 1, self.strict)
                i = self.ws(i)
                if i >= n or s[i] != ":":
                    raise JSONDecodeError("Expecting ':' delimiter", s, i)
                i = self.ws(i + 1)
                try:
                    val, i = self.value(i)
                except _Stop as e:
                    raise JSONDecodeError("Expecting value", s, e.idx) from None
                pairs.append((key, val))
                i = self.ws(i)
                if i < n and s[i] == "}":
                    i += 1
                    break
                if i >= n or s[i] != ",":
                    raise JSONDecodeError("Expecting ',' delimiter", s, i)
                comma = i
                i = self.ws(i + 1)
                if i < n and s[i] == "}":
                    raise JSONDecodeError(
                        "Illegal trailing comma before end of object", s, comma)
        if self.object_pairs_hook is not None:
            return self.object_pairs_hook(pairs), i
        d = dict(pairs)
        if self.object_hook is not None:
            d = self.object_hook(d)
        return d, i

    def arr(self, i):
        s, n = self.s, self.n
        values = []
        i = self.ws(i)
        if i < n and s[i] == "]":
            return values, i + 1
        while True:
            try:
                val, i = self.value(i)
            except _Stop as e:
                raise JSONDecodeError("Expecting value", s, e.idx) from None
            values.append(val)
            i = self.ws(i)
            if i < n and s[i] == "]":
                return values, i + 1
            if i >= n or s[i] != ",":
                raise JSONDecodeError("Expecting ',' delimiter", s, i)
            comma = i
            i = self.ws(i + 1)
            if i < n and s[i] == "]":
                raise JSONDecodeError(
                    "Illegal trailing comma before end of array", s, comma)


_CONSTANTS = {"NaN": float("nan"), "Infinity": float("inf"),
              "-Infinity": float("-inf")}


def loads(s, *, cls=None, object_hook=None, parse_float=None, parse_int=None,
          parse_constant=None, object_pairs_hook=None, strict=True, **kw):
    if not isinstance(s, str):
        raise TypeError("the JSON object must be str, not %s"
                        % type(s).__name__)
    if s.startswith("\ufeff"):
        raise JSONDecodeError("Unexpected UTF-8 BOM (decode using utf-8-sig)",
                              s, 0)
    dec = _Decoder(s, strict, object_hook, object_pairs_hook,
                   parse_float, parse_int, parse_constant)
    i = dec.ws(0)
    try:
        obj, end = dec.value(i)
    except _Stop as e:
        raise JSONDecodeError("Expecting value", s, e.idx) from None
    end = dec.ws(end)
    if end != len(s):
        raise JSONDecodeError("Extra data", s, end)
    return obj
