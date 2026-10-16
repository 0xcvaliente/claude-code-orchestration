// Grades d1-handbook: the public checks of setup/tools/check.mjs plus one check per source rule (cited once, in its
// own section, with the rule's key wording). Links into ../sources/ resolve against this task's own setup/sources.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checks } from "./setup/tools/check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const r = (id, section, source, key) => ({ id, section, source, key });
const A = "access-policy.md", D = "device-standard.md", I = "incident-runbook.md", C = "data-classification.md";
export const RULES = [
  r("AC-1", "access", A, "14 characters"),
  r("AC-2", "access", A, "hardware security key"),
  r("AC-3", "access", A, "90 days"),
  r("AC-4", "access", A, "24 hours"),
  r("DV-1", "devices", D, "BitLocker"),
  r("DV-2", "devices", D, "5 minutes"),
  r("DV-3", "devices", D, "7 days"),
  r("DV-4", "devices", D, "split tunneling"),
  r("IN-1", "incidents", I, "1 hour"),
  r("IN-2", "incidents", I, "on-call security engineer"),
  r("IN-3", "incidents", I, "reimage"),
  r("IN-4", "incidents", I, "5 business days"),
  r("DT-1", "data", C, "Restricted"),
  r("DT-2", "data", C, "Confidential at minimum"),
  r("DT-3", "data", C, "approved vault"),
  r("DT-4", "data", C, "30 days"),
];

export function score(dir) {
  const res = checks(join(dir, "handbook"), join(HERE, "setup", "sources"), { rules: RULES });
  const passed = res.filter((c) => c.ok).length;
  return { pass: passed === res.length, passed, total: res.length, failed: res.filter((c) => !c.ok).map((c) => `${c.name}: ${c.why}`) };
}
