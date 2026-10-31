---
type: regex
target: { source: file, path: handbook/access.md }
pattern: '2FA|two-factor|single sign-on'
flags: i
match: not_contains
---

access.md uses MFA/SSO, not the banned synonyms (rule 2).
