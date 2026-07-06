import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ModelInfo } from '@shared/model.types'
import type { HardwareInfo } from '@shared/system.types'
import type { ModelReliabilityRecord } from '@shared/modelReliability.types'
import { computeReliabilityScore } from '@shared/modelReliability.types'
import { inferModelFamily } from '@shared/recommendedModels'
import { useModelStore } from '../../../../stores/modelStore'
import { formatBytes } from '../../../../lib/format'
import { Button } from '../../../../components/ui/Button'
import { Icon } from '../../../../components/Icon'
import { ModelLogo } from '../../../../components/ModelLogo'
import { basename, scoreInstalledModel, type InstalledModelScore } from './scoring'
import styles from './AiModelsSettings.module.css'

/** Every downloaded model, each with a hardware-fit score and a usage-based reliability score. */
export function InstalledModelsList({
  models,
  totalModels,
  hardware,
  search,
  lastModelPath,
  bestInstalledId,
  reliability,
  onSearch,
  onRefresh,
  onAddModel,
  onOpenModelsFolder
}: {
  models: ModelInfo[]
  totalModels: number
  hardware: HardwareInfo | null
  search: string
  lastModelPath?: string
  bestInstalledId: string | null
  reliability: Map<string, ModelReliabilityRecord>
  onSearch: (value: string) => void
  onRefresh: () => void
  onAddModel: () => void
  onOpenModelsFolder: () => void
}): JSX.Element {
  return (
    <section className={styles.sectionFlush}>
      <div className={styles.sectionTitleRow}>
        <div>
          <p className={styles.sectionKicker}>Installed</p>
          <h2 className={styles.sectionTitle}>Downloaded models</h2>
          <p className={styles.sectionDesc}>
            Downloaded models are scored so the user knows which one is best for this machine.
          </p>
        </div>
      </div>

      <div className={styles.modelToolbar}>
        <label className={styles.searchBox}>
          <Icon name="search" size={14} />
          <input
            value={search}
            placeholder="Search installed models..."
            onChange={(event) => onSearch(event.target.value)}
          />
        </label>
        <div className={styles.toolbarActions}>
          <Button
            variant="ghost"
            size="sm"
            iconLeft={<Icon name="refresh" size={14} />}
            onClick={onRefresh}
          >
            Refresh
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconLeft={<Icon name="folder" size={14} />}
            onClick={onOpenModelsFolder}
          >
            Folder
          </Button>
          <Button
            variant="primary"
            size="sm"
            iconLeft={<Icon name="plus" size={14} />}
            onClick={onAddModel}
          >
            Add GGUF
          </Button>
        </div>
      </div>

      {totalModels === 0 ? (
        <div className={styles.empty}>
          <Icon name="models" size={28} />
          <p className={styles.emptyTitle}>No local models yet</p>
          <p className={styles.emptyText}>
            Add a <code>.gguf</code> file, or download one of the recommended models above.
          </p>
        </div>
      ) : models.length === 0 ? (
        <div className={styles.empty}>
          <Icon name="search" size={28} />
          <p className={styles.emptyTitle}>No models match that search</p>
          <p className={styles.emptyText}>Clear the search field to show all installed models.</p>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.modelTable}>
            <colgroup>
              <col style={{ width: '34%' }} />
              <col style={{ width: '18%' }} />
              <col style={{ width: '18%' }} />
              <col style={{ width: '16%' }} />
              <col style={{ width: '14%' }} />
            </colgroup>
            <thead>
              <tr>
                <th>Model</th>
                <th>Fit</th>
                <th>Reliability</th>
                <th>Size</th>
                <th className={styles.actionCell}>Status</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => (
                <InstalledModelRow
                  key={model.id}
                  model={model}
                  hardware={hardware}
                  isLast={model.path === lastModelPath}
                  isBest={model.id === bestInstalledId}
                  reliability={reliability.get(model.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function InstalledModelRow({
  model,
  hardware,
  isLast,
  isBest,
  reliability
}: {
  model: ModelInfo
  hardware: HardwareInfo | null
  isLast: boolean
  isBest: boolean
  reliability: ModelReliabilityRecord | undefined
}): JSX.Element {
  const engine = useModelStore((s) => s.engine)
  const pendingPath = useModelStore((s) => s.pendingPath)
  const loadModel = useModelStore((s) => s.loadModel)
  const unloadModel = useModelStore((s) => s.unloadModel)

  const isCurrent = engine.model?.path === model.path
  const isReady = isCurrent && engine.status === 'ready'
  const isLoadingThis = pendingPath === model.path || (isCurrent && engine.status === 'loading')
  const otherBusy = pendingPath !== null && pendingPath !== model.path
  const score = hardware ? scoreInstalledModel(model, hardware) : null

  return (
    <tr className={isReady ? styles.activeRow : undefined}>
      <td>
        <div className={styles.modelIdentity}>
          <span className={styles.modelIcon}>
            <ModelLogo family={inferModelFamily(model.name)} size={16} />
          </span>
          <div className={styles.modelNameBlock}>
            <div className={styles.modelName} title={model.name}>
              {model.name}
            </div>
            <div className={styles.modelPath} title={model.path}>
              {basename(model.path)}
            </div>
          </div>
        </div>
      </td>
      <td>
        {score ? (
          <ScoreStack
            score={score.score}
            note={isBest ? 'Best installed' : score.note}
            fit={score.fit}
          />
        ) : (
          <span className={styles.muted}>Detecting…</span>
        )}
      </td>
      <td>
        <ReliabilityCell record={reliability} />
      </td>
      <td>
        <div className={styles.sizeCell}>
          <span>{formatBytes(model.sizeBytes)}</span>
          {model.quant ? (
            <span className={styles.quant}>{model.quant}</span>
          ) : (
            <span className={styles.muted}>Unknown quant</span>
          )}
        </div>
      </td>
      <td className={styles.actionCell}>
        <div className={styles.statusActionCell}>
          {isReady && (
            <span className={styles.loadedBadge}>
              <span className={styles.loadedDot} />
              Loaded
            </span>
          )}
          {!isReady && isLast && <span className={styles.lastTag}>Last used</span>}
          {isReady ? (
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<Icon name="power" size={14} />}
              onClick={() => void unloadModel()}
            >
              Unload
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              loading={isLoadingThis}
              disabled={otherBusy}
              onClick={() => void loadModel(model)}
            >
              {isLoadingThis ? 'Loading…' : 'Load'}
            </Button>
          )}
        </div>
      </td>
    </tr>
  )
}

function ScoreStack({
  score,
  note,
  fit
}: {
  score: number
  note: string
  fit?: InstalledModelScore['fit']
}): JSX.Element {
  return (
    <div className={styles.scoreStack}>
      <div className={styles.scoreMain}>
        <strong>{score}</strong>
        <span>/100</span>
      </div>
      <div className={styles.scoreTrack}>
        <div
          className={`${styles.scoreFill} ${score < 80 ? styles.scoreFillWarn : ''}`}
          style={{ width: `${score}%` }}
        />
      </div>
      <div className={`${styles.scoreNote} ${fit ? styles[`fit${fit}`] : ''}`}>{note}</div>
    </div>
  )
}

/**
 * Usage-based reliability score, distinct from the hardware-fit score — a
 * model can be a great fit and still be unreliable at actually finishing
 * tasks. Hovering shows the per-tool breakdown behind the number, so a poor
 * score is explainable rather than just a number to distrust blindly.
 * Positioned via a portal (not CSS `position: absolute` in place) because the
 * settings modal only allows vertical scrolling — an in-place popover would
 * get clipped by the table's own row/cell overflow rather than sitting above
 * everything else.
 */
function ReliabilityCell({ record }: { record: ModelReliabilityRecord | undefined }): JSX.Element {
  const anchorRef = useRef<HTMLDivElement>(null)
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null)
  const score = computeReliabilityScore(record)
  const toolEntries = record ? Object.entries(record.byTool) : []

  const showPopover = (): void => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (rect) setPopoverPos({ top: rect.bottom + 6, left: rect.left })
  }

  if (score === null) {
    return <span className={styles.muted}>No usage yet</span>
  }

  return (
    <div
      ref={anchorRef}
      className={styles.reliabilityAnchor}
      onMouseEnter={showPopover}
      onMouseLeave={() => setPopoverPos(null)}
    >
      <ScoreStack
        score={score}
        note={`${toolEntries.length} tool${toolEntries.length === 1 ? '' : 's'} used`}
      />
      {popoverPos &&
        createPortal(
          <div
            className={styles.reliabilityPopover}
            style={{ top: popoverPos.top, left: popoverPos.left }}
          >
            <div className={styles.reliabilityPopoverTitle}>Reliability by tool</div>
            {toolEntries.length === 0 ? (
              <div className={styles.reliabilityRow}>No tool calls recorded yet.</div>
            ) : (
              toolEntries.map(([tool, stats]) => {
                const total = stats.successes + stats.errors
                const pct = total > 0 ? Math.round((stats.successes / total) * 100) : 0
                return (
                  <div key={tool} className={styles.reliabilityRow}>
                    <span>{tool}</span>
                    <span>
                      {stats.successes}/{total} ({pct}%)
                    </span>
                  </div>
                )
              })
            )}
            {record && record.fabrications > 0 && (
              <div className={styles.reliabilityFabrication}>
                Claimed an unactioned outcome {record.fabrications}×
              </div>
            )}
          </div>,
          document.body
        )}
    </div>
  )
}
