---
description: "From this project's runs: an implementer was launched before the plan was reviewed, and the plan's file split had to be redone. The task asks for a written plan with slices, files and checks before any code."
tags: ["code","small","plan","from-logs"]
max_turns: 70
timeout_seconds: 1200
allowed_tools: ["Read","Glob","Grep","Skill","Agent","TodoWrite","Bash","Write","Edit"]
---

Build a small config loader in two modules, planning first.

1. Before writing any code, write `PLAN.md` with one block per slice: a `SLICE:` line, a `FILES:` line (no file in two slices) and a `CHECK:` line with the command that accepts it.
2. `src/parse.js`: `parse(text)` turns lines of `key = value` into an object; blank lines and lines starting with `#` are skipped; values that are integers become numbers; a line without `=` throws `SyntaxError` naming its line number.
3. `src/validate.js`: `validate(obj, schema)` where schema maps each required key to `"number"` or `"string"`; returns a list of problems, empty when valid (a missing key gives `missing <key>`, a wrong type gives `<key> is not a <type>`).

Acceptance check: npm test

When you are done, run `npm test` once more and save its complete output to `test-results.txt` in the workspace root (for example `npm test > test-results.txt 2>&1`).
