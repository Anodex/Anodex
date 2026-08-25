import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const LLAMA_CPP_RELEASE = 'b10549'
const ROOT = resolve(import.meta.dirname, '..')
const RESOURCE_ROOT = resolve(ROOT, 'resources', 'llama-server')
const TARGET = resolve(RESOURCE_ROOT, `${process.platform}-${process.arch}`)
const MARKER = join(TARGET, '.release.json')

const assets = {
  'win32-x64': {
    name: `llama-${LLAMA_CPP_RELEASE}-bin-win-vulkan-x64.zip`,
    sha256: '8e7b0e6382a5bcbf57c79cf54b61483e9f7b26561d4413f28095cdaee256207b'
  },
  'win32-arm64': {
    name: `llama-${LLAMA_CPP_RELEASE}-bin-win-cpu-arm64.zip`,
    sha256: '88453b6c9ca186885ac22b3505f5591381068d830ebc622a499af73a3607d8c2'
  },
  'darwin-arm64': {
    name: `llama-${LLAMA_CPP_RELEASE}-bin-macos-arm64.tar.gz`,
    sha256: '71e4b31afb020d6b71894eb8d1f2c0693038aec3f41f672f9fafb5055c8f2226'
  },
  'darwin-x64': {
    name: `llama-${LLAMA_CPP_RELEASE}-bin-macos-x64.tar.gz`,
    sha256: '94177680843a187881ae54021bbad8211c40797cab0df923ef17ee735e3ade09'
  },
  'linux-x64': {
    name: `llama-${LLAMA_CPP_RELEASE}-bin-ubuntu-vulkan-x64.tar.gz`,
    sha256: '7e3a48ce9d6445cc7296691c240ab75d417558be999716209eaa70a06170a6b3'
  },
  'linux-arm64': {
    name: `llama-${LLAMA_CPP_RELEASE}-bin-ubuntu-vulkan-arm64.tar.gz`,
    sha256: '9e8bd06b973a91625a5a27f5222c568dc6bf77ba091d2c781f0db74ba33c095d'
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
  await moveExtractedRuntime(extracted, TARGET)
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

/**
 * GitHub-hosted Windows runners keep the checkout and the temp directory on
 * different drives. `rename` cannot cross that boundary, so copy in that one
 * case; the temporary source is still removed by the outer `finally` block.
 */
async function moveExtractedRuntime(source, target) {
  try {
    await rename(source, target)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EXDEV') {
      throw error
    }
    await cp(source, target, { recursive: true })
  }
}

function assertInsideResourceRoot(path) {
  const rootWithSeparator = RESOURCE_ROOT.endsWith(sep) ? RESOURCE_ROOT : `${RESOURCE_ROOT}${sep}`
  if (!path.startsWith(rootWithSeparator)) {
    throw new Error(`Refusing to replace an unsafe llama-server target: ${path}`)
  }
}
