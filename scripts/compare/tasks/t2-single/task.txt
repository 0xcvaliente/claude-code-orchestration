Add duration.js (ES module, named export) with a node:test file duration.test.js.
parseDuration(str) converts strings made of d, h, m, s parts into total seconds, for example "1h30m" is 5400 and "1d2h3m4s" is 93784.
Rules: units are lowercase d, h, m, s; each unit appears at most once and only in the order d, h, m, s; every unit has a non-negative integer before it; no spaces; at least one part. Anything else throws RangeError. A non-string argument throws TypeError.
Acceptance check: npm test
