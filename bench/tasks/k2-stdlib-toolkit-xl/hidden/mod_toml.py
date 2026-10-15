"""Hidden differential cases for toolkit.tomlparse against tomllib (Python 3.13).

Usage: python3 mod_toml.py <package_root>   (imports <package_root>/toolkit directly)
"""
import io
import math
import random
import sys
from datetime import date, datetime, time

NAME = "toml"
MODULE = "toolkit.tomlparse"
ORACLES = ["tomllib"]
WRAP = ["tomllib.loads", "tomllib.load"]

# ---------------------------------------------------------------- valid docs
VALID = [
    # strings
    r'''esc = "tab\there\nnew\\back \"q\" \b\f\r end"
uni = "caf\u00e9 \U0001F600 \u00E9"
lit = 'C:\Users\nodejs\templates'
lit2 = '<\i\c*\s*>'
quoted = 'Tom "Dubs" Preston'
hash = "not # a comment" # but this is
''',
    'ml = """\nRoses are red\nViolets are blue"""\nml2 = """Roses\\\n   \n    are \\\n  red"""\n',
    'a = """The quick brown \\\n\n\n  fox jumps over \\\n    the lazy dog."""\nb = """\\\n       The quick\\\n       brown\\\n       \\\n       fox.\\\n       """\n',
    'q4 = """Here are two quotation marks: "". Simple enough."""\nq5 = """Here are three quotation marks: ""\\"."""\nq6 = """Here are fifteen quotation marks: ""\\"""\\"""\\"""\\"""\\"."""\nend4 = """"This," she said, "is just a pointless statement.""""\nend5 = """ab"""""\n',
    "regex2 = '''I [dw]on't need \\d{2} apples'''\nlines = '''\nThe first newline is\ntrimmed in raw strings.\n   All other whitespace\n   is preserved.\n'''\nq = '''Here are fifteen quotation marks: \"\"\"\"\"\"\"\"\"\"\"\"\"\"\"'''\napos = ''''That,' she said, 'is still pointless.''''\nap1 = '''x''''\n",
    'trail = """a \\   \n   b"""\ntab = "a\tb"\nempty = ""\nempty_lit = \'\'\nempty_ml = """"""\nempty_mll = \'\'\'\'\'\'\n',
    'ws = """\\\t\n  x"""\nnl = """\n\n two"""\nlast = """x\\\n"""\n',
    # integers
    'int1 = +99\nint2 = 42\nint3 = 0\nint4 = -17\nint5 = 1_000\nint6 = 5_349_221\nint7 = 53_49_221\nint8 = 1_2_3_4_5\nz1 = -0\nz2 = +0\n',
    'hex1 = 0xDEADBEEF\nhex2 = 0xdeadbeef\nhex3 = 0xdead_beef\noct1 = 0o01234567\noct2 = 0o755\nbin1 = 0b11010110\nbin2 = 0b0\nhex4 = 0x0\nhex5 = 0x00_ff\nbig = 9223372036854775807\nsmall = -9223372036854775808\n',
    # floats
    'flt1 = +1.0\nflt2 = 3.1415\nflt3 = -0.01\nflt4 = 5e+22\nflt5 = 1e06\nflt6 = -2E-2\nflt7 = 6.626e-34\nflt8 = 224_617.445_991_228\nnz = -0.0\npz = +0.0\nexp0 = 1e007\nexpu = 1.5e1_0\n',
    'sf1 = inf\nsf2 = +inf\nsf3 = -inf\nsf4 = nan\nsf5 = +nan\nsf6 = -nan\narr = [inf, -inf, nan, 1.5]\n',
    'bool1 = true\nbool2 = false\nbools = [true,false , true]\n',
    # datetimes
    'odt1 = 1979-05-27T07:32:00Z\nodt2 = 1979-05-27T00:32:00-07:00\nodt3 = 1979-05-27T00:32:00.999999-07:00\nodt4 = 1979-05-27 07:32:00Z\nodt5 = 1979-05-27t07:32:00z\nodt6 = 2000-02-29T23:59:59+05:30\nodt7 = 1999-12-31T00:00:00-00:00\nodt8 = 1987-07-05T17:45:00.1+14:00\n',
    'ldt1 = 1979-05-27T07:32:00\nldt2 = 1979-05-27T00:32:00.999999\nldt3 = 1979-05-27T00:32:00.123456789\nldt4 = 1979-05-27 00:32:00.5\nld1 = 1979-05-27\nld2 = 2024-02-29\nlt1 = 07:32:00\nlt2 = 00:32:00.999999\nlt3 = 23:59:59.0000001\nlt4 = 12:00:00.75\n',
    'dates = [1979-05-27, 1979-05-27T07:32:00, 07:32:00, 1979-05-27T07:32:00+01:00]\nd = { when = 2020-01-01T00:00:00Z, day = 2020-01-01 }\n',
    # arrays
    'integers = [ 1, 2, 3 ]\ncolors = [ "red", "yellow", "green" ]\nnested_arrays_of_ints = [ [ 1, 2 ], [3, 4, 5] ]\nnested_mixed_array = [ [ 1, 2 ], ["a", "b", "c"] ]\nstring_array = [ "all", \'strings\', """are the same""", \'\'\'type\'\'\' ]\nnumbers = [ 0.1, 0.2, 0.5, 1, 2, 5 ]\ncontributors = [\n  "Foo Bar <foo@example.com>",\n  { name = "Baz Qux", email = "bazqux@example.com", url = "https://example.com/bazqux" }\n]\n',
    'integers2 = [\n  1, 2, 3\n]\nintegers3 = [\n  1,\n  2, # this is ok\n]\nempty = [ ]\nempty2 = [\n# only a comment\n]\ndeep = [[[[]]], [[1]]]\ntrail = [1,2,]\n',
    # inline tables
    'name = { first = "Tom", last = "Preston-Werner" }\npoint = { x = 1, y = 2 }\nanimal = { type.name = "pug" }\nempty = {}\nnest = { a = { b = { c = [1, { d = 2 }] } } }\narr_of_inline = [ { x = 1 }, { y = 2 }, {} ]\n',
    'spaced = {   a=1   ,b = "x" ,   c.d.e = true}\nq = { "quoted key" = 1, \'lit key\' = 2, 3 = 4 }\n',
    # tables
    '[table-1]\nkey1 = "some string"\nkey2 = 123\n\n[table-2]\nkey1 = "another string"\nkey2 = 456\n',
    '[dog."tater.man"]\ntype.name = "pug"\n\n[a.b.c]\n[ d.e.f ]\n[ g .  h  . i ]\n[ j . "\u029e" . \'l\' ]\n',
    '# [x] you\n# [x.y] don\'t\n# [x.y.z] need these\n[x.y.z.w] # for this to work\n\n[x] # defining a super-table afterward is ok\nk = 1\n',
    '[fruit]\napple.color = "red"\napple.taste.sweet = true\n\n[fruit.apple.texture]  # you can add sub-tables\nsmooth = true\n',
    '[apple]\ntype = "fruit"\nskin = "thin"\n[orange]\ntype = "fruit"\n[apple.inner]\nseeds = 5\n',
    'top = 1\n[a]\n  [a.b]\n    c = 2\n  [a.d]\n\tx = "tab-indented"\n',
    # dotted and quoted keys
    'name = "Orange"\nphysical.color = "orange"\nphysical.shape = "round"\nsite."google.com" = true\nfruit . flavor = "banana"\n3.14159 = "pi"\n1234 = "value"\n',
    'key = "value"\nbare_key = "value"\nbare-key = "value"\n1234x = "value"\n"127.0.0.1" = "value"\n"character encoding" = "value"\n"\u028e\u01dd\u029e" = "value"\n\'key2\' = "value"\n\'quoted "value"\' = "value"\n"" = "blank"\n-start = 1\n_ = 2\n',
    'a.b.c = 1\na.d = 2\nx."y z".w = "q"\n"x".v = 3\n',
    # arrays of tables
    '[[products]]\nname = "Hammer"\nsku = 738594937\n\n[[products]]  # empty table within the array\n\n[[products]]\nname = "Nail"\nsku = 284758393\ncolor = "gray"\n',
    '[[fruits]]\nname = "apple"\n\n[fruits.physical]  # subtable\ncolor = "red"\nshape = "round"\n\n[[fruits.varieties]]  # nested array of tables\nname = "red delicious"\n\n[[fruits.varieties]]\nname = "granny smith"\n\n\n[[fruits]]\nname = "banana"\n\n[[fruits.varieties]]\nname = "plantain"\n',
    '[[a]]\n[a.b]\nx = 1\n[[a]]\n[a.b]\nx = 2\n[[ a ]]\nb.x = 3\n',
    'points = [ { x = 1, y = 2, z = 3 },\n           { x = 7, y = 8, z = 9 },\n           { x = 2, y = 4, z = 8 } ]\n[[ srv . node ]]\nid = 1\n[[srv.node]]\nid = 2\n[srv.meta]\nn = 2\n',
    # whitespace, comments, line endings
    '# full line comment\n   key = "value"   # trailing comment\n\t\tother = 1\t# tab\n\n\n# end\n',
    'a = 1\r\nb = "two"\r\n[t]\r\nc = """x\r\ny"""\r\n',
    '',
    '# only a comment\n\n   \n\t\n',
    'k = "v"',
    'utf = "caf\u00e9 \u65e5\u672c \u00fc"\n"cl\u00e9" = 1\ncomment = 1 # caf\u00e9 \u65e5\u672c\n',
    'a = "#"\nb = \'#\'\nc = ["#", \'#\'] # #\nd = { e = "#" } #\n',
    'mixed = [1, 2.0, "three", true, 1979-05-27, [4], {five = 5}]\n',
    'k1 = 0.0\nk2 = 1_0.0_1\nk3 = 3e-0_1\nk4 = 0e0\nk5 = -0e-0\nk6 = 1E+1_0\n',
    'title = "TOML Example"\n\n[owner]\nname = "Tom Preston-Werner"\ndob = 1979-05-27T07:32:00-08:00\n\n[database]\nenabled = true\nports = [ 8000, 8001, 8002 ]\ndata = [ ["delta", "phi"], [3.14] ]\ntemp_targets = { cpu = 79.5, case = 72.0 }\n\n[servers]\n\n[servers.alpha]\nip = "10.0.0.1"\nrole = "frontend"\n\n[servers.beta]\nip = "10.0.0.2"\nrole = "backend"\n',
    'a.b = 1\n[c]\na.b = 2\n[d.e]\na.b = 3\n[[f]]\na.b = 4\n',
    'str = "\\u0000\\u001F\\u007f\\U0010FFFF\\uE000\\uD7FF"\n',
]

