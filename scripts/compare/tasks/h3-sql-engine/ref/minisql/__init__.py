"""minisql: an in-memory SQL engine. See SPEC.md."""
import re
import math
from decimal import Decimal, ROUND_HALF_UP


class Error(Exception):
    """Raised for every invalid statement."""


# ---------------------------------------------------------------- lexer
KEYWORDS = set("""SELECT FROM WHERE GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET UNION ALL INTERSECT
EXCEPT JOIN INNER CROSS LEFT OUTER ON AS DISTINCT AND OR NOT IN IS NULL LIKE BETWEEN CASE WHEN THEN
ELSE END CAST EXISTS INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE DROP IF PRIMARY KEY UNIQUE
WITH OVER PARTITION""".split())

TOKRE = re.compile(r"""\s+|--[^\n]*|(?P<num>(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|(?P<str>'(?:[^']|'')*')|(?P<id>[A-Za-z_][A-Za-z0-9_]*)|(?P<qid>"(?:[^"]|"")*")|(?P<op>\|\||<=|>=|==|!=|<>|[-+*/%(),.;<>=])""")


def tokenize(sql):
    toks = []
    pos = 0
    n = len(sql)
    while pos < n:
        m = TOKRE.match(sql, pos)
        if not m:
            raise Error("unrecognized token near %r" % sql[pos:pos + 10])
        pos = m.end()
        k = m.lastgroup
        if k is None:
            continue
        t = m.group(k)
        if k == 'num':
            if re.fullmatch(r'\d+', t):
                v = int(t)
                toks.append(('num', v if v < 2 ** 63 else float(t)))
            else:
                toks.append(('num', float(t)))
        elif k == 'str':
            toks.append(('str', t[1:-1].replace("''", "'")))
        elif k == 'qid':
            toks.append(('id', t[1:-1].replace('""', '"').lower()))
        elif k == 'id':
            u = t.upper()
            if u in KEYWORDS:
                toks.append(('kw', u))
            else:
                toks.append(('id', t.lower()))
        else:
            toks.append(('op', '!=' if t == '<>' else ('=' if t == '==' else t)))
    toks.append(('eof', None))
    return toks


