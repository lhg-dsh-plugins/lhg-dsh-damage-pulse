import { describe, expect, it } from 'vitest'
import type {
  BudgetThresholdNotificationEvent,
  ChargeNotificationEvent,
  PeakEnterNotificationEvent,
  TokenMonitorNotificationBatch,
} from '../src/client/notificationApi.ts'
import {
  applyNotificationBatch,
  applyNotificationPollResult,
  createNotificationQueueState,
  dequeueNotificationItem,
} from '../src/client/notificationQueue.ts'

function charge(seq: number, timestamp: number, key = `charge-${String(seq)}`): ChargeNotificationEvent {
  return {
    schemaVersion: 1,
    seq,
    id: key,
    dedupeKey: key,
    kind: 'charge',
    timestamp,
    priority: 'normal',
    payload: {
      cost: 0.25,
      damageKind: seq % 2 === 0 ? 'miss' : 'normal',
      sessionId: 'session-1',
      turn: seq,
      step: 0,
      provider: 'deepseek',
      model: 'deepseek-chat',
    },
  }
}

function budget(seq: number, timestamp: number): BudgetThresholdNotificationEvent {
  return {
    schemaVersion: 1,
    seq,
    id: `budget-${String(seq)}`,
    dedupeKey: `budget-${String(seq)}`,
    kind: 'budget-threshold',
    timestamp,
    priority: 'high',
    payload: {
      date: '2026-08-24',
      budget: 10,
      previousSpend: 9,
      currentSpend: 10.5,
      remaining: -0.5,
    },
  }
}

function peak(seq: number, timestamp: number): PeakEnterNotificationEvent {
  return {
    schemaVersion: 1,
    seq,
    id: `peak-${String(seq)}`,
    dedupeKey: `peak-${String(seq)}`,
    kind: 'peak-enter',
    timestamp,
    priority: 'normal',
    payload: { from: 'offPeak', to: 'peak', periodKey: '2026-08-24:peak' },
  }
}

function batch(streamId: string, seq: number, events: TokenMonitorNotificationBatch['events']): TokenMonitorNotificationBatch {
  return { streamId, seq, events }
}

describe('notification visual queue', () => {
  it('accepts legacy charge events without creating visual items', () => {
    const events = [charge(1, 1_000, 'one'), charge(2, 1_100, 'two')]
    const before = structuredClone(events)
    const update = applyNotificationBatch(
      createNotificationQueueState(),
      batch('stream-1', 2, events),
      1_100,
    )

    expect(update).toMatchObject({ accepted: 2, streamChanged: false, stale: false })
    expect(update.state.cursor).toEqual({ streamId: 'stream-1', seq: 2 })
    expect(update.state.seenDedupeKeys).toEqual(['one', 'two'])
    expect(update.state.ready).toEqual([])
    expect(events).toEqual(before)
  })

  it('keeps non-charge notifications distinct and ordered around suppressed charges', () => {
    const update = applyNotificationBatch(
      createNotificationQueueState(),
      batch('stream-1', 4, [charge(1, 1_000), budget(2, 1_100), peak(3, 1_200), charge(4, 1_300)]),
      1_300,
    )

    expect(update.accepted).toBe(4)
    expect(update.state.ready.map(item => item.event.kind)).toEqual(['budget-threshold', 'peak-enter'])
  })

  it('resets the cursor at a stream boundary and deduplicates stable keys', () => {
    const old = applyNotificationBatch(
      createNotificationQueueState({ dedupeCapacity: 2 }),
      batch('stream-old', 1, [charge(1, 1_000, 'stable')]),
      1_000,
    ).state
    const update = applyNotificationBatch(
      old,
      batch('stream-new', 2, [charge(1, 1_100, 'stable'), charge(2, 1_200, 'new')]),
      1_200,
    )

    expect(update).toMatchObject({ accepted: 1, streamChanged: true, stale: false })
    expect(update.state.cursor).toEqual({ streamId: 'stream-new', seq: 2 })
    expect(update.state.ready).toEqual([])
    expect(update.state.seenDedupeKeys).toEqual(['stable', 'new'])
  })

  it('bounds the cross-stream dedupe history', () => {
    const first = applyNotificationBatch(
      createNotificationQueueState({ dedupeCapacity: 2 }),
      batch('stream-1', 2, [charge(1, 1_000, 'one'), charge(2, 1_100, 'two')]),
      1_100,
    ).state
    const second = applyNotificationBatch(
      first,
      batch('stream-1', 3, [charge(3, 1_200, 'three')]),
      1_200,
    ).state

    expect(second.seenDedupeKeys).toEqual(['two', 'three'])
    expect(second.ready).toEqual([])
  })

  it('ignores regressing batches and stale concurrent poll results', () => {
    const current = applyNotificationBatch(
      createNotificationQueueState(),
      batch('stream-1', 2, [charge(1, 1_000), budget(2, 1_100)]),
      1_100,
    ).state
    const regressed = applyNotificationBatch(current, batch('stream-1', 1, [charge(1, 1_000)]), 1_200)
    expect(regressed).toMatchObject({ accepted: 0, streamChanged: false, stale: true })
    expect(regressed.state).toBe(current)

    const stalePoll = applyNotificationPollResult(current, {
      ok: true,
      requestedCursor: { streamId: 'stream-1', seq: 1 },
      streamChanged: false,
      batch: batch('stream-1', 3, [peak(3, 1_200)]),
    }, 1_200)
    expect(stalePoll).toMatchObject({ accepted: 0, stale: true })
    expect(stalePoll.state).toBe(current)
  })

  it('preserves state across fail-soft polling and exposes the failure', () => {
    const state = createNotificationQueueState()
    const update = applyNotificationPollResult(state, {
      ok: false,
      failure: { kind: 'network', message: 'offline' },
    }, 1_000)

    expect(update).toMatchObject({ accepted: 0, streamChanged: false, stale: false })
    expect(update.failure).toEqual({ kind: 'network', message: 'offline' })
    expect(update.state).toBe(state)
  })

  it('dequeues only non-charge notification items in source order', () => {
    const state = applyNotificationBatch(
      createNotificationQueueState(),
      batch('stream-1', 4, [charge(1, 1_000), budget(2, 1_100), charge(3, 1_200), peak(4, 1_300)]),
      1_300,
    ).state

    const first = dequeueNotificationItem(state, 1_300)
    expect(first).toMatchObject({ item: { kind: 'event', event: { kind: 'budget-threshold' } } })
    const second = dequeueNotificationItem(first.state, 1_301)
    expect(second).toMatchObject({ item: { kind: 'event', event: { kind: 'peak-enter' } } })
    expect(dequeueNotificationItem(second.state, 1_302)).toEqual({ state: second.state })
  })

  it('rejects invalid queue options and clock values', () => {
    expect(() => createNotificationQueueState({ dedupeCapacity: 0 })).toThrow(RangeError)
    expect(() => applyNotificationBatch(createNotificationQueueState(), batch('stream-1', 0, []), -1)).toThrow(RangeError)
    expect(() => dequeueNotificationItem(createNotificationQueueState(), -1)).toThrow(RangeError)
  })
})
