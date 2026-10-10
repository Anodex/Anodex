import { describe, expect, it } from 'vitest'
import { readableModelName } from '../modelName'

describe('readableModelName', () => {
  it('drops the quant tag and turns separators into spaces', () => {
    expect(readableModelName('Qwen3-4B-Instruct-2507-Q4_K_M')).toBe('Qwen3 4B Instruct 2507')
    expect(readableModelName('Sharp-MiniCPM5-2B-Q6_K_XL')).toBe('Sharp MiniCPM5 2B')
    expect(readableModelName('Llama-3.2-3B-Instruct-IQ4_XS')).toBe('Llama 3.2 3B Instruct')
    expect(readableModelName('gemma-3-4b-it-BF16')).toBe('gemma 3 4b it')
  })

  it('drops GGUF packaging and a left-over extension in either order', () => {
    expect(readableModelName('Phi-4-mini-GGUF-Q8_0.gguf')).toBe('Phi 4 mini')
    expect(readableModelName('nomic-embed-text-v1.5.Q4_K_M')).toBe('nomic embed text v1.5')
  })

  it('keeps a name that is nothing but a quant rather than returning nothing', () => {
    expect(readableModelName('Q4_K_M')).toBe('Q4_K_M')
    expect(readableModelName('My Model')).toBe('My Model')
  })
})
