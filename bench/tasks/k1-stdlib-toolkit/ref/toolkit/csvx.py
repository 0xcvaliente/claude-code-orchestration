"""Reference implementation of toolkit.csvx: reader and writer that mirror the
standard library's `csv` module (Python 3.13) for the subset described in
spec/csv.md.  Pure Python, imports nothing on the blocked list."""

__all__ = [
    "reader", "writer", "Error", "Dialect", "QUOTE_MINIMAL", "QUOTE_ALL",
    "QUOTE_NONNUMERIC", "QUOTE_NONE", "QUOTE_STRINGS", "QUOTE_NOTNULL",
    "list_dialects", "get_dialect",
]

QUOTE_MINIMAL = 0
QUOTE_ALL = 1
QUOTE_NONNUMERIC = 2
QUOTE_NONE = 3
QUOTE_STRINGS = 4
QUOTE_NOTNULL = 5

_QUOTINGS = (QUOTE_MINIMAL, QUOTE_ALL, QUOTE_NONNUMERIC, QUOTE_NONE,
             QUOTE_STRINGS, QUOTE_NOTNULL)


class Error(Exception):
    pass


_PRESETS = {
    "excel": dict(delimiter=",", quotechar='"', escapechar=None, doublequote=True,
                  skipinitialspace=False, lineterminator="\r\n",
                  quoting=QUOTE_MINIMAL, strict=False),
    "excel-tab": dict(delimiter="\t", quotechar='"', escapechar=None, doublequote=True,
                      skipinitialspace=False, lineterminator="\r\n",
                      quoting=QUOTE_MINIMAL, strict=False),
    "unix": dict(delimiter=",", quotechar='"', escapechar=None, doublequote=True,
                 skipinitialspace=False, lineterminator="\n",
                 quoting=QUOTE_ALL, strict=False),
}

_PARAMS = ("delimiter", "doublequote", "escapechar", "lineterminator",
           "quotechar", "quoting", "skipinitialspace", "strict")


def list_dialects():
    return list(_PRESETS)


class Dialect:
    """Validated, read-only formatting parameters."""

    def __init__(self, dialect="excel", **kw):
        for k in kw:
            if k not in _PARAMS:
                raise TypeError("this function got an unexpected keyword "
                                "argument %r" % k)
        if isinstance(dialect, str):
            if dialect not in _PRESETS:
                raise Error("unknown dialect")
            base = dict(_PRESETS[dialect])
        elif isinstance(dialect, Dialect):
            base = {p: getattr(dialect, p) for p in _PARAMS}
        else:
            base = {p: getattr(dialect, p, _PRESETS["excel"][p]) for p in _PARAMS}
        quoting_given = "quoting" in kw
        params = dict(base)
        params.update(kw)

        delimiter = _char("delimiter", params["delimiter"], allow_none=False)
        doublequote = bool(params["doublequote"])
        escapechar = _char("escapechar", params["escapechar"], allow_none=True)
        lt = params["lineterminator"]
        if lt is None:
            raise TypeError("lineterminator must be set")
        if not isinstance(lt, str):
            raise TypeError('"lineterminator" must be a string')
        quotechar = _char("quotechar", params["quotechar"], allow_none=True)
        quoting = params["quoting"]
        if isinstance(quoting, bool) or not isinstance(quoting, int):
            raise TypeError('"quoting" must be an integer')
        if quoting not in _QUOTINGS:
            raise TypeError('bad "quoting" value')
        skipinitialspace = bool(params["skipinitialspace"])
        strict = bool(params["strict"])

        if "quotechar" in kw and kw["quotechar"] is None and not quoting_given:
            quoting = QUOTE_NONE
        if quoting != QUOTE_NONE and quotechar is None:
            raise TypeError("quotechar must be set if quoting enabled")

        _check_char("delimiter", delimiter, lt, True)
        _check_char("escapechar", escapechar, lt, not skipinitialspace)
        _check_char("quotechar", quotechar, lt, not skipinitialspace)
        _check_pair("delimiter", "escapechar", delimiter, escapechar)
        _check_pair("delimiter", "quotechar", delimiter, quotechar)
        _check_pair("escapechar", "quotechar", escapechar, quotechar)

        object.__setattr__(self, "delimiter", delimiter)
        object.__setattr__(self, "doublequote", doublequote)
        object.__setattr__(self, "escapechar", escapechar)
        object.__setattr__(self, "lineterminator", lt)
        object.__setattr__(self, "quotechar", quotechar)
        object.__setattr__(self, "quoting", quoting)
        object.__setattr__(self, "skipinitialspace", skipinitialspace)
        object.__setattr__(self, "strict", strict)

    def __setattr__(self, name, value):
        raise AttributeError("attribute %r of Dialect objects is not writable" % name)


