import { describe, expect, it } from 'vitest'
import { applyDebitToDisplay } from '../src/client/balanceMath.ts'

describe('applyDebitToDisplay', () => {
  it('keeps a positive balance debit exact, including crossing below zero', () => {
    expect(applyDebitToDisplay(10, 12)).toBe(-2)
  })

  it('continues debiting an already negative balance', () => {
    expect(applyDebitToDisplay(-2, 0.5)).toBe(-2.5)
  })

  it('does not create a display baseline before the first balance response', () => {
    expect(applyDebitToDisplay(null, 1)).toBeNull()
  })
})
