import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ModelReliabilityRecord } from '@shared/modelReliability.types'
import type { ModelSettingsRecommendation } from '@shared/model.types'
import type { HardwareInfo } from '@shared/system.types'
import { recommendModel } from '@shared/modelRecommendation'
import { CONTEXT_SIZE_LADDER, formatContextSizeLabel } from '@shared/contextSizes'
import { ANTHROPIC_MODELS } from '@shared/anthropicModels'
import { OPENAI_MODELS } from '@shared/openaiModels'
import { useModelStore } from '../../../../stores/modelStore'
import { useSettingsStore } from '../../../../stores/settingsStore'
import { useUiStore } from '../../../../stores/uiStore'
import { anodex } from '../../../../lib/anodex'
import { Button } from '../../../../components/ui/Button'
import { Icon } from '../../../../components/Icon'
import { SettingRow } from '../../SettingRow'
import { RangeControl, SelectControl, TextControl } from '../../controls'
import { Spinner } from '../../../../components/ui/Spinner'
import { EnginePanel } from './EnginePanel'
import { HardwarePanel } from './HardwarePanel'
import { RecommendedModelStrip } from './RecommendedModelStrip'
import { DiscoverModelsPanel } from './DiscoverModelsPanel'
import { InstalledModelsList } from './InstalledModelsList'
import { ApiKeyField } from './ApiKeyField'
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

const CHAT_PROVIDER_OPTIONS = [
  { label: 'Local model', value: 'local' },
  { label: 'Claude (Anthropic)', value: 'anthropic' },
  { label: 'ChatGPT / Codex (OpenAI)', value: 'openai' }
]

const ANTHROPIC_MODEL_OPTIONS = ANTHROPIC_MODELS.map((model) => ({
  label: model.label,
  value: model.id
}))

const OPENAI_MODEL_OPTIONS = OPENAI_MODELS.map((model) => ({
  label: model.label,
  value: model.id
}))

/**
 * Parse a daily-cap text field: empty clears the cap (`null`), a positive
 * integer sets it. Anything else (negative, zero, non-numeric) is treated as
 * not-yet-valid and ignored rather than committed, so a half-typed number
 * doesn't wipe out the field's own previous value mid-keystroke.
 */
function parseDailyCapInput(value: string): number | null | undefined {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined
}

/**
 * A daily-cap text field backed by local state, not the settings value
 * directly. `onCommit` persists over IPC, which is async — a plain
 * controlled input bound straight to `settings...dailyTokenCap` re-renders
 * with the still-stale value between keystrokes and drops fast typing (e.g.
 * typing "100" quickly leaves only "1" committed). Local state renders every
 * keystroke immediately; `value` only seeds it once, on mount, since nothing
 * else edits this field concurrently in a single-window desktop app.
 */
