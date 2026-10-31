---
type: tool_used
tool: Agent
input_match: '"subagent_type"\s*:\s*"orchestration:'
arm: with-only
---

Plugin-only indicator: one of the plugin's agents (orchestration:*) was dispatched. Never possible without the plugin, so not scored in a two-arm run.
