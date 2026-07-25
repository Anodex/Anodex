import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ModelReliabilityRecord } from '@shared/modelReliability.types'
import type { ModelSettingsRecommendation } from '@shared/model.types'
import type { HardwareInfo } from '@shared/system.types'
import { recommendModel } from '@shared/modelRecommendation'
import { CONTEXT_SIZE_LADDER, formatContextSizeLabel } from '@shared/contextSizes'
import { useModelStore } from '../../../../stores/modelStore'
import { useSettingsStore } from '../../../../stores/settingsStore'
import { useUiStore } from '../../../../stores/uiStore'
import { anodex } from '../../../../lib/anodex'
import { Button } from '../../../../components/ui/Button'
import { Icon } from '../../../../components/Icon'
import { SettingRow } from '../../SettingRow'
import { RangeControl, SelectControl } from '../../controls'
import { Spinner } from '../../../../components/ui/Spinner'
import { EnginePanel } from './EnginePanel'
import { HardwarePanel } from './HardwarePanel'
import { RecommendedModelStrip } from './RecommendedModelStrip'
import { DiscoverModelsPanel } from './DiscoverModelsPanel'
import { InstalledModelsList } from './InstalledModelsList'
import { CompatibilitySummary } from './CompatibilitySummary'
import { ProviderConnectionsPanel } from './ProviderConnectionsPanel'
import { ctxSizeWarning, scoreInstalledModel } from './scoring'
import styles from './AiModelsSettings.module.css'

const CONTEXT_OPTIONS = CONTEXT_SIZE_LADDER.map((tokens) => ({
  label: formatContextSizeLabel(tokens),
  value: String(tokens)
}))

const GPU_OPTIONS = [
  { label: 'Auto', value: 'auto' },
  { label: 'CPU only', value: 'cpu' },
  { label: 'Custom', value: 'custom' }
]

const TURN_TIME_LIMIT_MAX_MINUTES = 120
const TURN_TIME_LIMIT_COMMIT_DELAY_MS = 250

function formatTurnTimeLimit(value: number): string {
  return value === 0 ? 'No limit' : `${value} min`
}

/**
 * Wraps `RangeControl` with its own local drag state so the slider glides
 * smoothly and never depends on the settings round-trip mid-drag — binding
 * it directly to `settings.generation.turnTimeLimitMinutes` meant every
 * pixel of movement fired an IPC call + disk write, and the thumb could
 * visibly snap back if a stale response settled after a newer one. The
 * commit to the store is debounced so a whole drag gesture persists once,
 * on release, not once per pixel.
 */
function TurnTimeLimitSlider({
  value,
  onCommit
}: {
  value: number | null
  onCommit: (minutes: number | null) => void
}): JSX.Element {
  const [local, setLocal] = useState(value ?? 0)
  const commitTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    setLocal(value ?? 0)
  }, [value])

  useEffect(() => {
    return () => clearTimeout(commitTimer.current)
  }, [])

  return (
    <RangeControl
      value={local}
      min={0}
      max={TURN_TIME_LIMIT_MAX_MINUTES}
      step={1}
      format={formatTurnTimeLimit}
      onChange={(next) => {
        setLocal(next)
        clearTimeout(commitTimer.current)
        commitTimer.current = setTimeout(() => {
          onCommit(next === 0 ? null : next)
        }, TURN_TIME_LIMIT_COMMIT_DELAY_MS)
      }}
    />
  )
}

type AiModelsTab = 'models' | 'compatibility' | 'providers' | 'advanced'

const AI_MODEL_TABS: Array<{ id: AiModelsTab; label: string }> = [
  { id: 'models', label: 'Models' },
  { id: 'compatibility', label: 'Compatibility' },
  { id: 'providers', label: 'Providers' },
  { id: 'advanced', label: 'Advanced' }
]

/** Ceiling for the custom layer slider when the loaded model's real layer
 * count isn't known yet (nothing loaded, or a model just switched). Comfortably
 * covers even the largest local models (70B-class GGUFs typically have ~80-100
 * layers) without needing model-specific data to render the control at all. */
const FALLBACK_MAX_GPU_LAYERS = 128

/**
 * Model and provider control center — engine status, detected hardware, model
 * recommendations, downloaded models, providers, and generation defaults. Split across this
 * folder's files: this component just handles top-level state and layout,
 * with each panel and the scoring math in its own file (see `scoring.ts`).
 */