# ---------------------------------------------------------------- parser
class Parser:
    def __init__(self, sql):
        self.t = tokenize(sql)
        self.i = 0

    def peek(self, k=0):
        return self.t[self.i + k]

    def next(self):
        tok = self.t[self.i]
        self.i += 1
        return tok

    def iskw(self, *kws):
        tok = self.t[self.i]
        return tok[0] == 'kw' and tok[1] in kws

    def isop(self, *ops):
        tok = self.t[self.i]
        return tok[0] == 'op' and tok[1] in ops

    def acceptkw(self, kw):
        if self.iskw(kw):
            self.i += 1
            return True
        return False

    def acceptop(self, op):
        if self.isop(op):
            self.i += 1
            return True
        return False

    def expectkw(self, kw):
        if not self.acceptkw(kw):
            raise Error("syntax error: expected %s near %r" % (kw, self.peek()[1]))

    def expectop(self, op):
        if not self.acceptop(op):
            raise Error("syntax error: expected %s near %r" % (op, self.peek()[1]))

    def ident(self):
        tok = self.next()
        if tok[0] != 'id':
            raise Error("syntax error near %r" % (tok[1],))
        return tok[1]

    def statement(self):
        if self.iskw('SELECT', 'WITH'):
            st = ('select', self.select())
        elif self.iskw('INSERT'):
            st = self.insert()
        elif self.iskw('UPDATE'):
            st = self.update()
        elif self.iskw('DELETE'):
            st = self.delete()
        elif self.iskw('CREATE'):
            st = self.create()
        elif self.iskw('DROP'):
            self.next()
            self.expectkw('TABLE')
            ife = False
            if self.acceptkw('IF'):
                self.expectkw('EXISTS')
                ife = True
            st = ('drop', self.ident(), ife)
        else:
            raise Error("syntax error near %r" % (self.peek()[1],))
        self.acceptop(';')
        if self.peek()[0] != 'eof':
            raise Error("syntax error near %r" % (self.peek()[1],))
        return st

    def create(self):
        self.expectkw('CREATE')
        self.expectkw('TABLE')
        ine = False
        if self.acceptkw('IF'):
            self.expectkw('NOT')
            self.expectkw('EXISTS')
            ine = True
        name = self.ident()
        self.expectop('(')
        cols = []
        while True:
            cname = self.ident()
            ctype = ''
            while self.peek()[0] == 'id':
                ctype += self.next()[1].upper() + ' '
            if self.acceptop('('):
                while not self.acceptop(')'):
                    self.next()
            pk = nn = uq = False
            while True:
                if self.acceptkw('PRIMARY'):
                    self.expectkw('KEY')
                    pk = True
                    if self.acceptkw('ASC') or self.acceptkw('DESC'):
                        pass
                elif self.acceptkw('NOT'):
                    self.expectkw('NULL')
                    nn = True
                elif self.acceptkw('UNIQUE'):
                    uq = True
                elif self.acceptkw('NULL'):
                    pass
                else:
                    break
            cols.append((cname, ctype.strip(), pk, nn, uq or pk))
            if self.acceptop(')'):
                break
            self.expectop(',')
        return ('create', name, cols, ine)

    def insert(self):
        self.expectkw('INSERT')
        self.expectkw('INTO')
        name = self.ident()
        cols = None
        if self.acceptop('('):
            cols = [self.ident()]
            while self.acceptop(','):
                cols.append(self.ident())
            self.expectop(')')
        if self.acceptkw('VALUES'):
            rows = []
            while True:
                self.expectop('(')
                r = [self.expr()]
                while self.acceptop(','):
                    r.append(self.expr())
                self.expectop(')')
                rows.append(r)
                if not self.acceptop(','):
                    break
            return ('insert', name, cols, rows, None)
        if self.iskw('SELECT', 'WITH'):
            return ('insert', name, cols, None, self.select())
        raise Error("syntax error in INSERT")

    def update(self):
        self.expectkw('UPDATE')
        name = self.ident()
        self.expectkw('SET')
        sets = []
        while True:
            c = self.ident()
            self.expectop('=')
            sets.append((c, self.expr()))
            if not self.acceptop(','):
                break
        where = self.expr() if self.acceptkw('WHERE') else None
        return ('update', name, sets, where)

    def delete(self):
        self.expectkw('DELETE')
        self.expectkw('FROM')
        name = self.ident()
        where = self.expr() if self.acceptkw('WHERE') else None
        return ('delete', name, where)

    def select(self):
        withs = []
        if self.acceptkw('WITH'):
            while True:
                name = self.ident()
                cols = None
                if self.acceptop('('):
                    cols = [self.ident()]
                    while self.acceptop(','):
                        cols.append(self.ident())
                    self.expectop(')')
                self.expectkw('AS')
                self.expectop('(')
                s = self.select()
                self.expectop(')')
                withs.append((name, cols, s))
                if not self.acceptop(','):
                    break
        cores = [self.core()]
        ops = []
        while True:
            if self.acceptkw('UNION'):
                ops.append('unionall' if self.acceptkw('ALL') else 'union')
            elif self.acceptkw('INTERSECT'):
                ops.append('intersect')
            elif self.acceptkw('EXCEPT'):
                ops.append('except')
            else:
                break
            cores.append(self.core())
        order = []
        if self.acceptkw('ORDER'):
            self.expectkw('BY')
            order = self.orderlist()
        limit = offset = None
        if self.acceptkw('LIMIT'):
            limit = self.expr()
            if self.acceptkw('OFFSET'):
                offset = self.expr()
            elif self.acceptop(','):
                offset = limit
                limit = self.expr()
        return {'with': withs, 'cores': cores, 'ops': ops, 'order': order,
                'limit': limit, 'offset': offset}

    def orderlist(self):
        order = []
        while True:
            e = self.expr()
            desc = False
            if self.acceptkw('DESC'):
                desc = True
            else:
                self.acceptkw('ASC')
            order.append((e, desc))
            if not self.acceptop(','):
                break
        return order

    def core(self):
        self.expectkw('SELECT')
        distinct = False
        if self.acceptkw('DISTINCT'):
            distinct = True
        else:
            self.acceptkw('ALL')
        cols = []
        while True:
            if self.acceptop('*'):
                cols.append(('star', None))
            elif self.peek()[0] == 'id' and self.peek(1) == ('op', '.') and self.peek(2) == ('op', '*'):
                q = self.ident()
                self.next()
                self.next()
                cols.append(('star', q))
            else:
                e = self.expr()
                alias = None
                if self.acceptkw('AS'):
                    alias = self.ident() if self.peek()[0] == 'id' else self.next()[1]
                elif self.peek()[0] == 'id':
                    alias = self.ident()
                elif self.peek()[0] == 'str':
                    alias = self.next()[1]
                cols.append(('expr', e, alias))
            if not self.acceptop(','):
                break
        frm = []
        if self.acceptkw('FROM'):
            frm.append(('first', self.tref(), None))
            while True:
                if self.acceptop(','):
                    jt = 'inner'
                elif self.acceptkw('JOIN'):
                    jt = 'inner'
                elif self.acceptkw('INNER') or self.acceptkw('CROSS'):
                    self.expectkw('JOIN')
                    jt = 'inner'
                elif self.acceptkw('LEFT'):
                    self.acceptkw('OUTER')
                    self.expectkw('JOIN')
                    jt = 'left'
                else:
                    break
                t = self.tref()
                on = self.expr() if self.acceptkw('ON') else None
                frm.append((jt, t, on))
        where = self.expr() if self.acceptkw('WHERE') else None
        group = []
        if self.acceptkw('GROUP'):
            self.expectkw('BY')
            group = [self.expr()]
            while self.acceptop(','):
                group.append(self.expr())
        having = self.expr() if self.acceptkw('HAVING') else None
        return {'distinct': distinct, 'cols': cols, 'from': frm, 'where': where,
                'group': group, 'having': having}

    def tref(self):
        if self.acceptop('('):
            s = self.select()
            self.expectop(')')
            self.acceptkw('AS')
            alias = self.ident() if self.peek()[0] == 'id' else None
            return ('sub', s, alias)
        name = self.ident()
        alias = name
        if self.acceptkw('AS'):
            alias = self.ident()
        elif self.peek()[0] == 'id':
            alias = self.ident()
        return ('table', name, alias)

    # expressions
    def expr(self):
        return self.climb(0)

    def p_not(self):
        return self.climb(3)

    def p_cmp(self):
        return self.climb(5)

    BINPREC = {'||': 8, '*': 7, '/': 7, '%': 7, '+': 6, '-': 6, '<': 5, '<=': 5, '>': 5, '>=': 5,
               '=': 4, '!=': 4}

    def climb(self, minp):
        tok = self.peek()
        if tok == ('kw', 'NOT'):
            self.next()
            lhs = ('not', self.climb(3))
        elif tok[0] == 'op' and tok[1] in ('-', '+'):
            self.next()
            lhs = ('un', tok[1], self.climb(9))
        else:
            lhs = self.primary()
        while True:
            tok = self.peek()
            k, v = tok
            if k == 'op' and v in self.BINPREC:
                p = self.BINPREC[v]
                if p < minp:
                    break
                self.next()
                lhs = ('bin', v, lhs, self.climb(p + 1))
            elif k == 'kw':
                if v == 'OR':
                    if 1 < minp:
                        break
                    self.next()
                    lhs = ('or', lhs, self.climb(2))
                elif v == 'AND':
                    if 2 < minp:
                        break
                    self.next()
                    lhs = ('and', lhs, self.climb(3))
                elif v == 'IS':
                    if 4 < minp:
                        break
                    self.next()
                    neg = self.acceptkw('NOT')
                    lhs = ('is', lhs, self.climb(5), neg)
                elif v in ('IN', 'LIKE', 'BETWEEN'):
                    if 4 < minp:
                        break
                    lhs = self.p_suffix(lhs, False)
                elif v == 'NOT' and self.peek(1)[0] == 'kw' and self.peek(1)[1] in ('IN', 'LIKE', 'BETWEEN'):
                    if 4 < minp:
                        break
                    self.next()
                    lhs = self.p_suffix(lhs, True)
                else:
                    break
            else:
                break
        return lhs

    def p_suffix(self, e, neg):
        kw = self.next()[1]
        if kw == 'IN':
            self.expectop('(')
            if self.iskw('SELECT', 'WITH'):
                s = self.select()
                self.expectop(')')
                return ('insub', e, s, neg)
            items = []
            if not self.isop(')'):
                items.append(self.expr())
                while self.acceptop(','):
                    items.append(self.expr())
            self.expectop(')')
            return ('in', e, items, neg)
        if kw == 'LIKE':
            return ('like', e, self.p_cmp(), neg)
        lo = self.p_not()
        self.expectkw('AND')
        hi = self.p_cmp()
        return ('between', e, lo, hi, neg)

    def primary(self):
        tok = self.next()
        k, v = tok
        if k == 'num' or k == 'str':
            return ('lit', v)
        if k == 'kw':
            if v == 'NULL':
                return ('lit', None)
            if v == 'CASE':
                base = None
                if not self.iskw('WHEN'):
                    base = self.expr()
                whens = []
                while self.acceptkw('WHEN'):
                    c = self.expr()
                    self.expectkw('THEN')
                    whens.append((c, self.expr()))
                if not whens:
                    raise Error("syntax error in CASE")
                els = self.expr() if self.acceptkw('ELSE') else None
                self.expectkw('END')
                return ('case', base, whens, els)
            if v == 'CAST':
                self.expectop('(')
                e = self.expr()
                self.expectkw('AS')
                t = self.ident().upper()
                self.expectop(')')
                return ('cast', e, t)
            if v == 'EXISTS':
                self.expectop('(')
                s = self.select()
                self.expectop(')')
                return ('exists', s)
            raise Error("syntax error near %r" % v)
        if k == 'op' and v == '(':
            if self.iskw('SELECT', 'WITH'):
                s = self.select()
                self.expectop(')')
                return ('subq', s)
            e = self.expr()
            self.expectop(')')
            return e
        if k == 'id':
            if self.acceptop('('):
                distinct = star = False
                args = []
                if self.acceptop('*'):
                    star = True
                else:
                    if self.acceptkw('DISTINCT'):
                        distinct = True
                    if not self.isop(')'):
                        args.append(self.expr())
                        while self.acceptop(','):
                            args.append(self.expr())
                self.expectop(')')
                over = None
                if self.acceptkw('OVER'):
                    self.expectop('(')
                    part = []
                    order = []
                    if self.acceptkw('PARTITION'):
                        self.expectkw('BY')
                        part = [self.expr()]
                        while self.acceptop(','):
                            part.append(self.expr())
                    if self.acceptkw('ORDER'):
                        self.expectkw('BY')
                        order = self.orderlist()
                    self.expectop(')')
                    over = (part, order)
                return ('func', v, args, distinct, star, over)
            if self.acceptop('.'):
                return ('col', v, self.ident())
            return ('col', None, v)
        raise Error("syntax error near %r" % (v,))


# ---------------------------------------------------------------- values
def fmt_real(f):
    if f != f:
        return None
    if f in (float('inf'), float('-inf')):
        return 'Inf' if f > 0 else '-Inf'
    s = '%.15g' % f
    if 'e' in s:
        m, ex = s.split('e')
        if '.' not in m:
            m += '.0'
        s = m + 'e' + ex
    elif '.' not in s:
        s += '.0'
    return s


