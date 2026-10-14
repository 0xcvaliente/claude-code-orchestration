# minisql — specification

Build `minisql`, an in-memory SQL database engine written in **pure Python 3.13 using only the
standard library**. The reference behaviour is **SQLite 3.53**: for every statement in the subset
below, `minisql` must produce the same rows (or raise an error in the same situations) as SQLite.

## Hard rules

- The package lives in `minisql/` (you may add any modules inside it).
- `minisql` must not import `sqlite3`, `_sqlite3`, `ctypes`, `subprocess`, or any third-party
  package. The grader blocks these imports; a package that needs them scores 0.
- You **may** use `sqlite3` in your own tests as a reference oracle (see `tests/`).
- `pytest` is not installed. Run the public tests with `python3 tests/run_public.py`.

## Python API

```python
import minisql

db = minisql.connect()            # a new, empty, in-memory database
rows = db.execute("SELECT 1 + 2") # -> [(3,)]
```

- `connect()` returns a database object. Databases are independent of each other.
- `execute(sql)` runs exactly **one** statement (an optional trailing `;` is allowed) and returns
  a `list` of `tuple`s for `SELECT` (and `WITH ... SELECT`), and `[]` for every other statement.
- Values are Python `None`, `int`, `float` or `str`. Boolean results are the integers `1` / `0`.
- Every invalid statement raises `minisql.Error` (a subclass of `Exception`) and never any other
  exception type. A statement that fails has **no effect** on the database (statements are atomic,
  e.g. a multi-row `INSERT` whose third row violates a constraint inserts nothing).
- Column names of results are not checked; only the row values.
- Row order is only checked when the statement's `ORDER BY` fully determines it. Without
  `ORDER BY` rows may come back in any order.

## Lexical rules

- Keywords, table names, column names and function names are case-insensitive.
  Identifiers match `[A-Za-z_][A-Za-z0-9_]*` and are never keywords.
- String literals use single quotes; `''` inside a string is an escaped quote.
- Numeric literals: `123` is an INTEGER; `1.5`, `.5`, `2.`, `1e3`, `1.5e-2` are REAL.
- `NULL` literal. `-- comment` runs to end of line.

## Types and storage

Column types: `INTEGER` (or `INT`), `REAL`, `TEXT`. Stored values follow SQLite affinity:

- INTEGER column: a REAL with an integral value is stored as an int (`3.0` → `3`); `3.5` stays `3.5`.
- REAL column: an int is stored as a float (`5` → `5.0`).
- TEXT column: a number is stored as its text (`7` → `'7'`).
- Tests never insert text into INTEGER/REAL columns.

## Statements

```
CREATE TABLE [IF NOT EXISTS] name (col type [PRIMARY KEY] [NOT NULL] [UNIQUE] ..., ...)
DROP TABLE [IF EXISTS] name
INSERT INTO name [(col, ...)] VALUES (expr, ...), (expr, ...) ...
INSERT INTO name [(col, ...)] select_stmt
UPDATE name SET col = expr [, col = expr ...] [WHERE expr]
DELETE FROM name [WHERE expr]
[WITH cte_name [(col, ...)] AS (select_stmt) [, ...]] select_stmt
```

- `CREATE TABLE` on an existing table, `DROP TABLE` on a missing table, unknown columns,
  and a wrong number of values are errors.
- Omitted columns in `INSERT` are `NULL`. Tests never omit a PRIMARY KEY column or set it to `NULL`.
- `PRIMARY KEY` implies `UNIQUE`. `UNIQUE` allows any number of `NULL`s. Violating `NOT NULL` or
  `UNIQUE` (in `INSERT` or `UPDATE`) is an error and the statement has no effect.
- In `UPDATE`, every expression sees the row's **old** values (`SET a = b, b = a` swaps).
- `WITH` (common table expressions, non-recursive) may be referenced like tables in the main
  query and in later CTEs.

### SELECT

