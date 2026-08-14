import { readFile } from 'node:fs/promises'
import { resolveInWorkspace } from './workspace'

/**
 * Works out how to run a project's tests, type check, linter, and build —
 * whatever language it happens to be written in.
 *
 * ## Why this exists
 *
 * `run_project_check` used to look for npm scripts and then fall back to
 * `npm test` / `npm run <kind>` unconditionally. In a Python, Rust, Go, C#, or
 * Java project — anything with no `package.json` — that meant every check ran
 * npm in a directory npm knows nothing about, and the model got a packaging
 * error instead of a test result. Verification is how Anodex stops itself
 * claiming unproven fixes, so a verification tool that only works for one
 * ecosystem quietly removes that safeguard everywhere else.
 *
 * ## Detection
 *
 * Marker files, in the priority order below. A repository can legitimately
 * contain several (a Rust service with a JS front end, a Python API with a
 * Vite dashboard), so ambiguity is reported rather than hidden: the caller
 * gets the chosen toolchain *and* the others that were detected, so an
 * unexpected choice can be overridden with an explicit command instead of
 * leaving the model to guess why the wrong test suite ran.
 *
 * ## Deliberately shallow
 *
 * This does not parse `pyproject.toml`, inspect Cargo workspaces, or resolve
 * monorepo layouts. It picks the conventional command for an ecosystem and
 * says which one it picked. An override argument already exists on
 * `run_project_check` for everything more specific, and guessing harder would
 * produce confidently wrong commands rather than honest ones.
 */

/**
 * The checks a toolchain can have a *conventional* command for.
 *
 * Deliberately excludes `run_project_check`'s `custom` kind: "custom" means the
 * caller supplied the command, so no toolchain can offer one for it. Named
 * distinctly from that tool's own `ProjectCheckKind` (which is this union plus
 * `custom`) because two same-named types with different members in adjacent
 * modules is an easy import to get wrong.
 */
export type ToolchainCheckKind = 'test' | 'typecheck' | 'lint' | 'build'

export type ToolchainId =
  'node' | 'python' | 'rust' | 'go' | 'dotnet' | 'maven' | 'gradle' | 'cmake' | 'make'

export interface Toolchain {
  id: ToolchainId
  /** Human-readable name, used in messages to the model. */
  label: string
  /** Conventional command per check kind. Absent where the ecosystem has no standard one. */
  commands: Partial<Record<ToolchainCheckKind, string>>
}

export interface ToolchainDetection {
  /** The toolchain whose commands will be used, or null if none was recognized. */
  chosen: Toolchain | null
  /** Every toolchain detected, in priority order — length > 1 means a mixed repo. */
  detected: Toolchain[]
}

/**
 * Marker files by toolchain, in priority order.
 *
 * Node is deliberately first. A repo containing both `package.json` and
 * another manifest is most often a native project with a JS front end or
 * tooling, and `package.json` is the one that reliably names its own scripts —
 * so it gives the most specific answer rather than a guessed convention. A
 * project where that is wrong is exactly the case the reported `detected` list
 * and the override argument exist for.
 */
const TOOLCHAINS: Array<{ toolchain: Toolchain; markers: string[] }> = [
  {
    toolchain: {
      id: 'node',
      label: 'Node.js',
      // Filled in from package.json scripts where they exist; see
      // `nodeToolchain` for why these are only the fallback.
      commands: {
        test: 'npm test',
        typecheck: 'npm run typecheck',
        lint: 'npm run lint',
        build: 'npm run build'
      }
    },
    markers: ['package.json']
  },
  {
    toolchain: {
      id: 'rust',
      label: 'Rust (Cargo)',
      commands: {
        test: 'cargo test',
        // `cargo check` is the type check: it compiles without producing a
        // binary, which is exactly the question `typecheck` asks.
        typecheck: 'cargo check',
        lint: 'cargo clippy',
        build: 'cargo build'
      }
    },
    markers: ['Cargo.toml']
  },
  {
    toolchain: {
      id: 'go',
      label: 'Go',
      commands: {
        test: 'go test ./...',
        typecheck: 'go build ./...',
        lint: 'go vet ./...',
        build: 'go build ./...'
      }
    },
    markers: ['go.mod']
  },
  {
    toolchain: {
      id: 'python',
      label: 'Python',
      commands: {
        test: 'pytest',
        typecheck: 'mypy .',
        lint: 'ruff check .',
        build: 'python -m build'
      }
    },
    markers: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile']
  },
  {
    toolchain: {
      id: 'dotnet',
      label: '.NET',
      commands: {
        test: 'dotnet test',
        // Compilation is the type check for a statically-typed compiled
        // language; there is no separate pass to run.
        typecheck: 'dotnet build',
        build: 'dotnet build'
      }
    },
    markers: ['global.json', 'Directory.Build.props']
  },
  {
    toolchain: {
      id: 'maven',
      label: 'Maven',
      commands: { test: 'mvn test', typecheck: 'mvn compile', build: 'mvn package' }
    },
    markers: ['pom.xml']
  },
  {
    toolchain: {
      id: 'gradle',
      label: 'Gradle',
      commands: {
        test: 'gradle test',
        typecheck: 'gradle compileJava',
        build: 'gradle build'
      }
    },
    markers: ['build.gradle', 'build.gradle.kts']
  },
  {
    toolchain: {
      id: 'cmake',
      label: 'CMake',
      commands: { test: 'ctest', build: 'cmake --build build' }
    },
    markers: ['CMakeLists.txt']
  },
  {
    toolchain: {
      id: 'make',
      label: 'Make',
      // Last resort: a Makefile says nothing about which targets exist, so
      // only the two near-universal conventions are offered.
      commands: { test: 'make test', build: 'make' }
    },
    markers: ['Makefile', 'makefile', 'GNUmakefile']
  }
]

