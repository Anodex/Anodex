import { useEffect, useMemo, useState } from 'react'
import type {
  CriticalThinkingActivity,
  CriticalThinkingRun,
  CriticalThinkingStatus
} from '@shared/criticalThinking.types'
import type { Plan } from '@shared/plan.types'
import { Icon, type IconName } from '../../components/Icon'
import { Button } from '../../components/ui/Button'
import { Spinner } from '../../components/ui/Spinner'
import { formatRelativeTime } from '../../lib/time'
import { isChatReady } from '../../lib/chatReadiness'
import { useCriticalThinkingStore } from '../../stores/criticalThinkingStore'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUiStore } from '../../stores/uiStore'
import { CriticalThinkingReport } from './CriticalThinkingReport'
import styles from './CriticalThinkingView.module.css'

const STATUS_LABEL: Record<CriticalThinkingStatus, string> = {
  planning: 'Building plan',
  'needs-review': 'Plan review',
  researching: 'Researching',
  done: 'Complete',
  stopped: 'Stopped',
  error: 'Failed'
}

const STATUS_ICON: Record<CriticalThinkingStatus, IconName> = {
  planning: 'activity',
  'needs-review': 'eye',
  researching: 'search',
  done: 'check',
  stopped: 'stop',
  error: 'alert'
}

function clonePlan(plan: Plan): Plan {
  return { ...plan, steps: plan.steps.map((step) => ({ ...step })) }
}

function providerLabel(run: CriticalThinkingRun): string {
  if (run.provider === 'local') return 'Local model'
  if (run.provider === 'anthropic') return run.model ? `Claude · ${run.model}` : 'Claude'
  return run.model ? `OpenAI · ${run.model}` : 'OpenAI'
}

function StatusBadge({ status }: { status: CriticalThinkingStatus }): JSX.Element {
  const active = status === 'planning' || status === 'researching'
  return (
    <span className={`${styles.statusBadge} ${styles[`status-${status}`]}`}>
      {active ? <Spinner size={11} /> : <Icon name={STATUS_ICON[status]} size={11} />}
      {STATUS_LABEL[status]}
    </span>
  )
}

