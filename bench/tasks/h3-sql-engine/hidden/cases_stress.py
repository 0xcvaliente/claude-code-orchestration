"""Stress suite, written after the main suite saturated. Stays within SPEC.md.
Randomized relational queries, a second expression-fuzz set, harder perf, and edge cases."""
import random
import sqlite3

from cases import CORP, Gen, perf_tables

# ------------------------------------------------------------ random relational queries
COLS = {
    "emp": {"id": "int", "name": "text", "dept_id": "int", "salary": "int", "bonus": "real", "hired": "text",
            "manager_id": "int", "email": "text"},
    "dept": {"id": "int", "name": "text", "city": "text", "budget": "int"},
    "proj": {"id": "int", "name": "text", "dept_id": "int", "lead_id": "int", "cost": "real", "started": "text"},
    "assign": {"emp_id": "int", "proj_id": "int", "hours": "int", "role": "text"},
}
EDGES = [("emp", "dept_id", "dept", "id"), ("proj", "dept_id", "dept", "id"), ("proj", "lead_id", "emp", "id"),
         ("assign", "emp_id", "emp", "id"), ("assign", "proj_id", "proj", "id"), ("emp", "manager_id", "emp", "id")]
INT_LITS = {"id": [1, 3, 5, 9, 12, 15, 101, 104, 106], "dept_id": [1, 2, 3, 4, 99], "salary": [50000, 70000, 88000, 95000, 105000],
            "manager_id": [1, 4, 7, 9], "budget": [90000, 150000, 300000], "lead_id": [1, 4, 9, 14], "emp_id": [1, 2, 10, 13],
            "proj_id": [101, 103, 104, 106], "hours": [30, 90, 160, 280]}
REAL_LITS = {"bonus": [0.0, 1000.0, 2500.5, 5000.0], "cost": [15000.0, 75000.25, 250000.0]}
TEXT_PATTERNS = ["'%a%'", "'A%'", "'%n'", "'_o%'", "'%corp%'", "'%2019%'", "'20%'", "'%e_'"]


