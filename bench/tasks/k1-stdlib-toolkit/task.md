Implement the `toolkit` Python package described in `SPEC.md`: four independent modules that re-implement parts of the Python 3.13 standard library in pure Python, using only the standard library.

| Module | Re-implements | Spec |
|---|---|---|
| `toolkit/tomlparse.py` | `tomllib` | `spec/toml.md` |
| `toolkit/shellsplit.py` | `shlex.split`, `shlex.quote`, `shlex.join` | `spec/shlex.md` |
| `toolkit/regex.py` | a subset of `re` | `spec/regex.md` |
| `toolkit/csvx.py` | a subset of `csv` | `spec/csv.md` |

The stubs are already in `toolkit/`; they raise `NotImplementedError`. Keep the module names and the public API in each spec. Read the rules in `SPEC.md` before you start: some standard library modules (for example `re`, `tomllib`, `shlex` and `csv`) may not be imported by your code, and an import of one of them makes that module score zero.

`python3 tests/run_public.py` runs the public examples. Each example compares your module's result with the real standard library on the same input and prints pass or fail; the command exits 0 only when every example passes.

The score comes from a hidden suite of about 400 differential tests, scored per module: each test runs one input through your module and through Python 3.13's standard library and passes only when the results (or the raised error kind) match. The hidden inputs are different from the public examples and cover everything in scope in the specs, so the public examples alone do not show your score. Each module is scored on its own, and a module that fails to import or crashes loses only its own tests.
