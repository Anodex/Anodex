import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { agentRunProviderVendor } from '@shared/agentRunProviders'
import type {
  CriticalThinkingRun,
  CriticalThinkingStatus,
  CriticalThinkingStepState,
  CriticalThinkingTerminationReason
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
import { criticalThinkingAttention } from '../../lib/navigationBadges'
import { CriticalThinkingReport } from './CriticalThinkingReport'
import { CriticalThinkingProgress } from './CriticalThinkingProgress'
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

/**
 * Names the backend a run used. This tested local, then Anthropic, then fell
 * through to OpenAI - so a DeepSeek run read as "OpenAI - deepseek-v4-flash",
 * the wrong vendor stated confidently. Same defect, same fix, as the agent run
 * list's own `providerLabel`.
 */
function providerLabel(run: CriticalThinkingRun): string {
  if (run.provider === 'local') return 'Local model'
  const vendor = agentRunProviderVendor(run.provider)
  return run.model ? `${vendor} · ${run.model}` : vendor
}

function StatusBadge({
  status,
  hasReport
}: {
  status: CriticalThinkingStatus
  hasReport: boolean
}): JSX.Element {
  const active = isActiveStatus(status)
  const badge = terminalBadge(status, hasReport)
  return (
    <span className={`${styles.statusBadge} ${styles[badge.className]}`}>
      {active ? <Spinner size={11} /> : <Icon name={badge.icon} size={11} />}
      {badge.label}
    </span>
  )
}

/**
 * A finished run that produced a report is a success, never an alarm: a
 * "partial" run WITH a report just means research was bounded (paywalled or
 * unavailable sources, or a budget limit) — the per-area reasons are spelled
 * out in `ResearchOutcomeDetails`. Only a run with NO report keeps the alert
 * styling, so a good report never looks broken next to real failures.
 */
function terminalBadge(
  status: CriticalThinkingStatus,
  hasReport: boolean
): { label: string; icon: IconName; className: string } {
  if (status === 'partial') {
    return hasReport
      ? { label: 'Complete with gaps', icon: 'info', className: 'status-gaps' }
      : { label: 'Incomplete', icon: 'alert', className: 'status-failed' }
  }
  if (status === 'stopped') {
    return { label: 'Stopped', icon: 'stop', className: 'status-stopped' }
  }
  return { label: STATUS_LABEL[status], icon: STATUS_ICON[status], className: `status-${status}` }
}

function isActiveStatus(status: CriticalThinkingStatus): boolean {
  return (
    status === 'planning' ||
    status === 'researching' ||
    status === 'synthesizing' ||
    status === 'validating'
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
  /**
   * The seen marker as it was when this view opened.
   *
   * Opening Critical Thinking advances that marker straight away (it is what
   * clears the sidebar badge), so reading it live would dim every finished run
   * the instant you looked at the page — including the one you came here to
   * read. Frozen on mount, the list shows what was new when you arrived.
   */
  const seenAtNow = useUiStore((state) => state.navigationSeenAt?.['critical-thinking'] ?? 0)
  const seenAtOnOpen = useRef(seenAtNow).current
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

  /**
   * Seed the editable draft when the run being reviewed changes, or when its
   * plan first arrives — and at no other time.
   *
   * This used to depend on `selected?.plan` itself. Every `runsChanged`
   * broadcast replaces the whole `runs` array with freshly deserialized objects
   * (see `criticalThinkingStore.setRuns`), so that dependency changed identity
   * on every broadcast even when the plan was untouched, and reseeded the draft
   * from the server copy. While a plan sits in review the broadcasts do not
   * stop: a run in `needs-review` holds no lock, so a second investigation can
   * be started and running underneath, and its progress broadcasts arrive
   * roughly seven times a second. Every one of them threw away whatever the
   * reviewer had typed.
   *
   * Keyed on the id only while a plan exists, so a plan appearing (`null` → an
   * object, the planning-to-review transition) still seeds, and a plan merely
   * re-sent does not.
   */
  const planSeedKey = selected?.plan ? selected.id : null
  useEffect(() => {
    setDraftPlan(selected?.plan ? clonePlan(selected.plan) : null)
    setCopied(false)
    // `selected.plan` is deliberately not a dependency — see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, planSeedKey])

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
    try {
      await navigator.clipboard.writeText(selected.report)
    } catch (error) {
      // The clipboard can refuse — a denied permission, a window that is not
      // focused. This is called as `void copyReport()`, so a rejection used to
      // leave an unhandled rejection and a button that simply did nothing,
      // after a run that may have taken an hour to produce the text.
      notify({
        kind: 'error',
        title: 'Could not copy the report',
        message: error instanceof Error ? error.message : 'The clipboard refused the request.'
      })
      return
    }
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
              {runs.map((run) => {
                const attention = criticalThinkingAttention(run, seenAtOnOpen)
                return (
                  <button
                    key={run.id}
                    type="button"
                    className={[
                      styles.historyItem,
                      selectedId === run.id ? styles.historyItemActive : '',
                      attention ? styles.historyItemAttention : ''
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => select(run.id)}
                  >
                    <span className={styles.historyQuestion}>
                      {attention && (
                        <span
                          className={`${styles.historyDot} ${attention === 'review' ? styles.historyDotReview : ''}`}
                          aria-hidden="true"
                        />
                      )}
                      {run.question}
                    </span>
                    <span className={styles.historyMeta}>
                      <StatusBadge status={run.status} hasReport={Boolean(run.report)} />
                      <span>{formatRelativeTime(run.updatedAt)}</span>
                    </span>
                    {attention === 'review' && (
                      <span className={styles.srOnly}>Waiting for your review</span>
                    )}
                  </button>
                )
              })}
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

/**
 * True once, for the run whose first report text this component watched appear.
 *
 * A run spends minutes searching and reading before any of the answer exists,
 * and the transition from nothing to the opening paragraph is the moment the
 * answer starts being real — the same thinking-to-words handoff `MessageBubble`
 * marks in chat, at a much larger scale and once per run.
 *
 * Gated on witnessing the transition: opening a finished run, or switching to
 * one in the history list, starts from "already had a report" and flares
 * nothing. A report that was there before this mounted was not an arrival.
 */
function useReportFirstLight(runId: string, hasReport: boolean): boolean {
  const [flared, setFlared] = useState(false)
  const watching = useRef<{ runId: string; hadReport: boolean } | null>(null)

  useEffect(() => {
    const previous = watching.current
    watching.current = { runId, hadReport: hasReport }
    // A different run is a fresh observation, never an arrival on its own.
    if (previous === null || previous.runId !== runId) {
      setFlared(false)
      return
    }
    if (!previous.hadReport && hasReport) setFlared(true)
  }, [runId, hasReport])

  return flared
}

function RunDetail(props: RunDetailProps): JSX.Element {
  const { run } = props
  const firstLight = useReportFirstLight(run.id, Boolean(run.report))
  const active = isActiveStatus(run.status)
  // A run that stopped on the lifetime evidence ceiling used to have Resume
  // hidden, and rightly so: the ceiling counted everything the investigation
  // had ever fetched, so resuming re-limited the step immediately and gathered
  // nothing. A resume now rebases that allowance, so the button does what it
  // says again and hiding it would strand exactly the runs that need it.
  const resumable = ['partial', 'stopped', 'failed'].includes(run.status) && Boolean(run.plan)
  const reportReady =
    run.status === 'completed' || run.status === 'partial' || run.status === 'stopped'
  return (
    <div className={styles.runDetail}>
      <div className={styles.runHeader}>
        <div className={styles.runHeading}>
          <StatusBadge status={run.status} hasReport={Boolean(run.report)} />
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
          <CriticalThinkingProgress run={run} />
          {(run.status === 'synthesizing' || run.status === 'validating') && run.report ? (
            <section
              className={`${styles.reportCard} ${firstLight ? styles.reportFirstLight : ''}`}
            >
              <div className={styles.writingLabel}>
                <Spinner size={12} /> Writing report
              </div>
              <div ref={props.reportRef}>
                <CriticalThinkingReport report={run.report} />
              </div>
            </section>
          ) : null}
        </>
      )}

      {!isActiveStatus(run.status) && <ResearchOutcomeDetails run={run} />}

      {reportReady && run.report && (
        <>
          {(run.status === 'stopped' || run.status === 'partial') && (
            <div className={styles.noticeBanner}>
              <Icon name="info" size={15} />
              <span>
                {run.lastError ?? 'This report covers the areas where sources were available.'} The
                reason each remaining area is incomplete is noted above.
              </span>
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
            {resumable && (
              <Button
                variant="secondary"
                iconLeft={<Icon name="refresh" size={14} />}
                onClick={props.onRetry}
              >
                Try again
              </Button>
            )}
          </div>
        )}
    </div>
  )
}

function ResearchOutcomeDetails({ run }: { run: CriticalThinkingRun }): JSX.Element | null {
  // Any area that didn't fully complete, or that completed but still noted open
  // questions — each shown with a plain-language reason so the gap is
  // understandable, not just marked.
  const incompleteSteps = run.steps.filter(
    (step) => step.status !== 'completed' || step.uncertainties.length > 0
  )
  if (incompleteSteps.length === 0) return null

  return (
    <section className={styles.limitDetails} aria-label="Why some areas are incomplete">
      <p className={styles.cardEyebrow}>Why some areas are incomplete</p>
      <ul>
        {incompleteSteps.map((step) => {
          const reason = gapReason(step)
          return (
            <li key={step.id}>
              <span className={styles.limitStepTitle}>{step.title}</span>
              {reason && <span className={styles.limitReason}>{reason}</span>}
              {step.uncertainties.length > 0 && (
                <span className={styles.limitGaps}>
                  Still missing: {step.uncertainties.slice(0, 3).join(' · ')}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** The plain-language "why" for one incomplete area, or null if it merely noted open questions. */
function gapReason(step: CriticalThinkingStepState): string | null {
  if (step.terminationReason) return stopReasonLabel(step.terminationReason)
  if (step.status !== 'completed') {
    return 'This area was not reached before the run ended — Resume to research it.'
  }
  return null
}

/** Plain-language cause a user can act on, not the internal budget/limit name. */
function stopReasonLabel(reason: CriticalThinkingTerminationReason): string {
  const labels: Record<CriticalThinkingTerminationReason, string> = {
    user: 'You stopped the run here.',
    'loop-guard': 'Stopped to avoid repeating the same searches.',
    'context-limit': "The model's context limit was reached while working this area.",
    'context-shift-limit': "The model's context limit was reached while working this area.",
    'fixed-context-limit': "The model's context limit was reached while working this area.",
    'token-limit': "The model's output limit was reached while working this area.",
    'rounds-exhausted': 'Reached the research-round budget here — Resume to keep looking.',
    'time-limit': 'Reached the time budget here — Resume to keep looking.',
    'tool-limit': 'Reached the search and page-reading budget here — Resume to keep looking.',
    'evidence-limit': "Reached this run's overall verified-source limit.",
    'no-progress':
      'Searches found no open, readable source with this data — the specifics may be paywalled or unpublished.',
    'tool-call-truncated':
      'The model kept getting cut off part-way through a search or page read, so it never ran.',
    'runtime-stalled':
      'The local runtime stopped running the model here — reload the model, then Resume.',
    'provider-error': 'The model provider failed here — Resume to pick this area back up.',
    yielded: 'Saved progress here to continue later.'
  }
  return labels[reason]
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
            <span className={styles.sourceHost}>{safeHostname(source.url)}</span>
          </a>
        ))}
      </div>
    </section>
  )
}

function safeHostname(value: string): string {
  try {
    return new URL(value).hostname
  } catch {
    return value.length > 80 ? `${value.slice(0, 79)}…` : value
  }
}