class RelGen:
    def __init__(self, seed):
        self.r = random.Random(seed)

    def sources(self):
        r = self.r
        t0 = r.choice(list(COLS))
        tabs = [(t0, "t0")]
        sql = f"{t0} t0"
        for i in range(1, r.choice([1, 2, 2, 3])):
            cands = []
            for a, ac, b, bc in EDGES:
                for (tn, al) in tabs:
                    if tn == a:
                        cands.append((al, ac, b, bc))
                    if tn == b:
                        cands.append((al, bc, a, ac))
            al, col, other, ocol = r.choice(cands)
            new = f"t{i}"
            kind = r.choice(["JOIN", "JOIN", "LEFT JOIN", "INNER JOIN", "LEFT OUTER JOIN"])
            extra = ""
            if r.random() < 0.25:
                extra = " AND " + self.pred([(other, new)], 0)
            sql += f" {kind} {other} {new} ON {new}.{ocol} = {al}.{col}{extra}"
            tabs.append((other, new))
        return tabs, sql

    def col(self, tabs, kinds=("int", "real", "text")):
        r = self.r
        opts = [(al, c, k) for tn, al in tabs for c, k in COLS[tn].items() if k in kinds]
        return r.choice(opts)

    def lit(self, c, k):
        r = self.r
        if k == "int":
            return str(r.choice(INT_LITS.get(c, [0, 1, 2, 100])))
        if k == "real":
            return repr(r.choice(REAL_LITS.get(c, [0.5])))
        return r.choice(["'Oslo'", "'Bergen'", "'dev'", "'lead'", "'Apollo'", "'2018-01-01'", "'M'"])

    def num_expr(self, tabs):
        r = self.r
        al, c, k = self.col(tabs, ("int", "real"))
        x = r.random()
        if x < 0.5:
            return f"{al}.{c}"
        if x < 0.7:
            return f"{al}.{c} {r.choice(['+', '-', '*'])} {r.randint(1, 9)}"
        if x < 0.8:
            return f"COALESCE({al}.{c}, {r.randint(0, 5)})"
        if x < 0.9:
            return f"{al}.{c} / {r.choice([2, 3, 7, 1000])}"
        return f"ABS({al}.{c} - {self.lit(c, k)})"

    def pred(self, tabs, depth=1):
        r = self.r
        if depth > 0 and r.random() < 0.3:
            op = r.choice(["AND", "OR"])
            p = f"({self.pred(tabs, depth - 1)} {op} {self.pred(tabs, depth - 1)})"
            return f"NOT {p}" if r.random() < 0.15 else p
        al, c, k = self.col(tabs)
        x = r.random()
        if k == "text":
            if x < 0.5:
                return f"{al}.{c} {r.choice(['', 'NOT '])}LIKE {r.choice(TEXT_PATTERNS)}"
            if x < 0.7:
                return f"{al}.{c} IS {r.choice(['', 'NOT '])}NULL"
            return f"{al}.{c} {r.choice(['<', '>=', '=', '<>'])} {self.lit(c, k)}"
        if x < 0.45:
            return f"{al}.{c} {r.choice(['<', '<=', '>', '>=', '=', '<>'])} {self.lit(c, k)}"
        if x < 0.6:
            return f"{al}.{c} IS {r.choice(['', 'NOT '])}NULL"
        if x < 0.75 and k == "int":
            items = sorted({self.lit(c, k) for _ in range(3)})
            if r.random() < 0.2:
                items.append("NULL")
            return f"{al}.{c} {r.choice(['', 'NOT '])}IN ({', '.join(items)})"
        if x < 0.88:
            a, b = sorted([float(self.lit(c, k)), float(self.lit(c, k))])
            fmt = (lambda v: str(int(v))) if k == "int" else repr
            return f"{al}.{c} {r.choice(['', 'NOT '])}BETWEEN {fmt(a)} AND {fmt(b)}"
        return f"{self.num_expr(tabs)} > {self.num_expr(tabs)}"

    def subpred(self, tabs):
        r = self.r
        x = r.random()
        al, _, _ = self.col(tabs)
        tn = dict((a, t) for t, a in tabs)[al]
        if x < 0.35:
            # correlated EXISTS via an edge
            for a, ac, b, bc in r.sample(EDGES, len(EDGES)):
                if b == tn:
                    inner = f"SELECT 1 FROM {a} s WHERE s.{ac} = {al}.{bc}"
                    if r.random() < 0.5:
                        inner += " AND " + self.pred([(a, "s")], 0)
                    return f"{r.choice(['', 'NOT '])}EXISTS ({inner})"
                if a == tn:
                    inner = f"SELECT 1 FROM {b} s WHERE s.{bc} = {al}.{ac}"
                    if r.random() < 0.5:
                        inner += " AND " + self.pred([(b, "s")], 0)
                    return f"{r.choice(['', 'NOT '])}EXISTS ({inner})"
        if x < 0.7:
            for a, ac, b, bc in r.sample(EDGES, len(EDGES)):
                if a == tn:
                    return f"{al}.{ac} {r.choice(['', 'NOT '])}IN (SELECT s.{bc} FROM {b} s WHERE {self.pred([(b, 's')], 0)})"
                if b == tn:
                    return f"{al}.{bc} {r.choice(['', 'NOT '])}IN (SELECT s.{ac} FROM {a} s WHERE {self.pred([(a, 's')], 0)})"
        c = r.choice([("emp", "salary"), ("proj", "cost"), ("assign", "hours"), ("dept", "budget")])
        al2, col2, _ = self.col(tabs, ("int", "real"))
        return f"{al2}.{col2} {r.choice(['>', '<', '>='])} (SELECT {r.choice(['AVG', 'MIN', 'MAX'])}(s.{c[1]}) FROM {c[0]} s)"

    def where(self, tabs):
        r = self.r
        parts = []
        if r.random() < 0.8:
            parts.append(self.pred(tabs))
        if r.random() < 0.3:
            parts.append(self.subpred(tabs))
        return (" WHERE " + " AND ".join(parts)) if parts else ""

    def proj_expr(self, tabs):
        r = self.r
        al, c, k = self.col(tabs)
        x = r.random()
        if k == "text":
            if x < 0.6:
                return f"{al}.{c}"
            if x < 0.75:
                return f"UPPER({al}.{c})"
            if x < 0.9:
                return f"SUBSTR({al}.{c}, {r.randint(1, 3)}, {r.randint(1, 4)})"
            return f"LENGTH({al}.{c})"
        if x < 0.6:
            return f"{al}.{c}"
        if x < 0.8:
            return self.num_expr(tabs)
        return f"CASE WHEN {self.pred(tabs, 0)} THEN {al}.{c} ELSE {r.randint(-1, 1)} END"

    def query(self):
        r = self.r
        tabs, src = self.sources()
        form = r.randrange(7)
        if form in (0, 1):
            exprs = [self.proj_expr(tabs) for _ in range(r.randint(1, 4))]
            distinct = "DISTINCT " if r.random() < 0.2 else ""
            q = f"SELECT {distinct}{', '.join(exprs)} FROM {src}{self.where(tabs)}"
            if r.random() < 0.5:
                order = ", ".join(f"{i + 1}{r.choice(['', ' DESC'])}" for i in range(len(exprs)))
                q += f" ORDER BY {order}"
                if r.random() < 0.5:
                    q += f" LIMIT {r.randint(1, 6)}" + (f" OFFSET {r.randint(1, 3)}" if r.random() < 0.3 else "")
            return q
        if form in (2, 3):
            keys = list(dict.fromkeys(f"{al}.{c}" for al, c, _ in (self.col(tabs) for _ in range(r.randint(1, 2)))))
            aggs = []
            for _ in range(r.randint(1, 3)):
                f = r.choice(["COUNT(*)", "COUNT", "SUM", "AVG", "MIN", "MAX", "COUNT(DISTINCT"])
                if f == "COUNT(*)":
                    aggs.append(f)
                elif f == "COUNT(DISTINCT":
                    al, c, _ = self.col(tabs)
                    aggs.append(f"COUNT(DISTINCT {al}.{c})")
                elif f in ("MIN", "MAX", "COUNT"):
                    al, c, _ = self.col(tabs)
                    aggs.append(f"{f}({al}.{c})")
                else:
                    aggs.append(f"{f}({self.num_expr(tabs)})")
            q = f"SELECT {', '.join(keys + aggs)} FROM {src}{self.where(tabs)} GROUP BY {', '.join(keys)}"
            if r.random() < 0.4:
                q += f" HAVING {r.choice(['COUNT(*) > 1', 'COUNT(*) >= 2', aggs[0] + ' IS NOT NULL', 'MAX(' + self.num_expr(tabs) + ') > 1000'])}"
            if r.random() < 0.5:
                q += " ORDER BY " + ", ".join(str(i + 1) for i in range(len(keys)))
            return q
        if form == 4:
            al, c, _ = self.col(tabs)
            al2, c2, _ = self.col(tabs, ("int", "real"))
            pk = f"{tabs[0][1]}.{list(COLS[tabs[0][0]])[0]}"
            w = r.choice([f"ROW_NUMBER() OVER (PARTITION BY {al}.{c} ORDER BY {al2}.{c2}, {pk})",
                          f"RANK() OVER (ORDER BY {al2}.{c2} DESC)",
                          f"DENSE_RANK() OVER (PARTITION BY {al}.{c} ORDER BY {al2}.{c2})",
                          f"SUM({al2}.{c2}) OVER (PARTITION BY {al}.{c})",
                          f"COUNT(*) OVER (PARTITION BY {al}.{c} ORDER BY {al2}.{c2})",
                          f"MAX({al2}.{c2}) OVER (ORDER BY {al2}.{c2})",
                          f"AVG({al2}.{c2}) OVER (PARTITION BY {al}.{c})",
                          f"LAG({al2}.{c2}, 1, 0) OVER (PARTITION BY {al}.{c} ORDER BY {al2}.{c2}, {pk})"])
            return f"SELECT {al}.{c}, {al2}.{c2}, {w} FROM {src}{self.where(tabs)}"
        if form == 5:
            t1, t2 = r.choice(list(COLS)), r.choice(list(COLS))
            k = r.choice(["int", "text"])
            c1 = r.choice([c for c, kk in COLS[t1].items() if kk == k])
            c2 = r.choice([c for c, kk in COLS[t2].items() if kk == k])
            op = r.choice(["UNION", "UNION ALL", "INTERSECT", "EXCEPT"])
            q = (f"SELECT x.{c1} FROM {t1} x WHERE {self.pred([(t1, 'x')], 0)} {op} "
                 f"SELECT y.{c2} FROM {t2} y WHERE {self.pred([(t2, 'y')], 0)}")
            if r.random() < 0.5:
                q += " ORDER BY 1" + r.choice(["", " DESC"])
            return q
        # CTE over a grouped query
        key_al, key_c, _ = self.col(tabs)
        al2, c2, _ = self.col(tabs, ("int", "real"))
        return (f"WITH g AS (SELECT {key_al}.{key_c} AS k, COUNT(*) AS n, SUM({al2}.{c2}) AS s FROM {src}{self.where(tabs)} "
                f"GROUP BY {key_al}.{key_c}) SELECT k, n, s FROM g WHERE n {r.choice(['>=', '>', '='])} {r.randint(1, 3)}"
                + (" ORDER BY n DESC, k" if r.random() < 0.5 else ""))


