import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const IDENTITY = ["-c", "user.name=orchestrator", "-c", "user.email=orchestrator@localhost"];

export const git = async (cwd: string, ...args: string[]) =>
  (await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();

export const headRef = (repo: string) => git(repo, "rev-parse", "HEAD");

export const isDirty = async (repo: string) => (await git(repo, "status", "--porcelain")) !== "";

export const addWorktree = (repo: string, dir: string, branch: string, base: string) =>
  git(repo, "worktree", "add", "-b", branch, dir, base);

/** Remove a worktree directory and its registration; the branch and its commits stay. Never throws. */
export async function removeWorktree(repo: string, dir: string): Promise<void> {
  await git(repo, "worktree", "remove", "--force", dir).catch(() => undefined);
  await git(repo, "worktree", "prune").catch(() => undefined);
}

/** Delete a branch and its commits if it exists. Used when a resumed run restarts a failed slice. Never throws. */
export const deleteBranch = (repo: string, branch: string) =>
  git(repo, "branch", "-D", branch).then(() => undefined, () => undefined);

/** Commit everything in the worktree. Returns false when the worker changed nothing. */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  await git(dir, "add", "-A");
  if ((await git(dir, "status", "--porcelain")) === "") return false;
  await git(dir, ...IDENTITY, "commit", "-m", message);
  return true;
}

/** Merge branches into the worktree's current branch; conflicts are aborted and reported. */
export async function mergeAll(dir: string, branches: string[]): Promise<{ merged: string[]; conflicted: string[] }> {
  const merged: string[] = [];
  const conflicted: string[] = [];
  for (const b of branches) {
    try {
      await git(dir, ...IDENTITY, "merge", "--no-ff", "-m", `merge ${b}`, b);
      merged.push(b);
    } catch {
      await git(dir, "merge", "--abort").catch(() => undefined);
      conflicted.push(b);
    }
  }
  return { merged, conflicted };
}

/** Merge branches into a new result branch in its own worktree. */
export async function mergeInto(
  repo: string, dir: string, branch: string, base: string, branches: string[],
): Promise<{ merged: string[]; conflicted: string[] }> {
  await addWorktree(repo, dir, branch, base);
  return mergeAll(dir, branches);
}

/** Run a shell command (the project's test command) without involving a model. */
export function sh(command: string, cwd: string, timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile("sh", ["-c", command], { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}` });
    });
  });
}
