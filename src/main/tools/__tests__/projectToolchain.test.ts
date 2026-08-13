import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { describeUnresolvedCheck, detectToolchain } from '../projectToolchain'

/**
 * `run_project_check` used to fall back to `npm test` / `npm run <kind>`
 * unconditionally, so every check in a non-JS project ran npm in a directory
 * npm knows nothing about. Verification is how Anodex stops itself claiming
 * unproven fixes, so a verification tool that only works for one ecosystem
 * quietly removes that safeguard everywhere else.
 */
describe('detectToolchain', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-toolchain-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it.each([
    ['Cargo.toml', 'rust', 'cargo test', 'cargo check'],
    ['go.mod', 'go', 'go test ./...', 'go build ./...'],
    ['pyproject.toml', 'python', 'pytest', 'mypy .'],
    ['pom.xml', 'maven', 'mvn test', 'mvn compile'],
    ['build.gradle', 'gradle', 'gradle test', 'gradle compileJava'],
    ['CMakeLists.txt', 'cmake', 'ctest', undefined],
    ['Makefile', 'make', 'make test', undefined]
  ])('detects %s as %s', async (marker, id, test, typecheck) => {
    const detection = await detectToolchain(workspace, [marker])

    expect(detection.chosen?.id).toBe(id)
    expect(detection.chosen?.commands.test).toBe(test)
    expect(detection.chosen?.commands.typecheck).toBe(typecheck)
  })

  it('detects .NET from a project file suffix', async () => {
    const detection = await detectToolchain(workspace, ['Game.csproj'])

    expect(detection.chosen?.id).toBe('dotnet')
    expect(detection.chosen?.commands.test).toBe('dotnet test')
  })

  it('reads real commands from package.json scripts rather than assuming them', async () => {
    await writeFile(
      join(workspace, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run', build: 'vite build' } })
    )

    const detection = await detectToolchain(workspace, ['package.json'])

    expect(detection.chosen?.commands.test).toBe('npm test')
    expect(detection.chosen?.commands.build).toBe('npm run build')
    // No `lint` script exists, so no lint command is offered — running
    // `npm run lint` would fail with npm's own "missing script" error.
    expect(detection.chosen?.commands.lint).toBeUndefined()
  })

  it('finds a type check under a common alternate script name', async () => {
    await writeFile(
      join(workspace, 'package.json'),
      JSON.stringify({ scripts: { types: 'tsc --noEmit' } })
    )

    const detection = await detectToolchain(workspace, ['package.json'])

    expect(detection.chosen?.commands.typecheck).toBe('npm run types')
  })

  it('reports every toolchain in a mixed repository', async () => {
    await writeFile(
      join(workspace, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest' } })
    )

    const detection = await detectToolchain(workspace, ['package.json', 'Cargo.toml'])

    expect(detection.chosen?.id).toBe('node')
    expect(detection.detected.map((toolchain) => toolchain.id)).toEqual(['node', 'rust'])
  })

  it('recognizes nothing in a workspace with no manifest', async () => {
    const detection = await detectToolchain(workspace, ['index.html', 'style.css'])

    expect(detection.chosen).toBeNull()
    expect(detection.detected).toEqual([])
  })

  it('returns nothing without a workspace', async () => {
    const detection = await detectToolchain(null, [])

    expect(detection.chosen).toBeNull()
  })
})

describe('describeUnresolvedCheck', () => {
  it('tells the model how to proceed when nothing was recognized', () => {
    const message = describeUnresolvedCheck('test', { chosen: null, detected: [] })

    expect(message).toContain('No recognizable project manifest')
    expect(message).toContain('kind: "custom"')
  })

  it('names the detected toolchain when it has no command for this kind', () => {
    const cmake = { id: 'cmake' as const, label: 'CMake', commands: { test: 'ctest' } }
    const message = describeUnresolvedCheck('lint', { chosen: cmake, detected: [cmake] })

    expect(message).toContain('CMake')
    expect(message).toContain('no standard "lint" command')
  })

  it('mentions the other toolchains found in a mixed repository', () => {
    const node = { id: 'node' as const, label: 'Node.js', commands: {} }
    const rust = { id: 'rust' as const, label: 'Rust (Cargo)', commands: { test: 'cargo test' } }
    const message = describeUnresolvedCheck('lint', { chosen: node, detected: [node, rust] })

    expect(message).toContain('Also detected: Rust (Cargo)')
  })
})
