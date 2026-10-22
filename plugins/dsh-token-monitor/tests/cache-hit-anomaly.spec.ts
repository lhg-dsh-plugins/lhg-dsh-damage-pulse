import { describe, expect, it } from 'vitest'
import {
  createCacheHitAnomalyDetector,
  formatCacheHitAnomalyMessage,
  type CacheHitAnomalySettings,
} from '../src/cache-hit-anomaly.ts'
import type { UsageRecord } from '../src/types.ts'

const settings: CacheHitAnomalySettings = { enabled: true, thresholdPercent: 30, consecutiveCalls: 3 }

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    sessionId: 'session-1', turn: 1, step: 1, timestamp: 1_777_000_000_000,
    provider: 'deepseek', model: 'deepseek-chat', inputTokens: 900, cacheReadTokens: 0,
    cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0,
    costInput: 0, costCache: 0, costCacheRead: 0, costCacheWrite: 0, costOutput: 0, cost: 0.01,
    peak: false, ...overrides,
  }
}

describe('cache hit anomaly detector', () => {
  it('formats the public project name and whale-girl alert copy', () => {
    const message = formatCacheHitAnomalyMessage({
      episodeId: 1, observedRate: 0.42, threshold: 0.8, sampleCount: 10, consecutiveCalls: 10, observedAt: 1,
    })
    expect(message).toContain('【dsh-damage-pulse · 缓存小警报】')
    expect(message).toContain('最近 10 次合格调用的聚合命中率约为 42.0%，低于设定阈值 80%。')
    expect(message).toContain('鲸鱼娘发现缓存命中率有点低啦')
    expect(message).not.toContain('DSH Token Monitor')
  })

  it('waits for the configured rolling window and emits once', () => {
    const detector = createCacheHitAnomalyDetector(() => settings)
    expect(detector.observe(record({ timestamp: 1 }))).toBeUndefined()
    expect(detector.observe(record({ timestamp: 2 }))).toBeUndefined()
    const alert = detector.observe(record({ timestamp: 3 }))
    expect(alert).toMatchObject({ episodeId: 1, observedRate: 0, threshold: 0.3, sampleCount: 3, consecutiveCalls: 3, observedAt: 3 })
    expect(detector.observe(record({ timestamp: 4 }))).toBeUndefined()
  })

  it('unlatches after recovery and emits a new episode later', () => {
    const detector = createCacheHitAnomalyDetector(() => settings)
    for (let i = 1; i <= 3; i += 1) detector.observe(record({ timestamp: i }))
    for (let i = 4; i <= 6; i += 1) {
      expect(detector.observe(record({ timestamp: i, inputTokens: 0, cacheReadTokens: 900 }))).toBeUndefined()
    }
    expect(detector.observe(record({ timestamp: 7 }))).toBeUndefined()
    expect(detector.observe(record({ timestamp: 8 }))).toBeUndefined()
    expect(detector.observe(record({ timestamp: 9 }))).toMatchObject({ episodeId: 2 })
  })

  it('skips invalid records, resets on configuration changes, and never persists state', () => {
    let current = { ...settings }
    const detector = createCacheHitAnomalyDetector(() => current)
    detector.observe(record({ timestamp: Number.NaN }))
    detector.observe(record({ timestamp: 1 }))
    current = { ...current, consecutiveCalls: 2 }
    expect(detector.observe(record({ timestamp: 2 }))).toBeUndefined()
    expect(detector.observe(record({ timestamp: 3 }))).toMatchObject({ episodeId: 1, sampleCount: 2 })
    current = { ...current, enabled: false }
    expect(detector.observe(record({ timestamp: 4 }))).toBeUndefined()
    current = { ...current, enabled: true }
    expect(detector.observe(record({ timestamp: 5 }))).toBeUndefined()
    const restarted = createCacheHitAnomalyDetector(() => current)
    expect(restarted.observe(record({ timestamp: 6 }))).toBeUndefined()
  })
})