def to_text(v):
    if isinstance(v, str):
        return v
    if isinstance(v, float):
        return fmt_real(v)
    return str(v)


NUMPRE = re.compile(r'\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)')


def text_to_num(s):
    m = NUMPRE.match(s)
    if not m:
        return 0
    t = m.group(1)
    if re.fullmatch(r'[+-]?\d+', t):
        return int(t)
    try:
        f = float(t)
    except ValueError:
        return 0
    return f


def to_num(v):
    if isinstance(v, str):
        return text_to_num(v)
    return v


def cast(v, t):
    if v is None:
        return None
    if 'INT' in t:
        if isinstance(v, str):
            m = re.match(r'\s*([+-]?\d+)', v)
            return int(m.group(1)) if m else 0
        if isinstance(v, float):
            if math.isnan(v):
                return 0
            if math.isinf(v):
                return 2 ** 63 - 1 if v > 0 else -2 ** 63
            return max(-2 ** 63, min(2 ** 63 - 1, int(v)))
        return v
    if t in ('REAL', 'FLOAT', 'DOUBLE') or 'REAL' in t or 'FLOA' in t or 'DOUB' in t:
        if isinstance(v, str):
            return float(text_to_num(v))
        return float(v)
    if 'TEXT' in t or 'CHAR' in t or 'CLOB' in t:
        return to_text(v)
    # NUMERIC
    if isinstance(v, str):
        n = text_to_num(v)
        return n
    return v


def truth(v):
    if v is None:
        return None
    if isinstance(v, str):
        v = text_to_num(v)
    return v != 0


def skey(v):
    if v is None:
        return (0, 0)
    if isinstance(v, str):
        return (2, v)
    return (1, v)


def compare(a, b):
    """returns -1/0/1, a,b non-null"""
    ta = isinstance(a, str)
    tb = isinstance(b, str)
    if ta != tb:
        return 1 if ta else -1
    return (a > b) - (a < b)


def sql_round(x, n=0):
    if x is None or n is None:
        return None
    x = to_num(x)
    n = int(to_num(n))
    if n < 0:
        n = 0
    if isinstance(x, int):
        return float(x)
    if math.isinf(x) or math.isnan(x):
        return x
    if n > 30:
        return x
    d = Decimal(x).quantize(Decimal(1).scaleb(-n), rounding=ROUND_HALF_UP)
    return float(d)


_like_cache = {}


def like(a, b):
    if a is None or b is None:
        return None
    a = to_text(a)
    b = to_text(b)
    r = _like_cache.get(b)
    if r is None:
        p = ''
        for ch in b:
            if ch == '%':
                p += '.*'
            elif ch == '_':
                p += '.'
            else:
                p += re.escape(ch)
        r = re.compile(p, re.S | re.I | re.A)
        _like_cache[b] = r
    return 1 if r.fullmatch(a) else 0


def arith(op, a, b):
    if a is None or b is None:
        return None
    if op == '||':
        return to_text(a) + to_text(b)
    a = to_num(a)
    b = to_num(b)
    if op == '+':
        return a + b
    if op == '-':
        return a - b
    if op == '*':
        return a * b
    if op == '/':
        if b == 0:
            return None
        if isinstance(a, int) and isinstance(b, int):
            q = abs(a) // abs(b)
            return q if (a >= 0) == (b >= 0) else -q
        return a / b
    if op == '%':
        if isinstance(a, int) and isinstance(b, int):
            if b == 0:
                return None
            r = abs(a) % abs(b)
            return r if a >= 0 else -r
        a = int(a) if not isinstance(a, int) else a
        b = int(b) if not isinstance(b, int) else b
        if b == 0:
            return None
        r = abs(a) % abs(b)
        return float(r if a >= 0 else -r)
    raise Error("bad op")


def cmpop(op, a, b):
    if a is None or b is None:
        return None
    c = compare(a, b)
    if op == '=':
        return 1 if c == 0 else 0
    if op == '!=':
        return 1 if c != 0 else 0
    if op == '<':
        return 1 if c < 0 else 0
    if op == '<=':
        return 1 if c <= 0 else 0
    if op == '>':
        return 1 if c > 0 else 0
    return 1 if c >= 0 else 0


def _substr(s, start, ln=None):
    if s is None or start is None:
        return None
    s = to_text(s)
    start = int(to_num(start))
    if ln is not None:
        ln = int(to_num(ln))
    L = len(s)
    if start > 0:
        b = start - 1
    elif start == 0:
        b = -1
    else:
        b = L + start
    if ln is None:
        e = L
    elif ln >= 0:
        e = b + ln
    else:
        e = b
        b = b + ln
    b = max(b, 0)
    e = min(e, L)
    if e <= b:
        return ''
    return s[b:e]


def _instr(s, t):
    if s is None or t is None:
        return None
    return to_text(s).find(to_text(t)) + 1


def _abs(x):
    if x is None:
        return None
    x = to_num(x)
    return abs(x)


def _nn(f):
    def g(*a):
        for x in a:
            if x is None:
                return None
        return f(*a)
    return g


def _minmax(fn):
    def g(*a):
        for x in a:
            if x is None:
                return None
        best = a[0]
        for x in a[1:]:
            c = compare(x, best)
            if (c < 0) if fn == 'min' else (c > 0):
                best = x
        return best
    return g


def _coalesce(*a):
    for x in a:
        if x is not None:
            return x
    return None


def _nullif(a, b):
    if a is not None and b is not None and compare(a, b) == 0:
        return None
    return a


SCALARS = {
    'abs': (1, 1, _abs),
    'length': (1, 1, _nn(lambda s: len(to_text(s)))),
    'upper': (1, 1, _nn(lambda s: ''.join(c.upper() if c < '\x80' else c for c in to_text(s)))),
    'lower': (1, 1, _nn(lambda s: ''.join(c.lower() if c < '\x80' else c for c in to_text(s)))),
    'substr': (2, 3, _substr),
    'substring': (2, 3, _substr),
    'trim': (1, 1, _nn(lambda s: to_text(s).strip(' '))),
    'ltrim': (1, 1, _nn(lambda s: to_text(s).lstrip(' '))),
    'rtrim': (1, 1, _nn(lambda s: to_text(s).rstrip(' '))),
    'replace': (3, 3, lambda s, a, b: None if s is None or a is None else (to_text(s) if to_text(a) == '' else (None if b is None else to_text(s).replace(to_text(a), to_text(b))))),
    'instr': (2, 2, _instr),
    'coalesce': (2, 999, _coalesce),
    'ifnull': (2, 2, _coalesce),
    'nullif': (2, 2, _nullif),
    'round': (1, 2, sql_round),
    'typeof': (1, 1, lambda v: 'null' if v is None else ('integer' if isinstance(v, int) else ('real' if isinstance(v, float) else 'text'))),
}

AGGS = ('count', 'sum', 'avg', 'min', 'max', 'total')
WINONLY = ('row_number', 'rank', 'dense_rank', 'lag', 'lead')


# ---------------------------------------------------------------- compile
class Ctx:
    __slots__ = ('correlated',)

    def __init__(self):
        self.correlated = False


class Scope:
    def __init__(self, cols, parent, ctx):
        self.cols = cols
        self.parent = parent
        self.ctx = ctx
        self.used = set()
        self.byname = {}
        for i, (q, n) in enumerate(cols):
            self.byname.setdefault(n, []).append((q, i))

    def resolve(self, qual, name):
        s = self
        d = 0
        while s is not None:
            cand = s.byname.get(name)
            if cand:
                m = [i for q, i in cand if qual is None or q == qual]
                if len(m) > 1:
                    raise Error("ambiguous column name: %s" % name)
                if m:
                    s.used.add(m[0])
                    t = self
                    for _ in range(d):
                        t.ctx.correlated = True
                        t = t.parent
                    return d, m[0]
            s = s.parent
            d += 1
        raise Error("no such column: %s" % (name if qual is None else qual + '.' + name))


