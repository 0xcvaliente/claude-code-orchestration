"""Public examples for toolkit.tomlparse, checked against tomllib."""
import io
import math
import tomllib

EXAMPLES = [
    {"name": "strings and escapes", "doc": 'title = "Caf\\u00e9 \\"menu\\""\npath = \'C:\\temp\'\nnote = """\nline one\nline two"""\n'},
    {"name": "numbers", "doc": "dec = -1_024\nhex = 0xff\noct = 0o17\nbin = 0b101\npi = 3.14_15\nexp = -1.5e-3\nbig = inf\nnot_a_number = nan\n"},
    {"name": "dates and times", "doc": "when = 2021-06-01T12:30:00+02:00\nlocal = 2021-06-01 12:30:00.25\nday = 2021-06-01\nalarm = 06:45:00\n"},
    {"name": "tables and dotted keys", "doc": '[server]\nhost = "localhost"\nlimits.cpu = 2\nlimits.mem = "1G"\n\n[server.tls]\nenabled = false\n'},
    {"name": "arrays and inline tables", "doc": 'ports = [80, 443,]\nusers = [\n  { name = "ann", admin = true },  # first\n  { name = "bob" },\n]\n'},
    {"name": "array of tables", "doc": '[[job]]\nname = "build"\n[[job.step]]\nrun = "make"\n[[job]]\nname = "test"\n'},
    {"name": "load() from bytes", "doc": 'greeting = "hej"\r\n[t]\r\nn = 1\r\n', "via": "load"},
    {"name": "error: duplicate key", "doc": 'name = "a"\nname = "b"\n'},
    {"name": "error: bad escape", "doc": 'x = "tab\\q"\n'},
]


def _eq(a, b):
    if type(a) is not type(b):
        return False
    if isinstance(a, float) and math.isnan(a):
        return math.isnan(b)
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(_eq(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(_eq(x, y) for x, y in zip(a, b))
    if hasattr(a, "utcoffset"):
        return a == b and a.utcoffset() == b.utcoffset()
    return a == b


def _run(loads, load, err, ex):
    try:
        if ex.get("via") == "load":
            return "ok", load(io.BytesIO(ex["doc"].encode("utf-8")))
        return "ok", loads(ex["doc"])
    except err:
        return "error", None


def check(ex):
    from toolkit import tomlparse

    exp = _run(tomllib.loads, tomllib.load, tomllib.TOMLDecodeError, ex)
    got = _run(tomlparse.loads, tomlparse.load, tomlparse.TOMLDecodeError, ex)
    ok = exp[0] == got[0] and _eq(exp[1], got[1])
    return ok, f"expected {exp[0]} {exp[1]!r}, got {got[0]} {got[1]!r}"
