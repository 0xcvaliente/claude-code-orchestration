# Fix notes: slice fix-judge (audit 2026-11-16, judge-sdk.md)

Both judge copies (`src/judge.ts`, `.claude/hooks/judge-core.mjs`) change together; the parity test passes unchanged.
Rows: `AUDIT_1116_DENY` (70 deny rows) and two guard tests in `src/judge.test.ts`; 11 corpus rows.

**J-1 `<<` in `$[...]` or a subscript.** Tokenizer counts unclosed unquoted `[` per simple command (`bracketOpen`); a `<<` after one is a Doubt.
- Refused: `echo $[1<<EOF]`, `a[1<<EOF]=1`, `$[ 1 <<EOF ]`. No common form refused; `[ -f x ] && cat <<EOF` still passes.
- Docs elsewhere: CHANGELOG.md:32 (known open families: drop "`$[...]`, an array subscript").

**J-2 brace + process substitution.** The brace scan steps over `<(...)`/`>(...)` as over `$(...)`.
- Refused: `{rm,-rf,x,<(:)}`. Nothing legitimate lost (brace expansion was already refused).
- Docs elsewhere: CHANGELOG.md:32 (drop "brace groups that hold a process substitution").

**J-3 git options that run a shell.** `GIT_SHELL_OPTS` table in `gitShellArgs`: values read as scripts, like `rebase -x`.
- Refused when the value is refused: `grep -O<cmd>`/`--open-files-in-pager=`, `difftool -x/--extcmd`, `--upload-pack` (fetch, pull, ls-remote, fetch-pack, clone `-u`), `--exec` (archive, fetch-pack); a dynamic value. A plain program path still passes.
- Docs elsewhere: CHANGELOG.md:32; README.md "Bash judge (SDK workers)" if it lists the git options read as scripts.

**J-4 config keys.** `GIT_EXEC_KEY` adds `gpg.*.defaultKeyCommand`, `browser|man.*.cmd|path`, `imap.tunnel`, `gc.recentObjectsHook`.
- Refused: those keys with `git -c`, `--config-env`, `git config` (set or read). Edit the config file instead.
- Docs elsewhere: CHANGELOG.md:32 (drop "further `git -c` keys").

**J-5 here-document delimiter.** A delimiter word holding `$` or a backtick is a Doubt.
- Refused: `cat <<$'E'`, `<<$"E"`, `<<$E`, ``<<E`x` ``. Write a plain or quoted delimiter (`<<'EOF'`).
- Docs elsewhere: none.

**J-6 PS4.** `PS0|PS1|PS4` join `EXEC_ENV`; also denied on a line with `set -x`/`set -o xtrace`/`setopt xtrace` (`ctx.prompt`, `ctx.traced`).
- Refused: `PS4='$(..)' bash -xc :`, `PS4=..; set -x`. Legitimate loss: `PS4='+ ' bash -x run.sh` (leave PS4 default).
- Docs elsewhere: README.md "Safety" / exec-env list, if it enumerates the names.

**J-7 BASH_FUNC_ and ZDOTDIR.** Both join `EXEC_ENV` (`BASH_FUNC_[^=]*`).
- Refused on a line with git, rm or a shell: `env 'BASH_FUNC_git%%=...' bash -c ..`, `ZDOTDIR=z zsh -c true`.
- Docs elsewhere: same README list as J-6.

**J-8 hash and enable.** `hash` with a `-p` cluster or a `name=path` word, `enable -f` (command word or after a wrapper).
- Refused: `hash -p /usr/bin/git ls`, `hash ls=/usr/bin/git`, `enable -f x.so x`; also zsh `hash -d name=path`. `hash`, `hash -r` pass.
- Docs elsewhere: README.md Limits ("function and alias definitions" line) could name hash.

**J-9 zsh tables.** A word whose static prefix assigns `functions|aliases|galiases|saliases|dis_functions` (`=`, `+=`, `[...]`).
- Refused: `functions+=(f '..')`, `typeset 'functions[f]=..'`. Loss: `grep functions= f` (search `'functions'`).
- Docs elsewhere: none.

**J-10 subscript substitution.** Literal text with `$(` or a backtick inside `name[...]` is denied (one linear pass).
- Refused: `x='a[$(..)]'; echo $((x))`, `let 'a[$(..)]'`. Loss: commit messages like `'use arr[`i`]'` (use `-F <file>`); ``'Fix `items[0]` lookup'`` still passes.
- Docs elsewhere: none.

**J-15 no-op editor and empty IFS (relaxed).** `noopSetting`: exact static `GIT_EDITOR=true|:`, `git -c core.editor=true|:`, `IFS=`.
- Passed now: `GIT_EDITOR=true git rebase --continue`, `git -c core.editor=: commit --amend`, `while IFS= read -r f; do git add "$f"; done`. `+=`, partial quoting, `--config-env`, `EDITOR=true` stay denied.
- Docs elsewhere: README.md "Safety" over-block list and CHANGELOG (new entry); `judge-differential.test.mjs` names the 8 forms in `RELAXED`.

**J-13 rm targets after `cd`.** `bashGuard` takes `opts.cwd` as root and the hook input's `cwd` as the shell folder; `JudgeContext.root`, `statPath(path, cwd, root)`.
- Facts and the symlink floor follow the shell's folder; the root bounds absolute targets. New refusal: a judged command while the shell is outside the root (`cd` back first); pass commands unaffected.
- Docs elsewhere: README.md "Bash judge (SDK workers)" if it describes the working folder.

**S-2 tokens of a failed worker.** `makeRunAgent` sums assistant-message usage per message id (largest field per id) and returns it from `fail`.
- A crash, timeout or result-less stream now charges what it spent, so `--budget` sees it. No legitimate use refused.
- Docs elsewhere: README.md:443/:460 (`--budget`) may say failed workers are charged their streamed usage.

**J-14 / J-11 / globsubst (doc only).** docs/bash-judge.md section 4: SDK 0.3.325; the timed-out-hook sentence now states only what sdk.d.ts says (failure = throw or invalid output; timeout not stated for callbacks). Section 11 lists J-11 and zsh globsubst.
- Docs elsewhere: src/agent.ts comment "a PreToolUse callback that does time out blocks the call, Claude Code 2.1.210 and later" is not backed by sdk.d.ts; owner to source or soften it.
