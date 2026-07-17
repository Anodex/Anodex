import type { CheckpointContentEncoding } from '@shared/checkpoint.types'

export interface EncodedCheckpointContent {
  data: string
  encoding: CheckpointContentEncoding
}

export function encodeCheckpointBuffer(buffer: Buffer): EncodedCheckpointContent {
  const binary = isLikelyBinary(buffer)
  return {
    data: buffer.toString(binary ? 'base64' : 'utf-8'),
    encoding: binary ? 'base64' : 'utf8'
  }
}

function isLikelyBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true
  const sample = buffer.subarray(0, 8_000)
  if (sample.length === 0) return false
  let controlBytes = 0
  for (const byte of sample) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) controlBytes += 1
  }
  return controlBytes / sample.length > 0.1
}
