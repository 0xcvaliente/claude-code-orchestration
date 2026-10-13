import assert from "node:assert/strict";
import { test } from "node:test";
import { createDb } from "./index.js";

function seeded() {
  const db = createDb();
  db.createTable("users", [{ name: "id", type: "int" }, { name: "name", type: "text" }, { name: "age", type: "int" }, { name: "city", type: "text" }]);
  for (const r of [
    { id: 1, name: "Alice", age: 30, city: "Paris" },
    { id: 2, name: "Bob", age: 25, city: "London" },
    { id: 3, name: "Carol", city: "Paris" },
    { id: 4, name: "Dave", age: 40 },
    { id: 5, name: "eve", age: 35, city: "London" },
  ]) db.insert("users", r);
  db.createTable("orders", [{ name: "id", type: "int" }, { name: "user_id", type: "int" }, { name: "item", type: "text" }, { name: "qty", type: "int" }, { name: "price", type: "int" }]);
  for (const r of [
    { id: 1, user_id: 1, item: "pen", qty: 2, price: 5 },
    { id: 2, user_id: 1, item: "book", qty: 1, price: 20 },
    { id: 3, user_id: 2, item: "pen", qty: 10, price: 5 },
    { id: 4, user_id: 3, item: "lamp", qty: 1, price: 30 },
    { id: 5, user_id: 9, item: "ghost", qty: 1, price: 1 },
    { id: 6, user_id: 2, qty: 3, price: 4 },
  ]) db.insert("orders", r);
  return db;
}
const names = (rows) => rows.map((r) => r.name);

test("select star returns every column with nulls", () => {
  const rows = seeded().query("SELECT * FROM users");
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[2], { id: 3, name: "Carol", age: null, city: "Paris" });
  assert.deepEqual(rows[3], { id: 4, name: "Dave", age: 40, city: null });
});

test("where with comparisons and null exclusion", () => {
  const db = seeded();
  assert.deepEqual(db.query("select name, age from users where age > 28"), [{ name: "Alice", age: 30 }, { name: "Dave", age: 40 }, { name: "eve", age: 35 }]);
  assert.deepEqual(names(db.query("SELECT name FROM users WHERE city != 'Paris'")), ["Bob", "eve"]);
  assert.deepEqual(names(db.query("SELECT name FROM users WHERE city <> 'Paris'")), ["Bob", "eve"]);
  assert.deepEqual(names(db.query("SELECT name FROM users WHERE NOT (city = 'Paris')")), ["Bob", "eve"]);
  assert.deepEqual(names(db.query("SELECT name FROM users WHERE age >= 35")), ["Dave", "eve"]);
  assert.deepEqual(names(db.query("SELECT name FROM users WHERE age <= 25")), ["Bob"]);
});

test("is null, and/or precedence and three-valued logic", () => {
  const db = seeded();
  assert.deepEqual(names(db.query("SELECT name FROM users WHERE city = 'Paris' AND age IS NULL")), ["Carol"]);
  assert.deepEqual(names(db.query("SELECT name FROM users WHERE age IS NOT NULL AND city IS NOT NULL")), ["Alice", "Bob", "eve"]);
  assert.deepEqual(names(db.query("SELECT name FROM users WHERE city = 'Paris' OR age > 30")), ["Alice", "Carol", "Dave", "eve"]);
  assert.deepEqual(names(db.query("SELECT name FROM users WHERE city = 'Paris' OR city = 'London' AND age > 30")), ["Alice", "Carol", "eve"]);
  assert.deepEqual(names(db.query("SELECT name FROM users WHERE (city = 'Paris' OR city = 'London') AND age > 30")), ["eve"]);
  assert.deepEqual(db.query("SELECT name FROM users WHERE city = 'Paris' AND age > 100"), []);
});

test("like and in", () => {
  const db = seeded();
  assert.deepEqual(names(db.query("SELECT name FROM users WHERE name LIKE 'a%'")), ["Alice"]);
  assert.deepEqual(names(db.query("SELECT name FROM users WHERE name LIKE '_ob'")), ["Bob"]);
  assert.deepEqual(names(db.query("SELECT name FROM users WHERE name NOT LIKE '%e'")), ["Bob", "Carol"]);
  assert.deepEqual(names(db.query("SELECT name FROM users WHERE city LIKE '%on%'")), ["Bob", "eve"]);
  assert.deepEqual(names(db.query("SELECT name FROM users WHERE id IN (1, 3, 99)")), ["Alice", "Carol"]);
  assert.deepEqual(names(db.query("SELECT name FROM users WHERE age NOT IN (30, 40)")), ["Bob", "eve"]);
  assert.deepEqual(db.query("SELECT name FROM users WHERE age NOT IN (30, NULL)"), []);
  assert.deepEqual(names(db.query("SELECT name FROM users WHERE age IN (30, NULL)")), ["Alice"]);
});

