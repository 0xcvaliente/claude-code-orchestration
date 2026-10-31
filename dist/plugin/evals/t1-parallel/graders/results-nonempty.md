---
type: regex
target: { source: file, path: test-results.txt }
pattern: '^(?:#|ℹ) pass [1-9]'
flags: m
---

test-results.txt records at least one passing test.
