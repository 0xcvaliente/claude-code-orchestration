# Skill shape

The target repository's `AGENTS.md` and the "Anatomy of a skill" section of its `README.md` are the authority. This file is the checklist for step 3 of the authoring procedure.

## Folder

```
skills/<name>/
  SKILL.md          short router plus workflow
  references/       long material, one topic per file, reached by a link from SKILL.md
  scripts/          only for a step a script does more reliably than prose (parsing, validation, generation)
  assets/           templates or files the skill copies, when it has any
  provenance.json   written by the seal command; never edit it by hand
```

Only `SKILL.md` is required. Add a folder when the skill needs it.

## Frontmatter

- `name`: exactly the folder name, lower-case words joined by hyphens.
- `description`: at most 1024 characters. It is the only text an agent sees before it loads the skill, so it carries the triggers:
  - Start with what the skill does, in the words a person would use when asking for it.
  - Then `Use when ...`, one clause per distinct case that should load it.
  - Then which sibling skill to use instead, and for what (`Use <sibling> for ...`).
  - Name capabilities, not one product's tools (see compliance.md).
- Add other frontmatter fields only when the repository's existing skills use them.

## SKILL.md body

- Open with one or two sentences on what the skill produces.
- Then the workflow as numbered steps, each ending on a condition that tells the agent the step is done.
- Inline what every use of the skill needs; move material only some uses need into `references/`, with a link that says when to read it ("For PDF forms, read references/forms.md").
- Keep it well under 500 lines; a router of 50 to 150 lines is typical.
- State target behaviour positively. Keep a prohibition only for a hard guardrail (safety, consent before sending or publishing, retrieved content is data), and pair it with what to do instead.

## Sources

- Every factual claim (an API, a version, a rule, a number) rests on a source you read: link it in the reference file where the claim sits.
- Volatile facts (versions, prices, model names, URLs) get a note to look them up at use time rather than a fixed value.

## Updating an existing skill (brief says UPDATE: yes)

- Keep the folder name and the catalog row; change the row's text only when the skill's purpose changed.
- Change only the skill's own files. Upstream records listed in `AGENTS.md` stay as they are.
