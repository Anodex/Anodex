// One-off: wait for a *new* Critical Thinking run to appear, then poll it to
// completion. `watch-ct-run.mjs` latches onto the newest stored run, which is
// still the previous finished one while a fresh run is starting -- so it
// reported an outcome for the wrong run and exited immediately.
import fs from 'node:fs'
import path from 'node:path'

const file = path.join(process.env.APPDATA, 'anodex', 'critical-thinking', 'runs.json')
const RUNNING = new Set([
  'running',
  'planning',
  'needs-review',
  'researching',
  'synthesizing',
  'validating',
  'repairing',
  'writing'
])

const read = () => {
  try {
    return Object.values(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(
      (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)
    )[0]
  } catch {
    return null
  }
}

const baseline = read()?.id ?? null
console.log(new Date().toISOString(), 'baseline run:', baseline)

let target = null
let last = ''
for (;;) {
  const run = read()
  if (run && run.id !== baseline) target = run
  if (!target) {
    await new Promise((r) => setTimeout(r, 10000))
    continue
  }
  const current = read()
  if (!current || current.id !== target.id) {
    await new Promise((r) => setTimeout(r, 10000))
    continue
  }
  if (current.status !== last) {
    const done = (current.steps ?? []).filter((s) => s.status === 'completed').length
    console.log(
      new Date().toISOString(),
      'status:',
      current.status,
      `| steps ${done}/${(current.steps ?? []).length}`,
      `| sources ${(current.sources ?? []).length}`
    )
    last = current.status
  }
  if (!RUNNING.has(current.status)) {
    console.log('RUN ID:', current.id)
    console.log('FINAL status:', current.status)
    break
  }
  await new Promise((r) => setTimeout(r, 20000))
}