def _char(name, value, allow_none):
    if value is None:
        if allow_none:
            return None
        raise TypeError('"%s" must be string, not NoneType' % name)
    if not isinstance(value, str):
        raise TypeError('"%s" must be string, not %s' % (name, type(value).__name__))
    if len(value) != 1:
        raise TypeError('"%s" must be a 1-character string' % name)
    return value


def _check_char(name, c, lineterminator, allowspace):
    if c is None:
        return
    if c in ("\r", "\n") or (c == " " and not allowspace):
        raise ValueError("bad %s value" % name)
    if c in lineterminator:
        raise ValueError("bad %s or lineterminator value" % name)


def _check_pair(n1, n2, c1, c2):
    if c1 is not None and c1 == c2:
        raise ValueError("bad %s or %s value" % (n1, n2))


def get_dialect(name):
    if name not in _PRESETS:
        raise Error("unknown dialect")
    return Dialect(name)


# ------------------------------------------------------------------- reader

_START_RECORD, _START_FIELD, _ESCAPED_CHAR, _IN_FIELD, _IN_QUOTED_FIELD, \
    _ESCAPE_IN_QUOTED_FIELD, _QUOTE_IN_QUOTED_FIELD, _EAT_CRNL, \
    _AFTER_ESCAPED_CRNL = range(9)

_EOL = object()


class _Reader:
    def __init__(self, iterable, dialect, kw):
        self._it = iter(iterable)
        self.dialect = Dialect(dialect, **kw)
        self.line_num = 0
        self._reset()

    def _reset(self):
        self._fields = []
        self._field = []
        self._state = _START_RECORD
        self._unquoted = True

    def __iter__(self):
        return self

    def _save_field(self):
        d = self.dialect
        text = "".join(self._field)
        if self._unquoted and not text and d.quoting in (QUOTE_NOTNULL, QUOTE_STRINGS):
            value = None
        elif self._unquoted and text and d.quoting in (QUOTE_NONNUMERIC, QUOTE_STRINGS):
            value = float(text)
        else:
            value = text
        self._fields.append(value)
        self._field = []
        self._unquoted = True

    def _add(self, c):
        self._field.append(c)

    def _process(self, c):
        d = self.dialect
        st = self._state
        if st == _START_RECORD:
            if c is _EOL:
                return
            if c == "\n" or c == "\r":
                self._state = _EAT_CRNL
                return
            st = self._state = _START_FIELD
        if st == _START_FIELD:
            if c is _EOL or c == "\n" or c == "\r":
                self._save_field()
                self._state = _START_RECORD if c is _EOL else _EAT_CRNL
            elif c == d.quotechar and d.quoting != QUOTE_NONE:
                self._unquoted = False
                self._state = _IN_QUOTED_FIELD
            elif c == d.escapechar:
                self._state = _ESCAPED_CHAR
            elif c == " " and d.skipinitialspace:
                pass
            elif c == d.delimiter:
                self._save_field()
            else:
                self._add(c)
                self._state = _IN_FIELD
            return
        if st == _ESCAPED_CHAR:
            if c == "\n" or c == "\r":
                self._add(c)
                self._state = _AFTER_ESCAPED_CRNL
                return
            if c is _EOL:
                c = "\n"
            self._add(c)
            self._state = _IN_FIELD
            return
        if st == _AFTER_ESCAPED_CRNL:
            if c is _EOL:
                return
            st = _IN_FIELD
        if st == _IN_FIELD:
            if c is _EOL or c == "\n" or c == "\r":
                self._save_field()
                self._state = _START_RECORD if c is _EOL else _EAT_CRNL
            elif c == d.escapechar:
                self._state = _ESCAPED_CHAR
            elif c == d.delimiter:
                self._save_field()
                self._state = _START_FIELD
            else:
                # like _csv.c: the state is left alone, so a field that began
                # after an escaped newline stays in _AFTER_ESCAPED_CRNL
                self._add(c)
            return
        if st == _IN_QUOTED_FIELD:
            if c is _EOL:
                pass
            elif c == d.escapechar:
                self._state = _ESCAPE_IN_QUOTED_FIELD
            elif c == d.quotechar and d.quoting != QUOTE_NONE:
                if d.doublequote:
                    self._state = _QUOTE_IN_QUOTED_FIELD
                else:
                    self._state = _IN_FIELD
            else:
                self._add(c)
            return
        if st == _ESCAPE_IN_QUOTED_FIELD:
            if c is _EOL:
                c = "\n"
            self._add(c)
            self._state = _IN_QUOTED_FIELD
            return
        if st == _QUOTE_IN_QUOTED_FIELD:
            if d.quoting != QUOTE_NONE and c == d.quotechar:
                self._add(c)
                self._state = _IN_QUOTED_FIELD
            elif c == d.delimiter:
                self._save_field()
                self._state = _START_FIELD
            elif c is _EOL or c == "\n" or c == "\r":
                self._save_field()
                self._state = _START_RECORD if c is _EOL else _EAT_CRNL
            elif not d.strict:
                self._add(c)
                self._state = _IN_FIELD
            else:
                raise Error("'%c' expected after '%c'" % (d.delimiter, d.quotechar))
            return
        if st == _EAT_CRNL:
            if c == "\n" or c == "\r":
                pass
            elif c is _EOL:
                self._state = _START_RECORD
            else:
                raise Error("new-line character seen in unquoted field - do you "
                            "need to open the file with newline=''?")
            return

    def __next__(self):
        self._reset()
        while True:
            try:
                line = next(self._it)
            except StopIteration:
                if self._field or self._state == _IN_QUOTED_FIELD:
                    if self.dialect.strict:
                        raise Error("unexpected end of data")
                    self._save_field()
                    break
                raise
            if not isinstance(line, str):
                raise Error("iterator should return strings, not %s (the file "
                            "should be opened in text mode)" % type(line).__name__)
            self.line_num += 1
            for ch in line:
                self._process(ch)
            self._process(_EOL)
            if self._state == _START_RECORD:
                break
        fields = self._fields
        self._fields = []
        return fields