```
select_stmt := select_core { (UNION | UNION ALL | INTERSECT | EXCEPT) select_core }
               [ORDER BY term [ASC|DESC], ...] [LIMIT expr [OFFSET expr]]
select_core := SELECT [DISTINCT] result_col, ...
               [FROM source] [WHERE expr] [GROUP BY expr, ...] [HAVING expr]
result_col  := * | table.* | expr [[AS] alias]
source      := table_ref { join_op table_ref [ON expr] }
join_op     := , | JOIN | INNER JOIN | CROSS JOIN | LEFT JOIN | LEFT OUTER JOIN
table_ref   := name [[AS] alias] | ( select_stmt ) [AS] alias
```

- `SELECT` without `FROM` returns one row.
- Column references: `col` or `qualifier.col` where qualifier is a table name or alias.
  An unknown column/table is an error; an unqualified name present in more than one source is an
  error ("ambiguous").
- `LEFT JOIN` pads unmatched rows with `NULL`s.
- `ORDER BY` terms may be expressions, result-column aliases, or 1-based result-column ordinals
  (an out-of-range ordinal is an error). `NULL` sorts **before** every other value in `ASC`
  order and after in `DESC`. Numbers compare numerically (int vs float), text compares by code point.
  For compound selects, `ORDER BY` terms are result-column aliases or ordinals.
- `DISTINCT`, `UNION`, `INTERSECT`, `EXCEPT` treat `NULL`s as equal to each other.
  Compound operators are left-associative with equal precedence; mismatched column counts are an error.
- `LIMIT n OFFSET m` with integer `n`, `m`.
- Aggregates: `COUNT(*)`, `COUNT(x)`, `SUM`, `AVG`, `MIN`, `MAX`, each optionally with
  `DISTINCT` (`COUNT(DISTINCT x)`). `NULL` inputs are ignored. `SUM` returns an int when all inputs
  are ints, `NULL` when there are no non-NULL inputs; `AVG` always returns a float (or `NULL`);
  `COUNT` of nothing is `0`. An aggregate query without `GROUP BY` returns exactly one row (even
  over zero rows). `HAVING` may use aggregates that are not in the result columns. Aggregates in
  `WHERE` or nested aggregates are errors. Tests never select a non-aggregated column that is not
  in `GROUP BY`.
- Subqueries: scalar `(select)` (zero rows → `NULL`; tests never return more than one row),
  `EXISTS (select)`, `NOT EXISTS (select)`, `x [NOT] IN (select)`, and derived tables in `FROM`.
  Subqueries may be **correlated** (reference columns of enclosing queries).

### Window functions

```
func(args) OVER ([PARTITION BY expr, ...] [ORDER BY term [ASC|DESC], ...])
```

Supported: `ROW_NUMBER()`, `RANK()`, `DENSE_RANK()`, `LAG(x [, offset [, default]])`,
`LEAD(x [, offset [, default]])`, and the aggregates `COUNT(*)`, `COUNT(x)`, `SUM`, `AVG`, `MIN`,
`MAX` as window functions. Default frame: without `ORDER BY` the whole partition; with `ORDER BY`
from the partition start through the current row **and its peers** (rows with equal ORDER BY
values). Window functions appear only in the result columns (and the outer `ORDER BY` may sort by
their alias). No named windows, no explicit frame clauses.

## Expressions

Operator precedence, highest first (binary operators are left-associative):

| Level | Operators |
|-------|-----------|
| 1 | unary `-`, unary `+` |
| 2 | `\|\|` |
| 3 | `*` `/` `%` |
| 4 | `+` `-` |
| 5 | `<` `<=` `>` `>=` |
| 6 | `=` `==` `!=` `<>` `IS` `IS NOT` `[NOT] IN` `[NOT] LIKE` `[NOT] BETWEEN` `IS NULL` `IS NOT NULL` |
| 7 | `NOT` |
| 8 | `AND` |
| 9 | `OR` |

So `1 = 2 < 3` is `1 = (2 < 3)` → `1`, and `3 > 2 > 1` is `(3 > 2) > 1` → `0`.

