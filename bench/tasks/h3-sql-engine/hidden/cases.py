"""Hidden test suite for the minisql benchmark. build_cases() returns a list of case dicts:
{"id", "cat", "tables", "setup", "sql", "expect_error"(bool), "query_timeout"}.
Setup statements prefixed with "?" may fail (errors are ignored, used for atomicity checks).
"""
import random

DEPT = ("CREATE TABLE dept (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT, budget INTEGER)", [
    (1, "Engineering", "Oslo", 500000), (2, "Sales", "Bergen", 200000), (3, "Marketing", "Oslo", 150000),
    (4, "Research", None, 300000), (5, "Legal", "Trondheim", None), (6, "Support", "Bergen", 90000),
])
EMP = ("CREATE TABLE emp (id INTEGER PRIMARY KEY, name TEXT NOT NULL, dept_id INTEGER, salary INTEGER, "
       "bonus REAL, hired TEXT, manager_id INTEGER, email TEXT)", [
    (1, "Alice Hansen", 1, 120000, 5000.0, "2015-03-01", None, "alice@corp.no"),
    (2, "Bob Olsen", 1, 95000, 2500.5, "2018-06-15", 1, "bob@corp.no"),
    (3, "Carla Berg", 1, 95000, None, "2019-01-10", 1, None),
    (4, "David Lie", 2, 70000, 7000.0, "2017-09-23", None, "david@corp.no"),
    (5, "Eva Dahl", 2, 65000, 3000.25, "2020-02-29", 4, "eva@corp.no"),
    (6, "frank moe", 2, None, None, "2021-11-30", 4, "FRANK@corp.no"),
    (7, "Gina Strand", 3, 80000, 1000.0, "2016-05-05", None, "gina@corp.no"),
    (8, "Hans Holm", 3, 58000, 0.0, "2022-08-01", 7, None),
    (9, "Ingrid Lund", 4, 110000, 12000.75, "2014-12-12", None, "ingrid@corp.no"),
    (10, "Jon Eide", 4, 102000, None, "2016-07-07", 9, "jon@corp.no"),
    (11, "Kari Vik", 4, 99000, 4500.0, "2019-10-10", 9, "kari@corp.no"),
    (12, "Lars Bakke", None, 50000, None, "2023-01-02", None, "lars@corp.no"),
    (13, "Mona Ruud", 5, 88000, 2000.0, "2018-04-04", None, "mona@corp.no"),
    (14, "Nils O'Brien", 1, 105000, 6000.0, "2017-02-14", 1, "nils@corp.no"),
    (15, "Ola Nord", 99, 45000, 500.0, "2024-05-20", None, None),
    (16, "Pia Sand", 2, 70000, 3500.0, "2019-09-09", 4, "pia@corp.no"),
    (17, "Quinn Ask", 3, 80000, None, "2020-12-01", 7, "quinn@corp.no"),
    (18, "Rita Fjell", 1, 120000, 8000.0, "2013-11-11", None, "rita@corp.no"),
])
PROJ = ("CREATE TABLE proj (id INTEGER PRIMARY KEY, name TEXT, dept_id INTEGER, lead_id INTEGER, cost REAL, started TEXT)", [
    (101, "Apollo", 1, 1, 250000.0, "2023-01-15"), (102, "Borealis", 1, 14, 120000.5, "2023-06-01"),
    (103, "Cirrus", 2, 4, 40000.0, None), (104, "Delta", 4, 9, 310000.0, "2022-03-03"),
    (105, "Echo", 4, None, None, "2024-01-01"), (106, "Fjord", 3, 7, 75000.25, "2023-09-09"),
    (107, "Glacier", None, 12, 15000.0, "2024-02-02"), (108, "Halo", 6, None, 5000.0, "2024-07-07"),
])
ASSIGN = ("CREATE TABLE assign (emp_id INTEGER, proj_id INTEGER, hours INTEGER, role TEXT)", [
    (1, 101, 120, "lead"), (2, 101, 300, "dev"), (3, 101, 280, "dev"), (14, 102, 200, "lead"), (2, 102, 50, "dev"),
    (4, 103, 90, "lead"), (5, 103, 160, "sales"), (16, 103, None, "sales"), (9, 104, 40, "lead"),
    (10, 104, 400, "research"), (11, 104, 350, "research"), (10, 105, 100, None), (11, 105, None, "research"),
    (7, 106, 60, "lead"), (8, 106, 200, "design"), (17, 106, 180, "design"), (12, 107, 30, "lead"),
    (1, 104, 20, "advisor"), (18, 101, 10, "advisor"), (13, 103, 15, "legal"), (13, 104, 25, "legal"),
    (15, 107, 80, "dev"),
])
CORP = {"dept": DEPT, "emp": EMP, "proj": PROJ, "assign": ASSIGN}