/** Extensions that identify a .NET project when no global.json is present. */
const DOTNET_PROJECT_SUFFIXES = ['.csproj', '.fsproj', '.sln']

export async function detectToolchain(
  workspaceRoot: string | null,
  /** Directory entries, injected by the caller so this stays a pure lookup. */
  entries: string[]
): Promise<ToolchainDetection> {
  if (!workspaceRoot) return { chosen: null, detected: [] }

  const present = new Set(entries)
  const detected: Toolchain[] = []

  for (const { toolchain, markers } of TOOLCHAINS) {
    const matched =
      markers.some((marker) => present.has(marker)) ||
      (toolchain.id === 'dotnet' &&
        entries.some((entry) => DOTNET_PROJECT_SUFFIXES.some((suffix) => entry.endsWith(suffix))))
    if (!matched) continue
    detected.push(
      toolchain.id === 'node' ? await nodeToolchain(workspaceRoot, toolchain) : toolchain
    )
  }

  return { chosen: detected[0] ?? null, detected }
}

/**
 * A Node project's real commands come from its own `package.json` scripts,
 * which is a far better signal than convention — `npm test` is meaningless if
 * no `test` script exists, and many projects name their type check something
 * other than `typecheck`. Scripts that are genuinely absent are dropped rather
 * than guessed, so the caller can say so instead of running a command destined
 * to fail with npm's own "missing script" error.
 */
async function nodeToolchain(workspaceRoot: string, base: Toolchain): Promise<Toolchain> {
  const scripts = await readPackageScripts(workspaceRoot)
  if (!scripts) return base

  const commands: Toolchain['commands'] = {}
  for (const kind of ['test', 'typecheck', 'lint', 'build'] as const) {
    if (scripts[kind]) commands[kind] = kind === 'test' ? 'npm test' : `npm run ${kind}`
  }
  // Common alternate spellings, so a project calling it `types` or `check`
  // still gets a type check rather than nothing.
  if (!commands.typecheck) {
    const alternate = ['types', 'check-types', 'tsc', 'check'].find((name) => scripts[name])
    if (alternate) commands.typecheck = `npm run ${alternate}`
  }
  return { ...base, commands }
}

async function readPackageScripts(workspaceRoot: string): Promise<Record<string, string> | null> {
  try {
    const file = resolveInWorkspace(workspaceRoot, 'package.json')
    const parsed = JSON.parse(await readFile(file, 'utf-8')) as {
      scripts?: Record<string, string>
    }
    return parsed.scripts ?? {}
  } catch {
    // Unreadable or malformed package.json: fall back to convention rather
    // than failing the whole check.
    return null
  }
}

/**
 * The message returned when no command can be resolved. Names what was
 * detected so the model can act, rather than reporting a bare failure.
 */
export function describeUnresolvedCheck(
  kind: ToolchainCheckKind,
  detection: ToolchainDetection
): string {
  if (!detection.chosen) {
    return (
      `No recognizable project manifest was found in the workspace, so there is no conventional ` +
      `${kind} command to run. Pass an explicit command (kind: "custom") once you know how this ` +
      `project is built — check its README, CI config, or task runner.`
    )
  }
  const others = detection.detected
    .slice(1)
    .map((toolchain) => toolchain.label)
    .join(', ')
  return (
    `This looks like a ${detection.chosen.label} project, which has no standard "${kind}" command ` +
    `configured here.${others ? ` Also detected: ${others}.` : ''} Pass an explicit command ` +
    `(kind: "custom") if this project defines one.`
  )
}