def deterministic(sql, tables):
    """Run on SQLite in forward and reverse insertion order; keep only queries whose result is
    the same multiset (and non-error)."""
    from grade import res_eq, run_sqlite  # local import: grade imports cases
    case = {"tables": tables, "setup": [], "sql": sql}
    a, b = run_sqlite(case), run_sqlite(case, reverse=True)
    if a[0] != "rows" or b[0] != "rows":
        return None
    if not res_eq(a[1], b[1], False):
        return None
    return a[1]


def rel_queries(n, seed):
    gen = RelGen(seed)
    out, empties = [], 0
    while len(out) < n:
        q = gen.query()
        rows = deterministic(q, CORP)
        if rows is None:
            continue
        if not rows:
            empties += 1
            if empties % 4:
                continue
        out.append(q)
    return out


FZ2 = ("CREATE TABLE fz (a INTEGER, b INTEGER, c INTEGER, t TEXT)", [
    (2, -3, 5, "alpha"), (-6, 0, 7, "Beta"), (0, 9, None, "gamma ray"), (14, 14, -2, None), (None, 1, 1, "Delta"),
    (7, None, -9, "epsilon"), (-2, 6, 0, "Zeta"), (11, -5, 3, "eta"), (4, 10, None, "Theta pi"), (None, None, None, "iota"),
    (8, -1, 12, "kappa"), (-3, 2, -4, ""), (1, 1, 1, "lambda"), (-9, -8, 6, "MU"), (0, 0, 0, "nu"),
])


