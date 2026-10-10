const QUANT_SUFFIX = /[-_. ]+(Q\d(?:_[A-Z0-9]+)*|F16|F32|BF16|IQ\d[A-Z0-9_]*)$/i
const QUANT_ONLY = /^(Q\d(?:_[A-Z0-9]+)*|F16|F32|BF16|IQ\d[A-Z0-9_]*)$/i
const PACKAGING_SUFFIX = /[-_. ]+(GGUF|GGML)$/i

/**
 * A local model's file name as a person would say it: "Qwen3-4B-Instruct-2507-Q4_K_M"
 * becomes "Qwen3 4B Instruct 2507". The quant tag and the "GGUF" packaging say
 * how the file was made, not which model it is, and in a narrow sidebar they
 * push the part that does off the end. The full name stays available for a
 * tooltip; this is display only and never used to identify a model.
 */
export function readableModelName(name: string): string {
  let readable = name.replace(/\.gguf$/i, '')
  if (QUANT_ONLY.test(readable)) return readable
  for (let i = 0; i < 2; i++) {
    readable = readable.replace(QUANT_SUFFIX, '').replace(PACKAGING_SUFFIX, '')
  }
  readable = readable
    .replace(/[-_]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return readable || name
}