BASICS = [
    "SELECT 2 * (3 + 4) - 10 / 3, 10 % 4, -(5 - 8), 3.0 / 2, 1 / 2",
    "SELECT 1 = 2 < 3, 3 > 2 > 1, 2 + 3 * 4 - 1, (2 + 3) * 4, 7 - 3 - 2, 100 / 10 / 5",
    "SELECT 'it''s' || ' ok', 'x' || 12, LENGTH('it''s')",
    "SELECT name FROM emp WHERE salary > 100000",
    "SELECT name, salary FROM emp WHERE dept_id = 1 AND salary >= 100000 OR dept_id = 3",
    "SELECT name FROM emp WHERE NOT (salary < 90000)",
    "SELECT id, salary * 12 / 1000 FROM emp WHERE id <= 5",
    "SELECT id, bonus * 2, salary + bonus FROM emp",
    "SELECT e.name, e.salary FROM emp AS e WHERE e.salary <> 70000",
    "select Name, SALARY from EMP where Dept_Id = 2",
    "SELECT name FROM emp WHERE hired >= '2020-01-01'",
    "SELECT id, -salary, +salary FROM emp WHERE id < 4",
    "SELECT 1.5e2, .25, 2., 1e-1 * 10",
    "SELECT * FROM dept",
    "SELECT dept.*, 1 FROM dept WHERE id < 3",
    "SELECT id, salary / 7, salary % 7, -salary / 7, -salary % 7 FROM emp WHERE salary IS NOT NULL",
    "SELECT 10 / 0, 10 % 0, 10.0 / 0, NULL / 0",
    "SELECT name FROM emp WHERE id = 14",
    "SELECT id FROM emp WHERE salary == 95000",
    "SELECT id, salary > 90000, salary = 95000 FROM emp",
    "SELECT name FROM emp WHERE (dept_id = 1 OR dept_id = 2) AND NOT salary > 90000",
    "SELECT 5 - -3, - - 4, 2 * -3",
    "SELECT id, name FROM emp -- trailing comment\nWHERE id = 3",
    "SELECT name, budget / 1000 FROM dept WHERE budget > 100000;",
    "SELECT id, cost / 1000.0 FROM proj",
    "SELECT e.id, e.dept_id + e.manager_id FROM emp e",
]
NULLS = [
    "SELECT NULL + 1, NULL * 0, NULL || 'a', NULL = NULL, NULL <> 1, NOT NULL",
    "SELECT NULL AND 0, NULL AND 1, NULL OR 1, NULL OR 0, 0 AND NULL, 1 OR NULL",
    "SELECT name FROM emp WHERE bonus IS NULL",
    "SELECT name FROM emp WHERE bonus IS NOT NULL AND bonus < 3000",
    "SELECT name FROM emp WHERE NOT (bonus > 3000)",
    "SELECT id, bonus > 3000 OR salary > 100000 FROM emp",
    "SELECT id, dept_id IS 1, dept_id IS NOT 2, manager_id IS NULL FROM emp",
    "SELECT name FROM emp WHERE dept_id IN (1, NULL)",
    "SELECT name FROM emp WHERE dept_id NOT IN (1, 2, NULL)",
    "SELECT id, dept_id IN (1, 2), dept_id NOT IN (3, 4) FROM emp",
    "SELECT id, salary BETWEEN 60000 AND 100000, bonus BETWEEN 1000 AND 5000 FROM emp",
    "SELECT id, CASE WHEN bonus > 3000 THEN 'high' WHEN bonus <= 3000 THEN 'low' END FROM emp",
    "SELECT id, CASE dept_id WHEN 1 THEN 'eng' WHEN NULL THEN 'none' ELSE 'other' END FROM emp",
    "SELECT name FROM emp WHERE manager_id = NULL",
    "SELECT COUNT(*) FROM emp WHERE NOT (dept_id = 1)",
    "SELECT id, NULL IS NULL, NULL IS NOT NULL, 1 IS NULL FROM dept WHERE id = 1",
]
FUNCS = [
    "SELECT UPPER(name), LOWER(name) FROM emp WHERE id IN (1, 6, 14)",
    "SELECT LENGTH(name), SUBSTR(name, 1, 3), SUBSTR(name, 3) FROM emp",
    "SELECT TRIM('  padded  '), TRIM(''), REPLACE(email, '@corp.no', '@corp.com') FROM emp WHERE id < 4",
    "SELECT INSTR(name, ' '), SUBSTR(name, 1, INSTR(name, ' ') - 1) FROM emp",
    "SELECT COALESCE(bonus, 0), IFNULL(email, 'none'), NULLIF(dept_id, 1) FROM emp",
    "SELECT COALESCE(NULL, NULL, 'z', 'y'), COALESCE(NULL, 2)",
    "SELECT ABS(-3), ABS(3.5), ABS(-0.25), ABS(NULL), ABS(salary - 100000) FROM emp WHERE id < 5",
    "SELECT ROUND(2.5), ROUND(-2.5), ROUND(3.14159, 2), ROUND(2.675, 2), ROUND(7), ROUND(-0.45, 1), ROUND(1234.5678, 3)",
    "SELECT id, ROUND(bonus / 3, 2), ROUND(salary / 7.0) FROM emp",
    "SELECT MAX(3, 7, 5), MIN(3, 7, 5), MAX(1, NULL), MIN('b', 'a', 'c'), MAX(2, 2.5)",
    "SELECT id, MAX(salary, 80000), MIN(bonus, 3000) FROM emp",
    "SELECT CAST(salary AS REAL) / 1000, CAST(bonus AS INTEGER), CAST(id AS TEXT) || '#' FROM emp WHERE id < 7",
    "SELECT CAST('42' AS INTEGER) + 1, CAST('3.5' AS REAL) * 2, CAST('12abc' AS INTEGER), CAST('abc' AS INTEGER), CAST(' 7' AS INTEGER), CAST(-2.9 AS INTEGER), CAST(NULL AS TEXT)",
    "SELECT name FROM emp WHERE LOWER(email) LIKE 'f%'",
    "SELECT name FROM emp WHERE name LIKE '%a_d%'",
    "SELECT name FROM emp WHERE name NOT LIKE '%a%'",
    "SELECT name, name LIKE 'ALICE%', email LIKE '%@CORP.NO' FROM emp",
    "SELECT UPPER(SUBSTR(name, 1, 1)) || LOWER(SUBSTR(name, 2)) FROM emp WHERE id = 6",
    "SELECT REPLACE('aaaa', 'aa', 'b'), INSTR('banana', 'an'), LENGTH(''), SUBSTR('abc', 2, 0), SUBSTR('abc', 5)",
    "SELECT name || ' (' || dept_id || ')' FROM emp",
    "SELECT 'x' LIKE 'X', 'abc' LIKE 'a%c', 'ac' LIKE 'a_c', 'a_c' LIKE 'a_c', '100%' LIKE '100%'",
    "SELECT id, LENGTH(email) - LENGTH(REPLACE(email, 'o', '')) FROM emp",
]
JOINS = [
    "SELECT e.name, d.name FROM emp e JOIN dept d ON e.dept_id = d.id",
    "SELECT e.name, d.name FROM emp e LEFT JOIN dept d ON e.dept_id = d.id",
    "SELECT d.name, e.name FROM dept d LEFT JOIN emp e ON e.dept_id = d.id AND e.salary > 100000",
    "SELECT d.name, COUNT(e.id) FROM dept d LEFT JOIN emp e ON e.dept_id = d.id GROUP BY d.id, d.name",
    "SELECT e.name, m.name FROM emp e LEFT JOIN emp m ON e.manager_id = m.id",
    "SELECT e.name, p.name, a.hours FROM assign a JOIN emp e ON e.id = a.emp_id JOIN proj p ON p.id = a.proj_id WHERE a.hours > 100",
    "SELECT d.name, p.name FROM dept d, proj p WHERE d.id = p.dept_id AND d.city = 'Oslo'",
    "SELECT COUNT(*) FROM dept CROSS JOIN proj",
    "SELECT d.name, p.name FROM dept d CROSS JOIN proj p WHERE p.cost > 200000",
    "SELECT e.name FROM emp e INNER JOIN dept d ON d.id = e.dept_id WHERE d.city IS NULL",
    "SELECT p.name, e.name FROM proj p LEFT JOIN emp e ON e.id = p.lead_id LEFT JOIN dept d ON d.id = e.dept_id WHERE d.id IS NULL",
    "SELECT e.id, d.id FROM emp e LEFT OUTER JOIN dept d ON d.id = e.dept_id WHERE e.id > 10",
    "SELECT a.emp_id, b.emp_id, a.proj_id FROM assign a JOIN assign b ON a.proj_id = b.proj_id AND a.emp_id < b.emp_id WHERE a.proj_id = 101",
    "SELECT x.name, y.name FROM dept x JOIN dept y ON x.city = y.city AND x.id < y.id",
    "SELECT e.name, d.name, p.name FROM emp e JOIN dept d ON d.id = e.dept_id LEFT JOIN proj p ON p.lead_id = e.id",
    "SELECT emp.name, dept.city FROM emp JOIN dept ON emp.dept_id = dept.id WHERE dept.budget >= 200000",
    "SELECT d.name, e.name FROM emp e JOIN dept d ON e.dept_id = d.id AND e.bonus IS NULL",
]
AGGS = [
    "SELECT COUNT(*), COUNT(salary), COUNT(bonus), COUNT(DISTINCT dept_id), COUNT(DISTINCT salary) FROM emp",
    "SELECT SUM(salary), AVG(salary), MIN(salary), MAX(salary) FROM emp",
    "SELECT SUM(bonus), AVG(bonus), MIN(bonus), MAX(bonus) FROM emp",
    "SELECT dept_id, COUNT(*), SUM(salary), AVG(salary) FROM emp GROUP BY dept_id",
    "SELECT dept_id, MAX(salary) - MIN(salary) FROM emp GROUP BY dept_id HAVING COUNT(salary) >= 2",
    "SELECT dept_id FROM emp GROUP BY dept_id HAVING AVG(salary) > 80000",
    "SELECT COUNT(*), SUM(salary), AVG(salary), MIN(name), MAX(hired) FROM emp WHERE salary > 1000000",
    "SELECT dept_id, COUNT(*) FROM emp WHERE salary > 1000000 GROUP BY dept_id",
    "SELECT SUBSTR(hired, 1, 4), COUNT(*) FROM emp GROUP BY SUBSTR(hired, 1, 4)",
    "SELECT dept_id, manager_id IS NULL, COUNT(*) FROM emp GROUP BY dept_id, manager_id IS NULL",
    "SELECT role, SUM(hours), COUNT(hours), COUNT(*) FROM assign GROUP BY role",
    "SELECT proj_id, SUM(DISTINCT hours), COUNT(DISTINCT role) FROM assign GROUP BY proj_id",
    "SELECT d.name, SUM(a.hours) FROM dept d JOIN proj p ON p.dept_id = d.id JOIN assign a ON a.proj_id = p.id GROUP BY d.name",
    "SELECT COUNT(*) FROM (SELECT DISTINCT dept_id FROM emp) t",
    "SELECT AVG(salary) * 2, SUM(salary) / COUNT(salary), MAX(salary) > 100000 FROM emp",
    "SELECT dept_id, SUM(salary) FROM emp WHERE dept_id IS NOT NULL GROUP BY dept_id HAVING SUM(salary) > 200000 ORDER BY SUM(salary) DESC",
    "SELECT MIN(bonus), MAX(email) FROM emp WHERE dept_id = 1",
    "SELECT COUNT(DISTINCT manager_id), SUM(DISTINCT salary), AVG(DISTINCT salary) FROM emp",
    "SELECT dept_id, CASE WHEN COUNT(*) > 3 THEN 'big' ELSE 'small' END FROM emp GROUP BY dept_id",
    "SELECT SUM(salary + COALESCE(bonus, 0)) FROM emp GROUP BY dept_id IS NULL",
    "SELECT p.dept_id, ROUND(AVG(p.cost), 2), COUNT(p.cost) FROM proj p GROUP BY p.dept_id",
    "SELECT dept_id, COUNT(*) FROM emp GROUP BY dept_id HAVING COUNT(*) > 2 AND MAX(salary) < 110000",
]
ORDER = [
    "SELECT name, salary FROM emp ORDER BY salary DESC, name",
    "SELECT name, bonus FROM emp ORDER BY bonus, id",
    "SELECT name, bonus FROM emp ORDER BY bonus DESC, id",
    "SELECT name AS n, salary AS s FROM emp ORDER BY s, n LIMIT 5",
    "SELECT name, salary FROM emp ORDER BY 2 DESC, 1 ASC LIMIT 3 OFFSET 2",
    "SELECT DISTINCT dept_id FROM emp ORDER BY dept_id",
    "SELECT DISTINCT salary, dept_id FROM emp WHERE salary > 70000",
    "SELECT id FROM emp ORDER BY salary * -1, id LIMIT 4",
    "SELECT name FROM emp ORDER BY LENGTH(name) DESC, name LIMIT 3",
    "SELECT id FROM emp ORDER BY id LIMIT 0",
    "SELECT id FROM emp ORDER BY id LIMIT 3 OFFSET 100",
    "SELECT DISTINCT city FROM dept ORDER BY city DESC",
    "SELECT dept_id, name FROM emp ORDER BY dept_id DESC, salary, name",
    "SELECT emp_id, proj_id, hours FROM assign ORDER BY hours DESC, emp_id, proj_id LIMIT 6",
    "SELECT DISTINCT role FROM assign",
    "SELECT name FROM emp ORDER BY dept_id IS NULL, dept_id, id",
]
SUBQ = [
    "SELECT name FROM emp WHERE salary = (SELECT MAX(salary) FROM emp)",
    "SELECT name, salary - (SELECT AVG(salary) FROM emp) FROM emp WHERE id < 6",
    "SELECT name FROM emp WHERE dept_id IN (SELECT id FROM dept WHERE city = 'Oslo')",
    "SELECT name FROM emp WHERE dept_id NOT IN (SELECT id FROM dept WHERE city = 'Oslo')",
    "SELECT name FROM emp WHERE dept_id NOT IN (SELECT dept_id FROM proj)",
    "SELECT e.name FROM emp e WHERE e.salary > (SELECT AVG(salary) FROM emp x WHERE x.dept_id = e.dept_id)",
    "SELECT d.name FROM dept d WHERE EXISTS (SELECT 1 FROM emp e WHERE e.dept_id = d.id AND e.salary > 100000)",
    "SELECT d.name FROM dept d WHERE NOT EXISTS (SELECT 1 FROM emp e WHERE e.dept_id = d.id)",
    "SELECT d.name, (SELECT COUNT(*) FROM emp e WHERE e.dept_id = d.id) FROM dept d",
    "SELECT d.name, (SELECT MAX(e.name) FROM emp e WHERE e.dept_id = d.id AND e.salary IS NULL) FROM dept d",
    "SELECT t.dept_id, t.total FROM (SELECT dept_id, SUM(salary) AS total FROM emp GROUP BY dept_id) AS t WHERE t.total > 150000",
    "SELECT MAX(n) FROM (SELECT COUNT(*) AS n FROM assign GROUP BY proj_id) t",
    "SELECT name FROM proj WHERE lead_id IN (SELECT id FROM emp WHERE dept_id = 4) OR cost > (SELECT AVG(cost) FROM proj)",
    "SELECT e.name, (SELECT d.name FROM dept d WHERE d.id = e.dept_id) FROM emp e",
    "SELECT p.name FROM proj p WHERE (SELECT SUM(hours) FROM assign a WHERE a.proj_id = p.id) > 200",
    "SELECT e.name FROM emp e WHERE EXISTS (SELECT 1 FROM assign a JOIN proj p ON p.id = a.proj_id WHERE a.emp_id = e.id AND p.dept_id <> e.dept_id)",
    "SELECT (SELECT COUNT(*) FROM emp), (SELECT COUNT(*) FROM dept), (SELECT name FROM dept WHERE id = 99)",
    "SELECT x.name FROM (SELECT name, salary FROM emp WHERE dept_id = 1) x WHERE x.salary = (SELECT MIN(salary) FROM emp WHERE dept_id = 1)",
    "SELECT name FROM emp e WHERE 2 <= (SELECT COUNT(*) FROM assign a WHERE a.emp_id = e.id)",
    "SELECT id, 1 IN (SELECT dept_id FROM proj), 6 IN (SELECT dept_id FROM emp), 3 NOT IN (SELECT dept_id FROM emp WHERE dept_id IS NOT NULL) FROM dept WHERE id = 1",
    "SELECT d.name FROM dept d WHERE EXISTS (SELECT 1 FROM proj p WHERE p.dept_id = d.id AND EXISTS (SELECT 1 FROM assign a WHERE a.proj_id = p.id AND a.hours > 300))",
]
COMPOUND = [
    "SELECT city FROM dept UNION SELECT 'Tromso'",
    "SELECT dept_id FROM emp UNION ALL SELECT dept_id FROM proj",
    "SELECT dept_id FROM emp INTERSECT SELECT dept_id FROM proj",
    "SELECT id FROM dept EXCEPT SELECT dept_id FROM emp",
    "SELECT name, salary FROM emp WHERE dept_id = 1 UNION SELECT name, salary FROM emp WHERE salary > 100000 ORDER BY 2 DESC, 1",
    "SELECT dept_id FROM emp UNION SELECT dept_id FROM proj EXCEPT SELECT id FROM dept",
    "SELECT 1, 'a' UNION ALL SELECT 2, 'b' UNION ALL SELECT 1, 'a' ORDER BY 1, 2 LIMIT 2",
    "WITH rich AS (SELECT * FROM emp WHERE salary > 100000) SELECT d.name, COUNT(*) FROM rich r JOIN dept d ON d.id = r.dept_id GROUP BY d.name",
    "WITH t(a, b) AS (SELECT id, salary FROM emp WHERE id < 4) SELECT a + 1, b FROM t",
    "WITH x AS (SELECT dept_id, SUM(salary) AS s FROM emp GROUP BY dept_id), y AS (SELECT MAX(s) AS m FROM x) SELECT x.dept_id FROM x, y WHERE x.s = y.m",
    "WITH h AS (SELECT emp_id, SUM(hours) AS total FROM assign GROUP BY emp_id) SELECT e.name, h.total FROM emp e JOIN h ON h.emp_id = e.id WHERE h.total >= 300 ORDER BY h.total DESC",
    "SELECT name AS n FROM dept UNION SELECT name FROM proj ORDER BY n LIMIT 5",
    "SELECT city FROM dept INTERSECT SELECT city FROM dept WHERE budget < 250000",
    "SELECT NULL UNION SELECT NULL",
    "SELECT dept_id, manager_id FROM emp EXCEPT SELECT dept_id, manager_id FROM emp WHERE salary > 90000",
]
WINDOW = [
    "SELECT name, salary, ROW_NUMBER() OVER (ORDER BY salary DESC, id) FROM emp",
    "SELECT name, salary, RANK() OVER (ORDER BY salary DESC), DENSE_RANK() OVER (ORDER BY salary DESC) FROM emp",
    "SELECT name, dept_id, ROW_NUMBER() OVER (PARTITION BY dept_id ORDER BY salary DESC, id) FROM emp",
    "SELECT name, dept_id, SUM(salary) OVER (PARTITION BY dept_id) FROM emp",
    "SELECT id, salary, SUM(salary) OVER (ORDER BY salary) FROM emp",
    "SELECT id, salary, COUNT(*) OVER (ORDER BY salary), AVG(salary) OVER (ORDER BY salary) FROM emp",
    "SELECT id, hired, LAG(id) OVER (ORDER BY hired), LEAD(id, 2) OVER (ORDER BY hired), LAG(id, 1, -1) OVER (ORDER BY hired) FROM emp",
    "SELECT emp_id, proj_id, hours, MAX(hours) OVER (PARTITION BY proj_id), MIN(hours) OVER (PARTITION BY proj_id ORDER BY emp_id) FROM assign",
    "SELECT name, salary, RANK() OVER (PARTITION BY dept_id ORDER BY salary) AS r FROM emp ORDER BY r, name",
    "SELECT * FROM (SELECT name, dept_id, ROW_NUMBER() OVER (PARTITION BY dept_id ORDER BY salary DESC, id) AS rn FROM emp) t WHERE rn = 1",
    "SELECT id, COUNT(bonus) OVER (PARTITION BY dept_id ORDER BY id) FROM emp",
    "SELECT dept_id, salary, DENSE_RANK() OVER (PARTITION BY dept_id ORDER BY salary DESC) FROM emp WHERE salary IS NOT NULL",
    "SELECT proj_id, emp_id, LEAD(hours, 1, 0) OVER (PARTITION BY proj_id ORDER BY emp_id) FROM assign",
    "SELECT id, salary, SUM(salary) OVER (ORDER BY salary DESC, id) FROM emp",
]
DML = [  # (setup, sql)
    (["UPDATE emp SET salary = salary + 1000 WHERE dept_id = 2"], "SELECT id, salary FROM emp"),
    (["UPDATE emp SET bonus = NULL, salary = salary * 2 WHERE bonus < 1000"], "SELECT id, salary, bonus FROM emp"),
    (["DELETE FROM assign WHERE hours IS NULL OR hours < 50"], "SELECT COUNT(*), SUM(hours) FROM assign"),
    (["DELETE FROM emp"], "SELECT COUNT(*) FROM emp"),
    (["INSERT INTO dept (id, name) VALUES (7, 'Ops'), (8, 'QA')"], "SELECT * FROM dept WHERE city IS NULL"),
    (["CREATE TABLE totals (dept_id INTEGER, total INTEGER)",
      "INSERT INTO totals SELECT dept_id, SUM(salary) FROM emp GROUP BY dept_id"], "SELECT * FROM totals"),
    (["UPDATE emp SET dept_id = manager_id, manager_id = dept_id WHERE id < 6"], "SELECT id, dept_id, manager_id FROM emp WHERE id < 6"),
    (["UPDATE emp SET salary = (SELECT MAX(budget) FROM dept WHERE dept.id = emp.dept_id) / 10 WHERE dept_id IS NOT NULL"], "SELECT id, salary FROM emp"),
    (["DELETE FROM emp WHERE id IN (SELECT emp_id FROM assign WHERE role = 'dev')"], "SELECT name FROM emp"),
    (["?INSERT INTO dept VALUES (9, 'X', NULL, NULL), (1, 'Dup', NULL, NULL)"], "SELECT COUNT(*), MAX(id) FROM dept"),
    (["CREATE TABLE u (a INTEGER UNIQUE, b TEXT NOT NULL)", "INSERT INTO u VALUES (1, 'x'), (NULL, 'y'), (NULL, 'z')",
      "?UPDATE u SET a = 5", "?INSERT INTO u VALUES (2, NULL)", "?UPDATE u SET b = NULL WHERE a = 1"], "SELECT * FROM u"),
    ([], "INSERT INTO emp (id, name) VALUES (1, 'Dup')"),
    ([], "INSERT INTO emp (id) VALUES (50)"),
    (["CREATE TABLE t (i INTEGER, r REAL, s TEXT)", "INSERT INTO t VALUES (4.0, 2, 33), (4.5, 2.5, 'q')",
      "INSERT INTO t (s) VALUES (5)"], "SELECT i, r, s, i + r FROM t"),
    (["DROP TABLE assign", "CREATE TABLE assign (x INTEGER)", "INSERT INTO assign VALUES (1)"], "SELECT * FROM assign"),
    (["CREATE TABLE IF NOT EXISTS dept (z INTEGER)", "DROP TABLE IF EXISTS nosuch"], "SELECT COUNT(*) FROM dept"),
    (["UPDATE emp SET name = UPPER(name) WHERE name LIKE '%o%'", "DELETE FROM emp WHERE salary IS NULL"], "SELECT name FROM emp ORDER BY id"),
    (["CREATE TABLE log (id INTEGER PRIMARY KEY, msg TEXT)", "INSERT INTO log VALUES (1, 'a')",
      "?INSERT INTO log SELECT id + 1, name FROM emp WHERE id < 3 UNION ALL SELECT 1, 'dup'"], "SELECT * FROM log"),
    (["UPDATE dept SET budget = budget * 2, city = COALESCE(city, 'Unknown')"], "SELECT * FROM dept"),
    (["DELETE FROM proj WHERE NOT EXISTS (SELECT 1 FROM assign a WHERE a.proj_id = proj.id)"], "SELECT id FROM proj"),
    (["INSERT INTO emp (name, id, salary) VALUES ('Zed', 40, 1)", "UPDATE emp SET salary = salary + 1 WHERE id = 40"],
     "SELECT id, name, salary, dept_id FROM emp WHERE id >= 18"),
]
ERRORS = [
    "SELECT * FROM nosuch",
    "SELECT nosuch FROM emp",
    "SELECT id FROM emp JOIN dept ON dept.id = emp.dept_id",
    "SELECT e.nosuch FROM emp e",
    "SELECT x.id FROM emp e",
    "SELECT name FROM emp WHERE COUNT(*) > 1",
    "SELECT MAX(MIN(salary)) FROM emp",
    "SELECT NOSUCHFUNC(1)",
    "SELECT ABS(1, 2)",
    "SELECT name FROM emp ORDER BY 5",
    "SELECT id FROM emp UNION SELECT id, name FROM dept",
    "SELECT FROM emp",
    "SELECT name FROM emp WHERE",
    "SELECT (1 + 2",
    "CREATE TABLE emp (x INTEGER)",
    "DROP TABLE nosuch",
    "INSERT INTO dept VALUES (20, 'x')",
    "INSERT INTO dept (id, nosuch) VALUES (20, 1)",
    "UPDATE emp SET nosuch = 1",
    "SELECT 'unterminated",
    "SELECT * FROM emp WHERE id = 1 2",
    "SELECT id FROM emp GROUP BY nosuch",
    "DELETE FROM nosuch",
    "INSERT INTO dept VALUES (1, 'dup', NULL, NULL)",
]


