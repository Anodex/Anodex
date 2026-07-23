import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const LLAMA_CPP_RELEASE = 'b10091'
const ROOT = resolve(import.meta.dirname, '..')
const RESOURCE_ROOT = resolve(ROOT, 'resources', 'llama-server')
const TARGET = resolve(RESOURCE_ROOT, `${process.platform}-${process.arch}`)
const MARKER = join(TARGET, '.release.json')

const assets = {
  'win32-x64': {
    name: `llama-${LLAMA_CPP_RELEASE}-bin-win-vulkan-x64.zip`,
    sha256: '28343a65a93b95250315747e1c23f09f7dc02f51d97225cde98c4738a06d95de'
  },
  'win32-arm64': {
    name: `llama-${LLAMA_CPP_RELEASE}-bin-win-cpu-arm64.zip`,
    sha256: '5d6a24de7b5965123371deff4f806c47af85ec48b1e3c15fe977c8db86218a0e'
  },
  'darwin-arm64': {
    name: `llama-${LLAMA_CPP_RELEASE}-bin-macos-arm64.tar.gz`,
    sha256: '0f6e5fd33629139793c705997cecc084c49045cf23f4b71b6dd489b9de5dc70f'
  },
  'darwin-x64': {
    name: `llama-${LLAMA_CPP_RELEASE}-bin-macos-x64.tar.gz`,
    sha256: '2b325afcf90c114a36f5a0ab475d84dd9f47f9f63b8ac5a66903b83d7cb1a777'
  },
  'linux-x64': {
    name: `llama-${LLAMA_CPP_RELEASE}-bin-ubuntu-vulkan-x64.tar.gz`,
    sha256: '8636767e0fdf440247913e4ba46a33fe02b8f13181bb11756ab890d73fdecdb4'
  },
  'linux-arm64': {
    name: `llama-${LLAMA_CPP_RELEASE}-bin-ubuntu-vulkan-arm64.tar.gz`,
    sha256: 'd9294f1afcd28299e08377af185f3a653e3c89d225437c3043898e129e9f743c'
  }
}

const platformKey = `${process.platform}-${process.arch}`
const assetConfig = assets[platformKey]
if (!assetConfig) {
  throw new Error(`No bundled llama-server build is configured for ${platformKey}.`)
}
const asset = assetConfig.name

if (existsSync(MARKER)) {
  const current = JSON.parse(await readFile(MARKER, 'utf8'))
  const binary = current.binaryRelativePath
    ? resolve(TARGET, current.binaryRelativePath)
    : undefined
  if (
    current.release === LLAMA_CPP_RELEASE &&
    current.sha256 === assetConfig.sha256 &&
    binary &&
    existsSync(binary)
  ) {
    process.stdout.write(`llama-server ${LLAMA_CPP_RELEASE} is already prepared.\n`)
    process.exit(0)
  }
}

const temp = await mkdtemp(join(tmpdir(), 'anodex-llama-server-'))
const archive = join(temp, asset)
const extracted = join(temp, 'extracted')
await mkdir(extracted, { recursive: true })

try {
  const url = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_RELEASE}/${asset}`
  process.stdout.write(`Downloading ${asset}...\n`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`llama.cpp download failed with HTTP ${response.status}.`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive))
  const digest = await sha256File(archive)
  if (digest !== assetConfig.sha256) {
    throw new Error(`llama.cpp archive checksum mismatch for ${asset}.`)
  }

  process.stdout.write('Extracting llama-server...\n')
  if (asset.endsWith('.zip')) {
    execFileSync('tar.exe', ['-xf', archive, '-C', extracted], { stdio: 'inherit' })
  } else {
    execFileSync('tar', ['-xzf', archive, '-C', extracted], { stdio: 'inherit' })
  }

  const binary = await findBinary(extracted)
  if (!binary) throw new Error(`The ${asset} archive did not contain llama-server.`)

  assertInsideResourceRoot(TARGET)
  await rm(TARGET, { recursive: true, force: true })
  await mkdir(RESOURCE_ROOT, { recursive: true })
  await rename(extracted, TARGET)
  const installedBinary = resolve(TARGET, relative(extracted, binary))
  await writeFile(
    MARKER,
    `${JSON.stringify(
      {
        release: LLAMA_CPP_RELEASE,
        asset,
        sha256: assetConfig.sha256,
        binaryRelativePath: relative(TARGET, installedBinary)
      },
      null,
      2
    )}\n`
  )
  process.stdout.write(`Prepared ${basename(installedBinary)} for ${platformKey}.\n`)
} finally {
  await rm(temp, { recursive: true, force: true })
}

async function findBinary(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = await findBinary(path)
      if (nested) return nested
    } else if (entry.name === 'llama-server' || entry.name.toLowerCase() === 'llama-server.exe') {
      return path
    }
  }
  return null
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function assertInsideResourceRoot(path) {
  const rootWithSeparator = RESOURCE_ROOT.endsWith(sep) ? RESOURCE_ROOT : `${RESOURCE_ROOT}${sep}`
  if (!path.startsWith(rootWithSeparator)) {
    throw new Error(`Refusing to replace an unsafe llama-server target: ${path}`)
  }
}
