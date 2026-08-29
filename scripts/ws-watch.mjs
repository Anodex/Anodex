// Wait for a *new* Workspace conversation to appear, then poll it until it
// goes quiet — the Workspace equivalent of `watch-ct-new-run.mjs`.
//
// Latching onto the newest stored conversation does not work: while a fresh
// run is starting, the newest stored one is still the previous finished run,
// so a watcher that latches reports the wrong run. This snapshots the ids that
// exist at startup and waits for one that is not among them.
//
// Usage:
//   node scripts/ws-watch.mjs            # wait for a new conversation, then poll
//   IDLE_MS=180000 node scripts/ws-watch.mjs
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(process.env.APPDATA, 'anodex', 'conversations')
const IDLE_MS = Number(process.env.IDLE_MS ?? 240_000)
const POLL_MS = 15_000

function readAll() {
  const out = new Map()
  for (const project of fs.readdirSync(ROOT)) {
    const dir = path.join(ROOT, project)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
        if (Array.isArray(data.messages)) out.set(`${project}/${file}`, data)
      } catch {
        // Being written right now.
      }
    }
  }
  return out
}

function summarise(key, data) {
  const calls = data.messages.flatMap((m) => m.toolCalls ?? [])
  const failed = calls.filter((c) => c.status === 'error')
  const steps = data.plan?.steps ?? []
  const done = steps.filter((s) => s.status === 'completed').length
  const lastAssistant = [...data.messages].reverse().find((m) => m.role === 'assistant')
  return {
    calls: calls.length,
    failed: failed.length,
    plan: steps.length ? `${done}/${steps.length}` : '-',
    messages: data.messages.length,
    chars: String(lastAssistant?.content ?? '').length,
    key
  }
}

const before = new Set(readAll().keys())
console.log(`watching for a new conversation (${before.size} already stored)...`)

let target = null
let lastChange = Date.now()
let previous = ''

const timer = setInterval(() => {
  const all = readAll()
  if (!target) {
    for (const key of all.keys()) {
      if (!before.has(key) && all.get(key).messages.length > 0) {
        target = key
        console.log(`\nnew conversation: ${key}\n  title: ${all.get(key).title ?? '(untitled)'}`)
        lastChange = Date.now()
        break
      }
    }
    if (!target) return
  }
  const data = all.get(target)
  if (!data) return
  const s = summarise(target, data)
  const line = `msgs ${s.messages}  calls ${s.calls}  failed ${s.failed}  plan ${s.plan}  lastReply ${s.chars} chars`
  if (line !== previous) {
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`)
    previous = line
    lastChange = Date.now()
  } else if (Date.now() - lastChange > IDLE_MS) {
    console.log(`\nquiet for ${Math.round(IDLE_MS / 1000)}s — stopping.`)
    clearInterval(timer)
  }
}, POLL_MS)
