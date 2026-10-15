# toolkit: a pure-Python standard library toolkit

`toolkit` is a Python 3.13 package of twelve independent modules. Each one re-implements part of a standard library module and must behave exactly like the real one on every input in scope: same results, and an error wherever the real module raises one.

## Modules

| Module | Re-implements | Oracles (never use them) | Spec |
|---|---|---|---|
| `toolkit/tomlparse.py` | `tomllib` | `tomllib` | [spec/toml.md](spec/toml.md) |
| `toolkit/shellsplit.py` | `shlex` (`split`, `quote`, `join`) | `shlex` | [spec/shlex.md](spec/shlex.md) |
| `toolkit/regex.py` | `re` (subset) | `re`, `sre_compile`, `sre_parse`, `sre_constants`, `_sre` | [spec/regex.md](spec/regex.md) |
| `toolkit/csvx.py` | `csv` (subset) | `csv`, `_csv` | [spec/csv.md](spec/csv.md) |
| `toolkit/ipaddr.py` | `ipaddress` (subset) | `ipaddress` | [spec/ipaddr.md](spec/ipaddr.md) |
| `toolkit/fraction.py` | `fractions` (subset) | `fractions` | [spec/fraction.md](spec/fraction.md) |
| `toolkit/urls.py` | `urllib.parse` (subset) | `urllib.parse` | [spec/urls.md](spec/urls.md) |
| `toolkit/b64.py` | `base64` (subset) | `base64`, `binascii` | [spec/b64.md](spec/b64.md) |
| `toolkit/diff.py` | `difflib` (subset) | `difflib` | [spec/diff.md](spec/diff.md) |
| `toolkit/wrap.py` | `textwrap` (subset) | `textwrap` | [spec/wrap.md](spec/wrap.md) |
| `toolkit/jsonx.py` | `json` (subset) | `json`, `_json` | [spec/jsonx.md](spec/jsonx.md) |
| `toolkit/cal.py` | `calendar` (subset) | `calendar` | [spec/cal.md](spec/cal.md) |

Each spec lists the public API of its module and what is in scope. The modules do not depend on each other, so they can be written in any order.

## Rules

1. Pure Python 3.13 standard library. No third-party packages, no C extensions, no network, no subprocesses.
2. Code inside `toolkit/` may not import any module in the Oracles column, of any row, directly or with `from ... import`. The grader also refuses `subprocess`, `ctypes`, `sqlite3`, `socket`, `multiprocessing` and `importlib`, and refuses `os.system`, `os.posix_spawn`, the `os.exec*`, `os.fork` and `os.spawn*` functions and `os.link` while your code runs. A refused import raises `ImportError` inside the grader, so the module that does it fails to import and scores zero. Standard library modules you are allowed to import may themselves use any module internally, with the exception in rule 6.
3. The toolkit modules may import each other (for example `from toolkit import regex` inside `csvx.py`), but a module that imports a broken sibling breaks with it.
4. Keep `toolkit/__init__.py` free of imports of the submodules: the grader imports each module (`toolkit.tomlparse`, ...) separately, and the package `__init__` runs for every one of them.
5. Do not rename the modules or change the public names in the specs. Extra private helpers and extra files inside `toolkit/` are fine.
6. Never use the module you reimplement, or any of its oracles, in any way: doing so scores that module 0. This covers direct imports and indirect routes alike (`pkgutil`, `pydoc`, another module's attribute such as `json.decoder.re`, `sys.modules`, `__import__`, reading or running the oracle's source file, ...). While it grades a module, the grader cannot load that module's oracles at all, so even a stdlib helper that imports one of them fails and scores the module 0: for example `logging` and `traceback` import `textwrap`, `statistics` imports `fractions`, `email.utils` imports `urllib.parse` and `ipaddress`, `secrets` imports `base64` and `binascii`, and `webbrowser` imports `shlex`. The one exception is `re`, which much of the standard library imports: helpers that use it internally are fine, but the grader watches the real `re` engine while `regex` tests run, and if your code reaches it, `regex` scores 0. The grader also flags `__import__`, `importlib`, `sys.modules`, `eval`/`exec` and `builtins` in your sources for review.

## Grading

- Differential: each hidden test feeds one input to your function and to the Python 3.13 standard library function it mirrors. It passes when the normalized results are equal, or when both raise the error the spec names (only the error kind is compared, never the message).
- About 1,600 hidden tests, scored per module. The hidden inputs differ from the public examples and cover everything the specs put in scope.
- Each test has a 2 second limit. A test that runs longer fails on its own; the other tests still run.
- Timeout budget: after 5 tests of a module time out, that module's remaining tests fail without running. The same goes after 5 crashes of the test process, or after 10 minutes of grading time for one module.
- Importing a module may take at most 10 seconds; past that, all of that module's tests fail.
- A module that fails to import, or crashes the test process, fails only its own tests.
- Inputs are ASCII only where a module's spec says so (for example `regex` and `shlex`); elsewhere they may contain non-ASCII text.

## Public examples

`python3 tests/run_public.py` runs the examples in `tests/public_*.py` (`python3 tests/run_public.py toml csv` runs only those files). Each example runs your module and the standard library on the same input and compares them, printing `PASS` or `FAIL` per example. It exits 0 only when every example passes. A public file whose module is not written yet just fails its examples.
