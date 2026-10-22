import { describe, expect, it } from 'vitest'
import { OFFICIAL_PROVIDER_ID, priceUsage } from '../src/pricing.ts'
import { isValidUsageRecord } from '../src/types.ts'

const base = { sessionId: 's', turn: 0, step: 0, timestamp: Date.now(), provider: OFFICIAL_PROVIDER_ID, model: 'deepseek-v4-flash', inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, reasoningTokens: 0, costInput: 0.0000015, costCache: 0, costCacheRead: 0, costCacheWrite: 0, costOutput: 0.0000045, cost: 0.000006, peak: false }

describe('usage validation', () => {
  it('rejects non-finite and negative token counts at pricing boundary', () => {
    expect(priceUsage(Number.NaN, 0, 0, 1, OFFICIAL_PROVIDER_ID, 'deepseek-v4-flash', Date.now())).toBeUndefined()
    expect(priceUsage(-1, 0, 0, 1, OFFICIAL_PROVIDER_ID, 'deepseek-v4-flash', Date.now())).toBeUndefined()
  })

  it('rejects malformed persisted cost records', () => {
    expect(isValidUsageRecord({ ...base, cost: Number.NaN })).toBe(false)
    expect(isValidUsageRecord({ ...base, inputTokens: -1 })).toBe(false)
    expect(isValidUsageRecord({ ...base, costCache: 1 })).toBe(false)
    expect(isValidUsageRecord(base)).toBe(true)
  })

  it('accepts an optional source event sequence only when it is a non-negative safe integer', () => {
    expect(isValidUsageRecord({ ...base, sourceEventSeq: 0 })).toBe(true)
    expect(isValidUsageRecord({ ...base, sourceEventSeq: -1 })).toBe(false)
    expect(isValidUsageRecord({ ...base, sourceEventSeq: 1.5 })).toBe(false)
  })
})