def colgetter(d, i):
    if d == 0:
        return lambda e: e[0][i]
    if d == 1:
        return lambda e: e[1][0][i]
    if d == 2:
        return lambda e: e[1][1][0][i]

    def g(e):
        for _ in range(d):
            e = e[1]
        return e[0][i]
    return g


def has_subquery(node):
    if isinstance(node, tuple):
        if node and node[0] in ('subq', 'exists', 'insub'):
            return True
        return any(has_subquery(x) for x in node)
    if isinstance(node, list):
        return any(has_subquery(x) for x in node)
    return False


class Compiler:
    """Compiles expressions for one select core (or DML scope)."""

    def __init__(self, db, scope, ctes, aggs=None, wins=None, refs=None):
        self.db = db
        self.scope = scope
        self.ctes = ctes
        self.aggs = aggs      # list or None (aggregates not allowed)
        self.wins = wins      # list or None
        self.refs = refs

    def c(self, n, inagg=False):
        k = n[0]
        if k == 'lit':
            v = n[1]
            return lambda e: v
        if k == 'col':
            al = getattr(self, 'aliases', None)
            if al and n[1] is None and n[2] in al and n[2] not in self.scope.byname:
                return self.c(al[n[2]], inagg)
            d, i = self.scope.resolve(n[1], n[2])
            if self.refs is not None:
                self.refs.append((d, i))
            return colgetter(d, i)
        if k == 'un':
            f = self.c(n[2], inagg)
            if n[1] == '-':
                def neg(e):
                    v = f(e)
                    if v is None:
                        return None
                    return -to_num(v)
                return neg
            return f
        if k == 'bin':
            op = n[1]
            a = self.c(n[2], inagg)
            b = self.c(n[3], inagg)
            if op in ('=', '!=', '<', '<=', '>', '>='):
                if op == '=':
                    def eq(e):
                        x = a(e)
                        if x is None:
                            return None
                        y = b(e)
                        if y is None:
                            return None
                        if (x.__class__ is str) == (y.__class__ is str):
                            return 1 if x == y else 0
                        return 0
                    return eq
                return lambda e: cmpop(op, a(e), b(e))
            return lambda e: arith(op, a(e), b(e))
        if k == 'and':
            a = self.c(n[1], inagg)
            b = self.c(n[2], inagg)

            def f_and(e):
                x = truth(a(e))
                if x is False:
                    return 0
                y = truth(b(e))
                if y is False:
                    return 0
                if x is None or y is None:
                    return None
                return 1
            return f_and
        if k == 'or':
            a = self.c(n[1], inagg)
            b = self.c(n[2], inagg)

            def f_or(e):
                x = truth(a(e))
                if x is True:
                    return 1
                y = truth(b(e))
                if y is True:
                    return 1
                if x is None or y is None:
                    return None
                return 0
            return f_or
        if k == 'not':
            a = self.c(n[1], inagg)

            def f_not(e):
                x = truth(a(e))
                if x is None:
                    return None
                return 0 if x else 1
            return f_not
        if k == 'is':
            a = self.c(n[1], inagg)
            b = self.c(n[2], inagg)
            neg = n[3]

            def f_is(e):
                x = a(e)
                y = b(e)
                if x is None or y is None:
                    r = x is None and y is None
                else:
                    r = compare(x, y) == 0
                return int(r != neg)
            return f_is
        if k == 'in':
            a = self.c(n[1], inagg)
            items = [self.c(x, inagg) for x in n[2]]
            neg = n[3]

            def f_in(e):
                x = a(e)
                if x is None:
                    return None
                hasnull = False
                for it in items:
                    y = it(e)
                    if y is None:
                        hasnull = True
                    elif compare(x, y) == 0:
                        return 0 if neg else 1
                if hasnull:
                    return None
                return 1 if neg else 0
            return f_in
        if k == 'insub':
            a = self.c(n[1], inagg)
            sub = self.subplan(n[2])
            neg = n[3]
            if sub.ncols != 1:
                raise Error("sub-select returns %d columns - expected 1" % sub.ncols)
            cache = {}

            def getset(e):
                if not sub.ctx.correlated and 'v' in cache:
                    return cache['v']
                rows = sub.run(e)
                s = set()
                hasnull = False
                for r in rows:
                    v = r[0]
                    if v is None:
                        hasnull = True
                    else:
                        s.add(v)
                cache['v'] = (s, hasnull)
                return cache['v']

            def f_insub(e):
                x = a(e)
                if x is None:
                    # NULL IN (empty) is 0
                    s, hn = getset(e)
                    if not s and not hn:
                        return 1 if neg else 0
                    return None
                s, hn = getset(e)
                if x in s:
                    # guard text vs number equality (no hashing collisions between them)
                    return 0 if neg else 1
                if hn:
                    return None
                return 1 if neg else 0
            return f_insub
        if k == 'like':
            a = self.c(n[1], inagg)
            b = self.c(n[2], inagg)
            neg = n[3]

            def f_like(e):
                r = like(a(e), b(e))
                if r is None:
                    return None
                return 1 - r if neg else r
            return f_like
        if k == 'between':
            x = self.c(n[1], inagg)
            lo = self.c(n[2], inagg)
            hi = self.c(n[3], inagg)
            neg = n[4]

            def f_between(e):
                v = x(e)
                r1 = cmpop('>=', v, lo(e))
                r2 = cmpop('<=', v, hi(e))
                if r1 == 0 or r2 == 0:
                    r = 0
                elif r1 is None or r2 is None:
                    return None
                else:
                    r = 1
                return 1 - r if neg else r
            return f_between
        if k == 'case':
            base = self.c(n[1], inagg) if n[1] is not None else None
            whens = [(self.c(w, inagg), self.c(t, inagg)) for w, t in n[2]]
            els = self.c(n[3], inagg) if n[3] is not None else (lambda e: None)

            def f_case(e):
                if base is not None:
                    bv = base(e)
                    for w, t in whens:
                        wv = w(e)
                        if bv is not None and wv is not None and compare(bv, wv) == 0:
                            return t(e)
                    return els(e)
                for w, t in whens:
                    if truth(w(e)):
                        return t(e)
                return els(e)
            return f_case
        if k == 'cast':
            a = self.c(n[1], inagg)
            t = n[2]
            return lambda e: cast(a(e), t)
        if k == 'subq':
            sub = self.subplan(n[1])
            if sub.ncols != 1:
                raise Error("sub-select returns %d columns - expected 1" % sub.ncols)
            cache = {}

            def f_subq(e):
                if not sub.ctx.correlated and 'v' in cache:
                    return cache['v']
                rows = sub.run(e, limit1=True)
                v = rows[0][0] if rows else None
                cache['v'] = v
                return v
            return f_subq
        if k == 'exists':
            sub = self.subplan(n[1])
            cache = {}

            def f_exists(e):
                if not sub.ctx.correlated and 'v' in cache:
                    return cache['v']
                v = 1 if sub.run(e, limit1=True) else 0
                cache['v'] = v
                return v
            return f_exists
        if k == 'func':
            return self.func(n, inagg)
        raise Error("bad expression")

    def subplan(self, sel):
        return SelectPlan(self.db, sel, self.scope, self.ctes)

    def func(self, n, inagg):
        _, name, args, distinct, star, over = n
        if over is not None:
            if self.wins is None:
                raise Error("misuse of window function %s()" % name)
            if name not in AGGS and name not in WINONLY:
                raise Error("no such window function: %s" % name)
            sub = Compiler(self.db, self.scope, self.ctes, self.aggs, None)
            cargs = [sub.c(a) for a in args]
            part = [sub.c(p) for p in over[0]]
            order = [(sub.c(o), d) for o, d in over[1]]
            if name in ('row_number', 'rank', 'dense_rank') and args:
                raise Error("wrong number of arguments to %s" % name)
            if name in ('lag', 'lead') and not 1 <= len(args) <= 3:
                raise Error("wrong number of arguments to %s" % name)
            if name in AGGS and not star and len(args) != 1:
                raise Error("wrong number of arguments to %s" % name)
            k = len(self.wins)
            self.wins.append((name, cargs, star, distinct, part, order))
            return lambda e: e[3][k]
        if name in WINONLY:
            raise Error("misuse of window function %s()" % name)
        if name in AGGS and (star or len(args) == 1 or (name == 'count' and not args)):
            if name in ('min', 'max') or name == 'count' or True:
                pass
            if star and name != 'count':
                raise Error("wrong number of arguments to %s" % name)
            if name == 'count' and not args and not star:
                star = True
            if self.aggs is None or inagg:
                raise Error("misuse of aggregate function %s()" % name)
            sub = Compiler(self.db, self.scope, self.ctes, self.aggs, None)
            arg = sub.c(args[0], True) if args else None
            k = len(self.aggs)
            self.aggs.append((name, arg, distinct))
            return lambda e: e[2][k]
        if name in ('min', 'max'):
            if len(args) < 2:
                raise Error("wrong number of arguments to %s" % name)
            fn = _minmax(name)
        elif name in SCALARS:
            lo, hi, fn = SCALARS[name]
            if not lo <= len(args) <= hi or star or distinct:
                raise Error("wrong number of arguments to function %s()" % name)
        else:
            raise Error("no such function: %s" % name)
        cargs = [self.c(a, inagg) for a in args]
        if len(cargs) == 1:
            a0 = cargs[0]
            return lambda e: fn(a0(e))
        if len(cargs) == 2:
            a0, a1 = cargs
            return lambda e: fn(a0(e), a1(e))
        return lambda e: fn(*[a(e) for a in cargs])


