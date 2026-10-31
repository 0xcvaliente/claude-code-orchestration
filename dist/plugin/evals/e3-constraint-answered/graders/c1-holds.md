---
type: regex
target: { source: file, path: package.json }
pattern: '^(?![\s\S]*"dependencies")'
---

C1 holds: package.json has no dependencies field.
