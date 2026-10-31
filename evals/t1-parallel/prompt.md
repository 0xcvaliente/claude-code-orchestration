---
description: "Bench t1-parallel: two independent modules, a natural two-slice split."
tags: ["code","small","parallel"]
max_turns: 60
timeout_seconds: 900
allowed_tools: ["Read","Glob","Grep","Skill","Agent","TodoWrite","Bash","Write","Edit"]
---

Add two independent ES modules (named exports) with node:test files.
1. slugify.js exports slugify(str): strip accents, lowercase, replace every run of non-alphanumeric characters with a single "-", no leading or trailing "-". Throw TypeError if str is not a string. Tests in slugify.test.js.
2. capitalize.js exports capitalize(str): uppercase the first character and leave the rest unchanged; "" returns "". Throw TypeError if str is not a string. Tests in capitalize.test.js.
Acceptance check: npm test

When you are done, run `npm test` once more and save its complete output to `test-results.txt` in the workspace root (for example `npm test > test-results.txt 2>&1`).
