import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const SOURCE = 'https://github.com/ServeurpersoCom/qwentts.cpp.git'
const REVISION = '6a3e91283220197bad2ae1eb40ae1c1392bfd820'
const ROOT = resolve(import.meta.dirname, '..')
const OUTPUT = join(ROOT, 'resources', 'speech-runtime', `${process.platform}-${process.arch}`)
const temporary = await mkdtemp(join(tmpdir(), 'anodex-speech-build-'))
const source = join(temporary, 'source')
const build = join(temporary, 'build')

function run(program, args, cwd = temporary) {
  execFileSync(program, args, { cwd, stdio: 'inherit' })
}

function replaceOnce(path, before, after) {
  const contents = readFileSync(path, 'utf8')
  const lineEnding = contents.includes('\r\n') ? '\r\n' : '\n'
  const sourceText = before.replaceAll('\n', lineEnding)
  if (!contents.includes(sourceText))
    throw new Error(`The pinned speech source changed near ${path}.`)
  return writeFile(path, contents.replace(sourceText, after.replaceAll('\n', lineEnding)))
}

try {
  run('git', ['clone', '--no-checkout', SOURCE, source])
  run('git', ['checkout', REVISION], source)
  run('git', ['submodule', 'update', '--init', '--recursive'], source)

  const serverHeader = join(source, 'src', 'tts-server.h')
  await replaceOnce(
    serverHeader,
    'struct server_config {\n    std::string host = "127.0.0.1";\n    int         port = 8080;\n};',
    'struct server_config {\n    std::string host = "127.0.0.1";\n    std::string api_key;\n    int         port = 8080;\n};'
  )
  await replaceOnce(
    serverHeader,
    '    // permissive CORS so a browser client can call the API directly.\n    svr.set_default_headers({',
    '    // Anodex keeps this service private to its main process. Every route, including health, requires a random key.\n    svr.set_pre_routing_handler([&cfg](const httplib::Request & req, httplib::Response & res) {\n        if (cfg.api_key.empty() || req.get_header_value("Authorization") != "Bearer " + cfg.api_key) {\n            tts_json_error(res, 401, "authentication_error", "unauthorized");\n            return httplib::Server::HandlerResponse::Handled;\n        }\n        return httplib::Server::HandlerResponse::Unhandled;\n    });\n\n    // Requests come only from Anodex main through the typed preload boundary.\n    svr.set_default_headers({'
  )
  const serverMain = join(source, 'tools', 'tts-server.cpp')
  await replaceOnce(
    serverMain,
    '        } else if (!std::strcmp(arg, "--port") && i + 1 < argc) {\n            cfg.port = std::atoi(argv[++i]);',
    '        } else if (!std::strcmp(arg, "--port") && i + 1 < argc) {\n            cfg.port = std::atoi(argv[++i]);\n        } else if (!std::strcmp(arg, "--api-key") && i + 1 < argc) {\n            cfg.api_key = argv[++i];'
  )

  run('cmake', [
    '-S',
    source,
    '-B',
    build,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DGGML_VULKAN=OFF',
    '-DGGML_CUDA=OFF',
    '-DGGML_METAL=OFF',
    '-DGGML_NATIVE=OFF',
    '-DGGML_OPENMP=OFF'
  ])
  run('cmake', ['--build', build, '--config', 'Release', '--target', 'tts-server', '--parallel'])

  const configurationDirectory = process.platform === 'win32' ? join(build, 'Release') : build
  const entries = await listFiles(configurationDirectory)
  const binaryName = process.platform === 'win32' ? 'tts-server.exe' : 'tts-server'
  const binarySource = entries.find((path) => basename(path) === binaryName)
  if (!binarySource) throw new Error(`Speech build did not produce ${binaryName}.`)
  const runtimeRoot = resolve(ROOT, 'resources', 'speech-runtime')
  if (!OUTPUT.startsWith(`${runtimeRoot}${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('Refusing to write the speech runtime outside its resources directory.')
  }
  await rm(OUTPUT, { recursive: true, force: true })
  await mkdir(OUTPUT, { recursive: true })
  for (const path of entries) {
    const name = basename(path)
    if (path === binarySource || /^(?:lib)?ggml[^/\\]*\.(?:dll|so(?:\.\d+)*|dylib)$/.test(name)) {
      await cp(path, join(OUTPUT, name))
    }
  }
  await cp(join(source, 'LICENSE'), join(OUTPUT, 'LICENSE-qwentts.txt'))
  await cp(join(source, 'ggml', 'LICENSE'), join(OUTPUT, 'LICENSE-ggml.txt'))
  await cp(join(source, 'vendor', 'cpp-httplib', 'LICENSE'), join(OUTPUT, 'LICENSE-httplib.txt'))
  await cp(
    join(ROOT, 'resources', 'speech-runtime', 'LICENSE-Qwen3-TTS.txt'),
    join(OUTPUT, 'LICENSE-Qwen3-TTS.txt')
  )
  await writeFile(
    join(OUTPUT, 'LICENSE-yyjson.txt'),
    `Copyright (c) 2020 YaoYuan <ibireme@gmail.com>\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n`
  )
  await writeFile(
    join(OUTPUT, '.release.json'),
    `${JSON.stringify({ revision: REVISION, binaryRelativePath: binaryName }, null, 2)}\n`
  )
  console.log(
    `Prepared local speech runtime in resources/speech-runtime/${process.platform}-${process.arch}.`
  )
} finally {
  const safeTemporary = resolve(temporary)
  if (safeTemporary.startsWith(resolve(tmpdir())))
    await rm(safeTemporary, { recursive: true, force: true })
}

async function listFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(path)))
    else if (entry.isFile()) files.push(path)
  }
  return files
}
