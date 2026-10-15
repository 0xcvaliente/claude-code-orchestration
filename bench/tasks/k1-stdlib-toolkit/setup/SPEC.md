# toolkit: a pure-Python standard library toolkit

`toolkit` is a Python 3.13 package of four independent modules. Each one re-implements part of a standard library module and must behave exactly like the real one on every input in scope: same results, and an error wherever the real module raises one.

## Modules

| Module | Re-implements | API | Spec |
|---|---|---|---|
| `toolkit/tomlparse.py` | `tomllib` | `loads`, `load`, `TOMLDecodeError` | [spec/toml.md](spec/toml.md) |
| `toolkit/shellsplit.py` | `shlex` | `split`, `quote`, `join` | [spec/shlex.md](spec/shlex.md) |
| `toolkit/regex.py` | `re` (subset) | see spec | [spec/regex.md](spec/regex.md) |
| `toolkit/csvx.py` | `csv` (subset) | see spec | [spec/csv.md](spec/csv.md) |

The modules do not depend on each other, so they can be written in any order.

## Rules

1. Pure Python 3.13 standard library. No third-party packages, no C extensions, no network, no subprocesses.
2. Code inside `toolkit/` may not import any of these modules, directly or with `from ... import`: `re` (and `sre_compile`, `sre_parse`, `sre_constants`, `_sre`), `tomllib`, `csv` (and `_csv`), `shlex`, `textwrap`, `fnmatch`, `glob`, `string`, `importlib`. The grader also refuses `subprocess`, `ctypes`, `sqlite3`, `socket` and `multiprocessing`. A refused import raises `ImportError` inside the grader, so the module that does it fails to import and scores zero. Standard library modules you are allowed to import may themselves use any module internally; that is fine.
3. The toolkit modules may import each other (for example `from toolkit import regex` inside `csvx.py`), but a module that imports a broken sibling breaks with it.
4. Keep `toolkit/__init__.py` free of imports of the submodules: the grader imports each module (`toolkit.tomlparse`, ...) separately, and the package `__init__` runs for every one of them.
5. Do not rename the modules or change the public names in the specs. Extra private helpers and extra files inside `toolkit/` are fine.
6. Do not try to reach the forbidden modules indirectly (`__import__`, `importlib`, `sys.modules`, `eval`/`exec`, `builtins`). The grader flags these for review.

## Grading

- Differential: each hidden test feeds one input to your function and to the Python 3.13 standard library function it mirrors. It passes when the normalized results are equal, or when both raise the error the spec names (only the error kind is compared, never the message).
- About 400 hidden tests, scored per module. The hidden inputs differ from the public examples and cover everything the specs put in scope.
- Each test has a 2 second limit. A test that runs longer fails on its own; the other tests still run.
- A module that fails to import, or crashes the test process, fails only its own tests.
- Inputs for `regex` and `shlex` are ASCII only. `toml` and `csv` inputs may contain non-ASCII text.

## Public examples

`python3 tests/run_public.py` runs the examples in `tests/public_*.py`. Each example runs your module and the standard library on the same input and compares them, printing `PASS` or `FAIL` per example. It exits 0 only when every example passes. A public file whose module is not written yet just fails its examples.
