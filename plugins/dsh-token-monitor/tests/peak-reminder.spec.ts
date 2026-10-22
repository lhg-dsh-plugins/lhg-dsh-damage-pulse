import { describe, expect, it, vi } from 'vitest'
import {
  attachPeakBoundaryReminder,
  formatPeakTransitionMessage,
  type PeakReminderContext,
} from '../src/peak-reminder.ts'
import type { PeakTransitionClock } from '../src/peak-transition.ts'

const at = (value: string): number => Date.parse(`${value}+08:00`)

class ManualClock implements PeakTransitionClock {
  private nextId = 1
  private timers = new Map<number, { at: number; callback: () => void }>()

  constructor(private value: number) {}

  now(): number { return this.value }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++
    this.timers.set(id, { at: this.value + delayMs, callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  advanceTo(value: number): void {
    this.value = value
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= value)
      .sort((left, right) => left[1].at - right[1].at)
    for (const [id, timer] of due) {
      if (!this.timers.delete(id)) continue
      timer.callback()
    }
  }

  get timerCount(): number { return this.timers.size }
}

function lifecycleContext(): { ctx: PeakReminderContext; dispose(): void } {
  let cleanup: (() => void) | undefined
  return {
    ctx: {
      effect(callback) {
        cleanup = callback() || undefined
        return () => cleanup?.()
      },
    },
    dispose() { cleanup?.() },
  }
}

describe('formatPeakTransitionMessage', () => {
  it('describes both effective periods without relying on the scheduled boundary time', () => {
    const peak = formatPeakTransitionMessage({
      from: 'offPeak', to: 'peak', observedAt: at('2026-08-24T09:00:00'), key: 'peak:1',
    })
    const offPeak = formatPeakTransitionMessage({
      from: 'peak', to: 'offPeak', observedAt: at('2026-08-24T12:00:00'), key: 'offPeak:2',
    })
    expect(peak).toContain('【dsh-damage-pulse · 峰时提醒】')
    expect(peak).toContain('现在进入峰时段啦（北京时间）')
    expect(peak).toContain('鲸鱼娘会继续帮你盯着余额和消耗')
    expect(offPeak).toContain('【dsh-damage-pulse · 谷时提醒】')
    expect(offPeak).toContain('现在进入谷时段啦（北京时间）')
    expect(offPeak).toContain('鲸鱼娘会继续乖乖守着余额变化')
  })
})

describe('attachPeakBoundaryReminder', () => {
  const enabledSettings = () => ({
    peakReminderEnabled: true,
    peakReminderEnterPeak: true,
    peakReminderEnterValley: true,
  })

  it('fails closed when a community host omits the settings integration', async () => {
    const clock = new ManualClock(at('2026-08-24T08:59:59'))
    const lifecycle = lifecycleContext()
    const send = vi.fn().mockResolvedValue({ ok: true })

    attachPeakBoundaryReminder(lifecycle.ctx, { send }, { clock })
    clock.advanceTo(at('2026-08-24T09:00:00'))
    await Promise.resolve()

    expect(send).not.toHaveBeenCalled()
    expect(clock.timerCount).toBe(1)
  })

  it('starts silently, sends once on change, and stops with the plugin lifecycle', async () => {
    const clock = new ManualClock(at('2026-08-24T08:59:59'))
    const lifecycle = lifecycleContext()
    const send = vi.fn().mockResolvedValue({ ok: true })

    attachPeakBoundaryReminder(lifecycle.ctx, { send }, { clock, settings: enabledSettings })
    expect(send).not.toHaveBeenCalled()
    expect(clock.timerCount).toBe(1)

    clock.advanceTo(at('2026-08-24T09:00:00'))
    await Promise.resolve()
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]?.[0]).toContain('现在进入峰时段啦')

    lifecycle.dispose()
    expect(clock.timerCount).toBe(0)
  })

