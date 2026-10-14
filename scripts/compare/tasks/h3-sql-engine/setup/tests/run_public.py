"""Public example tests. Run: python3 tests/run_public.py [-v] [name-substring]

Each case is checked against SQLite (the reference) with tests/oracle.py. The hidden suite uses
the same mechanism with different data and ~300 different queries.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import minisql  # noqa: E402
from oracle import check  # noqa: E402

SHOP = {
    "customers": (
        "CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, country TEXT, vip INTEGER)",
        [(1, "Ada", "UK", 1), (2, "Linus", "FI", 0), (3, "Grace", "US", 1), (4, "Ken", "US", None),
         (5, "Barbara", None, 0), (6, "edsger", "NL", 0)],
    ),
    "products": (
        "CREATE TABLE products (id INTEGER PRIMARY KEY, title TEXT, price REAL, stock INTEGER)",
        [(10, "Keyboard", 49.5, 10), (11, "Mouse", 19.99, 0), (12, "Monitor", 199.0, 3),
         (13, "Cable", 4.25, None), (14, "Desk", 350.0, 1)],
    ),
    "orders": (
        "CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, product_id INTEGER, qty INTEGER, day TEXT)",
        [(100, 1, 10, 1, "2024-01-03"), (101, 1, 11, 2, "2024-01-03"), (102, 2, 12, 1, "2024-01-05"),
         (103, 3, 13, 5, "2024-02-01"), (104, 3, 10, 1, "2024-02-11"), (105, 4, None, 3, "2024-02-12"),
         (106, 9, 14, 1, "2024-03-01"), (107, 2, 11, None, "2024-03-02")],
    ),
}


def case(name, sql, setup=(), tables=SHOP):
    return {"name": name, "tables": tables, "setup": list(setup), "sql": sql}


CASES = [
    case("select_literal", "SELECT 1 + 2, 'a' || 'b', 7 / 2, -7 % 3, 1.5 * 2"),
    case("select_star", "SELECT * FROM customers"),
    case("where", "SELECT name FROM customers WHERE country = 'US' AND vip = 1"),
    case("where_null", "SELECT name FROM customers WHERE vip IS NULL OR country IS NULL"),
    case("order_limit", "SELECT title, price FROM products ORDER BY price DESC LIMIT 2 OFFSET 1"),
    case("order_nulls", "SELECT id, stock FROM products ORDER BY stock, id"),
    case("distinct", "SELECT DISTINCT country FROM customers"),
    case("like", "SELECT name FROM customers WHERE name LIKE '%a%' ORDER BY name"),
    case("in_list", "SELECT id FROM orders WHERE customer_id IN (1, 3) ORDER BY id"),
    case("between", "SELECT title FROM products WHERE price BETWEEN 10 AND 200"),
    case("case_expr", "SELECT name, CASE WHEN vip = 1 THEN 'vip' WHEN vip = 0 THEN 'regular' ELSE 'unknown' END FROM customers"),
    case("functions", "SELECT UPPER(name), LENGTH(name), SUBSTR(name, 2, 3), COALESCE(country, '??') FROM customers"),
    case("round", "SELECT ROUND(price), ROUND(price, 1), ABS(-stock) FROM products"),
    case("inner_join", "SELECT c.name, o.id FROM customers c JOIN orders o ON o.customer_id = c.id ORDER BY o.id"),
    case("left_join", "SELECT c.name, o.id FROM customers c LEFT JOIN orders o ON o.customer_id = c.id ORDER BY c.id, o.id"),
    case("three_way_join", "SELECT c.name, p.title, o.qty FROM orders o JOIN customers c ON c.id = o.customer_id JOIN products p ON p.id = o.product_id"),
    case("count_star", "SELECT COUNT(*), COUNT(vip), COUNT(DISTINCT country) FROM customers"),
    case("group_by", "SELECT customer_id, COUNT(*), SUM(qty) FROM orders GROUP BY customer_id"),
    case("having", "SELECT customer_id, SUM(qty) AS total FROM orders GROUP BY customer_id HAVING COUNT(*) > 1 ORDER BY total DESC"),
    case("avg_empty", "SELECT AVG(price), SUM(stock), MAX(title) FROM products WHERE id > 100"),
    case("scalar_subquery", "SELECT title FROM products WHERE price > (SELECT AVG(price) FROM products)"),
    case("in_subquery", "SELECT name FROM customers WHERE id IN (SELECT customer_id FROM orders WHERE qty > 1)"),
    case("correlated_exists", "SELECT name FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)"),
    case("derived_table", "SELECT t.cid, t.n FROM (SELECT customer_id AS cid, COUNT(*) AS n FROM orders GROUP BY customer_id) t WHERE t.n >= 2"),
    case("union", "SELECT country FROM customers UNION SELECT 'SE' ORDER BY 1"),
    case("cte", "WITH big AS (SELECT * FROM products WHERE price > 40) SELECT COUNT(*) FROM big"),
    case("row_number", "SELECT title, ROW_NUMBER() OVER (ORDER BY price DESC) FROM products"),
    case("window_partition", "SELECT id, customer_id, SUM(qty) OVER (PARTITION BY customer_id) FROM orders"),
    case("insert_update", "SELECT * FROM customers ORDER BY id",
         setup=["INSERT INTO customers (id, name) VALUES (7, 'Alan')", "UPDATE customers SET vip = 1 WHERE country = 'US'"]),
    case("delete", "SELECT COUNT(*) FROM orders",
         setup=["DELETE FROM orders WHERE qty IS NULL OR qty > 2"]),
    case("insert_select", "SELECT * FROM archive",
         setup=["CREATE TABLE archive (id INTEGER, total REAL)",
                "INSERT INTO archive SELECT o.id, o.qty * p.price FROM orders o JOIN products p ON p.id = o.product_id"]),
    case("affinity", "SELECT * FROM t",
         setup=["CREATE TABLE t (i INTEGER, r REAL, s TEXT)", "INSERT INTO t VALUES (3.0, 5, 7), (2.5, 1.5, 'x')"]),
    case("error_no_table", "SELECT * FROM nope"),
    case("error_no_column", "SELECT nope FROM customers"),
    case("error_ambiguous", "SELECT id FROM customers, orders"),
    case("error_unique", "SELECT COUNT(*) FROM customers",
         setup=[]),
    case("error_syntax", "SELECT name FROM WHERE"),
]
# A constraint violation is an error; the statement under test is the failing INSERT itself.
CASES[-2] = case("error_unique", "INSERT INTO customers VALUES (8, 'X', NULL, NULL), (1, 'dup', NULL, NULL)")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    verbose = "-v" in sys.argv
    selected = [c for c in CASES if not args or any(a in c["name"] for a in args)]
    failed = 0
    for c in selected:
        ok, detail = check(c, minisql)
        if not ok:
            failed += 1
        if verbose or not ok:
            print(f"{'PASS' if ok else 'FAIL'} {c['name']}: {detail}"[:600])
    print(f"{len(selected) - failed}/{len(selected)} public tests passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