def perf_tables():
    rng = random.Random(7)
    big1 = ("CREATE TABLE big1 (id INTEGER PRIMARY KEY, k INTEGER, v INTEGER, s TEXT)",
            [(i, rng.randrange(1000), rng.randrange(1000000), "name%d" % rng.randrange(5000)) for i in range(1, 50001)])
    j1 = ("CREATE TABLE j1 (id INTEGER PRIMARY KEY, k INTEGER, w INTEGER)",
          [(i, rng.randrange(20000), rng.randrange(1000)) for i in range(1, 20001)])
    j2 = ("CREATE TABLE j2 (id INTEGER PRIMARY KEY, k INTEGER, w INTEGER)",
          [(i, rng.randrange(20000), rng.randrange(1000)) for i in range(1, 20001)])
    c1 = ("CREATE TABLE c1 (id INTEGER PRIMARY KEY, k INTEGER)", [(i, rng.randrange(6000)) for i in range(1, 3001)])
    c2 = ("CREATE TABLE c2 (id INTEGER PRIMARY KEY, k INTEGER, w INTEGER)",
          [(i, rng.randrange(6000), rng.randrange(100)) for i in range(1, 3001)])
    return {"big1": big1, "j1": j1, "j2": j2, "c1": c1, "c2": c2}


