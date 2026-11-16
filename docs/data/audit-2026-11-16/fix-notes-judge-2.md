# Fix notes: slice fix-judge-2 (audit 2026-11-16, second pass)

Both judge copies (`src/judge.ts`, `.claude/hooks/judge-core.mjs`) change together; the parity test passes unchanged.
Rows: `AUDIT_1116_2_DENY` (86 deny rows, also read by `judge-differential.test.mjs`) and 41 neighbour rows in `src/judge.test.ts`.

**J-9 set -A and assigning `${...}` (item 1).** `set` with an `-A`/`+A` cluster joins the assigning builtins; a `${...}` whose inside starts with a table name and holds `=` is a Doubt.
- Refused: `set -A functions f '..'`, `set +A`/`-sA`, behind `builtin`/`command`; `: ${functions[f]::=..}`, `:=`, `=`, in double quotes; also `dis_aliases`, `dis_galiases`, `dis_saliases`.
- Legitimate loss: `${aliases[p]:-a=b}` (a default holding `=`; take the value in two steps).
- Docs elsewhere: CHANGELOG.md (new entry); README.md Limits ("function and alias definitions" line) could name `set -A`.

**J-8 commands table (item 1).** `commands` joins the table list with its own reason ("points a command name at another program, like hash -p").
- Refused: `commands+=(ls /usr/bin/git)`, `commands[ls]=..`, `commands=(..)`, `typeset`/`export`/`set -A`/`${commands[ls]::=..}`.
- Legitimate loss: a variable named `commands` (`read -r commands`, `local commands`, `commands=x make`); use another name.
- Docs elsewhere: README.md Limits (hash line) could name the `commands` table.

**J-4 hook.<name>.command (item 1).** `hook\..+\.command` joins `GIT_EXEC_KEY`.
- Refused: with `git -c`, `--config-env` (both forms), `git config` set, `--add`, `--global`, `--get`, `--unset`. `hook.x.event` and `git hook run` pass.
- Legitimate loss: reading the key with `git config --get` (read the config file), as for the other exec keys.
- Docs elsewhere: CHANGELOG.md:32 list of `git -c` keys.

**J-3 filter-branch (item 1).** `GIT_SHELL_OPTS` gets `filter-branch` with `setup`, `env-filter`, `tree-filter`, `index-filter`, `parent-filter`, `msg-filter`, `commit-filter`, `tag-name-filter` (any prefix, `=` form).
- Each value is read as a script, like `rebase -x`: `--tree-filter 'rm -rf ../victim'` is refused, `'git push ..'` is judged, `"$CMD"` is refused; `--msg-filter 'sed ..'`, `--subdirectory-filter` pass.
- Legitimate loss: a filter that is refused as a command of its own (`--tree-filter 'rm -rf build'`; use `--index-filter 'git rm -r --cached ..'`).
- Docs elsewhere: README.md "Bash judge (SDK workers)" if it lists the git options read as scripts.

**J-9 rule turned around (item 2, after review).** A table word (the name with `=`, `+=` or a subscript; after an assigning builtin anywhere earlier in the command, the bare name or `=<table>` too) is denied wherever it stands, behind any keyword, `!`, modifier (`noglob`, `nocorrect`, `-`, `repeat`, `coproc`) or wrapper. It passes only as an argument of a `TEXT_ONLY` command word (grep, egrep, fgrep, rg, ag, ack, git, cat, echo, ls, wc, head, tail, less, diff) with nothing but redirections in front.
- Passed again: `grep functions= f`, `git grep 'functions\[' -- src`, `git log --grep 'functions='`, `echo 'aliases[p]=x'`, `cat a | grep commands=`. Refused: the first pass's rows and the review's forms (`if typeset 'functions[f]=..'`, `! functions[f]=..`, `noglob set -A functions ..`, `! commands+=(..)`).
- Known over-block: such a word behind a keyword or wrapper even in a search (`if grep -q functions= f; then ..`, `xargs grep ..`; write the search as its own command), or given to a command off the list (`printf 'functions=%s' x`; write it so the word does not start with the name, as `sed 's/functions=/x/'`).
- Docs elsewhere: none.

**J-10 arithmetic (item 2).** Inside a subscript, a `$((...))` that closes at the first `))` and holds no `(`, `)` or backtick is stepped over; anything else is a substitution.
- Passed again: `echo 'arr[$((i+1))]'`, `git commit -m 'use arr[$((i+1))]'`. Still refused: `$(`, backticks, `$(( $(cmd) ))`, `$((cmd) )` (bash may read it as `$( (cmd) )`).
- Legitimate loss (safe side): arithmetic with parentheses in a quoted subscript (`'a[$(( (i+1)*2 ))]'`).
- Docs elsewhere: none.

**Docs (item 3).** docs/bash-judge.md section 2.1 rows (filter-branch, `hook.*.command`, table rule, J-10 arithmetic), the 2.1 paragraph, the Doubt list in 2.4, section 11 (subscript assembled across statements: `x='a['; x+='$(cmd)]'`, `printf -v x 'a[%s]' '$(cmd)'`) and the over-blocked list.
- Docs elsewhere: CHANGELOG.md entry for the second pass.

**agent.ts comment (item 4).** The comment no longer says a timed-out PreToolUse callback blocks the call; it states only what sdk.d.ts says (`timeout` bounds the hooks; `onFailure: "block"` covers a throw or invalid output). No code change.
- Docs elsewhere: none (docs/bash-judge.md section 4 already says the same).
