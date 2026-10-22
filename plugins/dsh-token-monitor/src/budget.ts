import type { TodaySpendInfo } from './types.ts'

export const DEFAULT_DAILY_BUDGET_CNY = 10

export interface DailyBudgetInfo {
  date: string
  timeZone: 'Asia/Shanghai'
  currency: 'CNY'
  budget: number
  spend: number
  remaining: number
  exceeded: boolean
  updatedAt: number
}

export interface BudgetThresholdCrossing {
  date: string
  budget: number
  previousSpend: number
  currentSpend: number
  remaining: number
}

/** Derive the display value without clamping: an over-budget remainder stays negative. */
export function dailyBudgetInfo(today: TodaySpendInfo, budget: number): DailyBudgetInfo {
  const remaining = budget - today.cost
  return {
    date: today.date,
    timeZone: today.timeZone,
    currency: today.currency,
    budget,
    spend: today.cost,
    remaining,
    exceeded: remaining < 0,
    updatedAt: today.updatedAt,
  }
}

/** Pure crossing rule used by both live delivery and replay-oriented tests. */
export function crossedDailyBudget(previousSpend: number, currentSpend: number, budget: number): boolean {
  return previousSpend < budget && currentSpend >= budget
}

/**
 * Tracks one current Beijing day. Cold-start state is seeded from authoritative
 * usage, so replay/restart never re-sends an already crossed threshold.
 */
export class DailyBudgetThresholdTracker {
  private date: string
  private spend: number
  private notified: boolean
  private budget: number
  private enabled: boolean

  constructor(initial: TodaySpendInfo, budget: number, enabled = true) {
    this.date = initial.date
    this.spend = initial.cost
    this.budget = budget
    this.enabled = enabled
    this.notified = initial.cost >= budget
  }

  observe(
    current: TodaySpendInfo,
    budget = this.budget,
    enabled = this.enabled,
  ): BudgetThresholdCrossing | undefined {
    if (current.date !== this.date) {
      this.date = current.date
      this.spend = 0
      this.notified = false
    }

    const previousSpend = this.spend
    if (budget !== this.budget || enabled !== this.enabled) {
      this.budget = budget
      this.enabled = enabled
      // A settings edit is not a usage crossing. Rebase against the last
      // observed spend before considering the current token-usage event.
      this.notified = previousSpend >= budget
    }
    this.spend = Math.max(this.spend, current.cost)
    if (!this.enabled || this.notified
      || !crossedDailyBudget(previousSpend, this.spend, this.budget)) return undefined

    this.notified = true
    return {
      date: current.date,
      budget: this.budget,
      previousSpend,
      currentSpend: this.spend,
      remaining: this.budget - this.spend,
    }
  }
}