test("order by with nulls, direction and ties", () => {
  const db = seeded();
  assert.deepEqual(db.query("SELECT name, age FROM users ORDER BY age"), [
    { name: "Carol", age: null }, { name: "Bob", age: 25 }, { name: "Alice", age: 30 }, { name: "eve", age: 35 }, { name: "Dave", age: 40 },
  ]);
  assert.deepEqual(names(db.query("SELECT name, age FROM users ORDER BY age DESC")), ["Dave", "eve", "Alice", "Bob", "Carol"]);
  assert.deepEqual(names(db.query("SELECT name, city FROM users ORDER BY city, name DESC")), ["Dave", "eve", "Bob", "Carol", "Alice"]);
  assert.deepEqual(names(db.query("SELECT name FROM users ORDER BY city ASC")), ["Dave", "Bob", "eve", "Alice", "Carol"]);
});

test("limit and offset", () => {
  const db = seeded();
  assert.deepEqual(db.query("SELECT id FROM users ORDER BY id LIMIT 2 OFFSET 1"), [{ id: 2 }, { id: 3 }]);
  assert.deepEqual(db.query("SELECT id FROM users LIMIT 0"), []);
  assert.deepEqual(db.query("SELECT id FROM users ORDER BY id DESC LIMIT 1"), [{ id: 5 }]);
  assert.deepEqual(db.query("SELECT id FROM users ORDER BY id LIMIT 10 OFFSET 4"), [{ id: 5 }]);
});

test("aliases and ordering by an alias", () => {
  const db = seeded();
  assert.deepEqual(db.query("SELECT name AS n, age AS a FROM users WHERE id = 2"), [{ n: "Bob", a: 25 }]);
  assert.deepEqual(db.query("SELECT age AS years FROM users WHERE age IS NOT NULL ORDER BY years DESC LIMIT 1"), [{ years: 40 }]);
  assert.deepEqual(db.query("SELECT u.name FROM users u WHERE u.id = 1"), [{ name: "Alice" }]);
  assert.deepEqual(db.query("SELECT users.name FROM users WHERE users.id = 1;"), [{ name: "Alice" }]);
});

test("aggregates without group by", () => {
  const db = seeded();
  assert.deepEqual(db.query("SELECT COUNT(*), COUNT(age), SUM(age), MIN(age), MAX(age), AVG(age) FROM users"), [
    { "count(*)": 5, "count(age)": 4, "sum(age)": 130, "min(age)": 25, "max(age)": 40, "avg(age)": 32.5 },
  ]);
  assert.deepEqual(db.query("SELECT COUNT(*) AS n, SUM(age) AS s, MIN(name) AS m, MAX(age) AS x FROM users WHERE id > 100"), [{ n: 0, s: null, m: null, x: null }]);
  assert.deepEqual(db.query("SELECT MIN(name) AS first, MAX(name) AS last FROM users"), [{ first: "Alice", last: "eve" }]);
});

test("group by", () => {
  const db = seeded();
  assert.deepEqual(db.query("SELECT city, COUNT(*) AS n FROM users GROUP BY city ORDER BY city"), [
    { city: null, n: 1 }, { city: "London", n: 2 }, { city: "Paris", n: 2 },
  ]);
  assert.deepEqual(db.query("SELECT city, SUM(age) AS total FROM users GROUP BY city ORDER BY total DESC"), [
    { city: "London", total: 60 }, { city: null, total: 40 }, { city: "Paris", total: 30 },
  ]);
  assert.deepEqual(db.query("SELECT city, COUNT(age) AS n FROM users GROUP BY city ORDER BY n DESC, city"), [
    { city: "London", n: 2 }, { city: null, n: 1 }, { city: "Paris", n: 1 },
  ]);
  assert.deepEqual(db.query("SELECT city FROM users GROUP BY city LIMIT 1"), [{ city: "Paris" }]);
  assert.deepEqual(db.query("SELECT city, COUNT(*) AS n FROM users WHERE id > 100 GROUP BY city"), []);
  assert.throws(() => db.query("SELECT name, COUNT(*) FROM users GROUP BY city"), Error);
  assert.throws(() => db.query("SELECT name, COUNT(*) FROM users"), Error);
  assert.throws(() => db.query("SELECT * FROM users GROUP BY city"), Error);
});

