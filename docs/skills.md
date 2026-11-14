# Skills in the orchestrator

How the native orchestrator uses installed skills, how a run can draft a new one, and how a person publishes that draft. The brief and reply lines are specified in [brief-grammar.md](brief-grammar.md); the gate details are in the hooks' own header comments (`plan-check.mjs`, `skill-gate.mjs`, `skill-seal.mjs`).

## Using installed skills

- **The orchestrator loads at most two.** The orchestrator has the `Skill` tool. Before planning it may load at most two installed skills that shape the plan itself (domain rules, architecture, a threat model). Every skill it loads stays in its context for the whole run, so every other fitting skill goes to the workers by name instead. The route skill and the session nudge carry the same rule.
- **`SKILLS:` lines.** Implementer, researcher and reviewer briefs (never the integrator's) may carry `SKILLS: <comma-separated names>`, each name as the Skill tool lists it (`anthropic-skills:docx`, `frontend-design`, `<plugin>:<skill>`). The worker loads each with the Skill tool before starting and ignores one that does not fit, saying so in one line of its report, not under OPEN (a non-empty OPEN is a doubt signal).
- **A decision per planned slice.** In the PLAN REVIEW brief each slice may carry `SKILLS: <names>` or `SKILLS: none`; a RISKY slice always carries one of the two. The plan reviewer treats a named skill that is not installed or does not fit the slice, and a RISKY slice with no decision, as gaps.
- **Suggestions.** The plan check appends a short block of suggested skills to implementer, researcher and reviewer launches: names and reason codes only, at most 3 (1 for a reviewer, 2 for a reviewer whose launch runs on opus or a stronger model), picked from the brief's `SKILLS:` names, the file types in FILES or SOURCES, the role and the goal's words. Installed skills are the ones found on disk (`~/.claude/skills`, the project's `.claude/skills`, enabled plugins' skills). Each decision goes to `skills.jsonl` in the state dir.
- **The gated workflow.** A planned slice of `.claude/workflows/orchestrate.js` may carry `skills` (at most 5 names); its implementer and reviewer briefs then carry a `SKILLS:` line. Workflow agents get no suggestions: they never reach the plan check.
- **What the worker reports.** A worker whose brief named, suggested or listed skills ends its report with `SKILLS-USED: <names>` and `SKILLS-SKIPPED: <names>`. The journal keeps the names on the stop record (`skills_used`, `skills_skipped`), and the run report counts them.

## Creating a skill

A run may draft one new skill when no installed skill covers knowledge the task needs and that knowledge is reusable beyond the task. The draft goes to the **private** skills repository unless the slice says `TARGET: public`.

### The eight steps and who does each

| Step | Who | What |
|---|---|---|
| 1. Intent and requirements | Orchestrator, then the implementer | The orchestrator proposes the skill (name, when it triggers, target, catalog category) and waits for a yes when a person can answer; in an unattended run it does not ask. The implementer restates the intent from its brief. |
| 2. Research and discovery | Implementer | Reads the target repository's `AGENTS.md` and README, looks for an overlapping skill (stops if one covers the intent), gathers sources. |
| 3. Design and architecture | Implementer | `SKILL.md` as a short router, long material in `references/`. |
| 4. Draft | Implementer | Creates the draft worktree with the command the plan check gave, writes the skill and one catalog row. |
| 5. Evaluate and iterate | Implementer, then the reviewer | The implementer checks trigger queries and walks two tasks through the draft; the reviewer does the same independently and checks claims against their sources. |
| 6. Package and compliance | Implementer, checked by the skill gate | Validator, secret and personal-detail check, seal. |
| 7. Deploy and verify | Implementer commits; a person publishes | The implementer commits on `skill/<name>` and never pushes or installs. `npm run skill-publish` pushes, opens the pull request and, after review, merges and installs. |
| 8. Monitor and evolve | Implementer, then `npm run report` | The implementer names what to watch; the report's Skills section shows use over time. |

The implementer follows these steps from the authoring skill `skill-authoring` (shipped in the plugin), which the plan check tells it to load.

### Brief lines

- `KIND: skill` on an implementer brief marks a skill slice. It also needs `SKILL: <name>` (lower-case words of letters and digits joined by single hyphens, at most 64 characters) and may carry `TARGET: private|public` (default private) and `UPDATE: yes` (change an existing skill). Its `FILES:` are relative to the skills repository: `skills/<name>/, README.md`. The slice carries the same lines in the PLAN REVIEW.
- `DRAFTS: <name>, ...` on an implementer, researcher or reviewer brief names drafts created earlier in this run; the plan check adds the path of each draft's `SKILL.md`, which the worker reads before starting.
- The skill slice replies `DRAFT: <name> <branch>` instead of a `BRANCH:` line. It never runs with `isolation: "worktree"`, the integrator never merges it, and the project's test gate does not judge it: its files are outside the project. A retry resumes the same implementer in the same draft worktree.

### What the plan check does

For a `KIND: skill` implementer launch it blocks, each reason at most twice per slice before the launch goes through as `<reason>_gave_up`:

| Reason | When |
|---|---|
| `skill_create_off` | Skill creation is switched off on this machine. |
| `skill_name_invalid` | No `SKILL:` line, or a name that breaks the rule above. |
| `skill_repo_missing` | The target repository is not configured, is not a git work tree, or has no `scripts/validate.py`. |
| `skill_exists` | `skills/<name>` exists in either repository, or a skill of that name is installed, and the brief does not say `UPDATE: yes`. |
| `skill_limit` | The run already allowed another new skill. |

On an allow it appends one facts block through its single allow with `updatedInput`: the repository, the draft worktree, branch `skill/<name>`, the base branch, the command that creates the worktree (or that it exists), the validator command, the catalog file, the seal command and the authoring skill to load. Every value comes from the hook, never from the model. The facts block and the DRAFTS lines go only to this plugin's own implementer, researcher and reviewer. The checks that read FILES (overlap between slices, `not_in_plan`) resolve a skill slice's FILES against its draft worktree, so its `README.md` never collides with the project's. Decisions go to `skill-create.jsonl`.

### The draft worktree

`<CLAUDE_CONFIG_DIR or ~/.claude>/orchestration/skill-drafts/<target>/<name>`: a git worktree of the target repository on branch `skill/<name>`, created by the implementer with the command from its brief. It stays there, uninstalled, until a person publishes it.

### The seal

`.claude/hooks/skill-seal.mjs` (a library and a CLI, no model) writes `skills/<name>/provenance.json`: `{ v: 1, name, created_at, created_by, target, files: { <path>: <sha256> }, digest }`, where `digest` is the sha256 over the sorted `path:sha256` lines, the seal itself excluded. Any change to the skill's files after sealing breaks it. The implementer seals after its last change; the skill gate and the publish script verify it.

### The skill gate

`skill-gate.mjs` is a SubagentStop hook on the implementer, beside the test gate. It acts only when the stopping implementer's launch was a skill slice, and is deny-only. In the draft worktree it checks:

1. `skills/<name>/SKILL.md` exists, its frontmatter `name` equals the folder, its `description` has 1 to 1024 characters, and it has at most 500 lines.
2. The repository's `scripts/` is unchanged from its base, and `python3 -I -B scripts/validate.py skills/<name>` exits 0 (it includes the catalog-row check).
3. No secret or personal detail in the skill's files or in the README lines the branch adds: private key blocks, well-known token prefixes, e-mail addresses, home-directory paths.
4. `provenance.json` exists and the seal verifies.
5. The worktree is clean, on `skill/<name>`, and the branch is ahead of its base.

It blocks with one message listing every failure; after three blocks it lets the stop through and logs `skill_gate_gave_up` (the reviewer still reviews). Records go to `skill-gate.jsonl`.

### Publishing

A person runs:

```
npm run skill-publish                                  # list the drafts
npm run skill-publish -- <name> --dry-run              # print the steps
npm run skill-publish -- <name>                        # push and open the pull request
npm run skill-publish -- <name> --merge                # after review: merge, update, install, clean up
```

Options: `--target private|public` (default private; a name that exists only under public is taken from there), `--base <branch>` (default: the branch the repository's main checkout is on), `--install "<command>"` (default `scripts/install.sh --target claude` when that file exists, else the install is skipped with a note).

`scripts/skill-publish.mjs` verifies the seal, runs the validator in the draft, checks the worktree is clean and the branch has a commit of its own, pushes `skill/<name>` (never a force push) and opens a pull request with `gh`. The body names the skill, the target, the provenance digest, and says an agent created it and a person must review it. With `--merge` it merges the pull request, fast-forwards the main checkout, runs the installer and removes the draft worktree. Each failing step exits non-zero and says what to do. It refuses to run, except with `--dry-run`, inside a Claude Code session: publishing is a person's step.

### Monitoring

`npm run report` adds a **Skills** section when the logs name a skill: per skill how often it was suggested (`skills.jsonl`), used and skipped (the journal); the drafts created with the skill gate's last result (`skill-create.jsonl`, `skill-gate.jsonl`); and a "worth revising" list of skills skipped three or more times or used in a slice whose latest review failed. A run without skills gets the report it got before.

### Switches

Maintainer-facing; each is also a plugin setting with the same key in lower case, and the environment wins.

| Variable | Plugin setting | Default | Effect |
|---|---|---|---|
| `ORCH_SKILL_CREATE` | `skill_create` | on | `off` blocks every skill slice (`skill_create_off`) |
| `ORCH_SKILLS_REPO_PRIVATE` | `skills_repo_private` | unset | Absolute path of the private skills repository, where new skills go by default |
| `ORCH_SKILLS_REPO_PUBLIC` | `skills_repo_public` | unset | Absolute path of the public skills repository, for `TARGET: public` |

With neither repository set, a skill slice is blocked with `skill_repo_missing` and the run continues without the skill.

## Checked live

On Claude Code 2.1.325, 2026-11-14:

- A main-thread agent whose `tools:` line names `Skill` sees the installed skills and can load one. This is why the orchestrator has the tool.
- A skill folder linked into `~/.claude/skills` mid-session can be loaded by the main session and by a worker launched afterwards, but not by a worker that was already running.
- A skill marked `disable-model-invocation: true` cannot be loaded by a model through the Skill tool. This is why a later slice reads a draft from its folder (`DRAFTS:`) instead of the draft being installed.

## Limits

- A draft is not installed until a person publishes it; workers of the same run read it from its folder.
- No agent pushes, opens a pull request, or installs or links a skill. Only `scripts/skill-publish.mjs`, run by a person, does.
- The reviewer's checks of a skill (trigger queries, two walk-throughs, claims against sources) are judgement, not proof. The seal proves only that the files did not change after sealing.
- The end-to-end creation of a real skill by a headless run has not been run yet.
