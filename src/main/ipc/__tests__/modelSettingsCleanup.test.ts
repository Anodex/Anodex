import { describe, expect, it } from 'vitest'
import { createDefaultSettings } from '@shared/settings.defaults'
import type { AppSettings } from '@shared/settings.types'
import { forgetModelSettings } from '../modelSettingsCleanup'

const GONE = 'C:/models/gone.gguf'
const KEPT = 'C:/models/kept.gguf'

function settings(patch: (base: AppSettings) => void): AppSettings {
  const base = createDefaultSettings('/models')
  patch(base)
  return base
}

describe('forgetModelSettings', () => {
  // The one the delete handler missed. A context size is only meaningful for
  // the model it was chosen for, and it is read back by path - so an entry that
  // outlives its file is a value waiting to be applied to something else.
  it('clears the remembered context size', () => {
    const patch = forgetModelSettings(
      settings((s) => {
        s.modelContextSizes = { [GONE]: 8192, [KEPT]: 65536 }
      }),
      GONE
    )

    expect(patch?.modelContextSizes).toEqual({ [GONE]: null })
  })

  it('leaves every other model alone', () => {
    const patch = forgetModelSettings(
      settings((s) => {
        s.addedModelPaths = [GONE, KEPT]
        s.modelContextSizes = { [GONE]: 8192, [KEPT]: 65536 }
      }),
      GONE
    )

    expect(patch?.addedModelPaths).toEqual([KEPT])
    expect(patch?.modelContextSizes).not.toHaveProperty(KEPT)
  })

  it('clears the three the handler already covered', () => {
    const patch = forgetModelSettings(
      settings((s) => {
        s.addedModelPaths = [GONE]
        s.lastModelPath = GONE
        s.visionProjectorPaths = { [GONE]: 'C:/models/proj.gguf' }
      }),
      GONE
    )

    expect(patch?.addedModelPaths).toEqual([])
    expect(patch?.lastModelPath).toBeNull()
    expect(patch?.visionProjectorPaths).toEqual({ [GONE]: null })
  })

  it('keeps lastModelPath when a different model was deleted', () => {
    const patch = forgetModelSettings(
      settings((s) => {
        s.addedModelPaths = [GONE]
        s.lastModelPath = KEPT
      }),
      GONE
    )

    expect(patch?.lastModelPath).toBe(KEPT)
  })

  // A model nothing was recorded about should not produce a settings write at
  // all - a patch per delete would churn the file for no reason.
  it('writes nothing when the model left nothing behind', () => {
    expect(forgetModelSettings(createDefaultSettings('/models'), GONE)).toBeNull()
  })

  it('acts on a context size even when nothing else knows the model', () => {
    const patch = forgetModelSettings(
      settings((s) => {
        s.modelContextSizes = { [GONE]: 16384 }
      }),
      GONE
    )

    expect(patch).not.toBeNull()
    expect(patch?.modelContextSizes).toEqual({ [GONE]: null })
  })
})
