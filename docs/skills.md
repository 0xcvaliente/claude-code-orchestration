# Skills in the orchestrator

How the native orchestrator uses installed skills, how a run drafts a new one, and how a person publishes that draft. For maintainers.

The exact brief and reply lines are in [brief-grammar.md](brief-grammar.md) ("Skill slice lines"). The hooks' own header comments hold the last detail: `plan-check.mjs`, `skill-hint.mjs`, `skill-gate.mjs`, `skill-scan.mjs`, `skill-seal.mjs` and `scripts/skill-publish.mjs`.

## Using installed skills

- **The orchestrator loads at most two.** The [orchestrator](glossary.md#o) has the `Skill` tool. Before planning it may load at most two installed skills that shape the plan itself (domain rules, architecture, a threat model). Every skill it loads stays in its context for the whole run, so it passes every other fitting skill to the [workers](glossary.md#w) by name. The route skill and the session nudge carry the same rule.
- **`SKILLS:` lines.** Implementer, researcher and reviewer [briefs](glossary.md#b) may carry `SKILLS: <comma-separated names>`; the integrator's never does. Each name is written as the Skill tool lists it (`anthropic-skills:docx`, `frontend-design`, `<plugin>:<skill>`).
- **The worker loads each one** with the Skill tool before starting. It ignores one that does not fit and says so in one line of its [reply](glossary.md#r), not under OPEN, because a non-empty OPEN is a [doubt signal](glossary.md#d).
- **A decision per planned slice.** In the PLAN REVIEW brief each slice may carry `SKILLS: <names>` or `SKILLS: none`. A RISKY slice always carries one of the two. The plan reviewer counts these as gaps: a named skill that is not installed or does not fit the slice, and a RISKY slice with no decision.
- **The gated workflow.** A planned slice of the [gated workflow](glossary.md#g) (`.claude/workflows/orchestrate.js`) may carry `skills`, at most 5 names. Its implementer and reviewer briefs then carry a `SKILLS:` line. [Workflow agents](glossary.md#w) get no suggestions: they never reach the plan check.
- **What the worker replies.** A worker whose brief named, suggested or listed skills ends its reply with `SKILLS-USED: <names>` and `SKILLS-SKIPPED: <names>`. The [journal](glossary.md#j) keeps the names on the stop record (`skills_used`, `skills_skipped`), and the run report counts them ("Monitoring" below).

### Suggestions

The [plan check](glossary.md#p) adds [skill suggestions](glossary.md#s) to a worker launch: one short block naming installed skills that may fit. It is on unless `ORCH_SKILL_HINTS=off` (plugin setting `skill_hints`). An explicit `SKILLS:` line still reaches the worker with it off.

- **Which launches.** An implementer (only when the plan check allows it with `ok` or `light_path`), a researcher or a reviewer. Never the integrator.
- **How many.** At most 3 skills. A reviewer gets 1, or 2 when its launch's model ranks opus or above. That model is the call's `model`, else the agent file's; a model the hook cannot rank keeps 1.
- **What the block holds.** Names and reason codes only, never a skill's text or description (`skill-hint.mjs`).
- **Order of picks:**
  1. The brief's `SKILLS:` names, checked against the catalog.
  2. A document extension in FILES or SOURCES (`.docx`, `.pptx`, `.xlsx`, `.pdf`, `.csv` and their older forms), matched to a skill whose name or description names that format.
  3. A preference table: security, bugfix, tdd, UI work, motion. Each suggests the first of its skills that is installed.
  4. Else a minimum word score from the brief's goal against a skill's name and description.
- **The bugfix rule.** The bugfix entry fires on `KIND: bugfix`, even when FILES are prose. Without a KIND line it fires on bug words only when some FILES entry is not prose. Prose is `.md`, `.markdown`, `.rst`, `.adoc` and `.txt`; no FILES at all counts as not prose. A KIND other than bugfix, or no KIND with only prose FILES, gets no bugfix suggestion.
- **Never on their own:** configuration, scheduling and session skills (for example `loop`, `schedule`, `update-config`), and this plugin's own skills. An explicit `SKILLS:` name for one still passes. One pick is made per family of near-duplicate skills.
- **Where installed skills are found** (`skill-catalog.mjs`, on disk):
  - `~/.claude/skills`; a `synced/<uuid>/<name>` skill is named `anthropic-skills:<name>`;
  - the project's `.claude/skills`;
  - the skills of plugins listed in `installed_plugins.json` and enabled in the merged settings, named `<plugin>:<skill>`.
- A `SKILLS:` name not found on disk passes through, marked as not found.
- In a PLAN REVIEW brief, only a `SKILLS:` line before the first `SLICE:` line is the reviewer's own. The lines inside the planned slices are the slices' choices, which the reviewer checks.
- A block in which any line would parse as a brief or reply line is dropped.
- Each decision goes to `skills.jsonl` in the [state dir](glossary.md#s), names and reason codes only.

The suggestions travel in the plan check's single allow with `updatedInput`; see [gates.md, Plan check: how it changes a launch](gates.md#plan-check-how-it-changes-a-launch).

## Creating a skill

A run may draft one new skill when no installed skill covers knowledge the task needs, and that knowledge is reusable beyond the task. The draft is a [skill slice](glossary.md#s): an implementer slice with `KIND: skill`. It goes to the **private** skills repository unless the slice says `TARGET: public`.

The implementer drafts, seals and commits the skill, the skill gate and a reviewer check it, and a person publishes it with `npm run skill-publish` (the table below). Skill creation needs a configured skills repository ("Switches" below).

### The eight steps and who does each

| Step | Who | What |
|---|---|---|
| 1. Intent and requirements | Orchestrator, then the implementer | The orchestrator proposes the skill (name, when it triggers, target, catalog category). It waits for a yes when a person can answer; in an unattended run it does not ask. The implementer restates the intent from its brief. |
| 2. Research and discovery | Implementer | Reads the target repository's `AGENTS.md` and README, looks for an overlapping skill (stops if one covers the intent), gathers sources. |
| 3. Design and architecture | Implementer | `SKILL.md` as a short router, long material in `references/`. |
| 4. Draft | Implementer | Creates the draft worktree with the command the plan check gave, writes the skill and one catalog row. |
| 5. Evaluate and iterate | Implementer, then the reviewer | The implementer checks trigger queries and walks two tasks through the draft. The reviewer does the same independently and checks claims against their sources. |
| 6. Package and compliance | Implementer, checked by the skill gate | Validator, secret and personal-detail check of the whole branch, path check, seal. |
| 7. Deploy and verify | Implementer commits; a person publishes | The implementer commits on `skill/<name>` and never pushes or installs. `npm run skill-publish` pushes, opens the pull request and, after review, merges and installs. |
| 8. Monitor and evolve | Implementer, then `npm run report` | The implementer names what to watch. The run report's Skills section shows use over time. |

The implementer follows these steps from the authoring skill `skill-authoring` (shipped in the plugin), which the plan check tells it to load.

### Brief lines

The exact grammar, the name rule included, is in [brief-grammar.md, Skill slice lines](brief-grammar.md#skill-slice-lines).

- `KIND: skill` on an implementer brief marks a skill slice. It also needs `SKILL: <name>`, and may carry `TARGET: private|public` (default private) and `UPDATE: yes` (change an existing skill).
- Its `FILES:` are relative to the skills repository: `skills/<name>/, README.md`. The slice carries the same lines in the PLAN REVIEW.
- `DRAFTS: <name>, ...` on an implementer, researcher or reviewer brief names drafts created earlier in this run. The plan check adds the path of each draft's `SKILL.md`, which the worker reads before starting.
- The skill slice replies `DRAFT: <name> <branch>` instead of a `BRANCH:` line.
- A skill slice never runs with `isolation: "worktree"`, the integrator never merges it, and the project's test gate does not judge it: its files are outside the project. A retry resumes the same implementer in the same draft worktree.

### What the plan check does

For a `KIND: skill` implementer launch the plan check blocks for these reasons, in this order. Each blocks at most twice per slice; then the launch goes through as `<reason>_gave_up`.

| Reason | When |
|---|---|
| `skill_create_off` | Skill creation is switched off on this machine. |
| `skill_name_invalid` | No `SKILL:` line, or a name that breaks the name rule (`isSkillName`). |
| `skill_repo_missing` | The target repository is not configured (or its path is not absolute), is not a git work tree, or has no `scripts/validate.py`. |
| `skill_exists` | `skills/<name>` exists in either repository, or an installed skill has that name, and the brief does not say `UPDATE: yes`. |
| `skill_limit` | The run already allowed another new skill slice (not an `UPDATE`) with a different name. |

On an allow, the plan check appends one facts block through its single allow with `updatedInput`. The block names the repository, the draft worktree, branch `skill/<name>` and the base branch. It also names the command that creates the worktree (or says it exists), the validator command, the catalog file, the seal command and the authoring skill to load.

- Every value comes from the hook, never from the model.
- The facts block and the DRAFTS lines go only to this plugin's own implementer, researcher and reviewer.
- The checks that read FILES (overlap between slices, `not_in_plan`) resolve a skill slice's FILES against its draft worktree, so its `README.md` never collides with the project's.
- Decisions go to `skill-create.jsonl`.

### The draft worktree

`<CLAUDE_CONFIG_DIR or ~/.claude>/orchestration/skill-drafts/<target>/<name>` is a git worktree of the target repository on branch `skill/<name>`. The implementer creates it with the command from its brief. It stays there, not installed, until a person publishes it.

### The seal

`.claude/hooks/skill-seal.mjs` is a library and a CLI; it calls no model. It writes `skills/<name>/provenance.json`:

```text
{ v: 1, name, created_at, created_by, target, files: { <path>: <sha256> }, digest }
```

`digest` is the sha256 over the sorted `path:sha256` lines, the seal itself excluded. Any change to the skill's files after sealing breaks it. The implementer seals after its last change. The skill gate and the publish script verify it.

### The skill gate

`skill-gate.mjs` is a SubagentStop hook on the implementer, beside the test gate. It acts only when the stopping implementer's launch was a skill slice. It only denies, and it only reads: it never writes into the draft, never pushes and never installs. In the draft worktree it checks the following; each failure has a reason code.

If the draft worktree does not exist or is not a git work tree (`draft_missing`), no other check runs. If `skills/<name>` is a link, or resolves outside the draft worktree (`skill_dir`), the `SKILL.md`, validator, secret and seal checks do not run on it.

1. **`SKILL.md`** (`skill_md`). `skills/<name>/SKILL.md` exists, its frontmatter `name` equals the folder, its `description` has 1 to 1024 characters, and it has at most 500 lines.
2. **Validator** (`validator`). The repository's `scripts/` is unchanged from its base. Then `python3 -I -B scripts/validate.py skills/<name>` exits 0; it includes the catalog-row check.
3. **No secret or personal detail** (`secrets`). It looks for:
   - private key blocks;
   - well-known token prefixes (GitHub, AWS, Slack, OpenAI, Anthropic, Google);
   - e-mail addresses, except the reserved example domains and `git@<host>`;
   - home-directory paths: `/root`, `/home/<user>` and `/Users/<user>` followed by a slash or the end of the word (so `cd /Users/alice` and `see /home/bob.` count), also after a URL scheme such as `file://`, and the Windows form `C:\Users\<user>`. `/Users/Shared` and `C:\Users\Public`, `Default` and `All Users` name no person and pass.

   What it scans:
   - every file under `skills/<name>/` on disk, as bytes, whatever the content (a file over 5 MB, or one it cannot read, is a finding of its own);
   - the README lines the branch adds;
   - every line that any commit of the branch adds, on every path. The commits run from the branch's merge base with its base to the tip of `skill/<name>`; merge commits are compared against each parent, and binary files are read as text;
   - since 2.0.0, each raw commit object a push of the branch carries (message, author and committer included), byte for byte except the `tree <id>` and `parent <id>` lines in exactly that form, and every tag whose chain of tag objects (at most 16) ends at an object the push carries: its name and each tag object of the chain except the `object <id>` and `type <type>` lines. In these objects an e-mail address also passes when it is the object's own author, committer or tagger address, or a no-reply address. A deeper chain, a loop, or an unreadable or malformed tag object is a problem, and a `skill/<name>` ref that names a tag object instead of a commit is refused.

   A hit that only an earlier commit holds is named with that commit. A hit in a commit message, author, committer or tag gets its own advice: recreate the commits with a clean message and your own identity, or delete or rename the tag. The message says to recreate the branch's commits without it (for example `git reset --soft <merge base>`, seal, commit once), because removing the line in a new commit leaves it in the history the publish step pushes. The message gives the file, line or commit, and the kind, never the matched text.
4. **Only the skill's folder and README.md** (`paths`). Every path the branch's commits change must be under `skills/<name>/` or be `README.md` (the catalog file). Renames count as both the old and the new path.
   - Names are judged exactly as git gives them. A name with a control character (a newline, for example) is never allowed and is shown escaped.
   - Anything else is named and blocks, with or without a secret in it.
   - A branch that shares no commit with its base blocks too: then what it would push cannot be checked.

   **Which commits.** The gate runs before any push, so it cannot ask the remote.
   - When origin's copy of the base is known (a remote-tracking ref `refs/remotes/origin/<base>` exists in the skills repository), it also covers the commits below the merge base that no `refs/remotes/origin/*` ref reaches. A push of the branch would send them, so they are scanned (named as "in commit <sha>, which is not part of the draft"), and their presence blocks as `paths`.
   - The remote-tracking refs are as fresh as the last fetch. They come from origin's fetch address, which may not be where a push goes (a `pushurl` or `pushInsteadOf` setting).
   - Without such a ref the gate scans the merge-base range only. The publish step compares with the push target itself ("Publishing" below; [Limits](#limits)).
5. **Seal** (`seal`). `provenance.json` exists and the seal verifies.
6. **Git state** (`git_state`). The worktree is clean and on `skill/<name>` (a branch git cannot name fails too). The branch is ahead of its base. Every file under `skills/<name>` is committed on the branch: the seal covers ignored and untracked files, which `git status` does not show and a push would not carry.

The branch scan and the path check live in `.claude/hooks/skill-scan.mjs`, which the publish script runs too.

The gate blocks with one message that lists every failure. After three blocks it lets the stop through and logs `skill_gate_gave_up`; the reviewer still reviews. Records go to `skill-gate.jsonl`: the failed reason codes and counts, never a matched secret.

### Publishing

A person runs these, in a terminal outside Claude Code:

```sh
npm run skill-publish                                  # list the drafts
npm run skill-publish -- <name> --dry-run              # print the steps (the branch scan still runs)
npm run skill-publish -- <name>                        # push and open the pull request
npm run skill-publish -- <name> --merge                # after review: merge, update, install, clean up
```

| Option | Default | Effect |
|---|---|---|
| `--target private\|public` | private | Which repository's draft. A name that exists only under public is taken from there. |
| `--base <branch>` | the branch the repository's main checkout is on | The branch the pull request goes to. |
| `--install "<command>"` | `scripts/install.sh --target claude` when that file exists, else the install is skipped with a note | Runs after `--merge`. |

What `scripts/skill-publish.mjs` does, in order. Each failing step exits non-zero and says what to do; bad usage exits 2.

1. **Seal.** It verifies the seal.
2. **Validate.** It runs the validator in the draft.
3. **Git state.** It checks that the worktree is clean, the branch has a commit of its own, and every file under `skills/<name>` is committed on it. It records the branch's head commit.
4. **Scan.** It runs the skill gate's branch scan and path check (checks 3 and 4 above, from `skill-scan.mjs`) on exactly what its push would send.
   - It compares with the push target, not with origin's fetch address. It takes every address a push to origin goes to as git resolves it: `git remote get-url --push --all origin`, which gives `remote.origin.pushurl`, else `remote.origin.url`, after `url.<base>.pushInsteadOf` and `insteadOf` rewrites, several when several are set. It reads each address's refs with `git ls-remote`.
   - It scans the draft's own commits (merge base with the base branch, to the tip). It also scans every commit below the merge base that some address's refs do not reach, whichever local branch it sits on. A commit counts as present only when every push address has it.
   - If there is any such commit (a base the push target lacks), it refuses and names it: the push would send it and the pull request would carry it.
   - It also refuses when an author or committer of the draft's own commits has an address other than the ones this git would write now (`git var GIT_AUTHOR_IDENT` and `GIT_COMMITTER_IDENT`), and names each.
   - It refuses with the same findings as the gate, before anything is pushed. It also refuses in every unclear case: a push address that cannot be read or that git would rewrite again when reading it, no push address at all, or origin set up as a mirror (`remote.origin.mirror`).
   - This step only reads, so it runs in `--dry-run` too and decides as the real run does.
5. **Push.** It refuses when `skill/<name>` exists at any push address and is neither that head nor an ancestor of it (commits the seal never covered). Otherwise it runs:

   ```sh
   git push --recurse-submodules=no --no-follow-tags -u origin skill/<name>:skill/<name>
   ```

   - It never force-pushes; the dry run shows the same command.
   - The command names the remote and the refspec, so `remote.pushDefault`, `branch.<name>.pushRemote` and a push refspec of origin (`remote.origin.push`) cannot send it anywhere else.
   - No submodule and no tag is pushed with it. With `push.followTags` set in the person's git config, a plain push would also send the annotated tags that point into the pushed commits ([Limits](#limits)).
6. **Pull request.** It opens one with `gh`. The body names the skill, the target and the provenance digest, and says an agent created it and a person must review it.

With `--merge`, after those:

7. It merges the pull request with `gh pr merge --match-head-commit <that head>`, so nothing pushed after the checks is merged.
8. It fast-forwards the main checkout.
9. It runs the installer.
10. It removes the draft worktree.

It refuses to run inside a Claude Code session, except with `--dry-run`: publishing is a person's step.

### Monitoring

`npm run report` adds a **Skills** section when the logs name a skill:

- per skill, how often it was suggested (`skills.jsonl`), used and skipped (the journal);
- the drafts created, with the skill gate's last result (`skill-create.jsonl`, `skill-gate.jsonl`);
- a "worth revising" list: skills skipped three or more times, or used in a slice whose latest review failed.

A run without skills gets the report it got before.

### Switches

`ORCH_SKILL_CREATE` (on unless `off`), `ORCH_SKILLS_REPO_PRIVATE` and `ORCH_SKILLS_REPO_PUBLIC` (the repositories' absolute paths), each also a plugin setting: [settings.md, Plugin settings](settings.md#plugin-settings). Without the target's repository a skill slice is blocked with `skill_repo_missing`, and the run goes on without the skill.

## Checked live

On Claude Code 2.1.325, 2026-11-14:

- A main-thread agent whose `tools:` line names `Skill` sees the installed skills and can load one. This is why the orchestrator has the tool.
- A skill folder linked into `~/.claude/skills` mid-session can be loaded by the main session and by a worker launched afterwards, but not by a worker that was already running.
- A skill marked `disable-model-invocation: true` cannot be loaded by a model through the Skill tool. This is why a later slice reads a draft from its folder (`DRAFTS:`) instead of the draft being installed.

## Limits

- A suggestion from goal words can name a skill that does not fit the slice: one shared word in the skill's name plus two words of its description is enough. The worker loads what fits and skips the rest, saying so in one line of its reply; nothing blocks on a suggestion.
- The skill catalog does not see plugins loaded with `--plugin-dir` or skills bundled with Claude Code. Explicit `SKILLS:` names for them still reach the worker, marked as not found.
- A draft is not installed until a person publishes it. Workers of the same run read it from its folder.
- No agent pushes, opens a pull request, or installs or links a skill. Only `scripts/skill-publish.mjs`, run by a person, does.
- The skill gate and the publish step scan file contents and paths and, since 2.0.0, each raw commit object the push carries (commit messages, authors and committers included), byte for byte except a commit's `tree <id>` and `parent <id>` lines in exactly that form. Every tag is followed through its chain of tag objects, at most 16 deep; when the chain ends at an object the push carries, the tag's name and every tag object of the chain are scanned the same way (except the `object <id>` and `type <type>` lines), and a deeper chain, a loop or an unreadable or malformed object is a problem. A draft branch ref that names a tag object is refused. The publish push never sends a tag (`--no-follow-tags`, whatever `push.followTags` says).
- A draft branch that merges its base (to bring in newer base commits) is blocked. The merge, compared against each parent, shows the base's files as paths outside the skill and repeats findings of older commits. Rebase the draft onto the new base, or recreate its commits there, instead.
- The skill gate makes no network call. It judges the base commits a push would send from the local remote-tracking refs of origin's fetch address only. The publish step compares with the push addresses themselves, and it is the step that makes sure whatever it pushes was scanned.
- The reviewer's checks of a skill (trigger queries, two walk-throughs, claims against sources) are judgement, not proof. The seal proves only that the files did not change after sealing.
- The end-to-end creation of a real skill by a headless run has not been run yet.
