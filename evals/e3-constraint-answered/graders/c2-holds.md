---
type: regex
target: { source: file, path: src/slug.js }
pattern: '^(?![\s\S]*(?:^|\n)[ \t]*import\s)'
---

C2 holds: src/slug.js has no import statement (the pattern matches only when no line starts with import).
