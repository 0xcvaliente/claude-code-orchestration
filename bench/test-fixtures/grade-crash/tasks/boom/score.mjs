// Throws unless BOOM_OK is set, so a test can make a later grade run succeed.
export async function score() {
  if (process.env.BOOM_OK) return { pass: true, passed: 7, total: 7 };
  throw new Error("grader blew up");
}
