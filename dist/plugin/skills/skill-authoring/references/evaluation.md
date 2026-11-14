# Evaluating a draft skill

Step 5 of the authoring procedure. Write the queries and the walk-throughs down in your working notes; the reviewer repeats the same checks on your draft.

## Trigger queries

1. Write at least five queries that should load the skill: realistic requests a person would type, in different words, covering each `Use when` case of the description.
2. Write at least three queries that should not load it: near misses that belong to a sibling skill or to no skill.
3. For each query, read only the frontmatter descriptions of the skills in the target repository's catalog (and the installed skills you know) and decide which one an agent would load.
4. The draft passes when every should-trigger query picks this skill and every should-not query picks the sibling or nothing. When a query picks wrongly, change the description (a missing trigger word, a sibling pointer, a narrower first sentence), never the query.

## Walk-throughs

1. Pick two realistic tasks the skill exists for, different from each other (for example one simple and one with an edge case the skill covers).
2. For each, follow the draft step by step as an agent would, reading only what `SKILL.md` links when it links it.
3. At every step note what you had to know that the draft did not tell you, and any step whose completion condition was unclear.
4. The draft passes when both tasks reach a correct result with only the draft and its cited sources. Add what was missing to the step or reference where it was needed, and walk the task again.

## Claims

Re-open each cited source for the claims the walk-throughs relied on and confirm the draft says what the source says.
