---
name: skill-authoring
description: Procedure for drafting a new or updated Agent Skill in a skills repository, from intent to a sealed, committed draft branch. Use when your brief is a skill slice (it carries KIND: skill and SKILL: <name>).
user-invocable: false
---
# Drafting a skill

Your brief is a skill slice. Two sources rule it, and you follow them over anything below:

- The **facts block** the plan check appended to your brief: repository, draft worktree, branch, base, worktree command, validator, catalog file, seal command. Use each value exactly as given; never work out a path or command of your own.
- The target repository's `AGENTS.md`: the skills library's own rules. Read it in step 2 and keep to it; this skill does not restate it.

The paths on your FILES line are relative to the draft worktree. Every file you write is under it. Run git as `git -C <draft worktree> ...`.

Work through the eight steps in order. Each ends on its completion criterion; the step is done only when that holds.

## 1. Intent and requirements

Restate from the brief, in your own words: what the skill is for, when it should trigger, when it should not (and which sibling skill covers that case), the target (private unless the brief says public) and the README category it belongs to.
Done when each of those five has one sentence you can point to in the brief.

## 2. Research and discovery

- Read the target repository's `AGENTS.md` and `README.md` in the draft worktree (or the repository, before the worktree exists).
- Look for an overlapping skill: list `skills/`, and read the descriptions of the skills in the category you chose and of any skill whose name shares a word with yours. When one already covers this intent, stop: report STATUS: fail with the overlapping skill's name under OPEN, and create nothing.
- Gather the sources the brief names. Keep a note of where each fact came from (path:line or URL); the reviewer checks claims against them.

Done when you have read both files, named the closest existing skill and why it does not cover the intent, and every fact you will write has its source.

## 3. Design and architecture

Plan the folder before writing it, following [references/skill-shape.md](references/skill-shape.md): `SKILL.md` as a short router plus the workflow, long material in `references/`, `scripts/` only for a step a script does more reliably than prose, and the sibling skill to use instead, with when.
Done when you can list every file of the skill with one line on what it holds.

## 4. Draft

- Create the draft worktree with the command in the facts block, or work in it when the block says it exists already.
- When a skill for writing agent documents is installed (one whose description covers writing or editing skills), load it with the Skill tool now and apply it to everything you write.
- Write `skills/<name>/SKILL.md` and its files.
- Add the catalog row to the catalog file under the fitting category, copying the row format of that table; when no category fits, add one in the same style. One row, no more.

Done when every file from step 3 exists and the catalog row is in place.

## 5. Evaluate and iterate

Follow [references/evaluation.md](references/evaluation.md): write down queries that should and should not trigger the skill, check the description against them and against the sibling descriptions, then walk two realistic tasks through the draft. Fix what does not hold and evaluate again.
Done when every should-trigger query matches, every should-not query points to a sibling or to no skill, and both walk-throughs reach a correct result using only the draft and its cited sources.

## 6. Package and compliance

- Run the validator command from the facts block until it passes. It is a script of the repository: fix the skill, never the script.
- Check every file of the skill and your catalog row against [references/compliance.md](references/compliance.md): no secrets, no personal details, no e-mail addresses, no home-directory paths, host-neutral wording, upstream records untouched.
- Run the seal command from the facts block. It writes `provenance.json` beside `SKILL.md`. Any later change to the skill's files breaks the seal: run the seal command again after it.

Done when the validator exits 0 and the seal is the last thing that wrote to the skill folder.

## 7. Deploy and verify

- Commit on the draft branch: `git -C <draft worktree> add -A`, then `git -C <draft worktree> commit -m "Add skill <name>"` (or "Update skill <name>"). The message carries no co-author or generated-by line.
- Confirm `git -C <draft worktree> status --porcelain` prints nothing and `git -C <draft worktree> log --oneline <base>..<branch>` shows your commit.
- The draft stays on its branch in the draft worktree. Publishing it is a separate step a person runs, so never push, open a pull request, or install or link the skill into any skills folder. Leave everything under `scripts/` as it is.

Done when the worktree is clean and the branch is ahead of its base.

## 8. Monitor and evolve

Decide what a later run should watch: what you left out on purpose, which facts may go stale (versions, URLs, tool behaviour) and the source to re-check for each.
Done when that fits on one `Watch:` line of your report.

## Report

Reply in the worker format, with these differences:

- `CHANGED:` the files, relative to the draft worktree.
- `DRAFT: <name> <branch>` in place of a BRANCH line; write no BRANCH line.
- `EVIDENCE:` the validator command and its result, the seal command, and the clean `git status`.
- `Watch:` the line from step 8.

If you are resumed with reviewer gaps or a gate message, work in the same draft worktree: fix, run the validator, seal again, commit again, and report as above.
