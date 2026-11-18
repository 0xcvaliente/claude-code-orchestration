# Probes of slice f4 (2.0.0), 2026-11-18

Claude Code 2.1.326, Linux (Ubuntu 26.04.1). One paid call, started with a dollar cap. Total: **0.0271673 USD** of
the 0.30 USD allowed.

| # | What | Cap | Cost |
|---|---|---|---|
| 1 | Item 2(a): the interpreters on this machine and the oracle of the recorded cases | none needed: no model call | 0 |
| 2 | Item 3: `apt-get install -y socat`, one attempt | none needed: no model call | 0 |
| 3 | Item 3: one sandboxed `claude -p` writing into a scratch project and a scratch skills-draft folder | `--max-budget-usd 0.15`, `timeout 280` | 0.0271673 USD |

## Probe 1: interpreters and the recorded py313 values (item 2(a))

`python3 --version` -> `Python 3.14.4`. `ls /usr/bin/python3*` -> `/usr/bin/python3`, `/usr/bin/python3-config`,
`/usr/bin/python3.14`, `/usr/bin/python3.14-config`. `command -v python3.13 python3.14` -> `/usr/bin/python3.14` only:
**no CPython 3.13 on this machine**. uv also holds CPython 3.12.16 (in uv's own folder); nothing was installed for this probe.

Script (`<scratch>/oracle.py`): loads `hidden/py313.py` and each `hidden/mod_<name>.py`, runs `run_oracle` for the named
cases (no `expected` override) and compares with `PY313`. Run as `python3.14 -I <scratch>/oracle.py <hidden dir> <ids>`
and the same with the uv 3.12.16 interpreter, for k2's eight listed cases (k1's two are the same regex ids).

| Case | Recorded value | CPython 3.14.4 | CPython 3.12.16 |
|---|---|---|---|
| fraction-098-format | ValueError x3, then `-1234567/1000` | differs (third input formats `-1234.56700`) | differs (ValueError for all four) |
| ipaddr-020-addr | scope kept in `exploded`/`reverse_pointer` | differs (AddressValueError) | differs, same as 3.14.4 |
| ipaddr-021-addr | scope kept | differs (AddressValueError) | differs, same as 3.14.4 |
| jsonx-106-loads | pos 0 | differs (pos 2) | differs, same as 3.14.4 (pos 2) |
| regex-025-search, regex-188-fullmatch (k1 and k2) | None | differs (empty match) | equal |
| urls-140-urljoin, urls-142-urljoin | `http:///h/`, `https:///k;p/g/h` | differs (`http:/h/`, `https:/k;p/g/h`) | equal |
| wrap-100-fill, wrap-102-wrap, wrap-123-wrap (not recorded) | live oracle | sha 29cbdabc6d81, 743bb6370e60, 70251e8ff54d | sha 66f187e859d8, f30c64d2cfff, 008c6e3692c7 (all three differ) |

What was done: the docstrings of both `py313.py` files now say which value each case holds, that no 3.13 was available
to reproduce them, what 3.12.16 and 3.14.4 give, and, for what could not be run, that an earlier review measured it
on 3.13.5 and 3.14.4. No expected value and no grader behaviour changed: no recorded value could be shown wrong for a
named version, since no 3.13 could be run. `node --test bench/eval-graders.test.mjs` (2/2) and
`node --test bench/grade.test.mjs` (6/6) pass.

## Probe 2: socat (item 3)

`command -v socat bwrap` -> `/usr/bin/bwrap` only. `apt-get install -y socat` (as root, once) -> exit 0;
`socat -V` -> `socat version 1.8.1.1`.

## Probe 3: sandboxed write into a project and a skills-draft stand-in (item 3)

`scripts/sandbox-smoke.mjs` takes no dollar cap, so it was not run. Instead, in `<scratch>/sbx/proj` (with
`<scratch>/sbx/skills-drafts/demo` beside it, the stand-in for the skills draft folder; the real user settings and the
real skills repository were not touched):

```
timeout 280 claude -p --max-budget-usd 0.15 --model sonnet --setting-sources project \
  --settings '{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,
               "filesystem":{"allowWrite":["<scratch>/sbx/skills-drafts"]}}}' \
  --strict-mcp-config --no-session-persistence --tools Bash --allowedTools Bash \
  --debug-file <scratch>/sbx/debug.log --output-format json \
  "Run exactly one Bash command and nothing else: printf ok > <scratch>/sbx/proj/in.txt && printf ok > <scratch>/sbx/skills-drafts/demo/SKILL.md ; echo rc=$? ..."
```

Result: exit 0 after 15 s, `subtype: success`, cost 0.0271673 USD. **Did a sandbox start: no.** The Bash tool result:

```
Exit code 1
apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted; caller must provide CAP_SYS_ADMIN): Permission denied
```

Neither file was written (`ls` of both paths: No such file or directory). The debug log shows the sandbox settings
were read (`Sandbox: ignoring permission rules and sandbox.filesystem entries from disabled setting source
userSettings`), so the sandbox was attempted with the flag settings alone.

Conclusion: with socat installed the sandbox now gets as far as its seccomp step, but it still cannot start on this
machine, because the kernel restricts nested user namespaces (setting up the namespace needs CAP_SYS_ADMIN), so
whether a sandboxed implementer can write skill drafts remains not shown live. No second route was tried.
