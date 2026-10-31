---
type: regex
target: { source: file, path: CHECKS.txt }
pattern: '^C3: pass\b'
flags: m
---

C3 has an answer line (the one a passing review left unanswered in the logs).
