/**
 * Emit `protocol/anodex-protocol.json` — the wire contract the mobile client is built against.
 *
 * Two repositories cannot typecheck each other. On the desktop side a protocol change that breaks
 * the renderer is a compile error; across the boundary to `Anodex/anodex-mobile` there is nothing
 * to catch it, and the symptom arrives at runtime, on a phone, in another room, with no stack
 * trace anyone will see. This artifact plus the CI gate is what replaces that compile error.
 *
 * ## Where the contract actually lives
 *
 * Not in `IpcChannel` alone. Three things have to be read together:
 *
 * 1. `IpcChannel` (src/shared/ipc.ts) names the channels.
 * 2. `AnodexApi` (same file) declares each call's argument and result *types* — which it imports
 *    from 31 sibling `*.types.ts` modules, so the type graph is the contract, not one file.
 * 3. `src/preload/index.ts` is the only place that says which API method uses which channel.
 *
 * Step 3 is not optional and cannot be replaced by matching names: `IpcChannel.Models.recommendSettings`
 * is reached by `api.models.recommendSettingsForFile`, and every event channel is renamed on the
 * way through (`stateChanged` becomes `onStateChanged`). Anything that assumed a naming convention
 * would silently emit a wrong contract, which is worse than emitting none.
 *
 * ## Usage
 *
 *     node scripts/generate-protocol.mjs           # write the artifact
 *     node scripts/generate-protocol.mjs --check   # fail if it differs from what is committed
 *
 * The `--check` form is the CI gate. It regenerates and diffs rather than testing whether
 * `ipc.ts` changed, because the likeliest breaking change — renaming a field in `ChatStreamChunk`,
 * adding a required field to `ToolConfirmRequest` — never touches `ipc.ts` at all.
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PRELOAD = path.join(ROOT, 'src', 'preload', 'index.ts')
const OUTPUT = path.join(ROOT, 'protocol', 'anodex-protocol.json')

/**
 * Bump the major only for a breaking channel change; add channels within a minor. The desktop must
 * keep serving the previous major for at least one release, so a phone that has not updated yet
 * gets a clear "update the app" message rather than a broken session.
 */
const PROTOCOL_VERSION = '1.0.0'

/** Types expanded inline rather than by reference — they carry no useful name for a client. */
const INLINE_TYPES = new Set(['Promise', 'Array', 'ReadonlyArray'])

/** Guard against pathological recursion in a type graph that does contain cycles. */
const MAX_DEPTH = 12

function main() {
  const check = process.argv.includes('--check')

  const program = createProgram()
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(PRELOAD)
  if (!source) fail(`could not load ${PRELOAD}`)

  const apiType = resolveAnodexApiType(program, checker)
  const definitions = new Map()
  const channels = collectChannels(source, checker, definitions, apiType)

  const known = collectDeclaredChannels(program)
  const unmapped = [...known].filter((c) => !channels.some((entry) => entry.channel === c)).sort()

  const artifact = {
    protocolVersion: PROTOCOL_VERSION,
    generatedBy: 'scripts/generate-protocol.mjs',
    note: 'Generated. Do not edit by hand; run the script and commit the result.',
    channels: channels.sort((a, b) => a.channel.localeCompare(b.channel)),
    // Channels declared but never reached from the preload bridge. Not an error: some exist for
    // main-side broadcasts the renderer subscribes to elsewhere. Recorded so the mobile side can
    // see what is deliberately unavailable rather than guessing it was forgotten.
    unmappedChannels: unmapped,
    definitions: Object.fromEntries(
      [...definitions.entries()].sort(([a], [b]) => a.localeCompare(b))
    )
  }

  const rendered = JSON.stringify(artifact, null, 2) + '\n'

  if (check) {
    if (!fs.existsSync(OUTPUT)) {
      fail(`${rel(OUTPUT)} does not exist. Run: node scripts/generate-protocol.mjs`)
    }
    const committed = fs.readFileSync(OUTPUT, 'utf8')
    if (committed !== rendered) {
      fail(
        `${rel(OUTPUT)} is out of date.\n\n` +
          'The wire contract changed but the committed artifact did not. The mobile client is\n' +
          'built against that file, so shipping this would break it at runtime with no stack\n' +
          'trace. Regenerate and commit:\n\n' +
          '    node scripts/generate-protocol.mjs\n'
      )
    }
    console.log(
      `protocol up to date — ${artifact.channels.length} channels, ` +
        `${Object.keys(artifact.definitions).length} types, v${PROTOCOL_VERSION}`
    )
    return
  }

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
  fs.writeFileSync(OUTPUT, rendered)
  console.log(
    `wrote ${rel(OUTPUT)} — ${artifact.channels.length} channels, ` +
      `${Object.keys(artifact.definitions).length} types, ${unmapped.length} unmapped`
  )
}