def reader(iterable, dialect="excel", **fmtparams):
    return _Reader(iterable, dialect, fmtparams)


# ------------------------------------------------------------------- writer

def _is_number(x):
    if isinstance(x, (int, float, complex)):
        return True
    return hasattr(type(x), "__float__") or hasattr(type(x), "__index__") \
        or hasattr(type(x), "__int__")


class _Writer:
    def __init__(self, fileobj, dialect, kw):
        try:
            self._write = fileobj.write
        except AttributeError:
            raise TypeError('argument 1 must have a "write" method') from None
        self.dialect = Dialect(dialect, **kw)

    def _field(self, field):
        d = self.dialect
        q = d.quoting
        if q == QUOTE_NONNUMERIC:
            quoted = not _is_number(field)
        elif q == QUOTE_ALL:
            quoted = True
        elif q == QUOTE_STRINGS:
            quoted = isinstance(field, str)
        elif q == QUOTE_NOTNULL:
            quoted = field is not None
        else:
            quoted = False
        null = field is None
        if isinstance(field, str):
            text = field
        elif null:
            text = ""
        else:
            text = str(field)
        out = []
        for c in text:
            want_escape = False
            if (c == d.delimiter or c == d.escapechar or c == d.quotechar or
                    c == "\n" or c == "\r" or c in d.lineterminator):
                if q == QUOTE_NONE:
                    want_escape = True
                else:
                    if c == d.quotechar:
                        if d.doublequote:
                            out.append(d.quotechar)
                        else:
                            want_escape = True
                    elif c == d.escapechar:
                        want_escape = True
                    if not want_escape:
                        quoted = True
                if want_escape:
                    if d.escapechar is None:
                        raise Error("need to escape, but no escapechar set")
                    out.append(d.escapechar)
            out.append(c)
        if not text and d.delimiter == " " and d.skipinitialspace:
            if q == QUOTE_NONE or (null and q in (QUOTE_STRINGS, QUOTE_NOTNULL)):
                raise Error("empty field must be quoted if delimiter is a space "
                            "and skipinitialspace is true")
            quoted = True
        body = "".join(out)
        if quoted:
            body = d.quotechar + body + d.quotechar
        return body, null

    def writerow(self, row):
        d = self.dialect
        try:
            it = iter(row)
        except TypeError:
            raise Error("iterable expected, not %s" % type(row).__name__) from None
        parts = []
        last_null = False
        for field in it:
            body, last_null = self._field(field)
            parts.append(body)
        line = d.delimiter.join(parts)
        if len(parts) == 1 and line == "":
            q = d.quoting
            if q == QUOTE_NONE or (last_null and q in (QUOTE_STRINGS, QUOTE_NOTNULL)):
                raise Error("single empty field record must be quoted")
            line = d.quotechar * 2
        return self._write(line + d.lineterminator)

    def writerows(self, rows):
        for row in rows:
            self.writerow(row)
        return None


def writer(fileobj, dialect="excel", **fmtparams):
    return _Writer(fileobj, dialect, fmtparams)
