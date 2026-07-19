import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
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
import { anodex } from '../../lib/anodex'
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
  synthesizing: 'Writing report',
  validating: 'Validating',
  completed: 'Complete',
  partial: 'Partial',
  stopped: 'Stopped',
  failed: 'Failed'
}

const STATUS_ICON: Record<CriticalThinkingStatus, IconName> = {
  planning: 'activity',
  'needs-review': 'eye',
  researching: 'search',
  synthesizing: 'pencil',
  validating: 'check',
  completed: 'check',
  partial: 'alert',
  stopped: 'stop',
  failed: 'alert'
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
  const active = isActiveStatus(status)
  return (
    <span className={`${styles.statusBadge} ${styles[`status-${status}`]}`}>
      {active ? <Spinner size={11} /> : <Icon name={STATUS_ICON[status]} size={11} />}
      {STATUS_LABEL[status]}
    </span>
  )
}

function isActiveStatus(status: CriticalThinkingStatus): boolean {
  return (
    status === 'planning' ||
    status === 'researching' ||
    status === 'synthesizing' ||
    status === 'validating'
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

interface ReportSplitButtonProps {
  copied: boolean
  exportingPdf: boolean
  onCopy: () => void
  onExportPdf: () => void
}

function ReportSplitButton(props: ReportSplitButtonProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const pdfItemRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    pdfItemRef.current?.focus()

    const handlePointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
      toggleRef.current?.focus()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuOpen])

  return (
    <div className={styles.reportSplitButton} ref={rootRef}>
      <button
        type="button"
        className={styles.reportSplitMain}
        onClick={() => {
          setMenuOpen(false)
          props.onCopy()
        }}
        aria-label="Copy report"
      >
        <Icon name={props.copied ? 'check' : 'copy'} size={14} />
        <span>{props.copied ? 'Copied' : 'Copy report'}</span>
      </button>
      <button
        ref={toggleRef}
        type="button"
        className={styles.reportSplitToggle}
        onClick={() => setMenuOpen((open) => !open)}
        aria-label="Report export options"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={props.exportingPdf}
      >
        {props.exportingPdf ? <Spinner size={13} /> : <Icon name="chevron-down" size={13} />}
      </button>
      {menuOpen && (
        <div className={styles.reportExportMenu} role="menu" aria-label="Report export options">
          <button
            ref={pdfItemRef}
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false)
              props.onExportPdf()
            }}
          >
            <Icon name="download" size={14} />
            <span>Save as PDF</span>
          </button>
        </div>
      )}
    </div>
  )
}

export function CriticalThinkingView(): JSX.Element {
  const runs = useCriticalThinkingStore((state) => state.runs)
  const selectedId = useCriticalThinkingStore((state) => state.selectedId)
  const create = useCriticalThinkingStore((state) => state.create)
  const approve = useCriticalThinkingStore((state) => state.approve)
  const stop = useCriticalThinkingStore((state) => state.stop)
  const resume = useCriticalThinkingStore((state) => state.resume)
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
  const [exportingPdf, setExportingPdf] = useState(false)
  const reportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setDraftPlan(selected?.plan ? clonePlan(selected.plan) : null)
    setCopied(false)
  }, [selected?.id, selected?.plan])

  const anotherRunActive = runs.some((run) => isActiveStatus(run.status))
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

  const exportPdf = async (): Promise<void> => {
    if (!selected?.report || !reportRef.current || exportingPdf) return
    setExportingPdf(true)
    try {
      const result = await anodex.criticalThinking.exportPdf({
        question: selected.question,
        reportHtml: reportRef.current.innerHTML
      })
      if (!result.ok) {
        notify({ kind: 'error', title: 'PDF export failed', message: result.error.message })
        return
      }
      if (result.value) {
        notify({ kind: 'success', title: 'PDF report saved', message: result.value })
      }
    } catch {
      notify({ kind: 'error', title: 'PDF export failed', message: 'The export did not finish.' })
    } finally {
      setExportingPdf(false)
    }
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
              exportingPdf={exportingPdf}
              reportRef={reportRef}
              onUpdatePlanTitle={updatePlanTitle}
              onUpdatePlanStep={updatePlanStep}
              onRemovePlanStep={removePlanStep}
              onAddPlanStep={addPlanStep}
              onApprovePlan={() => void approvePlan()}
              onStop={() => void stop(selected.id)}
              onResume={() => void resume(selected.id)}
              onRetry={() => startNew(selected.question)}
              onDelete={() => void deleteRun(selected.id)}
              onCopy={() => void copyReport()}
              onExportPdf={() => void exportPdf()}
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
  exportingPdf: boolean
  reportRef: RefObject<HTMLDivElement>
  onUpdatePlanTitle: (title: string) => void
  onUpdatePlanStep: (index: number, title: string) => void
  onRemovePlanStep: (index: number) => void
  onAddPlanStep: () => void
  onApprovePlan: () => void
  onStop: () => void
  onResume: () => void
  onRetry: () => void
  onDelete: () => void
  onCopy: () => void
  onExportPdf: () => void
}

