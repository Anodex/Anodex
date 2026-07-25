import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Marker recording that the bundled sample skills have already been offered
 * once. Deliberately not a `.md` file, so `listSkillCatalog` never sees it.
 *
 * Without it the only available "have we seeded?" signal would be "is the
 * personal skills directory empty", which resurrects samples the user
 * deliberately deleted. The marker also lets installs that predate seeding
 * (they already have an empty `skills/` directory) still receive the samples
 * on their next launch.
 */
const SEED_MARKER_FILE = '.samples-seeded'

export interface SeedSkillsOptions {
  /** Directory holding the sample `.md` files shipped inside the app. */
  bundledDir: string
  /** The user's personal skills directory (`userData/skills`). */
  personalDir: string
}

/**
 * Copy the bundled sample skills into the user's personal library exactly
 * once, then leave that library alone forever after. Returns the names of the
 * files actually written, for logging.
 *
 * Never overwrites an existing file: a user who edits a sample keeps their
 * edit even in the (marker-lost) case where seeding runs a second time.
 */
export function seedPersonalSkills(options: SeedSkillsOptions): string[] {
  const marker = join(options.personalDir, SEED_MARKER_FILE)
  if (existsSync(marker)) return []
  if (!existsSync(options.bundledDir)) return []

  const samples = readdirSync(options.bundledDir)
    .filter((name) => name.endsWith('.md'))
    .sort()

  mkdirSync(options.personalDir, { recursive: true })
  const seeded: string[] = []
  for (const sample of samples) {
    const target = join(options.personalDir, sample)
    if (existsSync(target)) continue
    copyFileSync(join(options.bundledDir, sample), target)
    seeded.push(sample)
  }

  // Written last, and separately guarded: if this throws, the samples are
  // still in place and the next launch simply finds every file already
  // present and copies nothing.
  writeFileSync(marker, new Date().toISOString(), 'utf-8')
  return seeded
}