# ---------------------------------------------------------------- aggregation
def agg_compute(name, vals, distinct):
    vals = [v for v in vals if v is not None]
    if distinct:
        seen = set()
        out = []
        for v in vals:
            kk = (isinstance(v, str), v)
            if kk not in seen:
                seen.add(kk)
                out.append(v)
        vals = out
    if name == 'count':
        return len(vals)
    if name in ('sum', 'total', 'avg'):
        if not vals:
            return 0.0 if name == 'total' else None
        vals = [to_num(v) for v in vals]
        if all(isinstance(v, int) for v in vals):
            s = sum(vals)
            if name == 'avg':
                return s / len(vals)
            return float(s) if name == 'total' else s
        s = math.fsum(vals)
        if name == 'avg':
            return s / len(vals)
        return s
    if not vals:
        return None
    best = vals[0]
    for v in vals[1:]:
        c = compare(v, best)
        if (c < 0) if name == 'min' else (c > 0):
            best = v
    return best


def sort_rows(items, keyspecs):
    """items list; keyspecs list of (keyfunc, desc). Stable multi-pass."""
    for kf, desc in reversed(keyspecs):
        items.sort(key=lambda it: skey(kf(it)), reverse=desc)
    return items


# ---------------------------------------------------------------- select plan
class SelectPlan:
    def __init__(self, db, sel, outer, ctes):
        self.db = db
        self.ctx = Ctx()
        ctes = dict(ctes) if ctes else {}
        for name, cols, s in sel['with']:
            ctes[name] = CTE(db, s, cols, dict(ctes))
        self.ctes = ctes
        self.cores = [CorePlan(db, c, outer, ctes, self.ctx) for c in sel['cores']]
        self.ops = sel['ops']
        self.ncols = self.cores[0].ncols
        for c in self.cores[1:]:
            if c.ncols != self.ncols:
                raise Error("SELECTs to the left and right of UNION do not have the same number of result columns")
        self.names = self.cores[0].names
        lim = Compiler(db, Scope([], outer, self.ctx), ctes)
        self.limit = lim.c(sel['limit']) if sel['limit'] is not None else None
        self.offset = lim.c(sel['offset']) if sel['offset'] is not None else None
        order = sel['order']
        if len(self.cores) == 1:
            self.cores[0].set_order(order)
            self.order = None
        else:
            self.order = []
            for e, desc in order:
                idx = None
                if e[0] == 'lit' and isinstance(e[1], int):
                    idx = e[1] - 1
                    if not 0 <= idx < self.ncols:
                        raise Error("ORDER BY term out of range")
                elif e[0] == 'col' and e[1] is None and e[2] in self.names:
                    idx = self.names.index(e[2])
                else:
                    raise Error("ORDER BY term does not match any column in the result set")
                self.order.append((idx, desc))

    def run(self, parent, limit1=False):
        if len(self.cores) == 1:
            rows = self.cores[0].run(parent)
        else:
            rows = self.cores[0].run(parent)
            for op, core in zip(self.ops, self.cores[1:]):
                r2 = core.run(parent)
                if op == 'unionall':
                    rows = rows + r2
                elif op == 'union':
                    seen = set()
                    out = []
                    for r in rows + r2:
                        kk = rkey(r)
                        if kk not in seen:
                            seen.add(kk)
                            out.append(r)
                    rows = out
                elif op == 'intersect':
                    s2 = set(rkey(r) for r in r2)
                    seen = set()
                    out = []
                    for r in rows:
                        kk = rkey(r)
                        if kk in s2 and kk not in seen:
                            seen.add(kk)
                            out.append(r)
                    rows = out
                else:
                    s2 = set(rkey(r) for r in r2)
                    seen = set()
                    out = []
                    for r in rows:
                        kk = rkey(r)
                        if kk not in s2 and kk not in seen:
                            seen.add(kk)
                            out.append(r)
                    rows = out
                if op != 'unionall':
                    rows = sorted(rows, key=lambda r: tuple(skey(v) for v in r))
            if self.order:
                rows = list(rows)
                sort_rows(rows, [((lambda r, i=i: r[i]), d) for i, d in self.order])
        if self.limit is not None or self.offset is not None:
            env = [(), parent, None, None]
            off = 0
            if self.offset is not None:
                off = self.offset(env)
                if not isinstance(off, int):
                    off = int(to_num(off) or 0)
                off = max(off, 0)
            if self.limit is not None:
                lim = self.limit(env)
                if not isinstance(lim, int):
                    lim = int(to_num(lim) or 0)
                rows = rows[off:] if lim < 0 else rows[off:off + lim]
            else:
                rows = rows[off:]
        if limit1:
            return rows[:1]
        return rows


def rkey(r):
    return tuple((v.__class__ is str, v) for v in r)


class CTE:
    def __init__(self, db, sel, cols, ctes):
        self.db = db
        self.sel = sel
        self.cols = cols
        self.ctes = ctes
        self.cache = None
        self.plan = None

    def get(self):
        if self.plan is None:
            self.plan = SelectPlan(self.db, self.sel, None, self.ctes)
            names = self.plan.names
            if self.cols:
                if len(self.cols) != self.plan.ncols:
                    raise Error("table has %d values for %d columns" % (self.plan.ncols, len(self.cols)))
                names = self.cols
            self.names = names
        return self.plan, self.names

    def rows(self):
        if self.cache is None:
            self.cache = self.plan.run(None)
        return self.cache


