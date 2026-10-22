import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LEGACY_PRICE_TABLE,
  OFFICIAL_PROVIDER_ID,
  PRICE_TABLE,
  beijingWeekday,
  isPeakHour,
  priceUsage,
  resolveModelPrice,
  resolvePricingEligibility,
} from '../plugins/dsh-token-monitor/src/pricing.ts'
import { isPeakPeriod } from '../packages/client/ui-token-monitor/src/client/peakPeriod.ts'

const OFF_PEAK = Date.UTC(2026, 7, 21, 0, 0, 0)
const PEAK = Date.UTC(2026, 7, 21, 2, 0, 0)
const beijing = (day: number, hour: number, minute = 0) => Date.UTC(2026, 7, day, hour - 8, minute)

function officialPrice(
  inputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  outputTokens: number,
  model: string,
  timestamp: number,
) {
  const result = priceUsage(
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    OFFICIAL_PROVIDER_ID,
    model,
    timestamp,
  )
  assert.ok(result)
  return result
}

test('resolves the official vision model and versioned ids', () => {
  assert.deepEqual(resolveModelPrice('deepseek-v4-flash-vision-exp', PRICE_TABLE), PRICE_TABLE.models['deepseek-v4-flash-vision-exp'])
  assert.deepEqual(resolveModelPrice('deepseek-v4-flash-vision-exp-2026', PRICE_TABLE), PRICE_TABLE.models['deepseek-v4-flash-vision-exp'])
})

test('requires both the official provider and an explicitly priced model', () => {
  assert.ok(resolvePricingEligibility(OFFICIAL_PROVIDER_ID, 'deepseek-v4-flash', OFF_PEAK))
  assert.equal(resolvePricingEligibility('openai-compatible', 'deepseek-v4-flash', OFF_PEAK), undefined)
  assert.equal(resolvePricingEligibility(OFFICIAL_PROVIDER_ID, 'future-deepseek-model', OFF_PEAK), undefined)
  assert.equal(resolvePricingEligibility(OFFICIAL_PROVIDER_ID, 'deepseek-v4-proxy', OFF_PEAK), undefined)
  assert.equal(
    resolvePricingEligibility(OFFICIAL_PROVIDER_ID, 'deepseek-v4-flash-0731', OFF_PEAK)?.matchedModel,
    'deepseek-v4-flash',
  )
})

test('prices image tokens already included in prompt usage exactly once', () => {
  const cost = officialPrice(1_000 + 384, 0, 0, 2_000, 'deepseek-v4-flash-vision-exp', OFF_PEAK)
  assert.equal(cost.costInput, 1_384 / 1e6 * 1.5)
  assert.equal(cost.costOutput, 2_000 / 1e6 * 4.5)
  assert.equal(cost.cost, cost.costInput + cost.costOutput)
})

test('prices vision cache hits and misses with the official peak multiplier', () => {
  const offPeak = officialPrice(1_000, 500, 0, 2_000, 'deepseek-v4-flash-vision-exp', OFF_PEAK)
  const peak = officialPrice(1_000, 500, 0, 2_000, 'deepseek-v4-flash-vision-exp', PEAK)
  assert.equal(peak.cost, offPeak.cost * 2)
  assert.equal(offPeak.costCacheRead, 500 / 1e6 * 0.05)
  assert.equal(offPeak.costInput, 1_000 / 1e6 * 1.5)
})

test('keeps the legacy table available for pre-price-change records', () => {
  const old = officialPrice(
    1_000, 500, 0, 2_000, 'deepseek-v4-flash-vision-exp', Date.UTC(2026, 7, 15, 1, 0, 0),
  )
  assert.equal(old.costInput, 1_000 / 1e6 * 1.0)
  assert.equal(old.costCacheRead, 500 / 1e6 * 0.02)
  assert.equal(old.costOutput, 2_000 / 1e6 * 2.0)
  assert.equal(LEGACY_PRICE_TABLE.models['deepseek-v4-flash-vision-exp']?.offPeak.input, 1.0)
})

test('keeps weekday peak windows and charges the whole weekend at valley rates', () => {
  const cases: Array<[number, boolean]> = [
    [beijing(21, 8, 59), false],
    [beijing(21, 9), true],
    [beijing(21, 12), false],
    [beijing(21, 14), true],
    [beijing(21, 18), false],
    [beijing(22, 9), false],
    [beijing(22, 14), false],
    [beijing(23, 9), false],
    [beijing(24, 9), true],
  ]
  for (const [timestamp, expected] of cases) {
    assert.equal(isPeakHour(timestamp, PRICE_TABLE.peakHours), expected)
    assert.equal(isPeakPeriod(timestamp), expected)
  }

  const saturday = beijing(22, 10)
  const known = officialPrice(1_000_000, 0, 0, 0, 'deepseek-v4-flash', saturday)
  const unknown = priceUsage(
    1_000_000, 0, 0, 0, OFFICIAL_PROVIDER_ID, 'future-deepseek-model', saturday,
  )
  assert.equal(known.costInput, 1.5)
  assert.equal(unknown, undefined)
})

test('uses the Asia/Shanghai day boundary instead of the host local timezone', () => {
  assert.equal(beijingWeekday(Date.UTC(2026, 7, 21, 15, 59)), 5)
  assert.equal(beijingWeekday(Date.UTC(2026, 7, 21, 16, 0)), 6)
})