function createProgram() {
  const configPath = path.join(ROOT, 'tsconfig.node.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) fail(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT)
  return ts.createProgram([PRELOAD], { ...parsed.options, noEmit: true })
}

/**
 * Walk the preload bridge's `const api: AnodexApi = { ... }` and record every leaf that reaches a
 * channel, together with the types declared for it on `AnodexApi`.
 */
function collectChannels(source, checker, definitions, apiType) {
  const entries = []

  const apiDecl = findDeclaration(source, 'api')
  if (!apiDecl) fail('could not find `const api: AnodexApi` in the preload bridge')

  walkObject(apiDecl, [])
  return entries

  function walkObject(node, apiPath) {
    if (!ts.isObjectLiteralExpression(node)) return

    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop) || !prop.name) continue
      const name = prop.name.getText()
      const nextPath = [...apiPath, name]

      if (ts.isObjectLiteralExpression(prop.initializer)) {
        walkObject(prop.initializer, nextPath)
        continue
      }

      const use = findChannelUse(prop.initializer, checker)
      if (!use) continue

      const memberType = memberTypeAt(apiType, nextPath, checker)
      if (!memberType) fail(`no \`AnodexApi\` member for ${nextPath.join('.')}`)

      entries.push({
        channel: use.channel,
        kind: use.kind,
        api: nextPath.join('.'),
        ...describeMember(memberType, prop, checker, definitions, use.kind)
      })
    }
  }
}

/** Find `ipcRenderer.invoke(CHANNEL, …)` or `subscribe<T>(CHANNEL, …)` anywhere inside a node. */
function findChannelUse(node, checker) {
  let found = null

  const visit = (n) => {
    if (found) return
    if (ts.isCallExpression(n)) {
      const callee = n.expression
      const isInvoke =
        ts.isPropertyAccessExpression(callee) &&
        callee.name.getText() === 'invoke' &&
        callee.expression.getText() === 'ipcRenderer'
      const isSubscribe = ts.isIdentifier(callee) && callee.getText() === 'subscribe'

      if ((isInvoke || isSubscribe) && n.arguments.length > 0) {
        const channel = literalValueOf(n.arguments[0], checker)
        if (channel) {
          found = { channel, kind: isSubscribe ? 'event' : 'invoke' }
          return
        }
      }
    }
    ts.forEachChild(n, visit)
  }

  visit(node)
  return found
}

/** Resolve `IpcChannel.Models.list` to `'models:list'` using its `as const` literal type. */
function literalValueOf(node, checker) {
  const type = checker.getTypeAtLocation(node)
  return type.isStringLiteral() ? type.value : null
}

/**
 * Describe one call's payloads from the type `AnodexApi` declares for it.
 *
 * The type **must** come from the interface, not from the preload property. Every bridge method
 * returns `ipcRenderer.invoke(...)`, whose type is `Promise<any>`, so reading the implementation
 * yields a correct-looking artifact in which the result of all 179 calls is `unknown`. Parameters
 * survive that mistake, because they are contextually typed from the interface — which is exactly
 * what makes it easy to miss.
 */
