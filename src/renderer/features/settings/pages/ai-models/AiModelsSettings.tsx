import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ModelReliabilityRecord } from '@shared/modelReliability.types'
import type { ModelSettingsRecommendation } from '@shared/model.types'
import type { HardwareInfo } from '@shared/system.types'
import type { ModelSettings } from '@shared/settings.types'
import { recommendModel } from '@shared/modelRecommendation'
import { CONTEXT_SIZE_LADDER, formatContextSizeLabel } from '@shared/contextSizes'
import { describeWorkingRoom } from '@shared/workingRoom'
import { contextSizeUpdate } from './contextSizeUpdate'
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
import { LoadRefusalCallout } from './LoadRefusalCallout'
import { HardwarePanel } from './HardwarePanel'
import { RecommendedModelStrip } from './RecommendedModelStrip'
import { DiscoverModelsPanel } from './DiscoverModelsPanel'
import { InstalledModelsList } from './InstalledModelsList'
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

const CONTEXT_ASSEMBLY_OPTIONS = [
  { label: 'Current (baseline)', value: 'current' },
  { label: 'Adaptive v1 (experimental)', value: 'adaptive-v1' }
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

/**
 * Local | Cloud | Advanced.
 *
 * "Models" and "Providers" named the implementation, not the choice: a user
 * picking between a GGUF on disk and an API key is choosing local or cloud, and
 * the two belong side by side because they are one decision.
 *
 * The former Compatibility tab is gone. Two of its three panels were already
 * elsewhere -- `InstalledModelsList` was rendered identically under Models, and
 * `CompatibilitySummary` re-scored the active model that `EnginePanel` and the
 * per-row reliability column already speak to. What was worth keeping is
 * `HardwarePanel`, which has moved to Local directly above the recommendations
 * it explains.
 */
type AiModelsTab = 'local' | 'cloud' | 'advanced'

const AI_MODEL_TABS: Array<{ id: AiModelsTab; label: string }> = [
  { id: 'local', label: 'Local' },
  { id: 'cloud', label: 'Cloud' },
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
  const dismissLoadRefusal = useModelStore((s) => s.dismissLoadRefusal)
  const lastModelPath = settings?.lastModelPath

  const [hardware, setHardware] = useState<HardwareInfo | null>(null)
  const [loadingHardware, setLoadingHardware] = useState(true)
  const [activeTab, setActiveTab] = useState<AiModelsTab>('local')
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

  /**
   * The model a runtime-settings change applies to: the loaded one, or — when
   * the last attempt didn't take — the model that attempt was for.
   *
   * A pending refusal wins over the loaded model because it is the more recent
   * intent. Refused loading Y while X is loaded, then lowering the context, is
   * a request to retry Y, not to reload X at the new size.
   */
  const settingsReloadTarget = engine.refusedLoad?.model ?? engine.model

  /**
   * Updating a setting alone doesn't retroactively change a running session —
   * the engine only picks up a new context size / GPU layer count when the
   * model is (re)loaded. Reload here so saving actually takes effect now
   * instead of only affecting the *next* manual load.
   *
   * Deliberately fires even when nothing is currently loaded. This used to bail
   * on `status !== 'ready'`, which left the most important case dead: after a
   * load was refused or failed, the message tells the user to lower the context
   * size or switch to CPU-only — and then doing exactly that was ignored,
   * leaving them to work out for themselves that they also had to go and
   * re-click Load. Adjusting a setting after a failed load *is* the retry.
   *
   * Skipped only while a load is already in flight (a second one just throws
   * `Another model is already loading`) or while a reply is streaming, which a
   * reload would silently cut off.
   */
  const reloadActiveModelIfSafe = useCallback((): void => {
    if (!settingsReloadTarget || engine.status === 'loading') return
    if (engine.generating) {
      useUiStore.getState().notify({
        kind: 'info',
        title: 'Settings saved',
        message: 'Will apply next time this model loads — a reply is in progress right now.'
      })
      return
    }
    void loadModel(settingsReloadTarget)
  }, [settingsReloadTarget, engine.status, engine.generating, loadModel])

  // The refusal callout's explicit "Try again". Same target and same busy
  // guards as a settings change, but the user clicked a button rather than
  // changing a value, so a refusal to act now needs saying out loud.
  const retryRefusedLoad = useCallback((): void => {
    const refused = engine.refusedLoad
    if (!refused) return
    if (engine.status === 'loading' || engine.generating) {
      useUiStore.getState().notify({
        kind: 'info',
        title: 'Engine is busy',
        message: engine.generating
          ? 'Wait for the current reply to finish, then try again.'
          : 'A model is already loading.'
      })
      return
    }
    void loadModel(refused.model)
  }, [engine.refusedLoad, engine.status, engine.generating, loadModel])

  /**
   * Save a deliberately chosen context size.
   *
   * Recorded against the loaded model as well as globally: a size is only ever
   * meaningful for the model it was chosen for, and without the per-model entry
   * this number silently followed the *next* model into the engine — see
   * `resolveModelContextSize`. Writing both keeps the global default in step
   * with the visible control while the running model keeps its own size.
   */
  const saveContextSize = (patch: Partial<ModelSettings> & { contextSize: number }): void => {
    const activePath = engine.model?.source === 'local' ? engine.model.path : null
    void update(contextSizeUpdate(patch, activePath)).then(reloadActiveModelIfSafe)
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
    saveContextSize({
      contextSize: fileRecommendation.contextSize,
      gpuLayers: fileRecommendation.gpuLayers,
      autoConfigured: true
    })
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
  // A context size is not working room: the reply reserve, project context and
  // tool schemas come off the top first. At 8,192 that leaves about 4,750
  // tokens, which decided whether a small model could work at all - see
  // `describeWorkingRoom`. Shown, never enforced.
  const workingRoom = describeWorkingRoom(settings.model.contextSize)
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

      {/* Above the sub-tabs on purpose: a refusal can be provoked from Local
          (loading a model) or from Advanced (changing the context size, which
          reloads the active model), so it must not be tied to either. */}
      <LoadRefusalCallout
        engine={engine}
        onRetry={retryRefusedLoad}
        onDismiss={dismissLoadRefusal}
      />

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

      {activeTab === 'local' && (
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

          {/* Directly above the recommendations, because it is what makes
              "best models for this computer" mean anything. Moved here from
              the removed Compatibility tab. */}
          <HardwarePanel
            hardware={hardware}
            loading={loadingHardware}
            onRedetect={redetectHardware}
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

      {activeTab === 'cloud' && (
        <div className={styles.tabPanel} role="tabpanel">
          <ProviderConnectionsPanel
            settings={settings}
            activeModelName={engine.model?.name ?? null}
            onUpdate={update}
            onOpenModels={() => setActiveTab('local')}
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
                    onChange={(value) => saveContextSize({ contextSize: Number(value) })}
                  />
                }
              />
              <div className={styles.engineInfo}>{workingRoom.text}</div>
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
                      const gpuLayers =
                        value === 'auto' ? 'auto' : value === 'cpu' ? 0 : customGpuLayersStart
                      void update({ model: { gpuLayers } }).then(reloadActiveModelIfSafe)
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
                      // Only once the slider is released: a reload per
                      // intermediate value would restart the model on every
                      // pixel of the drag.
                      onCommit={reloadActiveModelIfSafe}
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
              <SettingRow
                label="Context assembly"
                description="Current keeps the established projection path. Adaptive v1 gives workspace context, memory, and past-chat recall one shared budget based on the active model's context window; it never disables your tools, skills, or instructions."
                control={
                  <SelectControl
                    value={settings.generation.contextAssemblyStrategy}
                    options={CONTEXT_ASSEMBLY_OPTIONS}
                    onChange={(value) =>
                      void update({
                        generation: {
                          contextAssemblyStrategy: value as 'current' | 'adaptive-v1'
                        }
                      })
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
