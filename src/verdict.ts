/** The reviewer's answer, shared by the pipeline's per-slice verifier and the plain route's reviewer. */
export const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    issues: { type: "array", items: { type: "string" }, maxItems: 20 },
    summary: { type: "string" },
  },
  required: ["pass", "issues", "summary"],
  additionalProperties: false,
};

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

/** Model output is untrusted input: anything that is not a clear verdict counts as a failure. */
export function parseVerdict(x: unknown): { pass: boolean; issues: string[] } {
  if (isRecord(x) && typeof x.pass === "boolean") {
    const issues = Array.isArray(x.issues) && x.issues.every((s) => typeof s === "string") ? (x.issues as string[]) : [];
    return { pass: x.pass, issues };
  }
  return { pass: false, issues: ["verifier returned invalid output"] };
}
