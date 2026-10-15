Implement the `toolkit` Python package described in `SPEC.md`: twelve independent modules that re-implement parts of the Python 3.13 standard library in pure Python, using only the standard library.

| Module | Re-implements | Spec |
|---|---|---|
| `toolkit/tomlparse.py` | `tomllib` | `spec/toml.md` |
| `toolkit/shellsplit.py` | `shlex.split`, `shlex.quote`, `shlex.join` | `spec/shlex.md` |
| `toolkit/regex.py` | a subset of `re` | `spec/regex.md` |
| `toolkit/csvx.py` | a subset of `csv` | `spec/csv.md` |
| `toolkit/ipaddr.py` | a subset of `ipaddress` | `spec/ipaddr.md` |
| `toolkit/fraction.py` | a subset of `fractions` | `spec/fraction.md` |
| `toolkit/urls.py` | a subset of `urllib.parse` | `spec/urls.md` |
| `toolkit/b64.py` | a subset of `base64` | `spec/b64.md` |
| `toolkit/diff.py` | a subset of `difflib` | `spec/diff.md` |
| `toolkit/wrap.py` | a subset of `textwrap` | `spec/wrap.md` |
| `toolkit/jsonx.py` | a subset of `json` | `spec/jsonx.md` |
| `toolkit/cal.py` | a subset of `calendar` | `spec/cal.md` |

The stubs are already in `toolkit/`; they raise `NotImplementedError`. Keep the module names and the public API in each spec. Read the rules in `SPEC.md` before you start: the twelve standard library modules being reimplemented (for example `json`, `base64` and `textwrap`) may not be imported or used by your code, and neither may any stdlib module that imports one of them itself (for example `logging`, `traceback`, `pydoc`, `statistics`, `email.*`; the list in `SPEC.md` is not exhaustive). Such an import is refused and the module that does it scores zero.

`python3 tests/run_public.py` runs the public examples. Each example compares your module's result with the real standard library on the same input and prints pass or fail; the command exits 0 only when every example passes.

The score comes from about 1,600 hidden differential tests, scored per module: each test runs one input through your module and through Python 3.13's standard library and passes only when the results (or the raised error kind) match. The hidden inputs are different from the public examples and cover everything in scope in the specs, so the public examples alone do not show your score. Each module is scored on its own, and a module that fails to import or crashes loses only its own tests.
