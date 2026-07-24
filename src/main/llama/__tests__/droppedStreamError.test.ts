import { describe, expect, it } from 'vitest'
import { isDroppedStreamError, isDroppedStreamMessage } from '../droppedStreamError'

describe('isDroppedStreamMessage', () => {
  it('matches undici\'s bare "terminated"', () => {
    expect(isDroppedStreamMessage('terminated')).toBe(true)
    expect(isDroppedStreamMessage('  Terminated ')).toBe(true)
  })

  it('matches explicit socket drops', () => {
    expect(isDroppedStreamMessage('SocketError: other side closed')).toBe(true)
    expect(isDroppedStreamMessage('read ECONNRESET')).toBe(true)
    expect(isDroppedStreamMessage('UND_ERR_SOCKET')).toBe(true)
  })

  it('does not misclassify ordinary prose that merely contains the word', () => {
    expect(isDroppedStreamMessage('The scheduled run was terminated by the user.')).toBe(false)
    expect(isDroppedStreamMessage('Contract terminated.')).toBe(false)
    expect(isDroppedStreamMessage('Object is disposed')).toBe(false)
  })
})

describe('isDroppedStreamError', () => {
  it('detects the bare undici TypeError', () => {
    expect(isDroppedStreamError(new TypeError('terminated'))).toBe(true)
  })

  it('detects the underlying socket error carried on .cause', () => {
    const error = new TypeError('terminated', {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
    })
    expect(isDroppedStreamError(error)).toBe(true)
  })

  it('detects a cause by code even when the top-level message is generic', () => {
    const error = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    })
    expect(isDroppedStreamError(error)).toBe(true)
  })

  it('ignores unrelated errors and non-errors', () => {
    expect(isDroppedStreamError(new Error('Object is disposed'))).toBe(false)
    expect(isDroppedStreamError('terminated')).toBe(false)
    expect(isDroppedStreamError(null)).toBe(false)
  })
})