PERF = [  # (tables, sql)
    (["big1"], "SELECT k, COUNT(*), SUM(v) FROM big1 GROUP BY k ORDER BY k LIMIT 20"),
    (["big1"], "SELECT id, v FROM big1 ORDER BY v DESC, id LIMIT 10"),
    (["j1", "j2"], "SELECT COUNT(*), SUM(a.w + b.w) FROM j1 a JOIN j2 b ON a.k = b.k"),
    (["big1", "j1"], "SELECT COUNT(*) FROM big1 WHERE k IN (SELECT k FROM j1 WHERE w < 500)"),
    (["c1", "c2"], "SELECT COUNT(*) FROM c1 WHERE EXISTS (SELECT 1 FROM c2 WHERE c2.k = c1.k AND c2.w > 50)"),
    (["big1"], "SELECT s, COUNT(*) FROM big1 WHERE v % 7 = 3 GROUP BY s HAVING COUNT(*) > 3"),
    (["big1"], "SELECT COUNT(DISTINCT s), MAX(LENGTH(s)), AVG(v) FROM big1"),
    (["j1", "j2"], "SELECT a.id, b.id FROM j1 a LEFT JOIN j2 b ON b.k = a.k AND b.w > 900 WHERE a.id < 50"),
]

# ---------------------------------------------------------------- fuzz
FZ = ("CREATE TABLE fz (a INTEGER, b INTEGER, c INTEGER, t TEXT)", [
    (1, 2, 3, "apple"), (-4, 0, 7, "Banana"), (0, -3, None, "cherry"), (5, 5, -5, None), (None, 8, 2, "date"),
    (12, None, -1, "Elder"), (-7, 3, 0, "fig"), (9, -9, 4, "grape"), (3, 11, None, "Apple pie"), (None, None, None, "kiwi"),
    (6, -2, 13, "lemon"), (-1, 4, -8, ""),
])
LIKE_PATTERNS = ["'a%'", "'%e'", "'%an%'", "'_i%'", "'%'", "'A_P%'", "'%p_e%'"]


