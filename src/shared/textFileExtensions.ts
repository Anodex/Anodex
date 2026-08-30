/**
 * File extensions treated as readable text - shared by `fileTools.ts` (find/
 * search tools) and `codeChunking.ts` (semantic code indexing), so "is this a
 * text file worth looking at" stays a single definition instead of two
 * regexes that can silently drift apart.
 *
 * This list decides what `search_files` will even open. A language missing from
 * it does not search badly, it searches to nothing: the walk skips the file and
 * reports "No matches found" for code that is plainly there, with nothing to
 * say a filter was applied. That is the worst shape a gap can take, so the list
 * errs towards including a text format rather than leaving it out - the cost of
 * a wrong inclusion is one file opened and not matched.
 */
export const TEXT_EXT = new RegExp(
  '\\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|env|csv|html?|css|s[ac]ss|less|jsx?|tsx?|mjs|cjs|vue|svelte|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bash|ps1|sql|xml|dockerfile|lock|swift|scala|sc|lua|dart|ex|exs|erl|hrl|clj|cljs|cljc|edn|hs|lhs|ml|mli|fs|fsx|fsi|jl|nim|zig|cr|d|groovy|gradle|sbt|pl|pm|tcl|vb|vbs|pas|asm|r|rmd|f|f90|f95|m|mm|pyi|pyx|rake|gemspec|cshtml|razor|tsv|ndjson|tf|tfvars|hcl|proto|graphql|gql|cmake|mk|make|bat|cmd|zsh|fish|cfg|conf|properties|nix|bzl|bazel|rst|adoc|tex|ipynb|plist|gitignore|patch|diff)$',
  'i'
)

/**
 * Source files that carry no extension at all.
 *
 * `TEXT_EXT` requires a dot, so `Makefile`, `Dockerfile` and `Gemfile` - the
 * build definition of the whole project, in three different ecosystems - were
 * never searched and never indexed. Dotfiles like `.gitignore` are here for the
 * same reason: the leading dot is the whole name, not an extension.
 */
const TEXT_FILENAMES: ReadonlySet<string> = new Set([
  'makefile',
  'gnumakefile',
  'dockerfile',
  'containerfile',
  'gemfile',
  'rakefile',
  'procfile',
  'jenkinsfile',
  'vagrantfile',
  'brewfile',
  'justfile',
  'cargo.lock',
  'license',
  'licence',
  'readme',
  'changelog',
  'authors',
  'notice',
  'codeowners',
  '.gitignore',
  '.gitattributes',
  '.dockerignore',
  '.npmignore',
  '.editorconfig',
  '.prettierrc',
  '.eslintrc',
  '.babelrc',
  '.nvmrc'
])

/**
 * Whether a path names a file worth reading as text.
 *
 * Takes a path or a bare name; only the last segment is examined, so a folder
 * called `assets.png` cannot make a file inside it look like an image.
 */
export function isTextFile(pathOrName: string): boolean {
  const name = basename(pathOrName)
  return TEXT_FILENAMES.has(name.toLowerCase()) || TEXT_EXT.test(name)
}

/** Last path segment, for either separator - this runs on Windows too. */
function basename(value: string): string {
  const cut = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  return cut === -1 ? value : value.slice(cut + 1)
}
