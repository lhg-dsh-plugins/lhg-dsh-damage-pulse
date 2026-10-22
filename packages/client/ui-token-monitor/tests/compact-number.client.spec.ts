import { describe, expect, it } from 'vitest'
import { formatChineseCompactCurrency, formatChineseCompactNumber } from '../src/client/compactNumber.ts'

describe('formatChineseCompactNumber', () => {
  it('keeps values below ten thousand unshortened', () => {
    expect(formatChineseCompactNumber(9_999)).toBe('9,999')
  })

  it('uses the requested Chinese units from ten thousand onward', () => {
    expect(formatChineseCompactNumber(10_000)).toBe('1万')
    expect(formatChineseCompactNumber(125_000)).toBe('12.5万')
    expect(formatChineseCompactNumber(1_250_000)).toBe('125万')
    expect(formatChineseCompactNumber(12_500_000)).toBe('1.25千万')
    expect(formatChineseCompactNumber(123_000_000)).toBe('1.23亿')
    expect(formatChineseCompactNumber(1_250_000_000_000)).toBe('1.25万亿')
    expect(formatChineseCompactNumber(-100_000_000)).toBe('-1亿')
  })

 it('promotes rounded values instead of showing awkward unit multiples', () => {
   expect(formatChineseCompactNumber(9_999_999)).toBe('1千万')
   expect(formatChineseCompactNumber(99_999_999)).toBe('1亿')
   expect(formatChineseCompactNumber(999_999_999_999)).toBe('1万亿')
 })

  it('covers unit boundaries and promotion edges without changing outputs', () => {
    expect(formatChineseCompactNumber(10_000.4)).toBe('1万')
    expect(formatChineseCompactNumber(9_999_999.9)).toBe('1千万')
    expect(formatChineseCompactNumber(999_999_999_999.9)).toBe('1万亿')
    expect(formatChineseCompactNumber(-10_000)).toBe('-1万')
  })

 it('keeps two decimals for ordinary currency and compacts large amounts', () => {
    expect(formatChineseCompactCurrency(38.6)).toBe('38.60')
    expect(formatChineseCompactCurrency(-0.5)).toBe('-0.50')
    expect(formatChineseCompactCurrency(12_500)).toBe('1.25万')
  })
})