function RunDetail(props: RunDetailProps): JSX.Element {
  const { run } = props
  const active = isActiveStatus(run.status)
  const resumable = ['partial', 'stopped', 'failed'].includes(run.status) && Boolean(run.plan)
  const reportReady =
    run.status === 'completed' || run.status === 'partial' || run.status === 'stopped'
  return (
    <div className={styles.runDetail}>
      <div className={styles.runHeader}>
        <div className={styles.runHeading}>
          <StatusBadge status={run.status} />
          <h2>{run.question}</h2>
          <div className={styles.runMeta}>
            <span>{providerLabel(run)}</span>
            <span>{formatRelativeTime(run.updatedAt)}</span>
            {run.sources.some((source) => source.verified) && (
              <span>{run.sources.filter((source) => source.verified).length} pages verified</span>
            )}
            {run.evidenceCount > 0 && <span>{run.evidenceCount} evidence artifacts</span>}
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
            <ReportSplitButton
              copied={props.copied}
              exportingPdf={props.exportingPdf}
              onCopy={props.onCopy}
              onExportPdf={props.onExportPdf}
            />
          )}
          {!active && resumable && (
            <Button
              variant="secondary"
              iconLeft={<Icon name="refresh" size={14} />}
              onClick={props.onResume}
            >
              Resume
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

      {['researching', 'synthesizing', 'validating'].includes(run.status) && run.plan && (
        <>
          <div className={styles.progressGrid}>
            <PlanProgress plan={run.plan} />
            <div className={styles.activityCard}>
              <p className={styles.cardEyebrow}>Live activity</p>
              <ActivityTimeline activities={run.activities} />
            </div>
          </div>
          {(run.status === 'synthesizing' || run.status === 'validating') && run.report ? (
            <section className={styles.reportCard}>
              <div className={styles.writingLabel}>
                <Spinner size={12} /> Writing report
              </div>
              <div ref={props.reportRef}>
                <CriticalThinkingReport report={run.report} />
              </div>
            </section>
          ) : (
            <div className={styles.researchHint}>
              <Icon name="web" size={17} />
              <span>
                {run.status === 'researching'
                  ? `Researching step ${Math.min(run.currentStep + 1, run.steps.length)} of ${run.steps.length}. The report starts after evidence collection.`
                  : 'Preparing and validating the evidence-backed report.'}
              </span>
            </div>
          )}
        </>
      )}

      {reportReady && run.report && (
        <>
          {(run.status === 'stopped' || run.status === 'partial') && (
            <div className={styles.warningBanner}>
              <Icon name="alert" size={15} />{' '}
              {run.lastError ?? 'This report is based on partial research.'}
            </div>
          )}
          <section className={styles.reportCard}>
            <div ref={props.reportRef}>
              <CriticalThinkingReport report={run.report} />
            </div>
          </section>
          <Sources run={run} />
        </>
      )}

      {(run.status === 'failed' ||
        run.status === 'partial' ||
        (run.status === 'stopped' && !run.report)) &&
        !run.report && (
          <div className={styles.failureState}>
            <Icon name={run.status === 'failed' ? 'alert' : 'stop'} size={24} />
            <h3>
              {run.status === 'failed'
                ? 'The investigation failed'
                : 'The investigation is incomplete'}
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
  const verifiedSources = run.sources.filter((source) => source.verified)
  if (verifiedSources.length === 0) return null
  return (
    <section className={styles.sourcesSection}>
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.cardEyebrow}>Evidence trail</p>
          <h3>Sources reviewed</h3>
        </div>
        <span className={styles.sourceCount}>{verifiedSources.length}</span>
      </div>
      <div className={styles.sourceGrid}>
        {verifiedSources.map((source) => (
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