# Documents that are valid for tomllib but read through load() (binary file).
VALID_LOAD = [
    'a = 1\r\n[b]\r\nc = "caf\u00e9"\r\n',
    '[[x]]\ny = 1979-05-27T07:32:00Z\n[[x]]\ny = 2\n',
    'k = """\r\nline1\r\nline2"""\r\n',
]

# --------------------------------------------------------------- invalid docs
INVALID = [
    'a = 1\na = 2\n',
    '[a]\n[a]\n',
    '[a]\nb = 1\n[a.b]\n',
    '[fruit]\napple.color = "red"\n[fruit.apple]\n',
    'a = {b = 1}\n[a.c]\n',
    'a = {b = 1}\na.c = 2\n',
    'a = []\n[[a]]\n',
    '[[a]]\n[a]\n',
    '[a]\n[[a]]\n',
    'a = "abc\n',
    'a = "ab\ncd"\n',
    'a = "\\x41"\n',
    'a = "\\u12G4"\n',
    'a = "\\uD800"\n',
    'a = 012\n',
    'a = 1_\n',
    'a = 1__2\n',
    'a = _1\n',
    'a = .5\n',
    'a = 5.\n',
    'a = 0X1F\n',
    'a = Inf\n',
    'a = 1979-02-30\n',
    'a = 1979-13-01\n',
    'a = 07:32\n',
    'a =\n',
    'a = 1 b = 2\n',
    'a = [1 2]\n',
    'a = {b = 1,}\n',
    'a = {b = 1,\nc = 2}\n',
    'a.b! = 1\n',
    'a = 1 # \x01 control\n',
    'a = "\x7f"\n',
    '[a.]\n',
    '[[a]\n',
    'a = {b = 1, b = 2}\n',
    'a.b = 1\na = {}\n',
    "a = '''never ends\n",
    'a = """a""""""\n',
    'a = 1979-05-27T07:32:00+25:00\n',
    'a = 1\rb = 2\n',
    'a = 1979-05-27T07:32:60\n',
    'a = +0x10\n',
    'a = [1,,2]\n',
    'a = """ab \\ c"""\n',
    "a = 'line\nbreak'\n",
    '[a]\nb.c = 1\n[a.b]\n',
    'x = 0b102\n',
    'x = 2000-01-01T00:00:00.Z\n',
    '[t]\nx = 1\n[t.x.y]\n',
    'a = { b = [1] }\n[[a.b]]\n',
    '"key\nbreak" = 1\n',
    'a = 0x\n',
]