def fuzz2(n, seed):
    gen = Gen(seed)
    con = sqlite3.connect(":memory:")
    con.execute(FZ2[0])
    con.executemany("INSERT INTO fz VALUES (?, ?, ?, ?)", FZ2[1])
    out = []
    while len(out) < n:
        q = gen.query()
        try:
            rows = con.execute(q).fetchall()
        except sqlite3.Error:
            continue
        vals = [v for row in rows for v in row]
        if any(isinstance(v, float) or (isinstance(v, int) and abs(v) > 2 ** 53) for v in vals):
            continue
        out.append(q)
    return out


PERF2 = [
    (["c1", "c2"], "SELECT COUNT(*) FROM c1 WHERE NOT EXISTS (SELECT 1 FROM c2 WHERE c2.k = c1.k)"),
    (["j1", "j2"], "SELECT COUNT(*), SUM(b.w) FROM j1 a JOIN j2 b ON a.k = b.k AND a.w < b.w"),
    (["j1", "j2", "big1"], "SELECT COUNT(*) FROM j1 a JOIN j2 b ON b.k = a.k JOIN big1 c ON c.k = a.w"),
    (["big1"], "SELECT k, COUNT(*), MIN(v), MAX(s) FROM big1 GROUP BY k HAVING COUNT(*) > 55 ORDER BY k"),
    (["big1"], "SELECT id, k, v FROM big1 ORDER BY k, v DESC, id"),
    (["big1", "j1"], "SELECT COUNT(*) FROM big1 WHERE k NOT IN (SELECT w FROM j1 WHERE id < 5000)"),
    (["j1", "j2"], "SELECT COUNT(*) FROM j1 a LEFT JOIN j2 b ON a.k = b.k WHERE b.id IS NULL"),
    (["big1"], "SELECT COUNT(DISTINCT k), COUNT(DISTINCT s) FROM big1 WHERE v > 500000"),
    (["c1", "c2"], "SELECT c1.id FROM c1 WHERE EXISTS (SELECT 1 FROM c2 WHERE c2.k = c1.k AND c2.w > 90) ORDER BY c1.id LIMIT 20"),
    (["j1", "j2"], "SELECT a.k, COUNT(*) FROM j1 a JOIN j2 b ON a.k = b.k GROUP BY a.k ORDER BY COUNT(*) DESC, a.k LIMIT 10"),
    (["big1"], "SELECT COUNT(*) FROM big1 WHERE s IN (SELECT s FROM big1 WHERE v < 1000)"),
    (["big1"], "SELECT COUNT(*) FROM (SELECT DISTINCT k, s FROM big1) t"),
    (["j1", "j2"], "SELECT COUNT(*) FROM j1 a JOIN j2 b ON a.k = b.k AND a.w = b.w"),
    (["c1", "c2"], "SELECT COUNT(*) FROM c1, c2 WHERE c1.k = c2.k"),
    (["j1", "j2"], "SELECT COUNT(*) FROM j1 a, j2 b WHERE a.k = b.k AND b.w > 500"),
    (["big1"], "SELECT k, SUM(v) FROM big1 WHERE s LIKE 'name1%' GROUP BY k ORDER BY SUM(v) DESC, k LIMIT 5"),
]