test("joins", () => {
  const db = seeded();
  assert.deepEqual(db.query("SELECT u.name, o.item FROM users u JOIN orders o ON u.id = o.user_id ORDER BY o.id"), [
    { name: "Alice", item: "pen" }, { name: "Alice", item: "book" }, { name: "Bob", item: "pen" }, { name: "Carol", item: "lamp" }, { name: "Bob", item: null },
  ]);
  assert.deepEqual(db.query("SELECT u.name AS who, SUM(o.qty) AS units FROM users AS u INNER JOIN orders AS o ON o.user_id = u.id GROUP BY u.name ORDER BY who"), [
    { who: "Alice", units: 3 }, { who: "Bob", units: 13 }, { who: "Carol", units: 1 },
  ]);
  assert.deepEqual(db.query("SELECT * FROM users u JOIN orders o ON u.id = o.user_id WHERE o.id = 4"), [
    { "u.id": 3, "u.name": "Carol", "u.age": null, "u.city": "Paris", "o.id": 4, "o.user_id": 3, "o.item": "lamp", "o.qty": 1, "o.price": 30 },
  ]);
  assert.deepEqual(db.query("SELECT COUNT(*) AS n FROM users JOIN orders ON users.id = orders.user_id"), [{ n: 5 }]);
  assert.deepEqual(db.query("SELECT a.name AS x, b.name AS y FROM users a JOIN users b ON a.city = b.city WHERE a.id < b.id ORDER BY a.id"), [
    { x: "Alice", y: "Carol" }, { x: "Bob", y: "eve" },
  ]);
  assert.deepEqual(db.query("SELECT a.name AS x FROM users a JOIN users b ON a.age = b.age ORDER BY a.id"), [
    { x: "Alice" }, { x: "Bob" }, { x: "Dave" }, { x: "eve" },
  ]);
  assert.throws(() => db.query("SELECT id FROM users u JOIN orders o ON u.id = o.user_id"), /ambiguous/);
  assert.throws(() => db.query("SELECT * FROM users u JOIN orders u ON u.id = u.user_id"), Error);
});

test("errors", () => {
  const db = seeded();
  assert.throws(() => db.query("SELECT * FROM nope"), /unknown table/);
  assert.throws(() => db.query("SELECT nope FROM users"), /unknown column/);
  assert.throws(() => db.query("SELECT NAME FROM users"), /unknown column/);
  assert.throws(() => db.query("SELECT name FROM users WHERE nope = 1"), /unknown column/);
  assert.throws(() => db.query("SELECT name FROM users WHERE age = 'x'"), /type mismatch/);
  assert.throws(() => db.query("SELECT SUM(name) FROM users"), /type mismatch/);
  for (const bad of ["SELEC * FROM users", "SELECT * FROM users WHERE", "SELECT * FROM users LIMIT -1", "SELECT * FROM users; DROP", "SELECT * FROM users WHERE name = 'abc", "SELECT FROM users", "SELECT * FROM", "SELECT * FROM users ORDER", "SELECT * FROM users WHERE age", "SELECT SUM(*) FROM users", "SELECT * FROM users LIMIT 1 OFFSET"]) {
    assert.throws(() => db.query(bad), SyntaxError, `expected SyntaxError for ${bad}`);
  }
});

test("string escapes, negative numbers, trailing semicolon", () => {
  const db = createDb();
  db.createTable("t", [{ name: "id", type: "int" }, { name: "s", type: "text" }, { name: "x", type: "int" }]);
  db.insert("t", { id: 1, s: "O'Brien", x: -5 });
  db.insert("t", { id: 2, s: "plain", x: 3 });
  assert.deepEqual(db.query("SELECT id FROM t WHERE s = 'O''Brien';"), [{ id: 1 }]);
  assert.deepEqual(db.query("SELECT id FROM t WHERE x = -5"), [{ id: 1 }]);
  assert.deepEqual(db.query("SELECT id FROM t WHERE x < -1"), [{ id: 1 }]);
  assert.deepEqual(db.query("SELECT s FROM t WHERE s LIKE '%''%'"), [{ s: "O'Brien" }]);
});

test("table api validation and isolation", () => {
  const db = seeded();
  assert.throws(() => db.createTable("users", [{ name: "a", type: "int" }]), Error);
  assert.throws(() => db.createTable("z", []), Error);
  assert.throws(() => db.createTable("z", [{ name: "a", type: "int" }, { name: "a", type: "text" }]), Error);
  assert.throws(() => db.createTable("z", [{ name: "a", type: "float" }]), TypeError);
  assert.throws(() => db.insert("users", { id: 1.5 }), TypeError);
  assert.throws(() => db.insert("users", { name: 5 }), TypeError);
  assert.throws(() => db.insert("users", { bogus: 1 }), /unknown column/);
  assert.throws(() => db.insert("nope", {}), /unknown table/);
  const rows = db.query("SELECT * FROM users");
  rows[0].name = "MUTATED";
  assert.equal(db.query("SELECT name FROM users WHERE id = 1")[0].name, "Alice");
  const src = { id: 9, name: "Zed" };
  db.insert("users", src);
  src.name = "changed";
  assert.equal(db.query("SELECT name FROM users WHERE id = 9")[0].name, "Zed");
});
