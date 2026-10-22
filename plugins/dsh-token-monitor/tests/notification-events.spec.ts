import { describe, expect, it } from 'vitest'
import {
  coalesceNotificationEventsForDisplay,
  createBudgetThresholdNotification,
  createChargeNotification,
  createCacheHitAnomalyNotification,
  createPeakTransitionNotification,
  NotificationEventBuffer,
  parseNotificationEvent,
  serializeNotificationEvent,
  type TokenMonitorNotificationEvent,
} from '../src/notification-events.ts'
import type { UsageRecord } from '../src/types.ts'

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    sessionId: 'session-1',
    turn: 3,
    step: 2,
    timestamp: 1_777_000_000_000,
    provider: 'deepseek',
    model: 'deepseek-chat',
    inputTokens: 10,
    cacheReadTokens: 20,
    cacheWriteTokens: 0,
    outputTokens: 30,
    reasoningTokens: 0,
    costInput: 0.001,
    costCache: 0.002,
    costCacheRead: 0.002,
    costCacheWrite: 0,
    costOutput: 0.003,
    cost: 0.006,
    peak: true,
    ...overrides,
  }
}

function publishCharge(
  buffer: NotificationEventBuffer,
  timestamp: number,
  overrides: Partial<UsageRecord> = {},
  damageKind: 'normal' | 'miss' = 'normal',
): TokenMonitorNotificationEvent {
  const event = buffer.publish(createChargeNotification(usage({ timestamp, ...overrides }), damageKind))
  if (event === undefined) throw new Error('expected a published charge event')
  return event
}

describe('token monitor notification event contract', () => {
  it('constructs and serializes all five event variants', () => {
    const buffer = new NotificationEventBuffer({ streamId: 'test-stream' })
    const events = [
      buffer.publish(createChargeNotification(usage(), 'miss')),
      buffer.publish(createBudgetThresholdNotification({
        date: '2026-08-24',
        budget: 10,
        previousSpend: 9.5,
        currentSpend: 10.2,
        remaining: -0.2,
      }, 1_777_000_000_100)),
      buffer.publish(createPeakTransitionNotification({
        from: 'offPeak',
        to: 'peak',
        observedAt: 1_777_000_000_200,
        key: 'peak:1777000000200',
      })),
      buffer.publish(createPeakTransitionNotification({
        from: 'peak',
        to: 'offPeak',
        observedAt: 1_777_000_000_300,
        key: 'offPeak:1777000000300',
      })),
      buffer.publish(createCacheHitAnomalyNotification({
        episodeId: 1,
        observedRate: 0.12,
        threshold: 0.3,
        sampleCount: 3,
        consecutiveCalls: 3,
        observedAt: 1_777_000_000_400,
      })),
    ]

    expect(events.map(event => event?.kind)).toEqual([
      'charge', 'budget-threshold', 'peak-enter', 'peak-exit', 'cache-hit-anomaly',
    ])
    for (const event of events) {
      expect(event).toBeDefined()
      expect(parseNotificationEvent(serializeNotificationEvent(event!))).toEqual(event)
    }
  })

  it.each([
    [() => createChargeNotification(usage({ cost: 0 }), 'normal')],
    [() => createChargeNotification(usage({ timestamp: Number.NaN }), 'normal')],
    [() => createChargeNotification(usage({ turn: 1.5 }), 'normal')],
    [() => createBudgetThresholdNotification({
      date: '24-08-2026', budget: 10, previousSpend: 9, currentSpend: 10, remaining: 0,
    }, 1)],
    [() => createBudgetThresholdNotification({
      date: '2026-08-24', budget: 10, previousSpend: 10, currentSpend: 11, remaining: -1,
    }, 1)],
    [() => createPeakTransitionNotification({
      from: 'peak', to: 'peak', observedAt: 1, key: 'peak:1',
    })],
    [() => createCacheHitAnomalyNotification({ episodeId: 0, observedRate: 0.1, threshold: 0.3, sampleCount: 3, consecutiveCalls: 3, observedAt: 1 })],
    [() => createCacheHitAnomalyNotification({ episodeId: 1, observedRate: 1.1, threshold: 0.3, sampleCount: 3, consecutiveCalls: 3, observedAt: 1 })],
    [() => createCacheHitAnomalyNotification({ episodeId: 1, observedRate: 0.1, threshold: 0.3, sampleCount: 1, consecutiveCalls: 3, observedAt: 1 })],
  ])('rejects malformed constructor input', (run) => {
    expect(run).toThrow()
  })

  it('rejects malformed serialized data', () => {
    expect(() => parseNotificationEvent('{')).toThrow('JSON is invalid')
    expect(() => parseNotificationEvent(JSON.stringify({ schemaVersion: 99 }))).toThrow('schemaVersion')
  })

  it('publishes at most one charge event when one model-call record is replayed', () => {
    const buffer = new NotificationEventBuffer({ streamId: 'test-stream' })
    const first = buffer.publish(createChargeNotification(usage(), 'normal'))
    const replay = buffer.publish(createChargeNotification(usage(), 'normal'))
    expect(first?.seq).toBe(1)
    expect(replay).toBeUndefined()
    expect(buffer.currentSeq()).toBe(1)
  })

  it('keeps distinct model calls distinct even when turn and step are reused', () => {
    const buffer = new NotificationEventBuffer({ streamId: 'test-stream' })
    const first = buffer.publish(createChargeNotification(usage(), 'normal'))
    const second = buffer.publish(createChargeNotification(usage({
      timestamp: usage().timestamp + 1,
      model: 'deepseek-reasoner',
    }), 'miss'))
    expect([first?.seq, second?.seq]).toEqual([1, 2])
    expect(first?.dedupeKey).not.toBe(second?.dedupeKey)
  })

  it('keeps same-millisecond source events distinct while deduplicating a replay', () => {
    const buffer = new NotificationEventBuffer({ streamId: 'test-stream' })
    const firstRecord = usage({ sourceEventSeq: 10 })
    const secondRecord = usage({ sourceEventSeq: 11 })
    const first = buffer.publish(createChargeNotification(firstRecord, 'normal'))
    const second = buffer.publish(createChargeNotification(secondRecord, 'normal'))
    const replay = buffer.publish(createChargeNotification(firstRecord, 'normal'))

    expect([first?.seq, second?.seq]).toEqual([1, 2])
    expect(first?.dedupeKey).not.toBe(second?.dedupeKey)
    expect(replay).toBeUndefined()
  })

  it('uses Beijing date and integer cents for stable budget identity', () => {
    const first = createBudgetThresholdNotification({
      date: '2026-08-24', budget: 10, previousSpend: 9, currentSpend: 10, remaining: 0,
    }, 100)
    const equivalent = createBudgetThresholdNotification({
      date: '2026-08-24', budget: 10.0000000001, previousSpend: 9, currentSpend: 10.1, remaining: -0.1,
    }, 200)
    const nextDay = createBudgetThresholdNotification({
      date: '2026-08-25', budget: 10, previousSpend: 9, currentSpend: 10, remaining: 0,
    }, 300)
    expect(first.dedupeKey).toBe(equivalent.dedupeKey)
    expect(first.dedupeKey).not.toBe(nextDay.dedupeKey)
  })

  it('maps peak destination to kind and reuses the stable period key across restart', () => {
    const transition = {
      from: 'offPeak' as const,
      to: 'peak' as const,
      observedAt: 1_777_000_000_000,
      key: 'peak:1777000000000',
    }
    const first = new NotificationEventBuffer({ streamId: 'boot-a' })
      .publish(createPeakTransitionNotification(transition))
    const restarted = new NotificationEventBuffer({ streamId: 'boot-b' })
      .publish(createPeakTransitionNotification(transition))
    expect(first?.kind).toBe('peak-enter')
    expect(first?.seq).toBe(1)
    expect(restarted?.seq).toBe(1)
    expect(restarted?.dedupeKey).toBe(first?.dedupeKey)
  })
})