function PlanProgress({ plan }: { plan: Plan }): JSX.Element {
  return (
    <div className={styles.planProgress}>
      <p className={styles.cardEyebrow}>Research plan</p>
      <h3>{plan.title}</h3>
      <ol className={styles.progressSteps}>
        {plan.steps.map((step) => (
          <li key={step.id} className={styles[`step-${step.status}`]}>
            <span className={styles.stepIcon}>
              {step.status === 'completed' ? (
                <Icon name="check" size={12} />
              ) : step.status === 'in_progress' ? (
                <Spinner size={11} />
              ) : (
                <Icon name="circle" size={11} />
              )}
            </span>
            <span>{step.title}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function ActivityTimeline({ activities }: { activities: CriticalThinkingActivity[] }): JSX.Element {
  if (activities.length === 0) {
    return <p className={styles.activityEmpty}>Waiting for the first research action…</p>
  }
  return (
    <div className={styles.activityList}>
      {activities.map((activity) => (
        <div key={activity.id} className={styles.activityRow}>
          <span className={styles.activityIcon}>
            {activity.status === 'running' ? (
              <Spinner size={11} />
            ) : activity.status === 'success' ? (
              <Icon name="check" size={11} />
            ) : activity.status === 'error' ? (
              <Icon name="alert" size={11} />
            ) : (
              <Icon name="circle" size={11} />
            )}
          </span>
          <span className={styles.activityLabel}>{activity.label}</span>
          {activity.detail && <span className={styles.activityDetail}>{activity.detail}</span>}
        </div>
      ))}
    </div>
  )
}

export function CriticalThinkingView(): JSX.Element {
  const runs = useCriticalThinkingStore((state) => state.runs)
  const selectedId = useCriticalThinkingStore((state) => state.selectedId)
  const create = useCriticalThinkingStore((state) => state.create)
  const approve = useCriticalThinkingStore((state) => state.approve)
  const stop = useCriticalThinkingStore((state) => state.stop)
  const deleteRun = useCriticalThinkingStore((state) => state.delete)
  const select = useCriticalThinkingStore((state) => state.select)
  const settings = useSettingsStore((state) => state.settings)
  const engine = useModelStore((state) => state.engine)
  const openSettings = useUiStore((state) => state.openSettings)
  const notify = useUiStore((state) => state.notify)
  const selected = useMemo(
    () => runs.find((run) => run.id === selectedId) ?? null,
    [runs, selectedId]
  )
  const [question, setQuestion] = useState('')
  const [draftPlan, setDraftPlan] = useState<Plan | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setDraftPlan(selected?.plan ? clonePlan(selected.plan) : null)
    setCopied(false)
  }, [selected?.id, selected?.plan])

  const anotherRunActive = runs.some(
    (run) => run.status === 'planning' || run.status === 'researching'
  )
  const modelReady = isChatReady(settings, engine.status)
  const searchReady = Boolean(settings?.tools.enabled && settings.webSearch.provider !== 'none')
  const startBlocked = anotherRunActive || !modelReady || !searchReady

  const startResearchPlan = async (): Promise<void> => {
    if (!question.trim() || startBlocked) return
    setSubmitting(true)
    const run = await create(question)
    if (run) setQuestion('')
    setSubmitting(false)
  }

  const approvePlan = async (): Promise<void> => {
    if (!selected || !draftPlan || draftPlan.steps.every((step) => !step.title.trim())) return
    setSubmitting(true)
    await approve(selected.id, draftPlan)
    setSubmitting(false)
  }

  const updatePlanTitle = (title: string): void => {
    setDraftPlan((plan) => (plan ? { ...plan, title } : null))
  }

  const updatePlanStep = (index: number, title: string): void => {
    setDraftPlan((plan) =>
      plan
        ? {
            ...plan,
            steps: plan.steps.map((step, stepIndex) =>
              stepIndex === index ? { ...step, title } : step
            )
          }
        : null
    )
  }

  const removePlanStep = (index: number): void => {
    setDraftPlan((plan) =>
      plan && plan.steps.length > 1
        ? { ...plan, steps: plan.steps.filter((_, stepIndex) => stepIndex !== index) }
        : plan
    )
  }

  const addPlanStep = (): void => {
    setDraftPlan((plan) =>
      plan
        ? {
            ...plan,
            steps: [...plan.steps, { id: `draft_${Date.now()}`, title: '', status: 'pending' }]
          }
        : null
    )
  }

  const startNew = (seed = ''): void => {
    select(null)
    setQuestion(seed)
  }

  const copyReport = async (): Promise<void> => {
    if (!selected?.report) return
    await navigator.clipboard.writeText(selected.report)
    setCopied(true)
    notify({ kind: 'success', title: 'Report copied' })
    setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <div>
          <div className={styles.titleRow}>
            <Icon name="insight" size={24} className={styles.titleIcon} />
            <h1>Critical Thinking</h1>
          </div>
          <p>Plan, investigate, cross-check, and turn web evidence into a cited report.</p>
        </div>
        {selected && (
          <Button
            variant="primary"
            iconLeft={<Icon name="plus" size={15} />}
            onClick={() => startNew()}
            disabled={anotherRunActive}
          >
            New research
          </Button>
        )}
      </header>

      <div className={`${styles.layout} ${runs.length === 0 ? styles.layoutEmpty : ''}`}>
        {runs.length > 0 && (
          <aside className={styles.history} aria-label="Research history">
            <p className={styles.historyTitle}>Recent research</p>
            <div className={styles.historyList}>
              {runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  className={`${styles.historyItem} ${selectedId === run.id ? styles.historyItemActive : ''}`}
                  onClick={() => select(run.id)}
                >
                  <span className={styles.historyQuestion}>{run.question}</span>
                  <span className={styles.historyMeta}>
                    <StatusBadge status={run.status} />
                    <span>{formatRelativeTime(run.updatedAt)}</span>
                  </span>
                </button>
              ))}
            </div>
          </aside>
        )}

        <main className={styles.workspace}>
          {!selected ? (
            <section className={styles.startCard}>
              <div className={styles.startIcon}>
                <Icon name="insight" size={28} />
              </div>
              <h2>What should Anodex investigate?</h2>
              <p>
                Give it the outcome, timeframe, and constraints you care about. You’ll review the
                plan before any web research starts.
              </p>
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                    event.preventDefault()
                    void startResearchPlan()
                  }
                }}
                placeholder="Example: Compare the strongest evidence for and against a four-day workweek for a 50-person software company, focusing on productivity, retention, and implementation risk since 2022."
                rows={7}
                autoFocus
              />

              {!searchReady && (
                <div className={styles.setupNotice}>
                  <Icon name="web" size={16} />
                  <span>Critical Thinking needs a configured web search provider.</span>
                  <button type="button" onClick={() => openSettings('tools-skills')}>
                    Configure search
                  </button>
                </div>
              )}
              {searchReady && !modelReady && (
                <div className={styles.setupNotice}>
                  <Icon name="cpu" size={16} />
                  <span>Load a model or connect the selected cloud provider first.</span>
                  <button type="button" onClick={() => openSettings('ai-models')}>
                    Open models
                  </button>
                </div>
              )}
              {anotherRunActive && (
                <p className={styles.activeNotice}>
                  Finish or stop the active investigation first.
                </p>
              )}

              <div className={styles.startActions}>
                <span>Ctrl/⌘ + Enter</span>
                <Button
                  variant="primary"
                  iconLeft={<Icon name="search" size={15} />}
                  onClick={() => void startResearchPlan()}
                  loading={submitting}
                  disabled={!question.trim() || startBlocked}
                >
                  Create research plan
                </Button>
              </div>
            </section>
          ) : (
            <RunDetail
              run={selected}
              draftPlan={draftPlan}
              submitting={submitting}
              copied={copied}
              onUpdatePlanTitle={updatePlanTitle}
              onUpdatePlanStep={updatePlanStep}
              onRemovePlanStep={removePlanStep}
              onAddPlanStep={addPlanStep}
              onApprovePlan={() => void approvePlan()}
              onStop={() => void stop(selected.id)}
              onRetry={() => startNew(selected.question)}
              onDelete={() => void deleteRun(selected.id)}
              onCopy={() => void copyReport()}
            />
          )}
        </main>
      </div>
    </div>
  )
}