class Source:
    """A FROM item: names and how to get rows."""

    def __init__(self, db, tref, outer, ctes):
        kind = tref[0]
        self.static = True
        if kind == 'table':
            name, alias = tref[1], tref[2]
            self.alias = alias
            if name in ctes:
                cte = ctes[name]
                plan, names = cte.get()
                self.names = list(names)
                self.getrows = lambda parent: cte.rows()
            else:
                t = db.tables.get(name)
                if t is None:
                    raise Error("no such table: %s" % name)
                self.names = [c[0] for c in t.cols]
                self.getrows = lambda parent: t.scan()
        else:
            plan = SelectPlan(db, tref[1], outer, ctes)
            self.alias = tref[2]
            self.names = list(plan.names)
            if plan.ctx.correlated:
                self.static = False
                self.getrows = lambda parent: plan.run(parent)
            else:
                cache = []

                def gr(parent):
                    if not cache:
                        cache.append(plan.run(parent))
                    return cache[0]
                self.getrows = gr


def split_and(e):
    if e is None:
        return []
    if e[0] == 'and':
        return split_and(e[1]) + split_and(e[2])
    return [e]


def expr_name(e):
    if e[0] == 'col':
        return e[2]
    return None


BAD = object()


class CorePlan:
    def __init__(self, db, core, outer, ctes, ctx):
        self.db = db
        self.core = core
        self.ctx = ctx
        sources = [Source(db, t, outer, ctes) for _, t, _ in core['from']]
        cols = []
        self.offsets = []
        for s in sources:
            self.offsets.append(len(cols))
            cols.extend((s.alias, n) for n in s.names)
        self.sources = sources
        scope = Scope(cols, outer, ctx)
        self.scope = scope
        self.width = len(cols)
        self.aggs = []
        self.wins = []
        comp = Compiler(db, scope, ctes, self.aggs, self.wins)
        self.comp = comp
        # result columns
        self.outs = []
        self.names = []
        for item in core['cols']:
            if item[0] == 'star':
                q = item[1]
                found = False
                for i, (cq, cn) in enumerate(cols):
                    if q is None or cq == q:
                        self.outs.append(colgetter(0, i))
                        self.names.append(cn)
                        found = True
                if not found:
                    raise Error("no such table: %s" % q if q else "no tables specified")
            else:
                self.outs.append(comp.c(item[1]))
                self.names.append(item[2] or expr_name(item[1]))
        self.ncols = len(self.outs)
        # where
        aliases = {}
        for it in core['cols']:
            if it[0] == 'expr' and it[2] and it[2] not in aliases:
                aliases[it[2]] = it[1]
        wc = Compiler(db, scope, ctes, None, None)
        wc.aliases = aliases
        self.where = wc.c(core['where']) if core['where'] is not None else None
        self.group = []
        for g in core['group']:
            if g[0] == 'lit' and isinstance(g[1], int):
                if not 1 <= g[1] <= len(core['cols']) or core['cols'][g[1] - 1][0] != 'expr':
                    raise Error("GROUP BY term out of range")
                g = core['cols'][g[1] - 1][1]
            elif g[0] == 'col' and g[1] is None and g[2] not in scope.byname:
                for it in core['cols']:
                    if it[0] == 'expr' and it[2] == g[2]:
                        g = it[1]
                        break
            self.group.append(Compiler(db, scope, ctes, None, None).c(g))
        comp.aliases = aliases
        self.having = comp.c(core['having']) if core['having'] is not None else None
        if self.having is not None and not self.aggs and not core['group']:
            raise Error("a GROUP BY clause is required before HAVING")
        self.order = []
        # join planning
        self.joins = []
        self.src_pki = []
        for jt, tr, on in core['from']:
            if tr[0] == 'table' and tr[1] not in ctes and tr[1] in db.tables:
                self.src_pki.append(db.tables[tr[1]].pki)
            else:
                self.src_pki.append(BAD)
        self.plan_driver(db, core, scope, ctes)
        self.swap = False
        wconj = split_and(core['where'])
        for j, (jt, tref, on) in enumerate(core['from']):
            lo = self.offsets[j]
            hi = lo + len(sources[j].names)
            conj = split_and(on)
            cands = conj + (wconj if jt != 'left' else [])
            key = None
            for c in cands:
                if c[0] != 'bin' or c[1] != '=' or has_subquery(c):
                    continue
                sides = []
                for side in (c[2], c[3]):
                    refs = []
                    f = Compiler(db, scope, ctes, None, None, refs).c(side)
                    loc = set()
                    for d, i in refs:
                        if d == 0:
                            if i >= hi:
                                loc.add('late')
                            elif i >= lo:
                                loc.add('right')
                            else:
                                loc.add('left')
                    sides.append((f, loc))
                (fa, la), (fb, lb) = sides
                if la == {'right'} and 'right' not in lb and 'late' not in lb:
                    key = (fa, fb)
                    lexpr, rexpr = c[3], c[2]
                elif lb == {'right'} and 'right' not in la and 'late' not in la:
                    key = (fb, fa)
                    lexpr, rexpr = c[2], c[3]
                if key:
                    if j == 1 and jt == 'inner' and len(core['from']) == 2 and outer is None:
                        def pkcol(src_i, ex):
                            tr = core['from'][src_i][1]
                            if tr[0] != 'table' or tr[1] in ctes or ex[0] != 'col':
                                return False
                            t = db.tables.get(tr[1])
                            if t is None or t.pki is None:
                                return False
                            try:
                                d, i = scope.resolve(ex[1], ex[2])
                            except Error:
                                return False
                            return d == 0 and i == self.offsets[src_i] + t.pki
                        if pkcol(0, lexpr) and not pkcol(1, rexpr):
                            self.swap = True
                    break
            onf = Compiler(db, scope, ctes, None, None).c(on) if on is not None else None
            self.joins.append((jt, lo, hi, key, onf, {}))

    def plan_driver(self, db, core, scope, ctes):
        self.driver_col = None
        frm = core['from']
        if len(frm) < 3 or any(jt == 'left' for jt, _, _ in frm):
            return
        pkpos = []
        for j, (jt, tr, on) in enumerate(frm):
            if tr[0] != 'table' or tr[1] in ctes or tr[1] not in db.tables:
                return
            t = db.tables[tr[1]]
            if t.pki is None:
                return
            pkpos.append(self.offsets[j] + t.pki)
        conj = split_and(core['where'])
        for _, _, on in frm:
            conj += split_and(on)
        pairs = []
        for c in conj:
            if c[0] == 'bin' and c[1] == '=' and c[2][0] == 'col' and c[3][0] == 'col':
                try:
                    a = scope.resolve(c[2][1], c[2][2])
                    b = scope.resolve(c[3][1], c[3][2])
                except Error:
                    continue
                if a[0] == 0 and b[0] == 0:
                    pairs.append((a[1], b[1]))
                    pairs.append((b[1], a[1]))
        def owner(i):
            for j in range(len(frm) - 1, -1, -1):
                if i >= self.offsets[j]:
                    return j
        looked = set()
        for x, y in pairs:
            ox = owner(x)
            if x == pkpos[ox] and owner(y) != ox:
                looked.add(ox)
        rest = [j for j in range(len(frm)) if j not in looked]
        if len(rest) == 1:
            self.driver_col = pkpos[rest[0]]

    def set_order(self, order):
        self.order = []
        for e, desc in order:
            if e[0] == 'lit' and isinstance(e[1], int):
                idx = e[1] - 1
                if not 0 <= idx < self.ncols:
                    raise Error("ORDER BY term out of range")
                self.order.append((('out', idx), desc))
            elif e[0] == 'col' and e[1] is None and e[2] in self.names and \
                    any(it[0] == 'expr' and it[2] == e[2] for it in self.core['cols']):
                self.order.append((('out', self.names.index(e[2])), desc))
            else:
                self.order.append((('expr', self.comp.c(e)), desc))

    def from_rows(self, parent):
        if not self.sources:
            return [()]
        rows = [()]
        width = 0
        for jidx, ((jt, lo, hi, key, onf, cache), src) in enumerate(zip(self.joins, self.sources)):
            rrows = src.getrows(parent)
            nr = hi - lo
            out = []
            if key is not None and self.swap and lo > 0:
                rk, lk = key
                idx = {}
                env = [None, parent, None, None]
                for l in rows:
                    env[0] = l
                    v = lk(env)
                    if v is None:
                        continue
                    if v.__class__ is str:
                        v = ('s', v)
                    idx.setdefault(v, []).append(l)
                pad = (None,) * lo
                for r in rrows:
                    env[0] = pad + r
                    v = rk(env)
                    if v is None:
                        continue
                    if v.__class__ is str:
                        v = ('s', v)
                    cand = idx.get(v)
                    if cand:
                        for l in cand:
                            c = l + r
                            if onf is not None:
                                env[0] = c
                                if not truth(onf(env)):
                                    continue
                            out.append(c)
            elif key is not None:
                rk, lk = key
                if src.static and 'idx' in cache:
                    idx = cache['idx']
                else:
                    idx = {}
                    pad = (None,) * lo
                    env = [None, parent, None, None]
                    for r in rrows:
                        env[0] = pad + r
                        v = rk(env)
                        if v is None:
                            continue
                        if v.__class__ is str:
                            v = ('s', v)
                        lst = idx.get(v)
                        if lst is None:
                            idx[v] = [r]
                        else:
                            lst.append(r)
                    tr = self.core['from'][len(self.joins_done)][1] if False else None
                    rpk = self.src_pki[jidx]
                    if rpk is not BAD:
                        usedc = sorted(i - lo for i in self.scope.used if lo <= i < hi and (rpk is None or i - lo != rpk))
                        if rpk is not None:
                            usedc.append(rpk)
                        if usedc:
                            for lst in idx.values():
                                if len(lst) > 1:
                                    lst.sort(key=lambda r: tuple(skey(r[c]) for c in usedc))
                    cache['idx'] = idx
                env = [None, parent, None, None]
                padr = (None,) * (hi - lo)
                for l in rows:
                    env[0] = l
                    v = lk(env)
                    matched = False
                    if v is not None:
                        if v.__class__ is str:
                            v = ('s', v)
                        cand = idx.get(v)
                        if cand:
                            for r in cand:
                                c = l + r
                                if onf is not None:
                                    env[0] = c
                                    if not truth(onf(env)):
                                        continue
                                out.append(c)
                                matched = True
                    if jt == 'left' and not matched:
                        out.append(l + padr)
            else:
                env = [None, parent, None, None]
                padr = (None,) * nr
                for l in rows:
                    matched = False
                    for r in rrows:
                        c = l + r
                        if onf is not None:
                            env[0] = c
                            if not truth(onf(env)):
                                continue
                        out.append(c)
                        matched = True
                    if jt == 'left' and not matched:
                        out.append(l + padr)
            rows = out
        return rows

    def run(self, parent):
        rows = self.from_rows(parent)
        if self.driver_col is not None:
            dc = self.driver_col
            rows.sort(key=lambda r: skey(r[dc]))
        where = self.where
        envs = []
        if where is not None:
            for r in rows:
                e = [r, parent, None, None]
                if truth(where(e)):
                    envs.append(e)
        else:
            envs = [[r, parent, None, None] for r in rows]
        if self.aggs or self.group:
            groups = {}
            if self.group:
                gf = self.group
                for e in envs:
                    k = tuple((v.__class__ is str, v) for v in (g(e) for g in gf))
                    lst = groups.get(k)
                    if lst is None:
                        groups[k] = [e]
                    else:
                        lst.append(e)
            else:
                groups[()] = envs
            newenvs = []
            gitems = list(groups.items())
            if self.group:
                gitems.sort(key=lambda kv: tuple(skey(v[1]) for v in kv[0]))
            for k, members in gitems:
                rep = members[0][0] if members else (None,) * self.width
                aggv = []
                for name, arg, distinct in self.aggs:
                    if arg is None:
                        aggv.append(len(members))
                    else:
                        aggv.append(agg_compute(name, [arg(m) for m in members], distinct))
                newenvs.append([rep, parent, aggv, None])
            envs = newenvs
            if self.having is not None:
                envs = [e for e in envs if truth(self.having(e))]
        elif self.having is not None:
            envs = [e for e in envs if truth(self.having(e))]
        if self.wins:
            for e in envs:
                e[3] = [None] * len(self.wins)
            for k in range(len(self.wins) - 1, -1, -1):
                envs = compute_window(k, self.wins[k], envs)
        outs = self.outs
        result = [(tuple(f(e) for f in outs), e) for e in envs]
        if self.core['distinct']:
            seen = set()
            r2 = []
            for t in result:
                kk = rkey(t[0])
                if kk not in seen:
                    seen.add(kk)
                    r2.append(t)
            result = r2
        if self.order:
            specs = []
            for (kind, v), desc in self.order:
                if kind == 'out':
                    specs.append(((lambda t, i=v: t[0][i]), desc))
                else:
                    specs.append(((lambda t, f=v: f(t[1])), desc))
            sort_rows(result, specs)
        return [t[0] for t in result]