function describeMember(memberType, prop, checker, definitions, kind) {
  const signature = memberType
    ? checker.getSignaturesOfType(memberType, ts.SignatureKind.Call)[0]
    : null
  if (!signature) return { args: [], result: { kind: 'unknown', note: 'no call signature' } }

  if (kind === 'event') {
    // Events are `on*(listener: (payload: P) => void): () => void`. The payload is what a client
    // needs; the unsubscribe function is a local convenience with no wire representation.
    const listener = signature.getParameters()[0]
    const listenerType = listener ? checker.getTypeOfSymbolAtLocation(listener, prop) : null
    const listenerSig = listenerType
      ? checker.getSignaturesOfType(listenerType, ts.SignatureKind.Call)[0]
      : null
    const payload = listenerSig?.getParameters()[0]

    return {
      args: [],
      payload: payload
        ? serializeType(checker.getTypeOfSymbolAtLocation(payload, prop), checker, definitions, 0)
        : { kind: 'void' }
    }
  }

  return {
    args: signature.getParameters().map((param) => ({
      name: param.getName(),
      optional: Boolean(param.flags & ts.SymbolFlags.Optional),
      type: serializeType(checker.getTypeOfSymbolAtLocation(param, prop), checker, definitions, 0)
    })),
    result: serializeType(
      unwrapPromise(signature.getReturnType(), checker),
      checker,
      definitions,
      0
    )
  }
}

/**
 * The declared type of `AnodexApi`, which is where the contract is actually written down.
 */
