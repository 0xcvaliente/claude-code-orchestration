Write a security handbook for new employees from the four policy files in `sources/`. Write in plain English. Every file goes in `handbook/`:

- `handbook/README.md`: a title, then links to the four sections in this order: `access.md`, `devices.md`, `incidents.md`, `data.md`, then a link to `glossary.md`.
- `handbook/access.md` from `sources/access-policy.md`, `handbook/devices.md` from `sources/device-standard.md`, `handbook/incidents.md` from `sources/incident-runbook.md`, `handbook/data.md` from `sources/data-classification.md`.
- `handbook/glossary.md`: one `## ` heading per term, exactly `MFA`, `SSO`, `VPN`, `PII` and `Incident commander`, each followed by a one- or two-sentence definition.

Rules:

1. Every rule in a source (AC-1 to AC-4, DV-1 to DV-4, IN-1 to IN-4, DT-1 to DT-4) is explained exactly once in the whole handbook, in its own section, as one paragraph or list item. That paragraph or item cites the rule with a link to its heading in the source, for example `[AC-1](../sources/access-policy.md#ac-1)`, and keeps every number, duration and product name of the rule exactly as written.
2. One term per concept. Outside `glossary.md`, never write "2FA", "two-factor", "single sign-on" or "personally identifiable"; use MFA, SSO and PII instead.
3. In each section, the first mention of a glossary term in the body text (headings do not count) is a link to its glossary entry, for example `[MFA](glossary.md#mfa)`. The anchors are `#mfa`, `#sso`, `#vpn`, `#pii` and `#incident-commander`.
4. Every relative link in the handbook must resolve to an existing file and, when it has an anchor, an existing heading.

Acceptance check: `node tools/check.mjs` (structure, terms and links). The final grade also checks every rule's paragraph.
