/**
 * Keep the prefix and the part that reads as "which one", drop the random tail.
 *
 * `run_mt90zawo_qhcfg` becomes `run_mt90zawo`; a UUID-shaped chat id keeps its
 * first group. Never shortens something already short enough to read.
 */
export function shortenId(id: string): string {
  // `run_<when>_<rand>`, and `agent_conv_<when>_<rand>` for a multi-word prefix:
  // everything but the random tail is what a person quotes.
  const segments = id.split('_')
  if (segments.length >= 3) return segments.slice(0, -1).join('_')

  // `c_<uuid>`: the first group is already unique enough to recognise.
  const dash = id.indexOf('-')
  if (dash > 0) return id.slice(0, dash)

  return id
}
