# Sharing the plugin

This repository is a Claude Code plugin marketplace. People add it once and then install the plugin from it. This page says what is shared, how to install it, how to stay on a stable version, and what a maintainer does at each release.

The commands below were checked with `--help` on Claude Code 2.1.327. One form comes from Claude Code's docs only, and it says so where it appears.

## What is shared

| Path | What it is |
|---|---|
| `.claude-plugin/marketplace.json` | The marketplace manifest. Its name is `claude-code-orchestration`, its owner `0xcvaliente`. It lists one plugin, `orchestration`. |
| `dist/plugin/` | The plugin itself. The marketplace entry points at it with `"source": "./dist/plugin"`, so the built files are committed. |
| `dist/dashboard/` | The pane alone, as the plugin `orchestration-dashboard`. It is not in the marketplace. `npm start` loads it from the checkout. |

`npm run build-plugin` writes all three manifests. The facts they share (repository, homepage, keywords, owner, the marketplace's name) sit in one place, `SHARED` in `scripts/build-plugin.mjs`. `npm run check-plugin` fails when the committed marketplace file or `dist/` differs from what the build writes.

## Add the marketplace and install

```bash
claude plugin marketplace add 0xcvaliente/claude-code-orchestration
claude plugin install orchestration@claude-code-orchestration
```

- `claude plugin install orchestration --marketplace 0xcvaliente/claude-code-orchestration` does both steps in one command.
- Inside a session, `/plugin` opens the same plugin manager.
- Restart Claude Code after an install or an update.
- A plugin cannot set two settings this one needs. Add them yourself, as [Install](../README.md#install) shows.

## Stable or latest

You get a new copy of the plugin only when a release changes its version. Between releases, `main` and a release tag give you the same copy.

**Following `main`.** The marketplace added as above reads the default branch, `main`. When the next release merges into `main`, your next update picks it up.

**Pinned to a release.** Add the marketplace at a release tag instead. It stays on that release until you add it again at a newer tag:

```bash
claude plugin marketplace add 0xcvaliente/claude-code-orchestration#v2.0.2
```

- The `#<tag>` form comes from Claude Code's docs. The 2.1.327 help says only "a URL, path, or GitHub repo".
- Release tags are `vX.Y.Z`. The `v2.0.2` tag exists once 2.0.2 is released.
- To move to a newer release, remove the marketplace (`claude plugin marketplace remove claude-code-orchestration`), add it again at the new tag, and install again.

## How updates reach people

- Claude Code gets a new copy only when the plugin's version changes. Commits merged into `main` without a new version do not reach anyone.
- The version lives in `dist/plugin/.claude-plugin/plugin.json` only, taken from `package.json`. The marketplace entry sets none: with a version in both, Claude Code silently uses `plugin.json`'s.
- By default, a marketplace that is not Anthropic's own does not update by itself.

To update by hand:

```bash
claude plugin marketplace update claude-code-orchestration
claude plugin update orchestration@claude-code-orchestration
```

From a checkout, `npm run claude-update` says when the installed copy is older than the checkout, and `npm run claude-update -- --fix` updates it ([After a Claude Code update](claude-code-updates.md)).

## What the plugin ships, and why

| In `dist/plugin/` | Why |
|---|---|
| `agents/` | The orchestrator and its four workers: researcher, implementer, reviewer, integrator. |
| `skills/` | `route` (sizes a task first), `orchestration-conventions` (the workers' rules) and `skill-authoring`. |
| `hooks/` | The gates, the guards, the nudge, the journal and telemetry, plus the pane's mod (`dashboard.tsx`). |
| `workflows/` | The gated workflow, `/orchestration:orchestrate`. Only a person starts it. |
| `types/` | The type file the pane's mod imports. `plugin.json` names it under `types`. |
| `evals/` | The eval suite, for `npm run eval` (`claude plugin eval dist/plugin`). |
| `.claude-plugin/plugin.json` | Name, version, description, author, homepage, repository, keywords and the 22 plugin settings (`userConfig`). |

The plugin does not ship permission denies or the `worktree` setting. A plugin cannot set them.

## At each release

1. Set the new version in `package.json` and `package-lock.json`.
2. Run `npm run build-plugin`. It writes the version into both plugin manifests. The marketplace entry carries none.
3. Run `npm run check-plugin`. It must pass.
4. Run `claude plugin validate .` and `claude plugin validate dist/plugin`. Neither may report an error.
5. After the merge into `main`, tag the merge commit `vX.Y.Z` and push the tag.

Every step, the changelog and the GitHub release included: [Release steps](development.md#release-steps).

## Not done here, for the owner

- **Claude's plugin directory.** Nothing here submits the plugin anywhere. The owner submits it through the web portal (claude.ai/directory/manage). `claude plugin validate --profile directory dist/plugin` lists what the directory would refuse.
- **A license.** None is set, so no right to reuse the code is stated. The directory refuses a plugin without one. Choosing one is the owner's decision.
- **An icon.** The directory check also warns that the plugin has no square PNG icon. It is optional.
