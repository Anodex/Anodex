/**
 * How a model's context is divided between jobs running side by side.
 *
 * llama-server runs parallel jobs over one pool of context memory
 * (`--kv-unified`). Nothing in the pool stops one job taking more than its share,
 * and each job used to plan its reply as if the whole pool were its own — so two
 * long jobs together outgrew it and both failed on the same token ("Context size
 * has been exceeded"; measured on the user's machine at 26,651 + 38,886 tokens in a
 * 65,536 pool). Each job is now planned against an equal share, which is the only
 * division that holds whatever the other jobs do: a job's reply cannot be cut short
 * once it has started, and an idle job's cached context still occupies the pool.
 */

/** The smallest share worth running a job in. Below it, fewer jobs run instead. */
export const MIN_CONTEXT_PER_JOB = 8192

/** How many jobs can each have a usable share of `contextSize`, up to `requestedJobs`. */
export function jobsThatFit(requestedJobs: number, contextSize: number): number {
  const requested = Math.max(1, Math.floor(requestedJobs))
  return Math.max(1, Math.min(requested, Math.floor(contextSize / MIN_CONTEXT_PER_JOB)))
}

/** The context each job is planned against when `jobs` share `contextSize`. */
export function contextPerJob(contextSize: number, jobs: number): number {
  return Math.floor(contextSize / Math.max(1, Math.floor(jobs)))
}
