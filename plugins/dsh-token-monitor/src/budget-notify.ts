import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { WechatNotifyResult } from '../../wechat-notify/src/sender.ts'
import type { UsageStorage } from './storage.ts'
import { DailyBudgetThresholdTracker, type BudgetThresholdCrossing } from './budget.ts'
import { beijingDateKey } from './todaySpend.ts'

export interface BudgetNotificationSender {
  send(message: string): Promise<WechatNotifyResult>
}

export interface BudgetNotificationContext {
  on(event: 'session/event', listener: (session: unknown, event: SessionEvent) => void): unknown
}

export interface BudgetNotificationOptions {
  now?: () => number
  warn?: (message: string) => void
  onCrossing?: (crossing: BudgetThresholdCrossing, observedAt: number) => void
}

export interface BudgetNotificationSettings {
  dailyBudgetEnabled: boolean
  dailyBudgetCny: number
  budgetExceededNotificationEnabled: boolean
}

export function formatBudgetThresholdMessage(event: BudgetThresholdCrossing): string {
  return [
    '【dsh-damage-pulse · 今日预算】',
    '',
    `今天（${event.date}）已经花费 CNY ${event.currentSpend.toFixed(2)}，刚刚越过 CNY ${event.budget.toFixed(2)} 的预算线啦 (｡•́︿•̀｡)`,
    '',
    `当前剩余预算：CNY ${event.remaining.toFixed(2)}`,
    '',
    '别担心～鲸鱼娘只负责提醒，不会阻止或取消任何请求。',
  ].join('\n')
}

/**
 * Observe the collector's post-persistence token-usage event. Delivery is
 * intentionally detached and fail-soft: sender failures never escape into
 * session event handling, usage persistence, charge animation, or UI reads.
 */
export function attachBudgetThresholdNotifications(
  ctx: BudgetNotificationContext,
  storage: Pick<UsageStorage, 'todaySpend'>,
  getSettings: () => BudgetNotificationSettings,
  sender: BudgetNotificationSender,
  options: BudgetNotificationOptions = {},
): void {
  const now = options.now ?? (() => Date.now())
  const warn = options.warn ?? (message => console.warn(message))
  const initialSettings = getSettings()
  const tracker = new DailyBudgetThresholdTracker(
    storage.todaySpend(),
    initialSettings.dailyBudgetCny,
    initialSettings.dailyBudgetEnabled,
  )
  ctx.on('session/event', (_session, event: SessionEvent) => {
    if (event.type !== 'token-usage/record') return
    const observedAt = now()
    const timestamp = event.data.record.timestamp
    if (!Number.isFinite(timestamp) || timestamp > observedAt) return
    const current = storage.todaySpend(observedAt)
    if (current.date !== beijingDateKey(timestamp)) return
    const settings = getSettings()
    const crossing = tracker.observe(
      current,
      settings.dailyBudgetCny,
      settings.dailyBudgetEnabled,
    )
    if (crossing === undefined) return
    if (!settings.budgetExceededNotificationEnabled) return
    options.onCrossing?.(crossing, observedAt)
    Promise.resolve(sender.send(formatBudgetThresholdMessage(crossing))).then((result) => {
      if (!result.ok) {
        warn(`[dsh-token-monitor] 微信预算提醒发送失败（不影响计费/UI）: ${result.detail}`)
      }
    }, (error) => {
      warn(`[dsh-token-monitor] 微信预算提醒异常（不影响计费/UI）: ${String(error)}`)
    })
  })
}
