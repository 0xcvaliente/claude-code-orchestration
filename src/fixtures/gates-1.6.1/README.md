# 1.6.1 gate modules (stored copies)

`run.mjs`, `brief.mjs` and `state.mjs` are byte-for-byte copies of `.claude/hooks/<name>` at commit
`7b408fe51296dfd188794d0c4f0d560073985e63` (the `release-1.6.1` branch), taken with
`git show 7b408fe:.claude/hooks/<name>`. `run.mjs` imports only the other two, so the folder is the whole module
closure. `src/test-gate-pairing.test.mjs` compares the current pairing with this base, so it runs in a one-commit clone
that has no history. Do not edit these files; they carry no header so they stay identical to the release.
