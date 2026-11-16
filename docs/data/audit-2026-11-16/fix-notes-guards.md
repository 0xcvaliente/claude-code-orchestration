# Fix notes: slice fix-guards (T-7, T-5, G-14, T-6, T-11)

## T-7: a quote citing a page outside the PDF is unverified
- Changed: `.claude/hooks/quote-check.mjs` (a PDF's pages are cut to pdfinfo's page count, dropping pdftotext's empty
  element after the last form feed; the "page with no text" rule applies only to `1 <= page <= pages`); test in
  `src/handback.test.mjs` ("quote check (T-7)", pages 1, 4, 999 and 0 of a 3-page PDF).
- Visible effect: a researcher whose QUOTE cites a page the PDF does not have, with text not in the PDF, is sent back
  once like any unverified quote; `quotes.jsonl` counts it as `unverified`, not `unverifiable`.
- Docs: none wrong (README.md:169, docs/native-mode.md:197 and `.claude/rules/agents.md` "Quotes from scans and from
  URLs are unverifiable" stay true); optionally add "a page outside the document is unverified" to the quote check text.

## T-5: device rule on the normalised path, wc included
- Changed: `.claude/hooks/researcher-guard.mjs` (`readsDevice`: each candidate path, as a word, a long option's value
  or any suffix of a short-option cluster (`-rfdev/zero`), is resolved, from every folder a `cd` before it reached, against the command's folder and, when it exists, through symlinks; the
  hook passes the payload's `cwd`; wc, sed and cut are under the rule); tests in `src/guards.test.mjs` ("(T-5)").
- Visible effect: `cat /./dev/zero`, `cat //dev/zero`, `cat /private/../dev/zero`, a relative `../../dev/zero`,
  `wc /dev/zero` and `wc -c /dev/stdin` are refused ("reads a device that may never end"); `/dev/null` still passes.
- Docs: README.md:170 "none of them on a `/dev/` device other than `/dev/null`" should add "wc too, judged on the
  normalised path"; docs/native-mode.md:192 (Researcher Bash) the same.

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

## T-11: narrow cd, sed -n, cut, stat and echo for the researcher
- Changed: `.claude/hooks/researcher-guard.mjs` (`cdTarget`, `sedForm`, `cutViolation`, `STAT_LONG`, new refusal
  messages naming each allowed form; after a `cd`, later relative paths are judged from every folder it may reach, and
  a cd into /dev is refused); `src/config.ts` researcher tools (`Bash(cd *)`, `Bash(sed -n *)`, `Bash(cut*)`,
  `Bash(stat*)`, `Bash(echo*)`), written to `.claude/agents/researcher.md` by `npm run sync-agents`; its body says which
  forms it has; tests in `src/guards.test.mjs` ("(T-11)"). Five pinned decisions flipped to allow, each marked `T-11`
  with a refused neighbour added (`cd /tmp && ls`, `cd src && ls`, `cd /x && grep ...`, `sed -n 1,5p a.txt`, `echo hi`).
- Visible effect: the researcher may run `cd <path> && ...`, `sed -n '10,40p' f`, `cut -d, -f1 f`, `stat f`, `echo`;
  `sed -i`, `sed -n '1w x'`, `sed -e`, `sed -n 1p *`, `cut -z`, `cd a b`, `cd ~`, `cd -P` stay refused with a message
  naming the allowed form. Claude Code itself may still prompt for `cd` followed by `git` (docs/native-mode.md:262).
- Docs: README.md:147 and :170, docs/native-mode.md:192 (allowed prefixes), `.claude/rules/agents.md` researcher-guard
  line and CLAUDE.md 1.2.0 ("The researcher's Bash list includes ...") should list the five forms; dist/ needs a rebuild.