  it('contains a structured send failure and keeps the next boundary scheduled', async () => {
    const clock = new ManualClock(at('2026-08-24T11:59:59'))
    const lifecycle = lifecycleContext()
    const warn = vi.fn()
    attachPeakBoundaryReminder(lifecycle.ctx, {
      send: vi.fn().mockResolvedValue({ ok: false, code: 'send-failed', detail: 'offline' }),
    }, { clock, warn, settings: enabledSettings })

    clock.advanceTo(at('2026-08-24T12:00:00'))
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('offline'))
    expect(clock.timerCount).toBe(1)
  })

  it('contains a throwing sender and keeps the next boundary scheduled', async () => {
    const clock = new ManualClock(at('2026-08-24T13:59:59'))
    const lifecycle = lifecycleContext()
    const warn = vi.fn()
    attachPeakBoundaryReminder(lifecycle.ctx, {
      send: vi.fn().mockRejectedValue(new Error('adapter exploded')),
    }, { clock, warn, settings: enabledSettings })

    clock.advanceTo(at('2026-08-24T14:00:00'))
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('adapter exploded'))
    expect(clock.timerCount).toBe(1)
  })

  it('consumes disabled boundaries without replaying them after re-enable', async () => {
    const clock = new ManualClock(at('2026-08-24T08:59:59'))
    const lifecycle = lifecycleContext()
    const send = vi.fn().mockResolvedValue({ ok: true })
    let settings = {
      peakReminderEnabled: false,
      peakReminderEnterPeak: true,
      peakReminderEnterValley: true,
    }
    attachPeakBoundaryReminder(lifecycle.ctx, { send }, { clock, settings: () => settings })

    clock.advanceTo(at('2026-08-24T09:00:00'))
    await Promise.resolve()
    expect(send).not.toHaveBeenCalled()

    settings = { ...settings, peakReminderEnabled: true }
    await Promise.resolve()
    expect(send).not.toHaveBeenCalled()
    clock.advanceTo(at('2026-08-24T12:00:00'))
    await Promise.resolve()
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]?.[0]).toContain('现在进入谷时段啦')
  })

  it('publishes raw transitions even when user-facing reminders are disabled', async () => {
    const clock = new ManualClock(at('2026-08-24T08:59:59'))
    const lifecycle = lifecycleContext()
    const send = vi.fn().mockResolvedValue({ ok: true })
    const onTransition = vi.fn()
    attachPeakBoundaryReminder(lifecycle.ctx, { send }, {
      clock,
      settings: () => ({
        peakReminderEnabled: false,
        peakReminderEnterPeak: true,
        peakReminderEnterValley: true,
      }),
      onTransition,
    })

    clock.advanceTo(at('2026-08-24T09:00:00'))
    await Promise.resolve()

    expect(onTransition).toHaveBeenCalledOnce()
    expect(onTransition).toHaveBeenCalledWith(expect.objectContaining({ from: 'offPeak', to: 'peak' }))
    expect(send).not.toHaveBeenCalled()
  })

  it('applies the enter-peak and enter-valley direction switches independently', async () => {
    const clock = new ManualClock(at('2026-08-24T08:59:59'))
    const lifecycle = lifecycleContext()
    const send = vi.fn().mockResolvedValue({ ok: true })
    let settings = {
      peakReminderEnabled: true,
      peakReminderEnterPeak: false,
      peakReminderEnterValley: true,
    }
    attachPeakBoundaryReminder(lifecycle.ctx, { send }, { clock, settings: () => settings })

    clock.advanceTo(at('2026-08-24T09:00:00'))
    await Promise.resolve()
    expect(send).not.toHaveBeenCalled()
    clock.advanceTo(at('2026-08-24T12:00:00'))
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)

    settings = { ...settings, peakReminderEnterPeak: true, peakReminderEnterValley: false }
    clock.advanceTo(at('2026-08-24T14:00:00'))
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(2)
    clock.advanceTo(at('2026-08-24T18:00:00'))
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(2)
  })
})
