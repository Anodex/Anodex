import { describe, expect, it } from 'vitest'
import { activeParametersB, tierForParametersB } from '../activeParameters'

describe('activeParametersB', () => {
  it('reads effective and active parameter counts from model names', () => {
    expect(activeParametersB('google/gemma-4-E4B-it-qat-q4_0-gguf')).toBe(4)
    expect(activeParametersB('gemma-4-E2B_q4_0-it.gguf')).toBe(2)
    expect(activeParametersB('unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF')).toBe(3)
    expect(activeParametersB('gemma-4-26B-A4B-it')).toBe(4)
    expect(activeParametersB('Some-Model-235B-A22B-Q4_K_M.gguf')).toBe(22)
    expect(activeParametersB('mixtral-8x7B-A12.9B')).toBe(12.9)
  })

  it('finds none in an ordinary name or a word that only contains the letters', () => {
    for (const name of [
      'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
      'Qwen3.8-27B-GGUF',
      'AEB-model',
      'TEAM4B-chat',
      'llama-3.2-3B-instruct'
    ]) {
      expect(activeParametersB(name), name).toBeNull()
    }
  })
})

describe('tierForParametersB', () => {
  it('puts a model in the class its parameter count is named for', () => {
    expect(tierForParametersB(0.6)).toBe('1b')
    expect(tierForParametersB(2)).toBe('1b')
    expect(tierForParametersB(4)).toBe('3b')
    expect(tierForParametersB(8)).toBe('7b')
    expect(tierForParametersB(14)).toBe('14b')
    expect(tierForParametersB(32)).toBe('32b')
    expect(tierForParametersB(70)).toBe('70b')
  })
})