function DailyCapInput({
  value,
  onCommit
}: {
  value: number | null
  onCommit: (cap: number | null) => void
}): JSX.Element {
  const [text, setText] = useState(value?.toString() ?? '')
  return (
    <TextControl
      value={text}
      placeholder="No cap"
      onChange={(next) => {
        setText(next)
        const cap = parseDailyCapInput(next)
        if (cap !== undefined) onCommit(cap)
      }}
    />
  )
}

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
          <p className={styles.eyebrow}>AI & Models</p>
          <h1 className={styles.pageTitle}>Models & providers</h1>
          <p className={styles.pageDesc}>
            Manage the local engine, cloud providers, model recommendations, and response defaults.
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

      <HardwarePanel
        hardware={hardware}
        loading={loadingHardware}
        recommendation={recommendation}
        onApplyRecommendation={applyRecommendation}
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

      <section className={styles.section}>
        <div className={styles.sectionTitleRow}>
          <div>
            <p className={styles.sectionKicker}>Model defaults</p>
            <h2 className={styles.sectionTitle}>Runtime settings</h2>
            <p className={styles.sectionDesc}>Defaults used whenever Anodex loads a local model.</p>
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
              Running at {engine.contextSize?.toLocaleString()} tokens — smaller than the setting
              because the model or memory could not support the full value.
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
          {!contextWasDownsized && !contextMemoryWarning && settings.model.contextSize >= 32768 && (
            <div className={styles.hintLine}>
              <span className={styles.hintDot} />
              Large sizes only help if the model itself was trained for a context this long — check
              the model card.
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
                {engine.gpuLayersUsed} of {engine.gpuLayersTotal} layers to the GPU for this model —
                a real, hardware-based number, not an estimate.
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
            description="Upper bound for each reply across local, Anthropic, and OpenAI providers."
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
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitleRow}>
          <div>
            <p className={styles.sectionKicker}>Cloud models</p>
            <h2 className={styles.sectionTitle}>Claude &amp; ChatGPT / Codex</h2>
            <p className={styles.sectionDesc}>
              Anodex stays local-first by default. Switch to a cloud provider for chat replies when
              you want a larger model instead — your API key is stored locally, the same as the web
              search provider keys.
            </p>
          </div>
        </div>

        <div className={styles.defaultsPanel}>
          <SettingRow
            label="Chat provider"
            description="Which backend generates assistant replies."
            control={
              <SelectControl
                value={settings.provider.active}
                options={CHAT_PROVIDER_OPTIONS}
                onChange={(value) =>
                  void update({ provider: { active: value as 'local' | 'anthropic' | 'openai' } })
                }
              />
            }
          />
          {settings.provider.active === 'anthropic' && (
            <>
              <SettingRow
                label="API key"
                description="Your Anthropic API key, from your Anthropic Console account."
                control={
                  <ApiKeyField
                    provider="anthropic"
                    value={settings.provider.anthropic.apiKey}
                    model={settings.provider.anthropic.model}
                    placeholder="sk-ant-..."
                    onChange={(value) =>
                      void update({ provider: { anthropic: { apiKey: value } } })
                    }
                  />
                }
              />
              <SettingRow
                label="Model"
                description="Claude model used for chat generations."
                control={
                  <SelectControl
                    value={settings.provider.anthropic.model}
                    options={ANTHROPIC_MODEL_OPTIONS}
                    onChange={(value) => void update({ provider: { anthropic: { model: value } } })}
                  />
                }
              />
              <SettingRow
                label="Daily token cap"
                description="Optional self-imposed budget in tokens/day. Anodex warns when you're near or over it — it never blocks a message."
                control={
                  <DailyCapInput
                    value={settings.provider.anthropic.dailyTokenCap}
                    onCommit={(cap) =>
                      void update({ provider: { anthropic: { dailyTokenCap: cap } } })
                    }
                  />
                }
              />
              {!settings.provider.anthropic.apiKey.trim() && (
                <div className={styles.hintLine}>
                  <span className={styles.hintDot} />
                  Add an API key above to start chatting with Claude.
                </div>
              )}
            </>
          )}
          {settings.provider.active === 'openai' && (
            <>
              <SettingRow
                label="API key"
                description="Your OpenAI API key, from your OpenAI platform account."
                control={
                  <ApiKeyField
                    provider="openai"
                    value={settings.provider.openai.apiKey}
                    model={settings.provider.openai.model}
                    placeholder="sk-..."
                    onChange={(value) => void update({ provider: { openai: { apiKey: value } } })}
                  />
                }
              />
              <SettingRow
                label="Model"
                description="OpenAI model used for chat generations — including Codex, tuned for coding."
                control={
                  <SelectControl
                    value={settings.provider.openai.model}
                    options={OPENAI_MODEL_OPTIONS}
                    onChange={(value) => void update({ provider: { openai: { model: value } } })}
                  />
                }
              />
              <SettingRow
                label="Daily token cap"
                description="Optional self-imposed budget in tokens/day. Anodex warns when you're near or over it — it never blocks a message."
                control={
                  <DailyCapInput
                    value={settings.provider.openai.dailyTokenCap}
                    onCommit={(cap) =>
                      void update({ provider: { openai: { dailyTokenCap: cap } } })
                    }
                  />
                }
              />
              {!settings.provider.openai.apiKey.trim() && (
                <div className={styles.hintLine}>
                  <span className={styles.hintDot} />
                  Add an API key above to start chatting with ChatGPT / Codex.
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  )
}
