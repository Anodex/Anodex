/**
 * What running jobs side by side means for the model that is loaded.
 *
 * Said before it is switched on, because the cost differs by runtime: a model with
 * picture support shares one pool of context between its jobs, and a text-only
 * model cannot run them side by side at all yet.
 */
export function parallelJobsDescription(
  parallelJobs: number | undefined,
  vision: boolean | undefined,
  contextSize: number
): string {
  const jobs = parallelJobs ?? 1
  const context = contextSize.toLocaleString()
  if (vision === false) {
    return (
      'Lets a chat run while an agent works, instead of waiting for it. Not available for ' +
      'the loaded model yet: only models with picture support can run jobs side by side.'
    )
  }
  if (jobs <= 1) {
    return (
      'Lets a chat run while an agent works, instead of waiting for it. Jobs share the ' +
      `${context}-token context and use no extra memory, but each runs a little slower.`
    )
  }
  return (
    `Up to ${jobs} jobs run at once and share the ${context}-token context, so a long job ` +
    'leaves less room for the others. No extra memory is used; each runs a little slower.'
  )
}