describe('NotificationEventBuffer', () => {
  it('trims the event ring while retaining a separate dedupe memory', () => {
    const buffer = new NotificationEventBuffer({ capacity: 2, dedupeCapacity: 4, streamId: 'test-stream' })
    const original = usage({ timestamp: 100 })
    buffer.publish(createChargeNotification(original, 'normal'))
    publishCharge(buffer, 200)
    publishCharge(buffer, 300)

    expect(buffer.since(0).map(event => event.seq)).toEqual([2, 3])
    expect(buffer.publish(createChargeNotification(original, 'normal'))).toBeUndefined()
    expect(buffer.currentSeq()).toBe(3)
  })

  it('returns stream identity, current cursor, and incremental events', () => {
    const buffer = new NotificationEventBuffer({ streamId: 'boot-42' })
    publishCharge(buffer, 100)
    publishCharge(buffer, 200)
    expect(buffer.batchSince(1)).toMatchObject({
      streamId: 'boot-42',
      seq: 2,
      events: [{ seq: 2 }],
    })
  })

  it('does not advance the cursor when a malformed draft is rejected', () => {
    const buffer = new NotificationEventBuffer({ streamId: 'test-stream' })
    const invalid = { ...createChargeNotification(usage(), 'normal'), timestamp: -1 }
    expect(() => buffer.publish(invalid)).toThrow('timestamp')
    expect(buffer.currentSeq()).toBe(0)
  })
})

describe('charge display coalescing', () => {
  it('coalesces consecutive charges inside the window and lets miss win', () => {
    const buffer = new NotificationEventBuffer({ streamId: 'test-stream' })
    const events = [
      publishCharge(buffer, 1_000, { cost: 0.01 }),
      publishCharge(buffer, 2_000, { cost: 0.02 }, 'miss'),
    ]
    expect(coalesceNotificationEventsForDisplay(events, 1_750)).toEqual([{
      kind: 'charge-summary',
      firstSeq: 1,
      lastSeq: 2,
      firstTimestamp: 1_000,
      lastTimestamp: 2_000,
      cost: 0.03,
      calls: 2,
      damageKind: 'miss',
      eventIds: [events[0]!.id, events[1]!.id],
      dedupeKeys: [events[0]!.dedupeKey, events[1]!.dedupeKey],
    }])
  })

  it('splits charges outside the window and never swallows budget or peak events', () => {
    const buffer = new NotificationEventBuffer({ streamId: 'test-stream' })
    const first = publishCharge(buffer, 1_000)
    const budget = buffer.publish(createBudgetThresholdNotification({
      date: '2026-08-24', budget: 10, previousSpend: 9, currentSpend: 10, remaining: 0,
    }, 1_100))!
    const second = publishCharge(buffer, 1_200)
    const third = publishCharge(buffer, 4_000)
    const peak = buffer.publish(createPeakTransitionNotification({
      from: 'offPeak', to: 'peak', observedAt: 4_100, key: 'peak:4100',
    }))!

    const output = coalesceNotificationEventsForDisplay([first, budget, second, third, peak], 1_750)
    expect(output.map(item => item.kind)).toEqual([
      'charge-summary', 'event', 'charge-summary', 'charge-summary', 'event',
    ])
    expect(output[1]).toEqual({ kind: 'event', event: budget })
    expect(output[4]).toEqual({ kind: 'event', event: peak })
  })
})
