---
description: "From this project's runs: a review passed while one listed constraint had no answer line, so a broken constraint shipped. Every constraint must be answered with evidence."
tags: ["code","small","constraints","from-logs"]
max_turns: 60
timeout_seconds: 900
allowed_tools: ["Read","Glob","Grep","Skill","Agent","TodoWrite","Bash","Write","Edit"]
---

Implement `slugify(text)` in `src/slug.js` (named export): lowercase, every run of characters other than a-z and 0-9 becomes one `-`, no leading or trailing `-`; for example `"  Hello, World! 2026 "` gives `"hello-world-2026"`. Throw `TypeError` for a non-string.

Constraints:

- C1: add no dependencies (`package.json` keeps no `dependencies` field).
- C2: `src/slug.js` has no import statements.
- C3: `slugify` never returns an empty string for a string with at least one letter or digit.

Write `CHECKS.txt` with one line per constraint, in the form `C1: pass <how you checked it>` or `C1: fail <why>`, for C1, C2 and C3.

Acceptance check: npm test

When you are done, run `npm test` once more and save its complete output to `test-results.txt` in the workspace root (for example `npm test > test-results.txt 2>&1`).