EDGE = [  # (setup, sql, expect_error)
    ([], "SELECT UPPER('blåbær'), LOWER('ÆØÅ abc'), LENGTH('blåbær'), SUBSTR('blåbær', 3, 2)", False),
    ([], "SELECT 'Æ' LIKE 'æ', 'a' LIKE 'A', 'ø%' LIKE 'Ø%'", False),
    ([], "SELECT -7 / -2, 7 % -3, -7 % -3, 0 / 5, -0 % 3", False),
    ([], "SELECT 1 = 1.0, 2 > 1.5, 3 / 2 = 1, 3 / 2.0 = 1.5", False),
    ([], "SELECT CAST('  -12xyz' AS INTEGER), CAST('3.9' AS INTEGER), CAST('-' AS INTEGER), CAST('' AS REAL), CAST('.5' AS REAL), CAST('12.5abc' AS REAL)", False),
    ([], "SELECT ROUND(-1.5), ROUND(0.5), ROUND(1.45, 1), ROUND(-0.5), ROUND(2.5, 0), ROUND(NULL)", False),
    ([], "SELECT MIN(1, 2.5, -3), MAX(1.5, 2), COALESCE(NULL, NULL), NULLIF(NULL, 1), IFNULL(NULL, NULL)", False),
    ([], "SELECT 3 BETWEEN 5 AND 1, NULL NOT BETWEEN 1 AND 2, 2 NOT BETWEEN NULL AND 1", False),
    ([], "SELECT name FROM emp WHERE salary IN (100000 + 20000, 95000) ORDER BY id", False),
    ([], "SELECT * FROM (SELECT 1 AS a UNION ALL SELECT 2 UNION ALL SELECT NULL) t ORDER BY a DESC", False),
    ([], "SELECT DISTINCT a FROM (SELECT NULL AS a UNION ALL SELECT NULL UNION ALL SELECT 1) t", False),
    ([], "SELECT COUNT(*) FROM emp e1 JOIN emp e2 ON e1.manager_id = e2.id JOIN emp e3 ON e2.manager_id = e3.id", False),
    ([], "SELECT d.name, COUNT(*), COUNT(e.id) FROM dept d LEFT JOIN emp e ON e.dept_id = d.id GROUP BY d.name ORDER BY d.name", False),
    ([], "SELECT e.name FROM emp e ORDER BY (SELECT COUNT(*) FROM assign a WHERE a.emp_id = e.id) DESC, e.id LIMIT 5", False),
    ([], "SELECT d.name, (SELECT MAX(p.cost) FROM proj p WHERE p.dept_id = d.id AND p.lead_id IN (SELECT e.id FROM emp e WHERE e.dept_id = d.id)) FROM dept d", False),
    ([], "SELECT x.n, d.name FROM (SELECT dept_id, COUNT(*) AS n FROM emp GROUP BY dept_id) x JOIN dept d ON d.id = x.dept_id ORDER BY x.n DESC, d.name", False),
    ([], "WITH a AS (SELECT id, salary FROM emp WHERE salary IS NOT NULL) SELECT x.id, y.id FROM a x JOIN a y ON x.salary = y.salary AND x.id < y.id", False),
    ([], "WITH a(d, n) AS (SELECT dept_id, COUNT(*) FROM emp GROUP BY dept_id), b AS (SELECT d FROM a WHERE n > 2) SELECT COUNT(*) FROM b", False),
    ([], "SELECT dept_id, SUM(salary), RANK() OVER (ORDER BY SUM(salary) DESC) FROM emp GROUP BY dept_id", False),
    ([], "SELECT id, COUNT(*) OVER () FROM emp WHERE dept_id = 1", False),
    ([], "SELECT id, SUM(salary) OVER (PARTITION BY dept_id ORDER BY salary DESC) FROM emp", False),
    ([], "SELECT id, LAG(salary, 2) OVER (ORDER BY id), LEAD(salary, 5, -1) OVER (ORDER BY id) FROM emp", False),
    ([], "SELECT t.dept_id, MAX(t.rn) FROM (SELECT dept_id, ROW_NUMBER() OVER (PARTITION BY dept_id ORDER BY id) AS rn FROM emp) t GROUP BY t.dept_id", False),
    ([], "SELECT name, MIN(salary, 90000) AS capped FROM emp ORDER BY capped DESC, name LIMIT 4", False),
    ([], "SELECT id FROM emp ORDER BY id LIMIT 2 + 1 OFFSET 1", False),
    ([], "SELECT 1 IN (SELECT dept_id FROM emp WHERE dept_id IS NULL), 1 NOT IN (SELECT dept_id FROM emp WHERE id > 100)", False),
    ([], "SELECT name || '-' || -3, 'v' || (2 * 21) FROM dept WHERE id = 1", False),
    (["UPDATE emp SET salary = CASE WHEN salary > 100000 THEN salary - 1 ELSE salary + 1 END, bonus = bonus * 2"], "SELECT id, salary, bonus FROM emp", False),
    (["?UPDATE emp SET name = CASE WHEN id = 10 THEN NULL ELSE name || '!' END"], "SELECT name FROM emp ORDER BY id", False),
    (["CREATE TABLE s (k INTEGER PRIMARY KEY, v TEXT)", "INSERT INTO s SELECT id, name FROM dept UNION SELECT id + 10, city FROM dept"], "SELECT * FROM s", False),
    (["DELETE FROM emp WHERE salary < (SELECT AVG(salary) FROM emp e2 WHERE e2.dept_id = emp.dept_id)"], "SELECT id FROM emp", False),
    (["CREATE TABLE q (a INTEGER, b REAL, c TEXT)", "INSERT INTO q VALUES (1, 1, 1), (2.0, 2.5, -3), (NULL, 4, 4.5)"], "SELECT a, b, c, a * b FROM q", False),
    (["DROP TABLE emp"], "SELECT * FROM emp", True),
    ([], "INSERT INTO dept SELECT id, name FROM emp", True),
    ([], "SELECT dept_id FROM emp GROUP BY COUNT(*)", True),
    ([], "SELECT id FROM emp WHERE ROW_NUMBER() OVER (ORDER BY id) = 1", True),
    ([], "SELECT SUM()", True),
    ([], "SELECT SUBSTR('a', 1, 2, 3)", True),
    ([], "SELECT LENGTH('a', 'b')", True),
    ([], "WITH x AS (SELECT 1) SELECT * FROM y", True),
    ([], "SELECT name FROM emp ORDER BY 0", True),
    ([], "SELECT e.name FROM emp e JOIN nosuch n ON n.id = e.id", True),
    ([], "SELECT e.name FROM emp e JOIN dept d ON d.nosuch = e.dept_id", True),
    ([], "UPDATE emp SET name = NULL WHERE id = 3", True),
    ([], "SELECT name FROM emp e WHERE e.id = 1 GROUP BY", True),
    ([], "SELECT COUNT(*) FROM emp WHERE id IN (SELECT id, name FROM dept)", True),
]


def build_cases():
    cases = []

    def add(cat, sql, tables=CORP, setup=(), expect_error=False, query_timeout=10):
        cases.append({"id": f"{cat}{sum(c['cat'] == cat for c in cases) + 1:04d}", "cat": cat, "tables": tables,
                      "setup": list(setup), "sql": sql, "expect_error": expect_error, "query_timeout": query_timeout})

    for q in rel_queries(600, 777):
        add("s_relational", q)
    for q in fuzz2(400, 4242):
        add("s_fuzz", q, tables={"fz": FZ2})
    for setup, q, err in EDGE:
        add("s_edge", q, setup=setup, expect_error=err)
    pt = perf_tables()
    for names, q in PERF2:
        add("s_perf", q, tables={n: pt[n] for n in names})
    return cases