# ---------------------------------------------------------------- generator
def _gen_key(r):
    kind = r.random()
    if kind < 0.7:
        return r.choice(["a", "b", "key", "x1", "name", "port", "v-2", "_id", "k", "z9", "dog", "cat", "123"])
    if kind < 0.85:
        return '"' + r.choice(["sp ace", "dot.ted", "q#h", "", "caf\u00e9"]) + '"'
    return "'" + r.choice(["lit key", "a.b", "\\back", "x"]) + "'"


def _gen_scalar(r):
    t = r.randrange(12)
    if t == 0:
        return str(r.randrange(-10**6, 10**6))
    if t == 1:
        n = r.randrange(1, 10**9)
        return r.choice(["0x%X", "0x%x", "0o%o"]) % n if r.random() < 0.7 else "0b" + bin(n)[2:]
    if t == 2:
        d = str(r.randrange(1, 10**7))
        return d[:1] + "_".join([d[1:3], d[3:]]) if len(d) > 3 else d
    if t == 3:
        return r.choice(["%.3f", "%.1e", "%g"]) % (r.uniform(-1e5, 1e5))
    if t == 4:
        return r.choice(["inf", "-inf", "+inf", "nan", "-nan", "+nan", "-0.0", "6.02e23"])
    if t == 5:
        return r.choice(["true", "false"])
    if t == 6:
        y, mo, d = r.randrange(1, 9999), r.randrange(1, 13), r.randrange(1, 29)
        hh, mm, ss = r.randrange(24), r.randrange(60), r.randrange(60)
        frac = r.choice(["", ".5", ".123456", ".1234567"])
        tz = r.choice(["", "Z", "z", "+01:00", "-09:30", "+00:00"])
        sep = r.choice(["T", " ", "t"])
        return f"{y:04d}-{mo:02d}-{d:02d}{sep}{hh:02d}:{mm:02d}:{ss:02d}{frac}{tz}"
    if t == 7:
        return f"{r.randrange(1, 9999):04d}-{r.randrange(1, 13):02d}-{r.randrange(1, 29):02d}"
    if t == 8:
        return f"{r.randrange(24):02d}:{r.randrange(60):02d}:{r.randrange(60):02d}" + r.choice(["", ".25", ".000001"])
    if t == 9:
        body = "".join(r.choice(["a", " ", "\\t", "\\n", '\\"', "\\\\", "\\u00e9", "\\U0001F600", "#", "'", "z"]) for _ in range(r.randrange(0, 8)))
        return '"' + body + '"'
    if t == 10:
        body = "".join(r.choice(["a", " ", "\\", '"', "#", "x"]) for _ in range(r.randrange(0, 8)))
        return "'" + body + "'"
    body = "".join(r.choice(["line", "\n", '"', '""', "\\\n   ", "\\t", " "]) for _ in range(r.randrange(0, 6)))
    if body.endswith('"'):
        body += "x"
    return '"""' + body + '"""'


