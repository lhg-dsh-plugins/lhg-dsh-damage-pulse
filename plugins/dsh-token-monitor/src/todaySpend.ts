import type { TodaySpendInfo, UsageRecord } from './types.ts'

/** 北京时间在 IANA 时区数据库中的规范标识。 */
export const BEIJING_TIME_ZONE = 'Asia/Shanghai' as const

const DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: BEIJING_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** 返回指定时间戳对应的北京时间自然日键。 */
export function beijingDateKey(timestamp: number): string {
  const parts = DATE_FORMATTER.formatToParts(new Date(timestamp))
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return values.year + '-' + values.month + '-' + values.day
}

/** 聚合已经通过计费资格门禁的用量明细。 */
export function summarizeTodaySpend(records: readonly UsageRecord[], now = Date.now()): TodaySpendInfo {
  const date = beijingDateKey(now)
  let cost = 0
  let calls = 0

  for (const record of records) {
    // 历史 JSONL 可能包含可解析但字段损坏的旧行；聚合必须 fail-soft，不能让单行拖垮端点。
    if (!Number.isFinite(record.timestamp) || !Number.isFinite(record.cost) || record.cost < 0) continue
    if (beijingDateKey(record.timestamp) !== date) continue
    cost += record.cost
    calls++
  }

  return {
    date,
    timeZone: BEIJING_TIME_ZONE,
    currency: 'CNY',
    cost,
    calls,
    updatedAt: now,
  }
}