- **NULL**: any arithmetic, comparison, `||`, `LIKE` or `BETWEEN` with a `NULL` operand gives
  `NULL`. `AND`/`OR`/`NOT` use three-valued logic (`NULL AND 0` → `0`, `NULL OR 1` → `1`).
  `WHERE`/`HAVING`/`ON`/`CASE WHEN` treat `NULL` as false. `a IS b` / `a IS NOT b` are null-safe
  equality and never return `NULL`.
- **Arithmetic**: int op int → int; if either side is a float the result is a float.
  Integer `/` truncates toward zero (`-7 / 2` → `-3`); `%` takes the sign of the left operand
  (`-7 % 3` → `-1`, `7 % -3` → `1`); division or modulo by zero gives `NULL`. Tests only use `%`
  with integers and never overflow 64-bit integers.
- **Comparison**: numbers compare numerically; text by code point. Tests never compare text with numbers.
- `x IN (a, b, ...)`: `1` if a match is found; otherwise `NULL` if `x` or any list item is `NULL`;
  otherwise `0`. `NOT IN` is the negation (so `1 NOT IN (2, NULL)` → `NULL`). Same rules for `IN (select)`.
- `x BETWEEN a AND b` ≡ `x >= a AND x <= b`.
- `LIKE`: `%` matches any sequence, `_` one character; ASCII letters match case-insensitively.
  No `ESCAPE` clause.
- `||` concatenates text; integers convert to their decimal text (`'a' || 1` → `'a1'`).
  Tests never concatenate REAL values.
- `CASE WHEN c THEN r ... [ELSE e] END` and `CASE x WHEN v THEN r ... [ELSE e] END`
  (compares with `=`, so `NULL` never matches). Missing `ELSE` → `NULL`.
- `CAST(x AS INTEGER | REAL | TEXT)`: REAL→INTEGER truncates toward zero; TEXT→INTEGER/REAL parses
  the longest numeric prefix after leading spaces (`'12abc'` → `12`, `'abc'` → `0`);
  INTEGER→TEXT is the decimal string. `CAST(NULL AS ...)` is `NULL`.

### Scalar functions

Unknown functions and wrong argument counts are errors. All return `NULL` for a `NULL` argument
unless stated otherwise.

| Function | Behaviour |
|----------|-----------|
| `ABS(x)` | absolute value, keeps int/float type |
| `LENGTH(s)` | number of characters (tests only pass text) |
| `UPPER(s)`, `LOWER(s)` | ASCII case conversion |
| `SUBSTR(s, start [, len])` | 1-based; tests use `start >= 1` and `len >= 0` |
| `TRIM(s)` | strip spaces from both ends |
| `REPLACE(s, from, to)` | replace all occurrences |
| `INSTR(s, sub)` | 1-based index of first occurrence, `0` if absent |
| `COALESCE(a, b, ...)` | first non-NULL argument (at least 2 args) |
| `IFNULL(a, b)` | `COALESCE(a, b)` |
| `NULLIF(a, b)` | `NULL` if `a = b`, else `a` |
| `ROUND(x [, n])` | always returns a float; rounds half away from zero using the exact binary value of `x` (`ROUND(2.5)` → `3.0`, `ROUND(2.675, 2)` → `2.67`) |
| `MIN(a, b, ...)`, `MAX(a, b, ...)` | with 2+ arguments these are **scalar** functions; `NULL` if any argument is `NULL` |

## Performance

Hidden tests include tables of up to 50,000 rows, loaded with multi-row `INSERT` statements of
1,000 rows each. Each test's setup must finish within 60 s and each query within **10 s** on a
modern laptop. This includes equality joins between two 20,000-row tables, `IN (subquery)` over
large tables, `GROUP BY` / `ORDER BY` over 50,000 rows, and a correlated `EXISTS` subquery over
3,000 × 3,000 rows. Naive nested-loop evaluation will time out.

## Grading

A hidden suite of roughly 300 tests (different data and queries from the public ones) runs each
statement against both SQLite and `minisql` and compares results. Floats are compared with a
tolerance of 1e-6 and `3` equals `3.0`. Every test is worth the same; partial credit is per test.
