/**
 * Normalize a research URL for identity comparisons without changing path or
 * query-string case. Hosts are case-insensitive; URL paths are not.
 *
 * The implementation moved to `@shared/canonicalUrl` when chat's per-turn web
 * source registry needed the same normalization; this name is kept because
 * research code reads better with it, and because "the same page" must mean
 * exactly the same thing on both surfaces.
 */
export { canonicalUrl as canonicalResearchUrl } from '@shared/canonicalUrl'
