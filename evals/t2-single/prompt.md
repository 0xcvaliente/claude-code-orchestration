---
description: "Bench t2-single: one small module (duration parser). Plugin should stay light."
tags: ["code","small","single"]
max_turns: 40
timeout_seconds: 600
allowed_tools: ["Read","Glob","Grep","Skill","Agent","TodoWrite","Bash","Write","Edit"]
---

Add duration.js (ES module, named export) with a node:test file duration.test.js.
parseDuration(str) converts strings made of d, h, m, s parts into total seconds, for example "1h30m" is 5400 and "1d2h3m4s" is 93784.
Rules: units are lowercase d, h, m, s; each unit appears at most once and only in the order d, h, m, s; every unit has a non-negative integer before it; no spaces; at least one part. Anything else throws RangeError. A non-string argument throws TypeError.
Acceptance check: npm test

When you are done, run `npm test` once more and save its complete output to `test-results.txt` in the workspace root (for example `npm test > test-results.txt 2>&1`).