interface RunDetailProps {
  run: CriticalThinkingRun
  draftPlan: Plan | null
  submitting: boolean
  copied: boolean
  onUpdatePlanTitle: (title: string) => void
  onUpdatePlanStep: (index: number, title: string) => void
  onRemovePlanStep: (index: number) => void
  onAddPlanStep: () => void
  onApprovePlan: () => void
  onStop: () => void
  onRetry: () => void
  onDelete: () => void
  onCopy: () => void
}

function RunDetail(props: RunDetailProps): JSX.Element {
  const { run } = props
  const active = run.status === 'planning' || run.status === 'researching'
  return (
    <div className={styles.runDetail}>
      <div className={styles.runHeader}>
        <div className={styles.runHeading}>
          <StatusBadge status={run.status} />
          <h2>{run.question}</h2>
          <div className={styles.runMeta}>
            <span>{providerLabel(run)}</span>
            <span>{formatRelativeTime(run.updatedAt)}</span>
            {run.sources.length > 0 && <span>{run.sources.length} sources found</span>}
          </div>
        </div>
        <div className={styles.runActions}>
          {active && (
            <Button
              variant="secondary"
              iconLeft={<Icon name="stop" size={14} />}
              onClick={props.onStop}
            >
              Stop
            </Button>
          )}
          {!active && run.report && (
            <Button
              variant="secondary"
              iconLeft={<Icon name={props.copied ? 'check' : 'copy'} size={14} />}
              onClick={props.onCopy}
            >
              {props.copied ? 'Copied' : 'Copy report'}
            </Button>
          )}
          {!active && (
            <button
              className={styles.iconButton}
              type="button"
              onClick={props.onDelete}
              title="Delete research"
            >
              <Icon name="trash" size={15} />
            </button>
          )}
        </div>
      </div>

      {run.status === 'planning' && (
        <div className={styles.centerState}>
          <Spinner size={22} />
          <h3>Building an investigation plan</h3>
          <p>Anodex is breaking the question into evidence-gathering steps for your review.</p>
        </div>
      )}

      {run.status === 'needs-review' && props.draftPlan && (
        <section className={styles.planEditor}>
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.cardEyebrow}>Review before research</p>
              <h3>Edit the plan or start as written</h3>
            </div>
            <Icon name="pencil" size={18} />
          </div>
          <label>
            <span>Plan title</span>
            <input
              value={props.draftPlan.title}
              onChange={(event) => props.onUpdatePlanTitle(event.target.value)}
            />
          </label>
          <div className={styles.planStepEditor}>
            {props.draftPlan.steps.map((step, index) => (
              <div key={step.id} className={styles.planStepRow}>
                <span>{index + 1}</span>
                <input
                  value={step.title}
                  onChange={(event) => props.onUpdatePlanStep(index, event.target.value)}
                  aria-label={`Research step ${index + 1}`}
                />
                <button
                  type="button"
                  onClick={() => props.onRemovePlanStep(index)}
                  disabled={props.draftPlan!.steps.length === 1}
                  aria-label={`Remove step ${index + 1}`}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            ))}
          </div>
          <button type="button" className={styles.addStep} onClick={props.onAddPlanStep}>
            <Icon name="plus" size={13} /> Add step
          </button>
          <div className={styles.planApproval}>
            <p>
              Starting grants this run access only to web search and public-page reading. It cannot
              edit files, run commands, send email, or call connected MCP tools.
            </p>
            <Button
              variant="primary"
              iconLeft={<Icon name="search" size={15} />}
              onClick={props.onApprovePlan}
              loading={props.submitting}
              disabled={props.draftPlan.steps.every((step) => !step.title.trim())}
            >
              Start research
            </Button>
          </div>
        </section>
      )}

      {run.status === 'researching' && run.plan && (
        <>
          <div className={styles.progressGrid}>
            <PlanProgress plan={run.plan} />
            <div className={styles.activityCard}>
              <p className={styles.cardEyebrow}>Live activity</p>
              <ActivityTimeline activities={run.activities} />
            </div>
          </div>
          {run.report ? (
            <section className={styles.reportCard}>
              <div className={styles.writingLabel}>
                <Spinner size={12} /> Writing report
              </div>
              <CriticalThinkingReport report={run.report} />
            </section>
          ) : (
            <div className={styles.researchHint}>
              <Icon name="web" size={17} />
              <span>The report will appear here after Anodex finishes gathering evidence.</span>
            </div>
          )}
        </>
      )}

      {(run.status === 'done' || run.status === 'stopped') && run.report && (
        <>
          {run.status === 'stopped' && (
            <div className={styles.warningBanner}>
              <Icon name="stop" size={15} /> This is a partial report from a stopped investigation.
            </div>
          )}
          <section className={styles.reportCard}>
            <CriticalThinkingReport report={run.report} />
          </section>
          <Sources run={run} />
        </>
      )}

      {(run.status === 'error' || (run.status === 'stopped' && !run.report)) && (
        <div className={styles.failureState}>
          <Icon name={run.status === 'error' ? 'alert' : 'stop'} size={24} />
          <h3>
            {run.status === 'error' ? 'The investigation failed' : 'The investigation was stopped'}
          </h3>
          <p>{run.lastError ?? 'No report was produced.'}</p>
          <Button
            variant="secondary"
            iconLeft={<Icon name="refresh" size={14} />}
            onClick={props.onRetry}
          >
            Try again
          </Button>
        </div>
      )}
    </div>
  )
}

function Sources({ run }: { run: CriticalThinkingRun }): JSX.Element | null {
  if (run.sources.length === 0) return null
  return (
    <section className={styles.sourcesSection}>
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.cardEyebrow}>Evidence trail</p>
          <h3>Sources reviewed</h3>
        </div>
        <span className={styles.sourceCount}>{run.sources.length}</span>
      </div>
      <div className={styles.sourceGrid}>
        {run.sources.map((source) => (
          <a
            key={source.url}
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className={styles.sourceCard}
          >
            <span className={styles.sourceTitle}>{source.title}</span>
            {source.snippet && <span className={styles.sourceSnippet}>{source.snippet}</span>}
            <span className={styles.sourceHost}>{new URL(source.url).hostname}</span>
          </a>
        ))}
      </div>
    </section>
  )
}
