/**
 * File extensions treated as readable text — shared by `fileTools.ts` (find/
 * search tools) and `codeChunking.ts` (semantic code indexing), so "is this a
 * text file worth looking at" stays a single definition instead of two
 * regexes that can silently drift apart.
 */
export const TEXT_EXT =
  /\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|env|csv|html?|css|s[ac]ss|less|jsx?|tsx?|mjs|cjs|vue|svelte|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bash|ps1|sql|xml|dockerfile|lock)$/i
