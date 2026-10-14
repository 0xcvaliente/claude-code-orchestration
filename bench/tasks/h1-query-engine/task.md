Build a small in-memory SQL query engine as ES modules, with tests. The public entry point is index.js at the repository root, which exports createDb(). Organize the implementation into several modules of your choice (for example lexer, parser, executor) and write node:test files for them. Acceptance check: npm test

API
- createDb() returns { createTable(name, columns), insert(name, row), query(sql) }.
- createTable(name, columns): columns is an array of { name, type } with type "int" or "text". Throws Error if the table already exists, if there are no columns, or if a column name repeats; throws TypeError for an unknown type.
- insert(name, row): row is an object. Throws Error("unknown table: <name>") for an unknown table and Error for a key that is not a column. Missing or undefined columns become null. An "int" column accepts only integers (Number.isInteger) or null, a "text" column only strings or null; anything else throws TypeError. Rows are stored as copies.
- query(sql) returns an array of plain objects (fresh copies; mutating them never affects the table).

Supported SQL (exactly this grammar; everything else throws SyntaxError)
  SELECT select_list FROM table [[AS] alias]
    [[INNER] JOIN table [[AS] alias] ON colref = colref]
    [WHERE expr]
    [GROUP BY colref]
    [ORDER BY colref [ASC|DESC] {, colref [ASC|DESC]}]
    [LIMIT n [OFFSET m]] [;]
- Keywords are case-insensitive and reserved: SELECT FROM WHERE GROUP BY ORDER ASC DESC LIMIT OFFSET JOIN INNER ON AS AND OR NOT IS NULL LIKE IN COUNT SUM MIN MAX AVG. Identifiers (tables, columns, aliases) are case-sensitive.
- Literals: integers (an optional leading "-"), strings in single quotes where '' is an escaped quote, and NULL. LIMIT and OFFSET take non-negative integers only.
- colref is name or qualifier.name, where the qualifier is a table name or alias. Without a JOIN a qualifier is still allowed.
- select_list is * or a comma-separated list of items; an item is a colref or an aggregate COUNT(*), COUNT(colref), SUM(colref), MIN(colref), MAX(colref), AVG(colref), optionally followed by AS name.
- Trailing tokens after the query (other than one optional ;) are a SyntaxError.

WHERE expressions
- Comparisons operand op operand with op in = != <> < <= > >=, where an operand is a literal or a colref. <> means !=. Comparing an int with text (both non-NULL) throws Error whose message contains "type mismatch".
- operand IS [NOT] NULL; operand [NOT] LIKE 'pattern' (% matches any sequence, _ matches one character, case-insensitive; the operand must be text); operand [NOT] IN (literal, literal, ...).
- NOT, AND, OR with that precedence (NOT binds tightest), and parentheses.
- Standard SQL three-valued logic: any comparison, LIKE or IN with a NULL operand is unknown; NOT unknown is unknown; unknown AND false is false; unknown OR true is true; x IN (...) with no match and a NULL in the list is unknown. A row is kept only if the whole WHERE expression is true.

Result shape and rules
- Rows come back in table order (the left table, then matching right rows in right-table order for a JOIN) unless ORDER BY applies.
- A plain colref item is keyed by its column name without any qualifier. AS name overrides it. An unaliased aggregate is keyed by the lowercase function name and its argument as written, for example "count(*)", "sum(price)", "avg(u.age)".
- SELECT * returns every column in definition order keyed by plain name. With a JOIN, * returns the left table's columns then the right table's, keyed "alias.column", where alias is the alias if given, else the table name.
- JOIN is an inner equi-join: a pair matches when both sides are non-NULL and equal. Using the same alias twice throws Error.
- An unqualified column that does not exist throws Error whose message contains "unknown column"; one present in both joined tables throws Error containing "ambiguous column"; an unknown table throws Error containing "unknown table".
- Aggregates: COUNT(*) counts rows, COUNT(col) counts non-NULL values. SUM, AVG, MIN and MAX ignore NULLs and return null when there are no non-NULL values. SUM and AVG of a text column throw Error containing "type mismatch". AVG is the arithmetic mean as a JavaScript number.
- With aggregates but no GROUP BY the query returns exactly one row even over zero input rows (COUNT gives 0). With GROUP BY the result has one row per distinct value of the group column (NULL is its own group), in order of first appearance, before ORDER BY. In an aggregate query every non-aggregate select item must be the group column (any spelling that resolves to the same column), otherwise throw Error; SELECT * is invalid there too.
- ORDER BY: a name matching an output key sorts by that output value, otherwise it is resolved as a source column. NULL sorts first in ASC and last in DESC. Text compares by UTF-16 code units, numbers numerically. The sort is stable. LIMIT and OFFSET apply after ordering.