export function AiModelsSettings(): JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const models = useModelStore((s) => s.models)
  const refresh = useModelStore((s) => s.refresh)
  const addModel = useModelStore((s) => s.addModel)
  const engine = useModelStore((s) => s.engine)
  const unloadModel = useModelStore((s) => s.unloadModel)
  const loadModel = useModelStore((s) => s.loadModel)
  const lastModelPath = settings?.lastModelPath

  const [hardware, setHardware] = useState<HardwareInfo | null>(null)
  const [loadingHardware, setLoadingHardware] = useState(true)
  const [activeTab, setActiveTab] = useState<AiModelsTab>('models')
  const [search, setSearch] = useState('')
  const [reliability, setReliability] = useState<ModelReliabilityRecord[]>([])
  const [fileRecommendation, setFileRecommendation] = useState<ModelSettingsRecommendation | null>(
    null
  )
  const [recommendingFile, setRecommendingFile] = useState(false)

  const recommendation = hardware
    ? recommendModel({
        ramBytes: hardware.ramBytes,
        vramBytes: hardware.vramBytes,
        unified: hardware.unifiedMemory
      })
    : null

  const filteredModels = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return models
    return models.filter((model) => {
      const haystack = `${model.name} ${model.quant ?? ''} ${model.path}`.toLowerCase()
      return haystack.includes(query)
    })
  }, [models, search])

  const bestInstalled = useMemo(() => {
    if (!hardware || models.length === 0) return null
    return models.reduce(
      (best, model) => {
        const score = scoreInstalledModel(model, hardware).score
        return score > best.score ? { model, score } : best
      },
      { model: models[0], score: scoreInstalledModel(models[0], hardware).score }
    )
  }, [hardware, models])

  // Updating the setting alone doesn't retroactively change an already-
  // running session — the engine only picks up a new context size / GPU
  // layer count when the model is (re)loaded. Reload it here so "Apply"
  // actually takes effect immediately instead of only affecting the *next*
  // manual load. Skipped if nothing is loaded, or a reply is actively
  // streaming (reloading would silently cut it off).
  const reloadActiveModelIfSafe = useCallback((): void => {
    if (engine.status !== 'ready' || !engine.model) return
    if (engine.generating) {
      useUiStore.getState().notify({
        kind: 'info',
        title: 'Settings saved',
        message: 'Will apply next time this model loads — a reply is in progress right now.'
      })
      return
    }
    void loadModel(engine.model)
  }, [engine.status, engine.model, engine.generating, loadModel])

  const applyRecommendation = (): void => {
    if (!recommendation) return
    void update({
      model: {
        contextSize: recommendation.contextSize,
        gpuLayers: recommendation.gpuLayers,
        autoConfigured: true
      },
      generation: { maxTokens: recommendation.maxTokens }
    }).then(reloadActiveModelIfSafe)
  }

  // Reads the *loaded file's own* GGUF metadata rather than assuming a tier —
  // works identically for a catalog download or a model the user added
  // themselves. Only meaningful for local files, so it's gated on that below
  // (currently always true, but written so a future cloud model naturally
  // has nothing to analyze here instead of needing special-casing later).
  const recommendForLoadedModel = useCallback((): void => {
    if (!engine.model || engine.model.source !== 'local') return
    setRecommendingFile(true)
    setFileRecommendation(null)
    void anodex.models
      .recommendSettingsForFile(engine.model.path)
      .then((result) => {
        if (result.ok) setFileRecommendation(result.value)
      })
      .finally(() => setRecommendingFile(false))
  }, [engine.model])

  const applyFileRecommendation = (): void => {
    if (!fileRecommendation) return
    void update({
      model: {
        contextSize: fileRecommendation.contextSize,
        gpuLayers: fileRecommendation.gpuLayers,
        autoConfigured: true
      },
      generation: { maxTokens: fileRecommendation.maxTokens }
    }).then(reloadActiveModelIfSafe)
    setFileRecommendation(null)
  }

  // A recommendation is only valid for the file it was computed from —
  // clear it the moment the loaded model changes so switching models can
  // never show stale advice for a different file.
  useEffect(() => {
    setFileRecommendation(null)
  }, [engine.model?.path])

  const redetectHardware = useCallback((): void => {
    setLoadingHardware(true)
    void anodex.system
      .getHardwareInfo()
      .then(setHardware)
      .finally(() => setLoadingHardware(false))
  }, [])

  const loadReliability = useCallback((): void => {
    void anodex.models.getReliability().then((result) => {
      if (result.ok) setReliability(result.value)
    })
  }, [])

  const reliabilityByModelId = useMemo(
    () => new Map(reliability.map((record) => [record.modelId, record])),
    [reliability]
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    redetectHardware()
  }, [redetectHardware])

  useEffect(() => {
    loadReliability()
  }, [loadReliability])

  if (!settings) {
    return (
      <div className={styles.loading}>
        <Spinner size={20} />
      </div>
    )
  }

  const contextWasDownsized =
    engine.status === 'ready' &&
    !!engine.contextSize &&
    engine.contextSize < settings.model.contextSize
  const contextMemoryWarning = !!hardware && ctxSizeWarning(hardware, settings.model.contextSize)
  const effectiveContextSize =
    engine.status === 'ready' && engine.contextSize
      ? engine.contextSize
      : settings.model.contextSize

  const gpuMode =
    settings.model.gpuLayers === 'auto' ? 'auto' : settings.model.gpuLayers === 0 ? 'cpu' : 'custom'
  const gpuLayersMax = engine.gpuLayersTotal ?? FALLBACK_MAX_GPU_LAYERS
  // Real auto-detected split is the best starting point when switching to
  // Custom; only fall back to a guess if nothing has ever loaded yet.
  const customGpuLayersStart = engine.gpuLayersUsed ?? Math.round(gpuLayersMax / 2)

  return (
    <div className={styles.page}>
      <div className={styles.pageIntro}>
        <div>
          <p className={styles.eyebrow}>AI &amp; Connections</p>
          <h1 className={styles.pageTitle}>AI &amp; Models</h1>
          <p className={styles.pageDesc}>
            Choose what powers chat, manage local models, and tune performance when needed.
          </p>
        </div>
        <div className={styles.introActions}>
          <Button
            variant="ghost"
            size="sm"
            iconLeft={<Icon name="refresh" size={15} />}
            onClick={() => void refresh()}
          >
            Refresh models
          </Button>
          <Button
            variant="primary"
            size="sm"
            iconLeft={<Icon name="plus" size={15} />}
            onClick={() => void addModel()}
          >
            Add GGUF
          </Button>
        </div>
      </div>

      <div className={styles.modelTabs} role="tablist" aria-label="AI and model settings sections">
        {AI_MODEL_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? styles.modelTabActive : undefined}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'models' && (
        <div className={styles.tabPanel} role="tabpanel">
          <EnginePanel
            engine={engine}
            modelCount={models.length}
            contextSize={settings.model.contextSize}
            gpuLayers={settings.model.gpuLayers}
            fileRecommendation={fileRecommendation}
            recommendingFile={recommendingFile}
            onAddModel={() => void addModel()}
            onOpenModelsFolder={() => void anodex.settings.openModelsDir()}
            onUnload={() => void unloadModel()}
            onRecommendForModel={recommendForLoadedModel}
            onApplyFileRecommendation={applyFileRecommendation}
            onDismissFileRecommendation={() => setFileRecommendation(null)}
          />

          <RecommendedModelStrip
            hardware={hardware}
            loading={loadingHardware}
            recommendation={recommendation}
            installedModels={models}
            reliability={reliabilityByModelId}
          />

          <DiscoverModelsPanel installedModels={models} />

          <InstalledModelsList
            models={filteredModels}
            totalModels={models.length}
            hardware={hardware}
            search={search}
            lastModelPath={lastModelPath}
            bestInstalledId={bestInstalled?.model.id ?? null}
            reliability={reliabilityByModelId}
            onSearch={setSearch}
            onRefresh={() => {
              void refresh()
              loadReliability()
            }}
            onAddModel={() => void addModel()}
            onOpenModelsFolder={() => void anodex.settings.openModelsDir()}
          />
        </div>
      )}

      {activeTab === 'compatibility' && (
        <div className={styles.tabPanel} role="tabpanel">
          <HardwarePanel
            hardware={hardware}
            loading={loadingHardware}
            recommendation={recommendation}
            onApplyRecommendation={applyRecommendation}
            onRedetect={redetectHardware}
          />
          <CompatibilitySummary
            engine={engine}
            hardware={hardware}
            reliability={reliabilityByModelId}
          />
          <InstalledModelsList
            models={filteredModels}
            totalModels={models.length}
            hardware={hardware}
            search={search}
            lastModelPath={lastModelPath}
            bestInstalledId={bestInstalled?.model.id ?? null}
            reliability={reliabilityByModelId}
            onSearch={setSearch}
            onRefresh={() => {
              void refresh()
              loadReliability()
            }}
            onAddModel={() => void addModel()}
            onOpenModelsFolder={() => void anodex.settings.openModelsDir()}
          />
        </div>
      )}

      {activeTab === 'providers' && (
        <div className={styles.tabPanel} role="tabpanel">
          <ProviderConnectionsPanel
            settings={settings}
            activeModelName={engine.model?.name ?? null}
            onUpdate={update}
            onOpenModels={() => setActiveTab('models')}
          />
        </div>
      )}

      {activeTab === 'advanced' && (
        <div className={styles.tabPanel} role="tabpanel">
          <section className={styles.section}>
            <div className={styles.sectionTitleRow}>
              <div>
                <p className={styles.sectionKicker}>Model defaults</p>
                <h2 className={styles.sectionTitle}>Runtime settings</h2>
                <p className={styles.sectionDesc}>
                  Defaults used whenever Anodex loads a local model.
                </p>
              </div>
            </div>

            <div className={styles.defaultsPanel}>
              <SettingRow
                label="Context size"
                description="How much conversation and project context the model can consider at once."
                control={
                  <SelectControl
                    value={String(settings.model.contextSize)}
                    options={CONTEXT_OPTIONS}
                    onChange={(value) => void update({ model: { contextSize: Number(value) } })}
                  />
                }
              />
              {contextWasDownsized && (
                <div className={styles.engineInfo}>
                  Running at {engine.contextSize?.toLocaleString()} tokens — smaller than the
                  setting because the model or memory could not support the full value.
                </div>
              )}
              {!contextWasDownsized && engine.status === 'ready' && engine.contextSize && (
                <div className={styles.engineInfo}>
                  Running at {engine.contextSize.toLocaleString()} tokens
                </div>
              )}
              {contextMemoryWarning && (
                <div className={styles.ctxWarning}>
                  This context size may exceed available memory. Lower it if model loading fails.
                </div>
              )}
              {!contextWasDownsized &&
                !contextMemoryWarning &&
                settings.model.contextSize >= 32768 && (
                  <div className={styles.hintLine}>
                    <span className={styles.hintDot} />
                    Large sizes only help if the model itself was trained for a context this long —
                    check the model card.
                  </div>
                )}
              <SettingRow
                label="GPU acceleration"
                description="Offload model layers to the GPU when Anodex detects a supported device."
                control={
                  <SelectControl
                    value={gpuMode}
                    options={GPU_OPTIONS}
                    onChange={(value) => {
                      if (value === 'auto') void update({ model: { gpuLayers: 'auto' } })
                      else if (value === 'cpu') void update({ model: { gpuLayers: 0 } })
                      else void update({ model: { gpuLayers: customGpuLayersStart } })
                    }}
                  />
                }
              />
              {gpuMode === 'custom' && (
                <SettingRow
                  label="Layers on GPU"
                  description="Exact number of layers to offload. Higher uses more VRAM."
                  control={
                    <RangeControl
                      value={
                        typeof settings.model.gpuLayers === 'number' ? settings.model.gpuLayers : 0
                      }
                      min={0}
                      max={gpuLayersMax}
                      step={1}
                      onChange={(value) => void update({ model: { gpuLayers: value } })}
                    />
                  }
                />
              )}
              {engine.status === 'ready' &&
                engine.gpuLayersUsed !== undefined &&
                engine.gpuLayersTotal !== undefined && (
                  <div className={styles.hintLine}>
                    <span className={styles.hintDot} />
                    {gpuMode === 'auto' ? 'Auto is' : 'The loaded model is'} currently offloading{' '}
                    {engine.gpuLayersUsed} of {engine.gpuLayersTotal} layers to the GPU for this
                    model — a real, hardware-based number, not an estimate.
                  </div>
                )}
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionTitleRow}>
              <div>
                <p className={styles.sectionKicker}>Response defaults</p>
                <h2 className={styles.sectionTitle}>Response generation</h2>
                <p className={styles.sectionDesc}>
                  Sampling controls for local models and the reply-length ceiling used by every
                  provider.
                </p>
              </div>
            </div>

            <div className={styles.defaultsPanel}>
              <SettingRow
                label="Temperature"
                description="Local models only. Higher values vary wording and choices; lower values stay more focused."
                control={
                  <RangeControl
                    value={settings.generation.temperature}
                    min={0}
                    max={1.5}
                    step={0.05}
                    format={(value) => value.toFixed(2)}
                    onChange={(value) => void update({ generation: { temperature: value } })}
                  />
                }
              />
              <SettingRow
                label="Top-p"
                description="Local models only. Limits sampling to the most likely token choices."
                control={
                  <RangeControl
                    value={settings.generation.topP}
                    min={0}
                    max={1}
                    step={0.05}
                    format={(value) => value.toFixed(2)}
                    onChange={(value) => void update({ generation: { topP: value } })}
                  />
                }
              />
              <SettingRow
                label="Max response tokens"
                description="Requested upper bound for each reply. Local generations are automatically capped to the measured room left after instructions and tools; cloud providers use this value directly."
                control={
                  <RangeControl
                    value={Math.min(settings.generation.maxTokens, effectiveContextSize)}
                    min={128}
                    max={effectiveContextSize}
                    step={128}
                    onChange={(value) => void update({ generation: { maxTokens: value } })}
                  />
                }
              />
              <SettingRow
                label="Per-turn time limit"
                description="Wall-clock cap on a single reply, including all of its tool calls, before it's asked to wrap up and return partial work. Applies to chat and agent-run turns. Scheduled tasks and critical-thinking research keep their own fixed budgets."
                control={
                  <TurnTimeLimitSlider
                    value={settings.generation.turnTimeLimitMinutes}
                    onCommit={(minutes) =>
                      void update({ generation: { turnTimeLimitMinutes: minutes } })
                    }
                  />
                }
              />
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
