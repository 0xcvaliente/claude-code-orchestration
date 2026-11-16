# Fix notes: slice fix-guards (T-7, T-5, G-14, T-6, T-11)

## T-7: a quote citing a page outside the PDF is unverified
- Changed: `.claude/hooks/quote-check.mjs` (a PDF's pages are cut to pdfinfo's page count, dropping pdftotext's empty
  element after the last form feed; the "page with no text" rule applies only to `1 <= page <= pages`); test in
  `src/handback.test.mjs` ("quote check (T-7)", pages 1, 4, 999 and 0 of a 3-page PDF).
- Visible effect: a researcher whose QUOTE cites a page the PDF does not have, with text not in the PDF, is sent back
  once like any unverified quote; `quotes.jsonl` counts it as `unverified`, not `unverifiable`.
- Docs: none wrong (README.md:169, docs/native-mode.md:197 and `.claude/rules/agents.md` "Quotes from scans and from
  URLs are unverifiable" stay true); optionally add "a page outside the document is unverified" to the quote check text.

## T-5: device rule on the normalised and the system-resolved path, wc included
- Changed: `.claude/hooks/researcher-guard.mjs` (`readsDevice`). The candidate paths of an argument are the word
  itself, a long option's value (`--file=x`) and every suffix of a short-option cluster after its first letter, with
  or without a leading `=` (`-rfdev/zero` is `-r`, then `-f` with `dev/zero`). Each candidate is refused when any of
  three paths is under `/dev/` and is not `/dev/null`: the candidate resolved against the command's folder as text
  (`.`, `..` and repeated slashes collapsed), the system's real path of that (when it exists), and the system's real
  path of the string as written, joined to the command's folder when relative (when it exists;
  `realpathSync.native`, because Node's own `realpathSync` collapses `..` as text first). The last one closes
  `cat <link to />/../dev/zero`: the system follows the link before it applies `..`, while the text-normalised path
  names a file that does not exist. The command's folder is the hook payload's `cwd` when it is absolute, else
  `CLAUDE_PROJECT_DIR`, else the hook process's working folder. The rule covers the search and paging commands, wc, and the narrow
  sed and cut forms. Tests in `src/guards.test.mjs`: "(T-5): a device reached by another spelling ...", "(T-5): a
  device reached through a symlink and `..` is refused" (a symlink to `/` made in the test's temp folder:
  `cat <link>/../dev/zero`, `wc ...`, `grep -f<link>/../dev/zero x`, `--file=`, `head -c`, `cut`, and relative forms
  from the link's folder; seen failing before the fix) and "(T-5): a relative device path joined to an option is
  refused" (run from `/`).
- Visible effect: `cat /./dev/zero`, `cat //dev/zero`, `cat /private/../dev/zero`, a relative `../../dev/zero`,
  `grep -rf//dev/urandom x`, `grep -fdev/zero x` run from `/`, `wc /dev/zero`, `wc -c /dev/stdin` and
  `cat <symlink to />/../dev/zero` are refused ("reads a device that may never end"); `/dev/null` still passes, also
  through such a link.
- Known limit (as on the base): a glob that the shell expands to a device path (`cat /dev/zer?`) is not judged,
  since the guard sees the pattern, not what it expands to.
- Docs: README.md:170 "none of them on a `/dev/` device other than `/dev/null`" should add "wc too, judged on the
  normalised path and on the path the system resolves it to; a glob that expands to a device is not judged";
  docs/native-mode.md:192 (Researcher Bash) the same.

## G-14: a refused hand-back capture is never the stop's report
- Changed: `.claude/hooks/state.mjs` (new `HANDBACK_REFUSALS` log `handback-refusals.jsonl`, `recordHandbackRefusal`;
  `handbackFor` keeps its interface and skips refused captures: by `tool_use_id`, in either write order, or without an
  id the latest capture written before the refusal); `.claude/hooks/handback-check.mjs` (capture carries `tool_use_id`
  only when the payload has one; marks its own denial); `.claude/hooks/quote-check.mjs` (marks a hand-back it refuses);
  tests in `src/handback.test.mjs` ("(G-14)", both hook orders). Capture records keep their shape otherwise.
- Visible effect: a worker whose hand-back was refused (report check or quote check) and that then stops with a text
  report is recorded by the journal and telemetry with that text report, not the undelivered one.
- Docs: closes the known item in README.md:417 and CHANGELOG.md:59 ("A report that the hand-back check sends back is
  still captured ..."); `.claude/rules/agents.md` 1.4.4 "Hand-back capture" and CLAUDE.md 1.4.4 should say a refused
  capture is skipped (`handback-refusals.jsonl`). Limit: the quote check refusing without a `tool_use_id` in the
  payload, and finishing before handback-check.mjs writes its capture, is not tied to that capture.

## T-6: egress guard falls back to the reviewer's launch record
- Changed: `.claude/hooks/egress-guard.mjs` (`launchOf`, `launchHosts`: with no readable brief, the latest
  `journal-launches.jsonl` record of this session and agent id gives the hosts in `urls`, the host-shaped `sources`
  entries that are not existing paths, and its slice's planned FILES); tests in `src/guards.test.mjs` ("(T-6)").
- Visible effect: in headless runs without session persistence a reviewer's WebFetch to a host its brief does not
  name is denied (`host_not_in_brief`) instead of allowed as `egress_unverified`; a launch record that names no host
  allows nothing. `egress_unverified` now appears only when no launch record of the agent exists either.
- Docs: egress-guard.mjs header updated; README.md (Gate details, Guards; switch row of the guards),
  docs/native-mode.md:193 and `.claude/rules/agents.md` (egress-guard line: "an unreadable brief allows and logs
  `egress_unverified`") should name the launch-record fallback. journal.mjs needed no change: `urls`/`sources` exist.

## T-11: narrow sed -n, cut, stat and echo for the researcher; `cd` stays refused
- Changed: `.claude/hooks/researcher-guard.mjs` (`sedForm`, `cutViolation`, `STAT_LONG`, refusal messages naming each
  allowed form); `src/config.ts` researcher tools (`Bash(sed -n *)`, `Bash(cut*)`, `Bash(stat*)`, `Bash(echo*)`),
  written to `.claude/agents/researcher.md` by `npm run sync-agents`; its body lists these forms and says `cd` is
  refused and to put absolute paths in the command; tests in `src/guards.test.mjs` ("(T-11)"). Two pinned decisions
  flipped to allow, each marked `T-11` with a refused neighbour added (`sed -n 1,5p a.txt` beside `sed -i 1,5p a.txt`,
  `echo hi` beside `echo hi > a.txt`).
- `cd` is refused exactly as on the base commit (`` `cd` is not an allowed command; put absolute paths in the command
  itself ``), and it is not among the researcher's tools. An earlier attempt allowed a narrow `cd <one literal path>`;
  reviews showed that a relative path after it can reach a device in ways a check of the command text cannot follow
  (`cd /` then a device path joined to a short option; `cd` into a folder that is a symlink to `/`, then
  `cat ../dev/zero`). That form, its folder tracking and its tests were taken out, and the base's assertions about `cd`
  are restored unchanged.
- Visible effect: the researcher may run `sed -n '10,40p' f`, `cut -d, -f1 f`, `stat f`, `echo`; `sed -i`,
  `sed -n '1w x'`, `sed -e`, `sed -n 1p *` and `cut -z` stay refused with a message naming the allowed form,
  `stat --bogus` as not an allowed option; every `cd` stays refused.
- Docs: README.md:147 and :170, docs/native-mode.md:192 (allowed prefixes), `.claude/rules/agents.md` researcher-guard
  line and CLAUDE.md 1.2.0 ("The researcher's Bash list includes ...") should list the four forms and say `cd` stays
  refused; dist/ needs a rebuild.
