/**
 * Hardware names as the OS reports them carry filler that pushes the part that
 * identifies the chip off the end of a small tile: "12-Core Processor" repeats
 * the core count shown beside it, Intel adds trademark marks and a clock, and
 * Mesa appends its driver in parentheses.
 */
export function shortHardwareName(name: string): string {
  return name
    .replace(/\((R|TM)\)/gi, '')
    .replace(/\s*\(.*\)\s*$/, '')
    .replace(/\s+@\s*[\d.]+\s*GHz$/i, '')
    .replace(/\s+\d+-Core Processor$/i, '')
    .replace(/\s+(Processor|CPU)$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