function resolveAnodexApiType(program, checker) {
  const ipcFile = program
    .getSourceFiles()
    .find((f) => f.fileName.replace(/\\/g, '/').endsWith('src/shared/ipc.ts'))
  if (!ipcFile) fail('could not load src/shared/ipc.ts')

  let declaration = null
  const visit = (node) => {
    if (declaration) return
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'AnodexApi') {
      declaration = node
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(ipcFile)
  if (!declaration) fail('could not find the `AnodexApi` interface in src/shared/ipc.ts')

  return checker.getTypeAtLocation(declaration)
}

/** Walk a dotted API path (`chat.send`) down the `AnodexApi` type. */
function memberTypeAt(apiType, pathSegments, checker) {
  let current = apiType
  for (const segment of pathSegments) {
    if (!current) return null
    const symbol = checker.getPropertyOfType(current, segment)
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
    if (!symbol || !declaration) return null
    current = checker.getTypeOfSymbolAtLocation(symbol, declaration)
  }
  return current
}

function unwrapPromise(type, checker) {
  const symbol = type.getSymbol()
  if (symbol?.getName() === 'Promise') {
    const args = checker.getTypeArguments(type)
    if (args.length === 1) return args[0]
  }
  return type
}

/**
 * Turn a TypeScript type into a language-neutral shape.
 *
 * Named object types become `{ $ref }` plus an entry in `definitions`, so a payload's *structure*
 * is in the artifact rather than just its name. That is what makes the CI gate catch a renamed
 * field in a sibling `*.types.ts` module — the whole reason this file exists.
 */
function serializeType(type, checker, definitions, depth) {
  if (depth > MAX_DEPTH) return { kind: 'unknown', note: 'max depth' }

  const flags = type.getFlags()
  if (flags & ts.TypeFlags.Void) return { kind: 'void' }
  if (flags & ts.TypeFlags.Undefined) return { kind: 'undefined' }
  if (flags & ts.TypeFlags.Null) return { kind: 'null' }
  if (flags & ts.TypeFlags.Never) return { kind: 'never' }
  if (flags & ts.TypeFlags.BooleanLike) return { kind: 'boolean' }
  if (flags & ts.TypeFlags.NumberLike) {
    return type.isNumberLiteral() ? { kind: 'literal', value: type.value } : { kind: 'number' }
  }
  if (flags & ts.TypeFlags.StringLike) {
    return type.isStringLiteral() ? { kind: 'literal', value: type.value } : { kind: 'string' }
  }
  if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return { kind: 'unknown' }

  if (type.isUnion()) {
    return {
      kind: 'union',
      of: type.types.map((t) => serializeType(t, checker, definitions, depth + 1))
    }
  }

  if (checker.isArrayType(type)) {
    const [element] = checker.getTypeArguments(type)
    return {
      kind: 'array',
      of: element ? serializeType(element, checker, definitions, depth + 1) : { kind: 'unknown' }
    }
  }

  if (type.getCallSignatures().length > 0) {
    // A function in a payload has no wire representation. Recorded rather than dropped so a
    // reader can see why a field is missing on the client.
    return { kind: 'function', note: 'not transferable' }
  }

  if (flags & ts.TypeFlags.Object) {
    const name = namedTypeOf(type, checker)
    if (name && !INLINE_TYPES.has(name)) {
      if (!definitions.has(name)) {
        // Reserve the name before recursing, or a self-referential type loops forever.
        definitions.set(name, { kind: 'object', properties: {} })
        definitions.set(name, serializeObject(type, checker, definitions, depth))
      }
      return { $ref: name }
    }
    return serializeObject(type, checker, definitions, depth)
  }

  return { kind: 'unknown', note: checker.typeToString(type) }
}

function serializeObject(type, checker, definitions, depth) {
  const properties = {}
  for (const symbol of checker.getPropertiesOfType(type)) {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
    if (!declaration) continue
    properties[symbol.getName()] = {
      optional: Boolean(symbol.flags & ts.SymbolFlags.Optional),
      type: serializeType(
        checker.getTypeOfSymbolAtLocation(symbol, declaration),
        checker,
        definitions,
        depth + 1
      )
    }
  }
  return { kind: 'object', properties }
}

/** A type's own declared name, when it has one worth referencing. */
function namedTypeOf(type, checker) {
  const symbol = type.aliasSymbol ?? type.getSymbol()
  if (!symbol) return null
  const name = symbol.getName()
  if (!name || name === '__type' || name === '__object') return null

  // A generic instantiation such as `Result<ModelInfo[]>` must not collapse onto the bare name,
  // or two different results would share one definition and the artifact would be wrong.
  const args = type.aliasTypeArguments ?? checker.getTypeArguments(type) ?? []
  if (args.length > 0) {
    return `${name}<${args.map((a) => checker.typeToString(a)).join(', ')}>`
  }
  return name
}

/**
 * Every channel string declared in `IpcChannel`, so we can report ones nothing maps to.
 *
 * Scoped to the `IpcChannel` declaration and taking *every* string literal inside it, deliberately.
 * An earlier version filtered with `/^[a-zA-Z]+:[a-zA-Z-]+$/` — copied from the handoff's own
 * verification command — and that pattern requires an alphabetic-only prefix, so it silently
 * dropped all 18 hyphenated channels (`critical-thinking:*`, `computer-control:*`,
 * `context-menu:*`) and reported 183 where there are 201. A drift check that quietly ignores a
 * tenth of the surface is worse than no check, because it reports success.
 */
function collectDeclaredChannels(program) {
  const found = new Set()
  const ipcFile = program
    .getSourceFiles()
    .find((f) => f.fileName.replace(/\\/g, '/').endsWith('src/shared/ipc.ts'))
  if (!ipcFile) return found

  const declaration = findDeclaration(ipcFile, 'IpcChannel')
  if (!declaration) fail('could not find the `IpcChannel` declaration in src/shared/ipc.ts')

  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.initializer)) {
      found.add(node.initializer.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(declaration)
  return found
}

/** The initializer of a top-level `const <name> = …` in `source`. */
function findDeclaration(source, name) {
  let result = null
  const visit = (node) => {
    if (result) return
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      result = node.initializer
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/')
}

function fail(message) {
  console.error(`\n${message}\n`)
  process.exit(1)
}

main()