def compute_window(k, w, envs):
    name, cargs, star, distinct, part, order = w
    parts = {}
    for e in envs:
        pk = tuple((v.__class__ is str, v) for v in (p(e) for p in part))
        lst = parts.get(pk)
        if lst is None:
            parts[pk] = [e]
        else:
            lst.append(e)
    allout = []
    for pk in sorted(parts, key=lambda t: tuple(skey(v[1]) for v in t)):
        members = parts[pk]
        if order:
            okeys = [(e, tuple(skey(f(e)) for f, _ in order)) for e in members]
            for i in range(len(order) - 1, -1, -1):
                desc = order[i][1]
                okeys.sort(key=lambda t, i=i: t[1][i], reverse=desc)
            members = [t[0] for t in okeys]
            keys = [t[1] for t in okeys]
        else:
            keys = [()] * len(members)
        n = len(members)
        allout.extend(members)
        if name == 'row_number':
            for i, e in enumerate(members):
                e[3][k] = i + 1
        elif name in ('rank', 'dense_rank'):
            rank = dense = 0
            prev = object()
            for i, e in enumerate(members):
                if keys[i] != prev:
                    rank = i + 1
                    dense += 1
                    prev = keys[i]
                e[3][k] = rank if name == 'rank' else dense
        elif name in ('lag', 'lead'):
            for i, e in enumerate(members):
                off = cargs[1](e) if len(cargs) > 1 else 1
                if off is None:
                    e[3][k] = None
                    continue
                off = int(to_num(off))
                j = i - off if name == 'lag' else i + off
                if 0 <= j < n:
                    e[3][k] = cargs[0](members[j])
                else:
                    e[3][k] = cargs[2](e) if len(cargs) > 2 else None
        else:
            arg = cargs[0] if cargs else None
            vals = [arg(e) for e in members] if arg else [1] * n
            if not order:
                v = len(members) if star else agg_compute(name, vals, distinct)
                for e in members:
                    e[3][k] = v
            else:
                i = 0
                cnt = 0
                acc = None
                allint = True
                fs = []
                seen = set()
                while i < n:
                    j = i
                    while j + 1 < n and keys[j + 1] == keys[i]:
                        j += 1
                    for t in range(i, j + 1):
                        x = vals[t]
                        if star:
                            cnt += 1
                            continue
                        if x is None:
                            continue
                        if distinct:
                            kk = (x.__class__ is str, x)
                            if kk in seen:
                                continue
                            seen.add(kk)
                        cnt += 1
                        if name in ('min', 'max'):
                            if acc is None or ((compare(x, acc) < 0) if name == 'min' else (compare(x, acc) > 0)):
                                acc = x
                        else:
                            x = to_num(x)
                            if not isinstance(x, int):
                                allint = False
                            fs.append(x)
                    if star or name == 'count':
                        v = cnt
                    elif name in ('min', 'max'):
                        v = acc
                    elif cnt == 0:
                        v = 0.0 if name == 'total' else None
                    else:
                        tot = sum(fs) if allint else math.fsum(fs)
                        if len(fs) > 1:
                            fs = [tot]
                        v = tot / cnt if name == 'avg' else (float(tot) if name == 'total' else tot)
                    for t in range(i, j + 1):
                        members[t][3][k] = v
                    i = j + 1
    return allout