def _gen_value(r, depth):
    t = r.random()
    if depth < 2 and t < 0.15:
        items = [_gen_value(r, depth + 1) for _ in range(r.randrange(0, 4))]
        sep = r.choice([", ", ",", " , ", ",\n  "])
        trail = r.choice(["", ","]) if items else ""
        return "[" + sep.join(items) + trail + "]"
    if depth < 2 and t < 0.25:
        keys = []
        for _ in range(r.randrange(0, 3)):
            k = _gen_key(r)
            if k not in keys:
                keys.append(k)
        return "{" + ", ".join(f"{k} = {_gen_value(r, depth + 1)}" for k in keys) + "}"
    return _gen_scalar(r)


def _gen_doc(r):
    lines = []
    used = set()
    for _ in range(r.randrange(1, 5)):
        k = _gen_key(r)
        if k in used:
            continue
        used.add(k)
        lines.append(f"{k} = {_gen_value(r, 0)}" + r.choice(["", " # c", "\t#x"]))
    for ti in range(r.randrange(0, 4)):
        name = r.choice(["t%d" % ti, "s.t%d" % ti, '"q %d"' % ti])
        if r.random() < 0.3:
            lines.append(f"[[{name}]]")
        else:
            lines.append(f"[{name}]")
        used = set()
        for _ in range(r.randrange(0, 4)):
            k = _gen_key(r)
            if k in used:
                continue
            used.add(k)
            lines.append(r.choice(["", "  ", "\t"]) + f"{k} = {_gen_value(r, 0)}")
    return "\n".join(lines) + r.choice(["\n", "", "\n\n"])


