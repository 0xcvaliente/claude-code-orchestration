Build a job scheduler simulator as ES modules, with tests. The public entry point is index.js at the repository root, which exports simulate, criticalPath and formatGantt. Organize the implementation into several modules of your choice (for example graph validation, the simulation loop, formatting) and write node:test files for them. Acceptance check: npm test

Jobs and options
- A job is { id, duration, deps, priority, needs, failAttempts, maxRetries }. id is a string and duration a positive integer. Defaults: deps = [], priority = 0 (an integer; higher runs first), needs = {} (resource name to positive integer units), failAttempts = 0, maxRetries = 0 (non-negative integers).
- Options are { workers, resources } where workers is a positive integer and resources maps a resource name to a positive integer capacity (default {}).

Validation (all before any simulation; the input must never be mutated)
- Duplicate ids throw Error whose message contains "duplicate". A dependency on an unknown id throws Error containing "unknown". A cycle, including a job depending on itself, throws Error whose message contains "cycle" and lists the id of every job on the cycle.
- needs naming a resource not in options.resources throws Error containing "unknown resource"; needs larger than that resource's capacity throws RangeError. A non-integer or non-positive workers, a duration that is not a positive integer, or a negative or non-integer failAttempts or maxRetries throws RangeError.

simulate(jobs, options) rules (time is integer, starts at 0)
1. At each event time, first process every attempt that ends at that time, in ascending job id order. This frees its worker and resources.
2. An attempt numbered n (starting at 1) fails if n <= failAttempts, otherwise it succeeds. A successful job is "done". A failed job with retries left (total attempts allowed = 1 + maxRetries) becomes ready again immediately, at the same time, for attempt n+1. A failed job with no retries left is "failed", and every job that transitively depends on it and has not finished is "skipped" and never runs.
3. After processing the completions, start jobs. A job is ready when all its dependencies are "done" and it is not running. Consider ready jobs in order of priority descending, then id ascending (plain string comparison by UTF-16 code units). For each, start it if a worker is free and all of its needs are available right now; otherwise skip it and keep scanning, so a later job that does fit may start (no head-of-line blocking). A started job occupies one worker and its needs for its full duration.
4. Advance time to the earliest end among running attempts. Stop when nothing is running after starting.
Result: { makespan, attempts, status }. attempts is a list of { id, attempt, start, end, ok } sorted by start, then id, then attempt. makespan is the largest end (0 if no attempts). status maps every job id to "done", "failed" or "skipped".

criticalPath(jobs): validates like simulate (duplicates, unknown dependencies, cycles) and ignores workers, resources, failures and priority. Returns { length, path }: the longest chain of dependencies by total duration, path listing the ids with dependencies first. If several chains tie, choose the one whose id array is lexicographically smallest (compare element by element; a proper prefix is smaller). An empty job list gives { length: 0, path: [] }.

formatGantt(result): one text row per job that has at least one attempt, rows sorted by id, joined with "\n" and no trailing newline. A row is the id padded with spaces on the right to the longest such id, then " |", then makespan characters, then "|". Character u (0-based) describes the time unit [u, u+1): "#" if a successful attempt covers it, "x" if a failed attempt covers it, "." otherwise. Jobs that never ran are omitted. With no attempts the result is "".
