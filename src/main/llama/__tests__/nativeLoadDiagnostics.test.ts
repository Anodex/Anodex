import { describe, it, expect } from 'vitest'
import {
  createNativeLogTail,
  describeNativeLoadFailure,
  describeUnreadableModelFile
} from '../nativeLoadDiagnostics'

describe('native log tail', () => {
  it('keeps only the most recent lines', () => {
    const tail = createNativeLogTail(3)
    for (const line of ['a', 'b', 'c', 'd']) tail.record(line)
    expect(tail.lines()).toEqual(['b', 'c', 'd'])
  })

  it('hands back a copy, so a later load cannot mutate a captured tail', () => {
    const tail = createNativeLogTail()
    tail.record('first')
    const captured = tail.lines()
    tail.record('second')
    expect(captured).toEqual(['first'])
  })
})

describe('describeNativeLoadFailure', () => {
  it('names an architecture the bundled engine cannot read', () => {
    // The real line, from loading a Muse-Glimmer 30B GGUF.
    const message = describeNativeLoadFailure([
      'llama_model_loader: loaded meta data',
      "llama_model_load: error loading model: unknown model architecture: 'muse-glimmer'",
      'llama_model_load_from_file_impl: failed to load model'
    ])

    expect(message).toContain('muse-glimmer')
    // The point of the message: stop the user chasing memory they do not need.
    expect(message).toContain('not of your hardware')
  })

  it('prefers the most recent failure over an older one in the same session', () => {
    const message = describeNativeLoadFailure([
      "llama_model_load: error loading model: unknown model architecture: 'old-arch'",
      'llama_model_loader: loaded meta data',
      "llama_model_load: error loading model: unknown model architecture: 'new-arch'"
    ])

    expect(message).toContain('new-arch')
    expect(message).not.toContain('old-arch')
  })

  it('says nothing when the log holds no cause it recognises', () => {
    // The caller then keeps its own general guidance rather than inventing one.
    expect(describeNativeLoadFailure([])).toBeNull()
    expect(describeNativeLoadFailure(['ggml_vulkan: Device memory allocation failed'])).toBeNull()
  })
})

describe('describeUnreadableModelFile', () => {
  it('explains a truncated or corrupt download', () => {
    // The real error, from a partial Llama-3.2-3B download.
    const message = describeUnreadableModelFile(
      'The value of "size" is out of range. It must be >= 0 && <= 9007199254740991. Received 14_029_557_264_190_018_000'
    )

    expect(message).toContain('download was interrupted')
    expect(message).toContain('memory and context settings make no difference')
  })

  it('says nothing about an unrelated failure', () => {
    expect(describeUnreadableModelFile('Failed to load model')).toBeNull()
    expect(describeUnreadableModelFile('out of memory')).toBeNull()
  })
})
