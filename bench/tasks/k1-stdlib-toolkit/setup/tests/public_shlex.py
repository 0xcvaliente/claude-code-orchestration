"""Public examples for toolkit.shellsplit, checked against shlex."""
import shlex

EXAMPLES = [
    {"name": "split: plain words", "fn": "split", "args": ["git commit -m 'first commit'"], "kw": {}},
    {"name": "split: double quotes and escapes", "fn": "split", "args": ['echo "a \\"b\\" c" d\\ e'], "kw": {}},
    {"name": "split: adjacent quotes join", "fn": "split", "args": ["pre'mid dle'\"post\""], "kw": {}},
    {"name": "split: comments", "fn": "split", "args": ["run --fast # go\nnext"], "kw": {"comments": True}},
    {"name": "split: non-posix keeps quotes", "fn": "split", "args": ["cp 'a b' \"c d\""], "kw": {"posix": False}},
    {"name": "split: unbalanced quote", "fn": "split", "args": ["say \"hi"], "kw": {}},
    {"name": "quote: unsafe characters", "fn": "quote", "args": ["rm -rf $dir's"], "kw": {}},
    {"name": "quote: safe string", "fn": "quote", "args": ["user@host:/srv/file-1.txt"], "kw": {}},
    {"name": "join", "fn": "join", "args": [["printf", "%s\\n", "two words", ""]], "kw": {}},
]


def _run(mod, ex):
    try:
        return "ok", getattr(mod, ex["fn"])(*ex["args"], **ex["kw"])
    except ValueError:
        return "ValueError", None


def check(ex):
    from toolkit import shellsplit

    exp, got = _run(shlex, ex), _run(shellsplit, ex)
    return exp == got, f"expected {exp!r}, got {got!r}"
