// One-off: poll the stored run until it leaves a running state, then print the
// outcome. Used to watch a Critical Thinking run without driving the GUI.
import fs from 'node:fs'
import path from 'node:path'

const file = path.join(process.env.APPDATA, 'anodex', 'critical-thinking', 'runs.json')
const RUNNING = new Set([
  'running',
  'planning',
  'researching',
  'synthesizing',
  'validating',
  'repairing',
  'writing'
])

const read = () =>
  Object.values(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(
    (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)
  )[0]

let last = ''
for (;;) {
  let run
  try {
    run = read()
  } catch {
    await new Promise((r) => setTimeout(r, 5000))
    continue
  }
  if (run.status !== last) {
    console.log(new Date().toISOString(), 'status:', run.status)
    last = run.status
  }
  if (!RUNNING.has(run.status)) {
    const d = run.synthesisDiagnostics ?? {}
    console.log('FINAL status:', run.status)
    console.log('report chars:', (run.report ?? '').length)
    console.log('selectedStage:', d.selectedStage, '| strategy:', d.strategy)
    console.log('steps:', run.steps.map((s) => s.status).join(', '))
    for (const a of d.attempts ?? []) {
      console.log(
        `  ${a.stage}: chars=${a.contentChars} valid=${a.valid} issues=${(a.issues ?? []).length}`
      )
      for (const issue of (a.issues ?? []).slice(0, 14))
        console.log(`      - ${issue.slice(0, 120)}`)
    }
    break
  }
  await new Promise((r) => setTimeout(r, 20000))
}
