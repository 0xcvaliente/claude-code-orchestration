---
description: "From this project's runs: a read-only researcher tried to write its findings file and was denied, and the run lost the findings. Reading three notes and writing one answer file: the reading can be delegated, the write must be done by an agent allowed to write."
tags: ["research","small","read-only","from-logs"]
max_turns: 50
timeout_seconds: 900
allowed_tools: ["Read","Glob","Grep","Skill","Agent","TodoWrite","Bash","Write","Edit"]
---

Read the three supplier notes in `notes/` and write `findings.md` answering these questions, one `## ` section per question, each answer citing the note it comes from as a relative link (for example `[source](notes/a.md)`). Where notes disagree, the newest dated note wins.

1. What is the supplier's current lead time?
2. What is the minimum order quantity?
3. By how much do prices change, and from which month?