class Gen:
    def __init__(self, seed):
        self.r = random.Random(seed)

    def int_expr(self, d):
        r = self.r
        if d <= 0 or r.random() < 0.25:
            x = r.random()
            if x < 0.55:
                return r.choice(["a", "b", "c"])
            if x < 0.95:
                return str(r.randint(-20, 20))
            return "NULL"
        k = r.randrange(12)
        if k <= 3:
            op = r.choice(["+", "-", "*", "/", "%"])
            left, right = self.int_expr(d - 1), self.int_expr(d - 1)
            if r.random() < 0.5:
                return f"({left} {op} {right})"
            return f"{self.wrap(left)} {op} {self.wrap(right)}"
        if k == 4:
            e = self.int_expr(d - 1)
            return f"-{e}" if e[0] not in "-" else f"- {e}"
        if k == 5:
            n = r.randint(1, 2)
            whens = " ".join(f"WHEN {self.bool_expr(d - 1)} THEN {self.int_expr(d - 1)}" for _ in range(n))
            els = f" ELSE {self.int_expr(d - 1)}" if r.random() < 0.7 else ""
            return f"CASE {whens}{els} END"
        if k == 6:
            return f"CASE {self.int_expr(d - 1)} WHEN {self.int_expr(0)} THEN {self.int_expr(d - 1)} WHEN {self.int_expr(0)} THEN {self.int_expr(d - 1)} ELSE {self.int_expr(d - 1)} END"
        if k == 7:
            f = r.choice(["COALESCE", "NULLIF", "MAX", "MIN", "IFNULL"])
            n = 3 if f in ("COALESCE", "MAX", "MIN") and r.random() < 0.5 else 2
            return f"{f}({', '.join(self.int_expr(d - 1) for _ in range(n))})"
        if k == 8:
            return f"ABS({self.int_expr(d - 1)})"
        if k == 9:
            return f"({self.bool_expr(d - 1)})"
        if k == 10:
            return f"CAST({self.int_expr(d - 1)} AS INTEGER)"
        return f"LENGTH({self.text_expr(d - 1)})"

    def wrap(self, e):
        return e if all(ch not in e for ch in " ") or e.startswith("(") and e.endswith(")") and self.balanced(e[1:-1]) else f"({e})"

    @staticmethod
    def balanced(s):
        depth = 0
        for ch in s:
            depth += ch == "("
            depth -= ch == ")"
            if depth < 0:
                return False
        return depth == 0

    def text_expr(self, d):
        r = self.r
        k = r.randrange(5)
        if d <= 0 or k == 0:
            return "t"
        if k == 1:
            return f"UPPER({self.text_expr(d - 1)})"
        if k == 2:
            return f"SUBSTR({self.text_expr(d - 1)}, {r.randint(1, 3)}, {r.randint(0, 4)})"
        if k == 3:
            return f"({self.text_expr(d - 1)} || ({self.int_expr(d - 1)}))"
        return f"REPLACE({self.text_expr(d - 1)}, '{r.choice('aeip')}', '{r.choice(['', 'X', 'yy'])}')"

    def bool_expr(self, d):
        r = self.r
        k = r.randrange(9) if d > 0 else 0
        if k <= 1:
            op = r.choice(["=", "<>", "<", "<=", ">", ">=", "==", "!="])
            return f"{self.wrap(self.int_expr(d - 1))} {op} {self.wrap(self.int_expr(d - 1))}"
        if k == 2:
            return f"{self.wrap(self.int_expr(d - 1))} IS {r.choice(['', 'NOT '])}NULL"
        if k == 3:
            items = ", ".join(self.int_expr(0) for _ in range(r.randint(1, 4)))
            return f"{self.wrap(self.int_expr(d - 1))} {r.choice(['', 'NOT '])}IN ({items})"
        if k == 4:
            return f"{self.wrap(self.int_expr(d - 1))} {r.choice(['', 'NOT '])}BETWEEN {self.wrap(self.int_expr(0))} AND {self.wrap(self.int_expr(0))}"
        if k == 5:
            return f"{self.wrap(self.bool_expr(d - 1))} {r.choice(['AND', 'OR'])} {self.wrap(self.bool_expr(d - 1))}"
        if k == 6:
            return f"NOT {self.wrap(self.bool_expr(d - 1))}"
        if k == 7:
            return f"{self.text_expr(d - 1)} {r.choice(['', 'NOT '])}LIKE {r.choice(LIKE_PATTERNS)}"
        return f"{self.wrap(self.int_expr(d - 1))} IS {r.choice(['', 'NOT '])}{self.wrap(self.int_expr(0))}"

    def query(self):
        r = self.r
        form = r.randrange(5)
        if form == 0:
            return f"SELECT {self.int_expr(3)}, {self.bool_expr(2)}, {self.text_expr(2)} FROM fz"
        if form == 1:
            return f"SELECT a, b, c, t FROM fz WHERE {self.bool_expr(3)}"
        if form == 2:
            e = self.int_expr(2)
            return f"SELECT {e}, COUNT(*), SUM(b) FROM fz GROUP BY {e}"
        if form == 3:
            e = self.int_expr(2)
            return f"SELECT SUM({e}), MIN({e}), MAX({e}), COUNT({e}) FROM fz WHERE {self.bool_expr(2)}"
        return f"SELECT a, b, c, t FROM fz ORDER BY {self.int_expr(3)}{r.choice(['', ' DESC'])}, a, b, c, t"


