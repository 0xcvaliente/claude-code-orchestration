---
description: "From this project's runs: two slices owned the same file (src/registry.js in two FILES lines) and the second merge lost the first slice's change. Two formatters must each register in one shared file."
tags: ["code","small","shared-file","from-logs"]
max_turns: 60
timeout_seconds: 900
allowed_tools: ["Read","Glob","Grep","Skill","Agent","TodoWrite","Bash","Write","Edit"]
---

Add two formatters to the registry in `src/registry.js`:

- `src/money.js`: formatter `money` turns a number into a string with two decimals, a comma as thousands separator and the suffix ` EUR`, for example `1234.5` gives `1,234.50 EUR`.
- `src/percent.js`: formatter `percent` turns a fraction into a percentage with one decimal, for example `0.256` gives `25.6%`.

Each module registers its function in `formatters` from `src/registry.js`, and `src/index.js` imports both modules. `src/registry.js` must also list the registered names in alphabetical order, ending up as `export const NAMES = ["money", "percent"];`. Both formatters touch that one file: plan so that no change to it is lost.

Acceptance check: npm test

When you are done, run `npm test` once more and save its complete output to `test-results.txt` in the workspace root (for example `npm test > test-results.txt 2>&1`).
