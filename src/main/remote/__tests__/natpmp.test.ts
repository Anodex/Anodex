import { describe, expect, it } from 'vitest'
import { isPrivateAddress, parseExternalAddress, parseMapResponse } from '../natpmp'

/**
 * The NAT-PMP wire format, and the check that decides whether opening a port can
 * possibly work.
 *
 * Parsing is the part worth testing without a router: a misread reply either
 * reports a mapping that does not exist — leaving the user believing they can
 * reach their machine from away when they cannot — or discards a good one.
 */
describe('NAT-PMP replies', () => {
  /** A router's answer to "what is your public address?" */
  function externalAddressReply(address: number[], resultCode = 0): Buffer {
    const reply = Buffer.alloc(12)
    reply.writeUInt8(0, 0)
    reply.writeUInt8(128, 1) // opcode 0 + response flag
    reply.writeUInt16BE(resultCode, 2)
    reply.writeUInt32BE(1234, 4) // seconds since epoch, unused
    for (const [index, octet] of address.entries()) reply.writeUInt8(octet, 8 + index)
    return reply
  }

  function mapReply(externalPort: number, lifetime: number, resultCode = 0): Buffer {
    const reply = Buffer.alloc(16)
    reply.writeUInt8(0, 0)
    reply.writeUInt8(130, 1) // opcode 2 + response flag
    reply.writeUInt16BE(resultCode, 2)
    reply.writeUInt32BE(1234, 4)
    reply.writeUInt16BE(47800, 8) // internal port
    reply.writeUInt16BE(externalPort, 10)
    reply.writeUInt32BE(lifetime, 12)
    return reply
  }

  it('reads the public address out of a well-formed reply', () => {
    expect(parseExternalAddress(externalAddressReply([203, 0, 113, 7]))).toBe('203.0.113.7')
  })

  it('refuses a reply whose result code says no', () => {
    // A non-zero result is a refusal — reading the address anyway would report a
    // mapping the router never made.
    expect(parseExternalAddress(externalAddressReply([203, 0, 113, 7], 2))).toBeNull()
  })

  it('refuses a reply that is not an answer to this question', () => {
    const wrongOpcode = externalAddressReply([203, 0, 113, 7])
    wrongOpcode.writeUInt8(130, 1)
    expect(parseExternalAddress(wrongOpcode)).toBeNull()

    // A request echoed back rather than a response: the high bit is not set.
    const notAResponse = externalAddressReply([203, 0, 113, 7])
    notAResponse.writeUInt8(0, 1)
    expect(parseExternalAddress(notAResponse)).toBeNull()
  })

  it('refuses a truncated reply instead of reading past the end', () => {
    expect(parseExternalAddress(Buffer.alloc(4))).toBeNull()
    expect(parseMapResponse(Buffer.alloc(8), '203.0.113.7', 47800)).toBeNull()
  })

  it('reads the port and lifetime the router actually granted', () => {
    // Both can differ from what was asked for, and the router's answer wins.
    const mapping = parseMapResponse(mapReply(51234, 900), '203.0.113.7', 47800)

    expect(mapping).toEqual({
      externalAddress: '203.0.113.7',
      externalPort: 51234,
      internalPort: 47800,
      lifetimeSeconds: 900
    })
  })

  it('treats a zero lifetime as a removal, not a mapping', () => {
    // Zero is how NAT-PMP expresses "closed". Reading it as success would tell the
    // user a port is open when the router just shut it.
    expect(parseMapResponse(mapReply(47800, 0), '203.0.113.7', 47800)).toBeNull()
  })
})

describe('deciding whether a port can be reached at all', () => {
  it('recognises carrier-grade NAT, which no port forwarding can fix', () => {
    // 100.64/10 means the ISP is sharing one public address between customers. The
    // router will happily "forward" a port on an address nothing outside can reach,
    // so this has to be caught and said plainly rather than reported as success.
    expect(isPrivateAddress('100.64.0.1')).toBe(true)
    expect(isPrivateAddress('100.127.255.254')).toBe(true)
  })

  it('recognises the ordinary private ranges', () => {
    for (const address of ['10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255']) {
      expect(isPrivateAddress(address), address).toBe(true)
    }
  })

  it('accepts a genuinely public address', () => {
    for (const address of ['203.0.113.7', '8.8.8.8', '100.63.0.1', '100.128.0.1', '172.32.0.1']) {
      expect(isPrivateAddress(address), address).toBe(false)
    }
  })

  it('treats anything malformed as unusable rather than public', () => {
    // Failing closed: reporting rubbish as a public address would send the phone to
    // an address that cannot exist.
    for (const address of ['', 'not-an-address', '1.2.3', '1.2.3.4.5', '999.1.1.1']) {
      expect(isPrivateAddress(address), address).toBe(true)
    }
  })
})