def fuzz_queries(n=100, seed=20261014):
    import sqlite3
    gen = Gen(seed)
    out = []
    con = sqlite3.connect(":memory:")
    con.execute(FZ[0])
    con.executemany("INSERT INTO fz VALUES (?, ?, ?, ?)", FZ[1])
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


def build_cases():
    cases = []

    def add(cat, sql, tables=CORP, setup=(), expect_error=False, query_timeout=10):
        cases.append({"id": f"{cat}{sum(c['cat'] == cat for c in cases) + 1:03d}", "cat": cat, "tables": tables,
                      "setup": list(setup), "sql": sql, "expect_error": expect_error, "query_timeout": query_timeout})

    for q in BASICS:
        add("basics", q)
    for q in NULLS:
        add("nulls", q)
    for q in FUNCS:
        add("functions", q)
    for q in JOINS:
        add("joins", q)
    for q in AGGS:
        add("aggregates", q)
    for q in ORDER:
        add("order_limit", q)
    for q in SUBQ:
        add("subqueries", q)
    for q in COMPOUND:
        add("compound_cte", q)
    for q in WINDOW:
        add("window", q)
    for setup, q in DML:
        add("dml", q, setup=setup, expect_error=q.startswith("INSERT"))
    for q in ERRORS:
        add("errors", q, expect_error=True)
    pt = perf_tables()
    for names, q in PERF:
        add("perf", q, tables={n: pt[n] for n in names})
    for q in fuzz_queries():
        add("fuzz", q, tables={"fz": FZ})
    return cases