# ---------------------------------------------------------------- tables
class Table:
    def __init__(self, name, cols):
        self.name = name
        self.cols = cols   # (name, type, pk, nn, uq)
        self.rows = []
        self.affs = []
        self.pki = None
        for i, c in enumerate(cols):
            if c[2] and 'INT' in c[1]:
                self.pki = i
        self._scan = None
        for c in cols:
            t = c[1]
            if 'INT' in t:
                a = 'int'
            elif 'CHAR' in t or 'CLOB' in t or 'TEXT' in t:
                a = 'text'
            elif t == '' or 'BLOB' in t:
                a = 'none'
            elif 'REAL' in t or 'FLOA' in t or 'DOUB' in t:
                a = 'real'
            else:
                a = 'num'
            self.affs.append(a)


def _scan(self):
    if self.pki is None:
        return self.rows
    if self._scan is None or self._scan[0] is not self.rows:
        pi = self.pki
        self._scan = (self.rows, sorted(self.rows, key=lambda r: skey(r[pi])))
    return self._scan[1]


Table.scan = _scan


def apply_aff(a, v):
    if v is None or a == 'none':
        return v
    if a == 'text':
        return to_text(v) if not isinstance(v, str) else v
    if isinstance(v, str):
        m = NUMPRE.fullmatch(v.strip()) if v.strip() else None
        if not m:
            return v
        v = text_to_num(v)
    if a == 'real':
        return float(v)
    if isinstance(v, float) and v.is_integer() and abs(v) < 2 ** 63:
        return int(v)
    return v


class Database:
    def __init__(self):
        self.tables = {}

    def execute(self, sql):
        try:
            st = Parser(sql).statement()
            return self._exec(st)
        except Error:
            raise
        except RecursionError:
            raise Error("too complex")
        except Exception as ex:
            raise Error("%s: %s" % (type(ex).__name__, ex))

    def _exec(self, st):
        k = st[0]
        if k == 'select':
            plan = SelectPlan(self, st[1], None, {})
            return plan.run(None)
        if k == 'create':
            _, name, cols, ine = st
            if name in self.tables:
                if ine:
                    return []
                raise Error("table %s already exists" % name)
            names = [c[0] for c in cols]
            if len(set(names)) != len(names):
                raise Error("duplicate column name")
            self.tables[name] = Table(name, cols)
            return []
        if k == 'drop':
            _, name, ife = st
            if name not in self.tables:
                if ife:
                    return []
                raise Error("no such table: %s" % name)
            del self.tables[name]
            return []
        if k == 'insert':
            return self._insert(st)
        if k == 'update':
            return self._update(st)
        if k == 'delete':
            _, name, where = st
            t = self._table(name)
            if where is None:
                t.rows = []
                return []
            scope = Scope([(name, c[0]) for c in t.cols], None, Ctx())
            f = Compiler(self, scope, {}).c(where)
            t.rows = [r for r in t.rows if not truth(f([r, None, None, None]))]
            return []
        raise Error("unsupported")

    def _table(self, name):
        t = self.tables.get(name)
        if t is None:
            raise Error("no such table: %s" % name)
        return t

    def _check(self, t, rows):
        for ci, c in enumerate(t.cols):
            if c[3]:
                for r in rows:
                    if r[ci] is None:
                        raise Error("NOT NULL constraint failed: %s.%s" % (t.name, c[0]))
            if c[4]:
                seen = set()
                for r in rows:
                    v = r[ci]
                    if v is None:
                        continue
                    kk = (v.__class__ is str, v)
                    if kk in seen:
                        raise Error("UNIQUE constraint failed: %s.%s" % (t.name, c[0]))
                    seen.add(kk)

    def _insert(self, st):
        _, name, cols, vrows, sel = st
        t = self._table(name)
        tnames = [c[0] for c in t.cols]
        if cols is None:
            idxs = list(range(len(tnames)))
        else:
            idxs = []
            for c in cols:
                if c not in tnames:
                    raise Error("table %s has no column named %s" % (name, c))
                idxs.append(tnames.index(c))
        if sel is not None:
            plan = SelectPlan(self, sel, None, {})
            if plan.ncols != len(idxs):
                raise Error("table %s has %d columns but %d values were supplied" % (name, len(tnames), plan.ncols))
            src = plan.run(None)
        else:
            comp = Compiler(self, Scope([], None, Ctx()), {})
            src = []
            fns = []
            for r in vrows:
                if len(r) != len(idxs):
                    raise Error("%d values for %d columns" % (len(r), len(idxs)))
                fns.append([comp.c(x) for x in r])
            env = [(), None, None, None]
            src = [[f(env) for f in fr] for fr in fns]
        new = []
        affs = t.affs
        ncol = len(tnames)
        for r in src:
            row = [None] * ncol
            for i, v in zip(idxs, r):
                row[i] = apply_aff(affs[i], v)
            new.append(tuple(row))
        self._check(t, t.rows + new)
        t.rows = t.rows + new
        return []

    def _update(self, st):
        _, name, sets, where = st
        t = self._table(name)
        tnames = [c[0] for c in t.cols]
        scope = Scope([(name, c) for c in tnames], None, Ctx())
        comp = Compiler(self, scope, {})
        fs = []
        for c, e in sets:
            if c not in tnames:
                raise Error("no such column: %s" % c)
            fs.append((tnames.index(c), comp.c(e)))
        wf = comp.c(where) if where is not None else None
        new = []
        for r in t.rows:
            env = [r, None, None, None]
            if wf is None or truth(wf(env)):
                nr = list(r)
                for i, f in fs:
                    nr[i] = apply_aff(t.affs[i], f(env))
                new.append(tuple(nr))
            else:
                new.append(r)
        self._check(t, new)
        # emulate SQLite's row-by-row uniqueness check (rowid order)
        uq = [ci for ci, c in enumerate(t.cols) if c[4]]
        if uq:
            order = list(range(len(new)))
            pki = [ci for ci, c in enumerate(t.cols) if c[2] and t.affs[ci] == 'int']
            if pki:
                order.sort(key=lambda i: skey(t.rows[i][pki[0]]))
            for ci in uq:
                cur = {}
                for r in t.rows:
                    v = r[ci]
                    if v is not None:
                        kk = (v.__class__ is str, v)
                        cur[kk] = cur.get(kk, 0) + 1
                for i in order:
                    o = t.rows[i][ci]
                    nv = new[i][ci]
                    if o is nv or (o is not None and nv is not None and compare(o, nv) == 0 and o.__class__ is nv.__class__):
                        continue
                    if o is not None:
                        kk = (o.__class__ is str, o)
                        cur[kk] -= 1
                    if nv is not None:
                        kk = (nv.__class__ is str, nv)
                        if cur.get(kk, 0) > 0:
                            raise Error("UNIQUE constraint failed: %s.%s" % (t.name, t.cols[ci][0]))
                        cur[kk] = cur.get(kk, 0) + 1
        t.rows = new
        return []


def connect():
    return Database()
