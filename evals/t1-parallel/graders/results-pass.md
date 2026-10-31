---
type: regex
target: { source: file, path: test-results.txt }
pattern: '^(?:#|ℹ) fail 0\b'
flags: m
---

test-results.txt records a node:test run with zero failures.