def _corrupt(r, doc):
    if not doc:
        return "="
    i = r.randrange(len(doc))
    op = r.randrange(3)
    if op == 0:
        return doc[:i] + doc[i + 1:]
    if op == 1:
        return doc[:i] + doc[i] + doc[i:]
    return doc[:i] + r.choice(["=", "[", "]", '"', "'", ".", ",", "{", "}", "\n", "_", "#"]) + doc[i:]


def cases():
    out = []
    for i, d in enumerate(VALID):
        out.append({"id": f"toml-valid-{i:02d}", "doc": d})
    for i, d in enumerate(VALID_LOAD):
        out.append({"id": f"toml-load-{i:02d}", "doc": d, "via": "load"})
    for i, d in enumerate(INVALID):
        out.append({"id": f"toml-invalid-{i:02d}", "doc": d})
    r = random.Random(20261015)
    for i in range(16):
        out.append({"id": f"toml-gen-{i:02d}", "doc": _gen_doc(r)})
    for i in range(8):
        doc = _gen_doc(r)
        for _ in range(r.randrange(2, 4)):
            doc = _corrupt(r, doc)
        out.append({"id": f"toml-mut-{i:02d}", "doc": doc})
    return out


# ------------------------------------------------------------- normalization
def _fmt_float(f):
    if math.isnan(f):
        return "nan"
    if math.isinf(f):
        return "inf" if f > 0 else "-inf"
    return repr(f)


def norm(v):
    if isinstance(v, bool):
        return {"t": "bool", "v": v}
    if isinstance(v, int):
        return {"t": "int", "v": str(v)}
    if isinstance(v, float):
        return {"t": "float", "v": _fmt_float(v)}
    if isinstance(v, str):
        return {"t": "str", "v": v}
    if isinstance(v, datetime):
        off = v.utcoffset()
        return {"t": "datetime", "v": v.replace(tzinfo=None).isoformat(),
                "off": None if off is None else int(off.total_seconds())}
    if isinstance(v, date):
        return {"t": "date", "v": v.isoformat()}
    if isinstance(v, time):
        return {"t": "time", "v": v.isoformat(), "tz": v.tzinfo is not None}
    if isinstance(v, dict):
        return {"t": "table", "v": {str(k): norm(x) for k, x in v.items()},
                "keys_ok": all(isinstance(k, str) for k in v)}
    if isinstance(v, list):
        return {"t": "array", "v": [norm(x) for x in v]}
    return {"t": "unsupported:" + type(v).__name__}


def run_impl(mod, case):
    err = getattr(mod, "TOMLDecodeError", None)
    if not (isinstance(err, type) and issubclass(err, ValueError)):
        return {"error": "TOMLDecodeError missing or not a ValueError subclass"}
    try:
        if case.get("via") == "load":
            res = mod.load(io.BytesIO(case["doc"].encode("utf-8")))
        else:
            res = mod.loads(case["doc"])
    except err:
        return {"error": "TOMLDecodeError"}
    if not isinstance(res, dict):
        return {"error": "result is not a dict: " + type(res).__name__}
    return norm(res)


def run_oracle(case):
    import tomllib
    try:
        if case.get("via") == "load":
            res = tomllib.load(io.BytesIO(case["doc"].encode("utf-8")))
        else:
            res = tomllib.loads(case["doc"])
    except tomllib.TOMLDecodeError:
        return {"error": "TOMLDecodeError"}
    return norm(res)


def same(a, b):
    return a == b


def _main(root):
    import importlib
    sys.path.insert(0, root)
    mod = importlib.import_module(MODULE)
    cs = cases()
    bad = []
    for c in cs:
        exp = run_oracle(c)
        try:
            got = run_impl(mod, c)
        except Exception as e:  # noqa: BLE001
            got = {"crash": f"{type(e).__name__}: {e}"}
        if not same(exp, got):
            bad.append((c, exp, got))
    print(f"{NAME}: {len(cs) - len(bad)}/{len(cs)}")
    for c, exp, got in bad[:10]:
        print(f"  FAIL {c['id']} doc={c['doc'][:80]!r}\n    expected {str(exp)[:200]}\n    got      {str(got)[:200]}")
    return 0 if not bad else 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: mod_toml.py <package_root>")
    sys.exit(_main(sys.argv[1]))
