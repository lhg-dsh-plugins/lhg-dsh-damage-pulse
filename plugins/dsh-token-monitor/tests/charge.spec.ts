import { describe, expect, it } from 'vitest'
import { chargeBatchSince, currentChargeSeq, recordCharge } from '../src/charge.ts'

describe('charge replay idempotency', () => {
  it('deduplicates one source event without merging distinct events', () => {
    const before = currentChargeSeq()
    const sessionId = `charge-replay-${String(before)}`

    recordCharge(0.01, 1_000, 'normal', undefined, { sessionId, sourceEventSeq: 7 })
    recordCharge(0.01, 1_000, 'normal', undefined, { sessionId, sourceEventSeq: 7 })
    recordCharge(0.01, 1_000, 'normal', undefined, { sessionId, sourceEventSeq: 8 })

    expect(currentChargeSeq()).toBe(before + 2)
    expect(chargeBatchSince(before).events.map(event => event.sourceEvent)).toEqual([
      { sessionId, seq: 7 },
      { sessionId, seq: 8 },
    ])
  })

  it('preserves legacy calls that do not carry a source event identity', () => {
    const before = currentChargeSeq()
    recordCharge(0.01, 2_000, 'normal')
    recordCharge(0.01, 2_000, 'normal')
    expect(currentChargeSeq()).toBe(before + 2)
  })
})
